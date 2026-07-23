#!/usr/bin/env python3
"""Unit checks for the label-independent Round 5 identity audit."""
from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).with_name("audit-western-round5-audio-score-identity.py")
SPEC = importlib.util.spec_from_file_location("round5_audio_score_identity", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    score = [60, 62, 64, 65, 67, 69]
    exact = MODULE.alignment_metrics(score, list(score))
    wrong = MODULE.alignment_metrics(score, [72, 71, 69, 67, 65, 64])
    one_extra = MODULE.alignment_metrics(score, [60, 62, 63, 64, 65, 67, 69])

    assert exact["normalizedCost"] == 0
    assert exact["exactPitchMatches"] == len(score)
    assert exact["exactScoreCoverage"] == 1
    assert exact["normalizedCost"] < one_extra["normalizedCost"] < wrong["normalizedCost"]
    assert MODULE.counterpart("r5-cal-03") == "r5-fresh-03"
    assert MODULE.counterpart("r5-fresh-06") == "r5-cal-06"
    assert MODULE.substitution_cost(60, 60) == 0
    assert MODULE.substitution_cost(60, 61) < MODULE.substitution_cost(60, 64)

    print("western Round-5 audio-score identity tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
