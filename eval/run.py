#!/usr/bin/env python3
"""Classifier accuracy gate: runs the labeled prompt suite and prints a
confusion matrix. Exits non-zero below the threshold (default 0.90)."""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ccrouter import classifier, config  # noqa: E402

TIERS = ("low", "mid", "high")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=0.90)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    cfg = config.load_config(user_path=Path(os.devnull))  # defaults only
    cfg["classifier"]["api_key"] = None  # heuristics only, always offline

    with open(Path(__file__).resolve().parent / "prompts.json") as f:
        cases = json.load(f)

    matrix = {expected: {actual: 0 for actual in TIERS} for expected in TIERS}
    misses = []
    for case in cases:
        tier, score, signals = classifier.classify(case["text"], cfg)
        matrix[case["expect"]][tier] += 1
        if tier != case["expect"]:
            misses.append((case, tier, score, signals))
        elif args.verbose:
            print("ok   %-4s %+d  %s" % (tier, score, case["text"][:70]))

    correct = sum(matrix[t][t] for t in TIERS)
    total = len(cases)
    accuracy = correct / total

    print("\nconfusion matrix (rows=expected, cols=predicted)")
    print("%8s %6s %6s %6s" % ("", *TIERS))
    for expected in TIERS:
        print("%8s %6d %6d %6d" % (expected, *(matrix[expected][a] for a in TIERS)))
    print("\naccuracy: %d/%d = %.1f%% (threshold %.0f%%)"
          % (correct, total, accuracy * 100, args.threshold * 100))

    if misses:
        print("\nmisses:")
        for case, tier, score, signals in misses:
            print("  expected %-4s got %-4s (%+d) %s" % (
                case["expect"], tier, score, case["text"][:70]))
            print("           signals: %s" % ", ".join(signals))

    return 0 if accuracy >= args.threshold else 1


if __name__ == "__main__":
    sys.exit(main())
