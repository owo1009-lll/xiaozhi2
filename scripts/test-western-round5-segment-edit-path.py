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
    assert evaluation["promotionScope"] == "independent-per-gate"
    assert evaluation["promotedGates"] == list(MODULE.GATES)
    assert evaluation["failedGates"] == []
    assert evaluation["anyGateReady"] is True
    assert evaluation["allGatesReady"] is True, evaluation
    assert set(models) == set(MODULE.GATES)
    for gate in MODULE.GATES:
        assert evaluation["gates"][gate]["precision"] == 1.0
        assert evaluation["gates"][gate]["recall"] == 1.0
        assert evaluation["gates"][gate]["falsePositive"] == 0

    partial_dataset = synthetic_dataset()
    for row in partial_dataset:
        if row["split"] == "fresh-blind" and row["gate"] != "extra":
            row["features"]["operationEvidence"] = 0.0
    partial, _ = MODULE.train_and_evaluate(partial_dataset, promotion)
    assert partial["promotedGates"] == ["extra"]
    assert partial["failedGates"] == [
        "merged_substitution", "missing", "drag",
    ]
    assert partial["anyGateReady"] is True
    assert partial["allGatesReady"] is False

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

    synthetic_refinement_rows = [{
        "recordingId": "synthetic-refinement",
        "positionCount": 5,
        "refined": {1, 2, 4},
        "gapStrict": {1, 3},
        "rhythmRefined": {4},
        "rhythmStrict": {4},
        "knownPositive": {1, 3, 4},
        "positiveByGate": {
            "merged_substitution": {1},
            "missing": {3},
            "extra": {4},
            "drag": set(),
        },
    }]
    refinement_metrics = MODULE.frozen_refinement_metrics(synthetic_refinement_rows)
    assert refinement_metrics["truePositive"] == 1
    assert refinement_metrics["falsePositive"] == 1
    assert refinement_metrics["falseNegative"] == 1
    assert refinement_metrics["trueNegative"] == 1
    assert refinement_metrics["offScopeTrueErrorHints"] == 1
    assert refinement_metrics["precision"] == 0.5
    assert refinement_metrics["recall"] == 0.5
    gap_strict_metrics = MODULE.frozen_refinement_metrics(
        synthetic_refinement_rows,
        ("missing",),
        "gapStrict",
    )
    assert gap_strict_metrics["truePositive"] == 1
    assert gap_strict_metrics["falsePositive"] == 0
    assert gap_strict_metrics["offScopeTrueErrorHints"] == 1
    assert gap_strict_metrics["precision"] == 1.0
    assert gap_strict_metrics["recall"] == 1.0
    rhythm_metrics = MODULE.frozen_refinement_metrics(
        synthetic_refinement_rows,
        MODULE.RHYTHM_REFINEMENT_TARGET_GATES,
        "rhythmRefined",
    )
    assert rhythm_metrics["truePositive"] == 1
    assert rhythm_metrics["falsePositive"] == 0
    assert rhythm_metrics["precision"] == 1.0
    rhythm_strict_metrics = MODULE.frozen_refinement_metrics(
        synthetic_refinement_rows,
        MODULE.RHYTHM_REFINEMENT_TARGET_GATES,
        "rhythmStrict",
    )
    assert rhythm_strict_metrics["truePositive"] == 1
    assert rhythm_strict_metrics["falsePositive"] == 0

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        manifest = root / "manifest.csv"
        truth = root / "truth.json"
        manifest.write_text(
            "recordingId,split\nr5-cal-test,calibration\nr5-fresh-test,fresh-blind\n",
            encoding="utf-8",
        )
        truth.write_text(json.dumps({
            "recordings": {
                "r5-cal-test": {"events": [{"gate": "missing"}]},
                # Deliberately not a usable recording payload: calibration-only
                # selection must not inspect fresh event fields.
                "r5-fresh-test": {"poison": True},
            },
        }), encoding="utf-8")
        selected = MODULE.select_recording_specs(
            manifest,
            truth,
            {"calibration"},
        )
        assert [item[0] for item in selected] == ["r5-cal-test"]
        assert selected[0][2]["events"][0]["gate"] == "missing"

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
        assert result["evaluationPerformed"] is False
        assert result["promotionScope"] == "independent-per-gate"
        assert result["promotedGates"] == []
        assert result["failedGates"] == list(MODULE.GATES)
        assert result["partialGatePromotionReady"] is False
        assert result["allGatePromotionReady"] is False
        assert result["reviewAssistPromotionReady"] is False
        assert result["automaticAccusationReady"] is False
        assert result["studentFacing"] is False
        assert result["frozenGapRefinement"]["runnerWired"] is True
        assert result["frozenGapRefinement"]["evaluationPerformed"] is False
        assert result["frozenGapRefinement"]["reviewAssistPromotionReady"] is False
        assert result["frozenGapRefinement"]["automaticAccusationReady"] is False
        gap_strict_runner = result["frozenGapRefinement"]["strictIssueCandidate"]
        assert gap_strict_runner["contract"] == "western-round5-frozen-gap-strict-issue-candidate-v1"
        assert gap_strict_runner["runnerWired"] is True
        assert gap_strict_runner["evaluationPerformed"] is False
        assert gap_strict_runner["outputSemantic"] == "issue_detected_candidate"
        assert gap_strict_runner["automaticAccusationEvidenceReady"] is False
        assert gap_strict_runner["automaticAccusationReady"] is False
        assert gap_strict_runner["promotionEvidenceEligible"] is False
        rhythm_runner = result["frozenGapRefinement"]["rhythmStructuralRefinement"]
        assert rhythm_runner["runnerWired"] is True
        assert rhythm_runner["evaluationPerformed"] is False
        assert rhythm_runner["reviewAssistPromotionReady"] is False
        assert rhythm_runner["automaticAccusationReady"] is False
        strict_runner = rhythm_runner["strictIssueCandidate"]
        assert strict_runner["contract"] == "western-round5-frozen-rhythm-strict-issue-candidate-v1"
        assert strict_runner["runnerWired"] is True
        assert strict_runner["evaluationPerformed"] is False
        assert strict_runner["outputSemantic"] == "issue_detected_candidate"
        assert strict_runner["automaticAccusationEvidenceReady"] is False
        assert strict_runner["automaticAccusationReady"] is False
        assert strict_runner["promotionEvidenceEligible"] is False
        assert "round5-targeted-intake-not-ready" in result["blockingReasons"]
        assert not model.exists()
    print("western Round-5 segment edit-path tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
