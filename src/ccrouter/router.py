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


def apply_param_fixups(body: dict, model: str, cfg: dict) -> list:
    """Adapt request params to the routed model's capabilities.

    Claude Code shapes params (effort level, thinking) for the model the
    *user* selected — behind the router that's the sentinel, so the session
    settings pass through unchecked. Fix what the target model would 400 on:
    unsupported effort levels are capped/stripped, thinking is stripped for
    models without it. Unknown models are left untouched.
    """
    fixups = []
    try:
        params = cfg.get("model_params", {}).get(model)
        if not params:
            return fixups

        output_config = body.get("output_config")
        if isinstance(output_config, dict) and "effort" in output_config:
            effort = output_config["effort"]
            allowed = params.get("allowed_efforts", [])
            if effort not in allowed:
                if allowed and params.get("effort_fallback"):
                    output_config["effort"] = params["effort_fallback"]
                    fixups.append("effort:%s->%s" % (effort, output_config["effort"]))
                else:
                    output_config.pop("effort")
                    fixups.append("effort:%s->dropped" % effort)
                if not output_config:
                    body.pop("output_config")

        if not params.get("allow_thinking", True) and "thinking" in body:
            body.pop("thinking")
            fixups.append("thinking:dropped")
            # Cascade: context-management strategies that require thinking
            # (clear_thinking_*) 400 once thinking is gone.
            context_management = body.get("context_management")
            if isinstance(context_management, dict) and isinstance(
                context_management.get("edits"), list
            ):
                kept = [
                    edit for edit in context_management["edits"]
                    if not (isinstance(edit, dict)
                            and str(edit.get("type", "")).startswith("clear_thinking"))
                ]
                if len(kept) != len(context_management["edits"]):
                    fixups.append("clear_thinking_edit:dropped")
                    if kept:
                        context_management["edits"] = kept
                    else:
                        body.pop("context_management")
    except Exception:
        return fixups
    return fixups
