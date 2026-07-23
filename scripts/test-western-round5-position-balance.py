#!/usr/bin/env python3
"""Tests for the pre-recording Round 5 position-balance audit."""
from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).with_name("audit-western-round5-position-balance.py")
SPEC = importlib.util.spec_from_file_location("round5_position_balance", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def rows(confounded: bool) -> list[dict]:
    output = []
    for split in ("calibration", "fresh-blind"):
        for gate in MODULE.segment.GATES:
            for recording in range(6):
                for label, suffix in (
                    ("positive", "p"),
                    ("confusion_negative", "n1"),
                    ("confusion_negative", "n2"),
                ):
                    score_interval = (
                        -7.0 if label == "positive" else 2.0
                    ) if confounded and gate == "missing" else float(recording % 2)
                    output.append({
                        "recordingId": f"{split}-{recording}",
                        "eventId": f"{gate}-{suffix}",
                        "split": split,
                        "gate": gate,
                        "label": label,
                        "features": {
                            "scorePreviousInterval": score_interval,
                            "scoreNextInterval": 0.0,
                            "segmentEdgeStatus": 0.0,
                            "scoreDurationQuarter": 1.0,
                            "scorePreviousDurationRatio": 1.0,
                            "scoreNextDurationRatio": 1.0,
                            "scoreBeat": 1.0,
                            "scoreBeatStrength": 1.0,
                            "scoreRepeatedPrevious": 0.0,
                            "scoreRepeatedNext": 0.0,
                            "scoreNormalizedIndex": float(recording % 2),
                        },
                    })
    return output


def rhythm_rows(confounded: bool) -> list[dict]:
    output = []
    for split in ("calibration", "fresh-blind"):
        for recording in range(6):
            for index in range(20):
                positive = index in (4, 12)
                duration = (
                    2.0 if positive else 1.0
                ) if confounded else float(1 + ((index + recording) % 2))
                output.append({
                    "recordingId": f"{split}-{recording}",
                    "eventId": f"rhythm-{index}",
                    "split": split,
                    "gate": "rhythm_review_hint",
                    "label": "positive" if positive else "negative",
                    "features": {
                        "scorePreviousInterval": float((index + recording) % 3),
                        "scoreNextInterval": 0.0,
                        "segmentEdgeStatus": 0.0,
                        "scoreDurationQuarter": duration,
                        "scorePreviousDurationRatio": 1.0,
                        "scoreNextDurationRatio": 1.0,
                        "scoreBeat": float(1 + (index % 4)),
                        "scoreBeatStrength": 0.25,
                        "scoreRepeatedPrevious": 0.0,
                        "scoreRepeatedNext": 0.0,
                        "scoreNormalizedIndex": float((index + recording) % 7),
                    },
                })
    return output


def main() -> int:
    bad = MODULE.audit_rows(
        rows(confounded=True),
        rhythm_rows(confounded=True),
    )
    assert bad["readyForRecording"] is False
    assert "calibration:missing" in bad["confoundedSplitGates"]
    assert "fresh-blind:missing" in bad["confoundedSplitGates"]
    assert bad["rhythmReviewHint"]["confoundedSplits"] == [
        "calibration",
        "fresh-blind",
    ]
    assert (
        bad["rhythmReviewHint"]["bySplit"]["fresh-blind"]
        ["scoreContextOnlyRule"]["randomForestConfounded"]
        is True
    )

    good = MODULE.audit_rows(
        rows(confounded=False),
        rhythm_rows(confounded=False),
    )
    assert good["readyForRecording"] is True
    assert good["confoundedSplitGates"] == []
    assert good["rhythmReviewHint"]["confoundedSplits"] == []
    print("western Round-5 position balance tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
