#!/usr/bin/env python3
"""Tests for the calibration-only Round 5 failure audit."""
from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments"
    / "audit_western_round5_calibration_failure_modes.py"
)
SPEC = importlib.util.spec_from_file_location("round5_calibration_failure_audit", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def synthetic_score_leak() -> list[dict]:
    rows = []
    for index in range(6):
        recording_id = f"cal-{index}"
        rows.extend([
            {
                "recordingId": recording_id,
                "eventId": "positive",
                "label": "positive",
                "features": {
                    "scorePreviousInterval": -7.0,
                    "n_0Confidence": 0.5,
                },
            },
            {
                "recordingId": recording_id,
                "eventId": "negative-1",
                "label": "confusion_negative",
                "features": {
                    "scorePreviousInterval": 2.0,
                    "n_0Confidence": 0.5,
                },
            },
            {
                "recordingId": recording_id,
                "eventId": "negative-2",
                "label": "confusion_negative",
                "features": {
                    "scorePreviousInterval": 4.0,
                    "n_0Confidence": 0.5,
                },
            },
        ])
    return rows


def main() -> int:
    rows = synthetic_score_leak()
    score_only = MODULE.nested_univariate_loro(
        rows,
        allowed_features={"scorePreviousInterval"},
        method="score-only-test",
    )
    performance_only = MODULE.nested_univariate_loro(
        rows,
        allowed_features={"n_0Confidence"},
        method="performance-only-test",
    )
    assert score_only["candidateReadyForNewFreshBlind"] is True
    assert score_only["stableFeatureDirectionAcrossFolds"] is True
    assert score_only["metrics"]["precision"] == 1.0
    assert score_only["metrics"]["recall"] == 1.0
    assert performance_only["candidateReadyForNewFreshBlind"] is False
    assert "scorePreviousInterval" not in MODULE.feature_names(
        rows,
        performance_only=True,
    )
    print("western Round-5 calibration failure audit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
