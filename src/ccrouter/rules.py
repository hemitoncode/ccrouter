"""Preset routing rules that run before the heuristic classifier."""

PLAN_MODE_MARKER = "plan mode is active"


def is_routable_path(path: str) -> bool:
    """Only Messages API bodies carry a model to rewrite."""
    return path.split("?", 1)[0].rstrip("/") in (
        "/v1/messages",
        "/v1/messages/count_tokens",
    )


def is_sentinel(body: dict, cfg: dict) -> bool:
    return body.get("model") == cfg["sentinel"]


def thinking_rule(body: dict, cfg: dict) -> "str | None":
    """Extended thinking as a complexity signal.

    Claude Code may send `thinking: adaptive` routinely for capable models,
    so by default only the explicit legacy `enabled` (budgeted) form forces
    HIGH. Configurable: rules.thinking_forces_high = enabled_only|any|off.
    """
    mode = cfg["rules"].get("thinking_forces_high", "enabled_only")
    if mode == "off":
        return None
    thinking = body.get("thinking")
    if not isinstance(thinking, dict):
        return None
    ttype = thinking.get("type")
    if mode == "any" and ttype in ("enabled", "adaptive"):
        return "high"
    if mode == "enabled_only" and ttype == "enabled":
        return "high"
    return None


def plan_mode_rule(raw_last_user_texts: list, cfg: dict) -> "str | None":
    """Plan mode = design work → HIGH. Detected via the harness reminder
    inside the newest user turn only (older turns may predate a mode exit)."""
    if not cfg["rules"].get("plan_mode_high", True):
        return None
    for raw in raw_last_user_texts:
        if PLAN_MODE_MARKER in raw.lower():
            return "high"
    return None


def subagent_fixed_tier(headers: dict, cfg: dict) -> "str | None":
    """If subagent routing is disabled, pin subagent requests to MID
    (the sentinel is not a real model, so passthrough isn't an option)."""
    agent_id = headers.get("x-claude-code-agent-id")
    if agent_id and not cfg["rules"].get("route_subagents", True):
        return "mid"
    return None


def estimated_tokens(raw_body_len: int) -> int:
    return raw_body_len // 4
