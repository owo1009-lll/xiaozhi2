#!/usr/bin/env python3
"""Tests for the Round-6 complete-score false-accusation denominator."""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments"
    / "train_western_round6_full_score_candidate.py"
)
SPEC = importlib.util.spec_from_file_location("round6_full_score_candidate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    positions = [
        {"noteIndex": index, "measure": index + 1, "beat": 1.0, "scoreMidi": 60 + index}
        for index in range(5)
    ]
    metadata = {
        "pieceId": "piece",
        "performerId": "performer",
        "deviceId": "device",
        "roomId": "room",
        "split": "fresh-blind",
    }
    truth = {
        "events": [
            {
                "eventId": "missing-positive",
                "gate": "missing",
                "label": "positive",
                "measure": 2,
                "beat": 1.0,
                "scoreMidi": 61,
            },
            {
                "eventId": "missing-control",
                "gate": "missing",
                "label": "confusion_negative",
                "measure": 3,
                "beat": 1.0,
                "scoreMidi": 62,
            },
            {
                "eventId": "extra-positive",
                "gate": "extra",
                "label": "positive",
                "measure": 4,
                "beat": 1.0,
                "scoreMidi": 63,
            },
        ],
    }
    rows = MODULE.expand_full_score_rows(
        recording_id="recording",
        metadata=metadata,
        positions=positions,
        features_by_note={index: {"feature": float(index)} for index in range(5)},
        truth_recording=truth,
    )
    assert len(rows) == len(positions) * len(MODULE.GATES)
    missing = [row for row in rows if row["gate"] == "missing"]
    assert sum(row["label"] == "positive" for row in missing) == 1
    assert sum(row["label"] == "confusion_negative" for row in missing) == 4
    assert {row["noteIndex"] for row in missing if row["truthRole"] == "ordinary-unlisted"} == {
        0,
        4,
    }
    assert [row["noteIndex"] for row in missing if row["truthRole"] == "other-gate-positive"] == [
        3
    ]
    denominators = MODULE.denominator_summary(rows)
    missing_denominator = denominators["fresh-blind"]["missing"]
    assert missing_denominator == {
        "allScorePositions": 5,
        "positivePositions": 1,
        "strictNegativePositions": 4,
        "ordinaryUnlistedPositions": 2,
        "targetConfusionNegativePositions": 1,
        "otherGateOrControlPositions": 1,
    }

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        contract = root / "contract.json"
        manifest = root / "missing-manifest.csv"
        truth_path = root / "missing-truth.json"
        report = root / "report.json"
        model = root / "model.joblib"
        contract.write_text(json.dumps({
            "contractVersion": "western-round6-counterbalanced-diagnosis-v1",
        }), encoding="utf-8")
        result = MODULE.run(contract, manifest, truth_path, report, model)
        assert result["intakeReady"] is False
        assert result["trainingPerformed"] is False
        assert result["evaluationPerformed"] is False
        assert result["automaticAccusationReady"] is False
        assert result["studentFacing"] is False
        assert not model.exists()

    print("western Round-6 full-score candidate tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
