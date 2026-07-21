#!/usr/bin/env python3
"""Tests for the gated Round-5 segment edit-path candidate."""
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/train_western_round5_segment_edit_path.py"
SPEC = importlib.util.spec_from_file_location("round5_segment_edit_path", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def synthetic_dataset() -> list[dict]:
    rows = []
    for gate_index, gate in enumerate(MODULE.GATES):
        for split in ("calibration", "fresh-blind"):
            for label_index, label in enumerate(("positive", "confusion_negative")):
                for repeat in range(4):
                    positive = label == "positive"
                    rows.append({
                        "recordingId": f"{split}-{gate}-{label}-{repeat}",
                        "pieceId": f"piece-{split}-{gate_index}-{repeat}",
                        "performerId": f"performer-{split}-{repeat}",
                        "deviceId": f"device-{split}-{repeat}",
                        "roomId": f"room-{split}-{repeat}",
                        "split": split,
                        "gate": gate,
                        "label": label,
                        "noteIndex": repeat,
                        "features": {
                            "operationEvidence": 10.0 if positive else -10.0,
                            "gateContext": float(gate_index),
                            "stableNoise": float(label_index) * 0.01,
                        },
                    })
    return rows


def main() -> int:
    promotion = {
        "minPrecision": 0.9,
        "minRecall": 0.5,
        "maxStrictFalseAccusations": 0,
    }
    evaluation, models = MODULE.train_and_evaluate(synthetic_dataset(), promotion)
    assert evaluation["allGatesReady"] is True, evaluation
    assert set(models) == set(MODULE.GATES)
    for gate in MODULE.GATES:
        assert evaluation["gates"][gate]["precision"] == 1.0
        assert evaluation["gates"][gate]["recall"] == 1.0
        assert evaluation["gates"][gate]["falsePositive"] == 0

    positions = [{"noteIndex": 3, "measure": 2, "beat": 1.0, "scoreMidi": 74}]
    assert MODULE.truth_note_index(positions, {
        "measure": 2, "beat": 1.0, "scoreMidi": 74,
    }) == 3

    take = {
        "notes": [
            {"midi": 60 + index, "scoreUnit": float(index)} for index in range(5)
        ],
        "rows": [
            {
                "predictedTime": float(index),
                "pitchDistanceSemitones": 0,
                "eventConfidence": 0.9,
                "relativeIoiDeviationRatio": 0.05,
                "eventDurationRatio": 1.0,
            }
            for index in range(5)
        ],
        "events": [
            {"midi": 60 + index, "start": float(index), "end": float(index) + 0.8}
            for index in range(5)
        ],
        "unassigned": [
            {"midi": 62, "start": 2.2, "end": 2.4},
        ],
    }
    features = MODULE.extract_segment_features(take, 2)
    assert features["targetUnassignedExactPitchCount"] == 1.0
    assert features["segmentGapCount"] == 0.0
    assert features["n_0AssignmentGap"] == 0.0

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        contract = root / "contract.json"
        manifest = root / "manifest.csv"
        truth = root / "truth.json"
        report = root / "report.json"
        model = root / "model.joblib"
        contract.write_text(json.dumps({
            "contractVersion": "western-round5-targeted-diagnosis-intake-v1",
        }), encoding="utf-8")
        result = MODULE.run(contract, manifest, truth, report, model)
        assert result["intakeReady"] is False
        assert result["trainingPerformed"] is False
        assert result["reviewAssistPromotionReady"] is False
        assert result["automaticAccusationReady"] is False
        assert result["studentFacing"] is False
        assert "round5-targeted-intake-not-ready" in result["blockingReasons"]
        assert not model.exists()
    print("western Round-5 segment edit-path tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
