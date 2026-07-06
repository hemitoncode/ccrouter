"""Append-only JSONL decision log. Prompt text is redacted by default;
credentials are never written."""

import datetime
import json
import threading

from . import config

_LOCK = threading.Lock()


def log_path():
    return config.state_dir() / "decisions.jsonl"


def record(decision, headers: dict, path: str, cfg: dict,
           extra: "dict | None" = None) -> None:
    try:
        entry = {
            "ts": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "sid": _short(headers.get("x-claude-code-session-id")),
            "agent": _short(headers.get("x-claude-code-agent-id")),
            "path": path.split("?", 1)[0],
            "tier": decision.tier,
            "model": decision.model,
            "rule": decision.rule,
            "score": decision.score,
            "signals": decision.signals,
            "hops": decision.hops,
            "ms": decision.ms,
        }
        if not cfg["log"].get("redact", True):
            head = cfg["log"].get("prompt_head_chars", 80)
            entry["prompt"] = (decision.picked_text or "")[:head]
        if extra:
            entry.update(extra)
        directory = config.state_dir()
        directory.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, ensure_ascii=False)
        with _LOCK:
            with open(log_path(), "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass  # logging must never break proxying


def _short(value: "str | None") -> "str | None":
    if not value:
        return None
    return value[-8:]
