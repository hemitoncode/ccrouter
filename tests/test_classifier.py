import sys as _sys
from pathlib import Path as _Path

_sys.path.insert(0, str(_Path(__file__).resolve().parents[1] / "src"))

import os
import unittest
from pathlib import Path

from ccrouter import classifier, config


def cfg():
    c = config.load_config(user_path=Path(os.devnull))
    c["classifier"]["api_key"] = None
    return c


class TestScoring(unittest.TestCase):
    def check(self, text, expected):
        tier, score, signals = classifier.classify(text, cfg())
        self.assertEqual(
            tier, expected,
            "%r -> %s (score %+d, signals %s), expected %s"
            % (text, tier, score, signals, expected),
        )

    def test_low(self):
        self.check("rename utils.py to helpers.py and update the imports", "low")
        self.check("what does curl -u do?", "low")
        self.check("delete the dist folder", "low")
        self.check("explain briefly what this repo does", "low")

    def test_mid(self):
        self.check("write a unit test for parse_config", "mid")
        self.check("fix the off-by-one in paginate()", "mid")
        self.check("write a function that deduplicates a list while preserving order", "mid")
        self.check("add pagination to the /users endpoint", "mid")

    def test_high(self):
        self.check("why does the app deadlock when two workers write to the queue?", "high")
        self.check("design a caching layer for our API client, then implement it end-to-end with tests", "high")
        self.check("refactor auth across the codebase to use the new session store", "high")

    def test_empty_defaults_to_mid(self):
        tier, _, signals = classifier.classify("   ", cfg())
        self.assertEqual(tier, "mid")
        self.assertIn("empty", signals)


class TestStripInjected(unittest.TestCase):
    def test_removes_reminders_and_command_output(self):
        text = (
            "<system-reminder>Plan mode is active.</system-reminder>"
            "real question here"
            "<local-command-stdout>noise</local-command-stdout>"
        )
        self.assertEqual(classifier.strip_injected(text), "real question here")


class TestPickMessage(unittest.TestCase):
    def messages(self):
        return [
            {"role": "user", "content": "design a distributed cache system"},
            {"role": "assistant", "content": "plan..."},
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}
                ],
            },
            {"role": "user", "content": "ok do it"},
        ]

    def test_continuation_hops_to_previous_real_message(self):
        text, hops, _ = classifier.pick_message(self.messages(), cfg())
        self.assertEqual(text, "design a distributed cache system")
        self.assertEqual(hops, 1)

    def test_continuation_inherits_tier(self):
        c = cfg()
        text, _, _ = classifier.pick_message(self.messages(), c)
        tier, _, _ = classifier.classify(text, c)
        self.assertEqual(tier, "high")

    def test_all_continuations_falls_back_to_newest(self):
        msgs = [
            {"role": "user", "content": "ok"},
            {"role": "assistant", "content": "?"},
            {"role": "user", "content": "yes"},
        ]
        text, hops, _ = classifier.pick_message(msgs, cfg())
        self.assertEqual(text, "yes")
        self.assertEqual(hops, 0)

    def test_no_messages(self):
        text, hops, raws = classifier.pick_message([], cfg())
        self.assertEqual(text, "")

    def test_skips_injected_only_turns(self):
        msgs = [
            {"role": "user", "content": "why is the build failing intermittently?"},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "<system-reminder>meta</system-reminder>"}
                ],
            },
        ]
        text, _, _ = classifier.pick_message(msgs, cfg())
        self.assertEqual(text, "why is the build failing intermittently?")


class TestContinuationDetection(unittest.TestCase):
    def test_known_phrases(self):
        c = cfg()
        for phrase in ("yes", "ok", "go ahead", "do it", "sounds good", "1"):
            self.assertTrue(classifier.is_continuation(phrase, c), phrase)

    def test_two_words_or_less(self):
        self.assertTrue(classifier.is_continuation("fix it", cfg()))

    def test_real_prompts_are_not_continuations(self):
        c = cfg()
        self.assertFalse(classifier.is_continuation("rename utils.py to helpers.py", c))
        self.assertFalse(classifier.is_continuation("what does curl -u do?", c))


if __name__ == "__main__":
    unittest.main()
