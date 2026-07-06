import sys as _sys
from pathlib import Path as _Path

_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "src"))

import json
import os
import unittest
from pathlib import Path

from ccrouter import config, router


def cfg(**overrides):
    c = config.load_config(user_path=Path(os.devnull))
    c["classifier"]["api_key"] = None
    for key, value in overrides.items():
        if isinstance(value, dict):
            c[key].update(value)
        else:
            c[key] = value
    return c


def body(prompt="hello there friend, please help", model="auto", **extra):
    b = {"model": model, "messages": [{"role": "user", "content": prompt}]}
    b.update(extra)
    return b


def decide(b, path="/v1/messages", headers=None, c=None, raw_len=None):
    c = c or cfg()
    raw_len = raw_len if raw_len is not None else len(json.dumps(b))
    return router.decide(path, headers or {}, b, raw_len, c)


class TestPassthrough(unittest.TestCase):
    def test_non_sentinel_model_is_passthrough(self):
        self.assertIsNone(decide(body(model="claude-sonnet-4-6")))
        self.assertIsNone(decide(body(model="claude-haiku-4-5")))

    def test_non_messages_path_is_passthrough(self):
        self.assertIsNone(decide(body(), path="/v1/complete"))
        self.assertIsNone(decide(body(), path="/v1/models"))

    def test_count_tokens_is_routed(self):
        decision = decide(body("rename a to b"), path="/v1/messages/count_tokens")
        self.assertIsNotNone(decision)
        self.assertEqual(decision.tier, "low")

    def test_query_string_still_routed(self):
        self.assertIsNotNone(decide(body(), path="/v1/messages?beta=true"))


class TestPresetRules(unittest.TestCase):
    def test_thinking_enabled_forces_high(self):
        decision = decide(body(thinking={"type": "enabled", "budget_tokens": 1024}))
        self.assertEqual((decision.tier, decision.rule), ("high", "thinking"))

    def test_thinking_adaptive_does_not_force_by_default(self):
        decision = decide(body("rename a.py to b.py", thinking={"type": "adaptive"}))
        self.assertEqual(decision.tier, "low")

    def test_thinking_any_mode(self):
        c = cfg(rules={"thinking_forces_high": "any"})
        decision = decide(body(thinking={"type": "adaptive"}), c=c)
        self.assertEqual(decision.tier, "high")

    def test_plan_mode_forces_high(self):
        b = {
            "model": "auto",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "rename this file"},
                    {"type": "text", "text": "<system-reminder>Plan mode is active."
                                             "</system-reminder>"},
                ],
            }],
        }
        decision = decide(b)
        self.assertEqual((decision.tier, decision.rule), ("high", "plan_mode"))

    def test_plan_mode_in_older_turn_is_ignored(self):
        b = {
            "model": "auto",
            "messages": [
                {"role": "user", "content": "x <system-reminder>Plan mode is active"
                                            "</system-reminder>"},
                {"role": "assistant", "content": "done"},
                {"role": "user", "content": "rename utils.py to helpers.py please"},
            ],
        }
        decision = decide(b)
        self.assertEqual(decision.tier, "low")

    def test_subagent_fixed_when_routing_disabled(self):
        c = cfg(rules={"route_subagents": False})
        decision = decide(body(), headers={"x-claude-code-agent-id": "abc"}, c=c)
        self.assertEqual((decision.tier, decision.rule), ("mid", "subagent_fixed"))

    def test_subagent_routed_normally_by_default(self):
        decision = decide(body("rename a.py to b.py now"),
                          headers={"x-claude-code-agent-id": "abc"})
        self.assertEqual(decision.tier, "low")

    def test_long_context_floor(self):
        decision = decide(body("rename a.py to b.py now"), raw_len=600_000)
        self.assertEqual(decision.tier, "mid")
        self.assertIn("long_context_floor", decision.signals)

    def test_long_context_does_not_lower_high(self):
        decision = decide(
            body("design and implement the sync engine end-to-end"),
            raw_len=600_000,
        )
        self.assertEqual(decision.tier, "high")


class TestRobustness(unittest.TestCase):
    def test_messages_none(self):
        decision = decide({"model": "auto", "messages": None})
        self.assertEqual(decision.tier, "mid")

    def test_messages_wrong_type(self):
        decision = decide({"model": "auto", "messages": "garbage"})
        self.assertEqual(decision.tier, "mid")

    def test_decision_model_mapping(self):
        c = cfg()
        decision = decide(body("what is git?"), c=c)
        self.assertEqual(decision.model, c["models"]["low"])
        decision = decide(body("design a plugin system architecture end-to-end"), c=c)
        self.assertEqual(decision.model, c["models"]["high"])


if __name__ == "__main__":
    unittest.main()
