#!/usr/bin/env python3
"""Unit tests for the segment/onset development candidate."""
from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments" / "eval_western_strings_segment_onset_candidate.py"
SPEC = importlib.util.spec_from_file_location("segment_onset_candidate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    rows = [
        {"relativeIoiDeviationRatio": 0.16, "eventDurationRatio": 1.2},
        {"relativeIoiDeviationRatio": 0.15, "eventDurationRatio": 2.0},
        {"relativeIoiDeviationRatio": 0.5, "eventDurationRatio": 1.19},
        {"relativeIoiDeviationRatio": None, "eventDurationRatio": None},
    ]
    assert MODULE.timing_duration_flags(rows) == {0}

    passing = MODULE.metrics({1, 2}, {1, 2}, 4)
    assert passing["precision"] == 1.0
    assert passing["recall"] == 1.0
    assert passing["jointFloorReady"] is True

    unsafe = MODULE.metrics({1, 2, 3}, {1, 4}, 6)
    assert unsafe["truePositive"] == 1
    assert unsafe["falsePositive"] == 2
    assert unsafe["falseNegative"] == 1
    assert unsafe["jointFloorReady"] is False
    print("western segment/onset candidate unit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
