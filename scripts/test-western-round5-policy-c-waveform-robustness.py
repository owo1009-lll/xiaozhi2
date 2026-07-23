#!/usr/bin/env python3
"""Unit tests for the Round-5 Policy-C waveform robustness audit."""
from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments"
    / "audit_western_round5_policy_c_waveform_robustness.py"
)
SPEC = importlib.util.spec_from_file_location("round5_policy_c_waveform_robustness", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def record(
    recording_id: str,
    split: str,
    performer: str,
    device: str,
    room: str,
    positive: int,
    feature_values: tuple[float, float, float],
) -> dict:
    return {
        "recordingId": recording_id,
        "split": split,
        "performerId": performer,
        "deviceId": device,
        "roomId": room,
        "positives": {positive},
        "confusionNegatives": {1},
        "rows": [
            {
                "noteIndex": index,
                "assignmentGap": True,
                "relativeEnergyDb": value,
                "targetPitchFrameRatio": value,
            }
            for index, value in enumerate(feature_values)
        ],
    }


def main() -> int:
    records = [
        record("cal", "calibration", "p1", "d1", "room1", 0, (-10.0, 2.0, 3.0)),
        record("fresh", "fresh-blind", "p1", "d1", "room2", 0, (-9.0, -8.0, 3.0)),
    ]
    evaluated = MODULE.stratified_evaluation(records, -5.0, "relativeEnergyDb")
    assert evaluated["pooled"]["truePositive"] == 2
    assert evaluated["pooled"]["falsePositive"] == 1
    assert evaluated["pooled"]["signedConfusionFalsePositiveCount"] == 1
    assert evaluated["split"]["calibration"]["falsePositive"] == 0
    assert evaluated["split"]["fresh-blind"]["falsePositive"] == 1
    assert set(evaluated["roomId"]) == {"room1", "room2"}
    summary = MODULE.diagnostic_joint_floor_summary(evaluated)
    assert summary["pooledJointFloorReady"] is False
    assert summary["allReportedStrataJointFloorReady"] is False

    report = MODULE.build_report(
        records,
        [SCRIPT],
        {
            "feature": "relativeEnergyDb",
            "threshold": -5.0,
            "selectionDomain": "synthetic-only",
        },
        {
            "feature": "targetPitchFrameRatio",
            "threshold": -5.0,
            "selectionDomain": "synthetic-only",
        },
    )
    assert report["scope"] == "consumed-multi-device-room-diagnostic-only"
    assert report["thresholdRetunedOnRound5"] is False
    assert report["promotionEvidenceEligible"] is False
    assert report["energyAbsence"]["energyRobustnessReady"] is False
    assert report["automaticAccusationReady"] is False
    assert "round5-consumed-diagnostic-not-promotion-evidence" in report["blockingReasons"]
    assert "round5-room-perfectly-confounded-with-split" in report["blockingReasons"]
    print("western Round-5 Policy-C waveform robustness unit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
