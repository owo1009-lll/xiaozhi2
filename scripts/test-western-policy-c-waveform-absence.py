#!/usr/bin/env python3
"""Unit tests for Policy C waveform-absence diagnostics."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np


SCRIPT = Path(__file__).resolve().parent / "experiments" / "eval_western_policy_c_waveform_absence.py"
SPEC = importlib.util.spec_from_file_location("policy_c_waveform_absence", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    waveform = np.ones(1000, dtype=np.float32) * 0.25
    assert abs(MODULE.centered_rms(waveform, 1000, (0.0, 1.0)) - 0.25) < 1e-6

    result = MODULE.classification_metrics({1, 2}, {1, 2, 3}, 6)
    assert result["precision"] == 1.0
    assert result["recall"] == 0.666667
    assert result["jointFloorReady"] is True

    rows = [
        ("take", [
            {"noteIndex": 0, "assignmentGap": True, "relativeEnergyDb": -10.0},
            {"noteIndex": 1, "assignmentGap": True, "relativeEnergyDb": 2.0},
            {"noteIndex": 2, "assignmentGap": False, "relativeEnergyDb": -20.0},
        ], {0}),
    ]
    evaluated = MODULE.evaluate_rows(rows, -5.0)
    assert evaluated["pooled"]["truePositive"] == 1
    assert evaluated["pooled"]["falsePositive"] == 0
    print("western Policy C waveform-absence unit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
