"""Lightweight prompt classifier: LOW / MID / HIGH.

Pure heuristics by default (zero latency, zero cost). An optional LLM
tie-break runs only when the heuristic score lands near a cutoff AND the
user has configured an API key — the proxy never reuses the session's
OAuth token for calls it mints itself.
"""

import http.client
import json
import re

# Harness-injected wrappers that are not the user's own words.
_INJECTED_TAGS = (
    "system-reminder",
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "command-name",
    "command-message",
    "command-args",
    "task-notification",
)
_INJECTED_RE = re.compile(
    r"<(%s)>.*?</\1>" % "|".join(_INJECTED_TAGS), re.DOTALL | re.IGNORECASE
)

_TRACEBACK_RE = re.compile(
    r"traceback \(most recent call last\)|\berror:|\bexception\b|\bpanic:"
    r"|\bat [\w./<>$-]+:\d+|^\s*file \"",
    re.IGNORECASE | re.MULTILINE,
)
_NUMBERED_RE = re.compile(r"^\s*\d+[.)]\s", re.MULTILINE)
_SEQUENCE_WORDS = (" then ", "after that", "finally", "afterwards", "step 1")
_FILE_PATH_RE = re.compile(
    r"(?:^|[\s\"'`(])[\w~./-]*\w\.(?:py|js|jsx|ts|tsx|go|rs|java|kt|cs|c|h|cc|cpp"
    r"|hpp|rb|php|swift|scala|json|ya?ml|toml|ini|cfg|md|rst|txt|sh|zsh|bash|sql"
    r"|css|scss|html|vue|svelte|lock|env)\b"
)


def strip_injected(text: str) -> str:
    return _INJECTED_RE.sub("", text)


def extract_user_text(message: dict) -> "tuple[str, str]":
    """Return (clean_text, raw_text) for a user message.

    raw_text keeps harness-injected blocks (needed for plan-mode detection);
    clean_text is what gets classified. tool_result blocks never count.
    """
    content = message.get("content")
    parts = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text") or "")
    raw = "\n".join(parts)
    return strip_injected(raw).strip(), raw


def _normalize(text: str) -> str:
    return re.sub(r"[^\w\s+-]", "", text.lower()).strip()


_FILLERS = {"ok", "okay", "yes", "yep", "yeah", "please", "now", "then",
            "just", "sure", "and", "also", "lets"}


def is_continuation(text: str, cfg: dict) -> bool:
    norm = _normalize(text)
    if not norm:
        return True
    continuations = set(cfg["keywords"]["continuations"])
    if norm in continuations:
        return True
    words = norm.split()
    if len(words) <= 2:
        return True
    if len(words) <= 4:
        # "ok do it", "yes go ahead": filler words wrapped around a
        # continuation phrase still make a continuation.
        stripped = " ".join(w for w in words if w not in _FILLERS)
        if not stripped or stripped in continuations:
            return True
    return False


def pick_message(messages: list, cfg: dict) -> "tuple[str, int, list]":
    """Pick the text to classify: the last real user message, hopping past
    continuation-style follow-ups so a thread keeps its tier.

    Returns (text, hops, raw_last_user_texts) where raw_last_user_texts[0]
    is the raw text of the newest user message (for plan-mode detection).
    """
    real = []  # newest-first (clean, raw)
    for message in reversed(messages or []):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        clean, raw = extract_user_text(message)
        if clean:
            real.append((clean, raw))
        elif raw and not real:
            # tool_result-only / injected-only turn: remember raw for
            # plan-mode detection but don't classify it.
            real.append(("", raw))
    raws = [r for _, r in real[:1]]
    candidates = [c for c, _ in real if c]
    if not candidates:
        return "", 0, raws
    hops = 0
    for text in candidates[:6]:
        if not is_continuation(text, cfg):
            return text, hops, raws
        hops += 1
    # Everything looked like a continuation; classify the newest anyway.
    return candidates[0], 0, raws


def _match_term(term: str, text_lower: str) -> bool:
    if term.startswith("\\b"):
        return re.search(term, text_lower) is not None
    return term in text_lower


def score_text(text: str, cfg: dict) -> "tuple[int, list]":
    """Heuristic score. Negative → trivial, positive → complex."""
    weights = cfg["weights"]
    thresholds = cfg["thresholds"]
    keywords = cfg["keywords"]
    signals = []
    score = 0
    lower = text.lower()
    words = text.split()
    word_count = len(words)

    # --- HIGH signals ---------------------------------------------------
    high_points = 0
    seen_terms = set()
    for category, terms in keywords["high_terms"].items():
        for term in terms:
            if term in seen_terms:
                continue
            if _match_term(term, lower):
                seen_terms.add(term)
                high_points += weights["high_term"]
                signals.append("%s:%s" % (category, term.replace("\\b", "")))
    high_points = min(high_points, weights["high_term_cap"])
    score += high_points

    if _TRACEBACK_RE.search(text):
        score += weights["traceback"]
        signals.append("traceback")
    if len(_NUMBERED_RE.findall(text)) >= 2 or sum(
        lower.count(s) for s in _SEQUENCE_WORDS
    ) >= 2:
        score += weights["multistep"]
        signals.append("multistep")
    for phrase in keywords["scope_phrases"]:
        if phrase in lower:
            score += weights["scope"]
            signals.append("scope:%s" % phrase)
            break
    if word_count >= thresholds["very_long_words"]:
        score += weights["very_long_prompt"]
        signals.append("very_long")
    elif word_count >= thresholds["long_words"]:
        score += weights["long_prompt"]
        signals.append("long")
    if "```" in text:
        score += weights["code_fence"]
        signals.append("code_fence")
    if _FILE_PATH_RE.search(text):
        score += weights["file_path"]
        signals.append("file_path")

    has_high_signal = high_points > 0 or "traceback" in signals

    # --- LOW signals ----------------------------------------------------
    first_words = [_normalize(w) for w in words[:3]]
    low_verb = next(
        (v for v in keywords["low_verbs_start"] if v in first_words), None
    )
    low_phrase = next((p for p in keywords["low_phrases"] if p in lower), None)
    if low_verb or low_phrase:
        score += weights["low_verb"]
        signals.append("low_verb:%s" % (low_verb or low_phrase))

    # Brevity/question penalties only matter for plain prompts; a short
    # "why does X deadlock?" is still hard.
    if not has_high_signal:
        if word_count <= thresholds["len_short_words"]:
            score += weights["len_short"]
            signals.append("short")
        elif word_count <= thresholds["len_medium_words"]:
            score += weights["len_medium"]
            signals.append("medium_len")
        if (
            text.rstrip().endswith("?")
            and "```" not in text
            and not _FILE_PATH_RE.search(text)
        ):
            score += weights["question"]
            signals.append("question")

    return score, signals


def tier_for_score(score: int, cfg: dict) -> str:
    if score <= cfg["cutoffs"]["low"]:
        return "low"
    if score >= cfg["cutoffs"]["high"]:
        return "high"
    return "mid"


def in_ambiguity_band(score: int, cfg: dict) -> bool:
    band = cfg.get("band", 1)
    return (
        abs(score - cfg["cutoffs"]["low"]) <= band
        or abs(score - cfg["cutoffs"]["high"]) <= band
    )


def classify(text: str, cfg: dict) -> "tuple[str, int, list]":
    if not text.strip():
        return "mid", 0, ["empty"]
    score, signals = score_text(text, cfg)
    tier = tier_for_score(score, cfg)
    if in_ambiguity_band(score, cfg) and cfg["classifier"].get("api_key"):
        llm_tier = llm_tiebreak(text, cfg)
        if llm_tier:
            signals.append("llm:%s" % llm_tier)
            tier = llm_tier
    return tier, score, signals


_LLM_SYSTEM = (
    "You classify prompts sent to a coding assistant. Reply with exactly one "
    "word:\nLOW - trivial: quick factual/informational questions, renames, "
    "moves, deletes, formatting, tiny repeatable edits.\nMID - a normal, "
    "self-contained coding task.\nHIGH - complex: architecture/design, "
    "debugging or diagnosing failures, multi-file refactors, building whole "
    "features/systems, performance or security work."
)


def llm_tiebreak(text: str, cfg: dict) -> "str | None":
    """Ask a small model for the label. Uses the user's configured API key
    only — never the session's OAuth credentials. Fails soft."""
    ccfg = cfg["classifier"]
    body = json.dumps(
        {
            "model": ccfg.get("model", "claude-haiku-4-5"),
            "max_tokens": 4,
            "system": _LLM_SYSTEM,
            "messages": [{"role": "user", "content": text[:2000]}],
        }
    ).encode("utf-8")
    conn = None
    try:
        conn = http.client.HTTPSConnection(
            cfg["upstream_host"], timeout=ccfg.get("timeout_s", 2.5)
        )
        conn.request(
            "POST",
            "/v1/messages",
            body=body,
            headers={
                "x-api-key": ccfg["api_key"],
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
        )
        resp = conn.getresponse()
        data = json.loads(resp.read())
        if resp.status != 200:
            return None
        label = "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        ).strip().upper()
        return {"LOW": "low", "MID": "mid", "HIGH": "high"}.get(label)
    except Exception:
        return None
    finally:
        if conn is not None:
            conn.close()
