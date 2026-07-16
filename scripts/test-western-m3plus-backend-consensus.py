#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_m3plus_backend_consensus import (  # noqa: E402
    aggregate_mode,
    fit_threshold,
)


def report(rows):
    return {
        "remainingLocalizationCandidates": [
            {"recordingId": "sample", "bestReportRows": rows}
        ]
    }


def row(index, split, positive, value, start=1.0, end=2.0, ready=True):
    return {
        "unitIndex": index,
        "measure": index + 1,
        "evaluationSplit": split,
        "expectedBehavior": "slide-source" if positive else "stable",
        "expectedPositiveModes": ["slide"] if positive else [],
        "expectedNegativeModes": [] if positive else ["slide"],
        "localizationUnitReady": ready,
        "f0QualityReady": True,
        "startSeconds": start,
        "endSeconds": end,
        "features": {"absoluteNetMotionSemitones": value},
    }


def test_threshold_uses_calibration_only() -> None:
    result = fit_threshold(
        [(0.1, False), (0.2, False), (0.8, True), (0.9, True)],
        [(0.15, False), (0.75, True)],
    )
    assert result["threshold"] == 0.8
    assert result["holdout"]["recall"] == 0.0


def test_cross_backend_gate_requires_four_rows_per_class() -> None:
    rows = []
    for index in range(8):
        rows.append(row(index, "calibration", index % 2 == 0, 1.0 if index % 2 == 0 else 0.0))
    for index in range(8, 16):
        rows.append(row(index, "holdout", index % 2 == 0, 1.0 if index % 2 == 0 else 0.0))
    reports = {
        name: report([{**item, "startSeconds": item["startSeconds"] + offset} for item in rows])
        for name, offset in (("a", 0.00), ("b", 0.02), ("c", 0.04))
    }
    result = aggregate_mode(
        "slide",
        {"recordingId": "sample", "feature": "absoluteNetMotionSemitones", "physicalThreshold": 0.8},
        reports,
    )
    assert result["classCounts"] == {
        "calibrationPositive": 4,
        "calibrationNegative": 4,
        "holdoutPositive": 4,
        "holdoutNegative": 4,
    }
    assert result["releaseReady"] is True
    assert result["rows"][0]["physicalState"] == "confirmed"
    assert result["rows"][1]["physicalState"] == "absent"


def test_boundary_disagreement_fails_closed() -> None:
    base = row(0, "calibration", True, 1.0)
    reports = {
        "a": report([base]),
        "b": report([{**base, "startSeconds": 1.5}]),
        "c": report([{**base, "startSeconds": 2.0}]),
    }
    result = aggregate_mode(
        "slide",
        {"recordingId": "sample", "feature": "absoluteNetMotionSemitones", "physicalThreshold": 0.8},
        reports,
    )
    assert result["rows"][0]["boundaryConsensusReady"] is False
    assert result["rows"][0]["medianFeatureValue"] is None
    assert result["rows"][0]["physicalState"] == "uncertain"
    assert result["scoreAdherenceIssueCandidates"][0]["reason"] == "cross-backend-window-evidence-insufficient"


def test_primary_recording_uses_observed_feature_rows() -> None:
    observed = row(0, "calibration", True, 1.0)
    reports = {
        name: {
            "recordingId": "sample",
            "observedFeatureRows": [observed],
            "remainingLocalizationCandidates": [],
        }
        for name in ("a", "b", "c")
    }
    result = aggregate_mode(
        "slide",
        {
            "recordingId": "sample",
            "feature": "absoluteNetMotionSemitones",
            "physicalThreshold": 0.8,
        },
        reports,
    )
    assert result["rows"][0]["physicalState"] == "confirmed"


def test_one_boundary_outlier_does_not_discard_two_agreeing_backends() -> None:
    base = row(0, "calibration", True, 1.0)
    reports = {
        "a": report([base]),
        "b": report([{**base, "startSeconds": 1.05, "endSeconds": 2.05}]),
        "outlier": report([{**base, "startSeconds": 3.0, "endSeconds": 4.0}]),
    }
    result = aggregate_mode(
        "slide",
        {"recordingId": "sample", "feature": "absoluteNetMotionSemitones", "physicalThreshold": 0.8},
        reports,
    )
    assert result["rows"][0]["boundaryConsensusReady"] is True
    assert result["rows"][0]["boundaryConsensusBackends"] == ["a", "b"]
    assert result["rows"][0]["medianFeatureValue"] == 1.0


def test_statistical_micro_threshold_cannot_bypass_physical_minimum() -> None:
    rows = []
    for index in range(8):
        rows.append(row(index, "calibration", index % 2 == 0, 0.02 if index % 2 == 0 else 0.0))
    for index in range(8, 16):
        rows.append(row(index, "holdout", index % 2 == 0, 0.02 if index % 2 == 0 else 0.0))
    reports = {name: report(rows) for name in ("a", "b", "c")}
    result = aggregate_mode(
        "slide",
        {"recordingId": "sample", "feature": "absoluteNetMotionSemitones", "physicalThreshold": 0.8},
        reports,
    )
    assert result["thresholdAudit"]["holdout"]["precision"] == 1.0
    assert result["fittedThresholdMeetsPhysicalMinimum"] is False
    assert result["releaseReady"] is False


test_threshold_uses_calibration_only()
test_cross_backend_gate_requires_four_rows_per_class()
test_boundary_disagreement_fails_closed()
test_primary_recording_uses_observed_feature_rows()
test_one_boundary_outlier_does_not_discard_two_agreeing_backends()
test_statistical_micro_threshold_cannot_bypass_physical_minimum()
print("western M3+ backend-consensus tests passed")
