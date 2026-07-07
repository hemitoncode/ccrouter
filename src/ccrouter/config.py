"""Configuration loading: repo defaults merged with the user's overrides.

Defaults live in config.default.json at the repo root (single source of
truth). User overrides live in ~/.cc-model-router/config.json and are
deep-merged over the defaults. CCROUTER_HOME overrides the state dir
(used by tests).
"""

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = REPO_ROOT / "config.default.json"

TIER_ORDER = {"low": 0, "mid": 1, "high": 2}


def state_dir() -> Path:
    return Path(os.environ.get("CCROUTER_HOME", str(Path.home() / ".cc-model-router")))


def user_config_path() -> Path:
    return state_dir() / "config.json"


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def _validate(cfg: dict) -> "str | None":
    """Minimal shape check for the keys the server dereferences at runtime."""
    models = cfg.get("models")
    if not isinstance(models, dict) or not all(
        isinstance(models.get(tier), str) and models.get(tier)
        for tier in ("low", "mid", "high")
    ):
        return "models must be an object with low/mid/high model-id strings"
    if not isinstance(cfg.get("port"), int):
        return "port must be an integer"
    if not isinstance(cfg.get("sentinel"), str) or not cfg["sentinel"]:
        return "sentinel must be a non-empty string"
    if not isinstance(cfg.get("rules"), dict) or not isinstance(
        cfg.get("keywords"), dict
    ):
        return "rules/keywords must be objects"
    return None


def load_config(user_path: "Path | None" = None) -> dict:
    with open(DEFAULT_CONFIG_PATH, "r", encoding="utf-8") as f:
        defaults = json.load(f)
    cfg = defaults
    path = user_path if user_path is not None else user_config_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            user_cfg = json.load(f)
        if not isinstance(user_cfg, dict):
            raise ValueError("top-level config must be a JSON object")
        merged = _deep_merge(defaults, user_cfg)
        problem = _validate(merged)
        if problem:
            raise ValueError(problem)
        cfg = merged
        cfg["_user_config_loaded"] = str(path)
    except FileNotFoundError:
        cfg["_user_config_loaded"] = None
    except (ValueError, TypeError, OSError) as exc:
        # A broken user config must never take the proxy down: fall back to
        # the pristine defaults and surface the problem via health/doctor.
        cfg = defaults
        cfg["_user_config_loaded"] = None
        cfg["_user_config_error"] = "%s: %s" % (path, exc)
    return cfg


def max_tier(a: str, b: str) -> str:
    return a if TIER_ORDER[a] >= TIER_ORDER[b] else b
