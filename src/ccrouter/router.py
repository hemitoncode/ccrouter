"""Decision pipeline: preset rules → message pick → heuristic → model."""

import time

from . import classifier, config, rules


class Decision:
    __slots__ = (
        "tier", "model", "rule", "score", "signals", "hops", "picked_text", "ms"
    )

    def __init__(self, tier, model, rule, score=0, signals=None, hops=0,
                 picked_text="", ms=0.0):
        self.tier = tier
        self.model = model
        self.rule = rule
        self.score = score
        self.signals = signals or []
        self.hops = hops
        self.picked_text = picked_text
        self.ms = ms

    def as_dict(self) -> dict:
        return {
            "tier": self.tier,
            "model": self.model,
            "rule": self.rule,
            "score": self.score,
            "signals": self.signals,
            "hops": self.hops,
        }


def decide(path: str, headers: dict, body: dict, raw_body_len: int,
           cfg: dict) -> "Decision | None":
    """Return a Decision for sentinel requests, or None for passthrough.

    Never raises: any internal error fails open to the MID tier (the
    sentinel is not a real model, so a routed request must get *some*
    rewrite).
    """
    started = time.time()
    if not rules.is_routable_path(path) or not isinstance(body, dict):
        return None
    if not rules.is_sentinel(body, cfg):
        return None
    try:
        decision = _decide_tier(headers, body, raw_body_len, cfg)
    except Exception as exc:  # fail open, always answer
        decision = Decision("mid", cfg["models"]["mid"], "fail_open",
                            signals=["error:%s" % type(exc).__name__])
    decision.ms = round((time.time() - started) * 1000, 2)
    return decision


def _decide_tier(headers: dict, body: dict, raw_body_len: int,
                 cfg: dict) -> Decision:
    models = cfg["models"]

    fixed = rules.subagent_fixed_tier(headers, cfg)
    if fixed:
        return Decision(fixed, models[fixed], "subagent_fixed")

    tier = rules.thinking_rule(body, cfg)
    if tier:
        return Decision(tier, models[tier], "thinking")

    text, hops, raw_last = classifier.pick_message(body.get("messages"), cfg)

    tier = rules.plan_mode_rule(raw_last, cfg)
    if tier:
        return Decision(tier, models[tier], "plan_mode", hops=hops,
                        picked_text=text)

    tier, score, signals = classifier.classify(text, cfg)
    rule = "heuristic" if hops == 0 else "continuation"
    if any(s.startswith("llm:") for s in signals):
        rule = "llm_tiebreak"

    # Very large contexts deserve at least the MID model.
    if rules.estimated_tokens(raw_body_len) > cfg["rules"]["long_context_tokens"]:
        floored = config.max_tier(tier, "mid")
        if floored != tier:
            signals.append("long_context_floor")
            tier = floored

    return Decision(tier, models[tier], rule, score=score, signals=signals,
                    hops=hops, picked_text=text)
