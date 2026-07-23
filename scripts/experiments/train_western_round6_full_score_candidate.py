#!/usr/bin/env python3
"""Train/evaluate the frozen Round-6 candidate on complete score positions.

Every score position is evaluated independently for every gate. A position is
positive only for its signed positive gate; all other positions, including
unlisted ordinary notes and positives of another gate, count as negatives.
"""
from __future__ import annotations

import csv
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import joblib


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import status_western_round5_targeted_intake as intake  # noqa: E402
import train_western_round5_segment_edit_path as base  # noqa: E402
from eval_western_strings_duration_extra_quantization import analyze_take  # noqa: E402


CONTRACT = "western-round6-full-score-candidate-v1"
MODEL_FAMILY = "full-score-fixed-random-forest-binary-per-gate"
STRICT_FALSE_ACCUSATION_DENOMINATOR = (
    "every fresh score position not signed positive for the evaluated gate"
)
GATES = base.GATES
MODEL_PARAMS = base.MODEL_PARAMS
FROZEN_GAP_REFINEMENT_CONTRACT = base.FROZEN_GAP_REFINEMENT_CONTRACT
FROZEN_GAP_STRICT_CONTRACT = base.FROZEN_GAP_STRICT_CONTRACT
FROZEN_RHYTHM_REFINEMENT_CONTRACT = base.FROZEN_RHYTHM_REFINEMENT_CONTRACT
FROZEN_RHYTHM_STRICT_CONTRACT = base.FROZEN_RHYTHM_STRICT_CONTRACT


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def expand_full_score_rows(
    *,
    recording_id: str,
    metadata: dict[str, str],
    positions: list[dict[str, Any]],
    features_by_note: dict[int, dict[str, float]],
    truth_recording: dict[str, Any],
) -> list[dict[str, Any]]:
    events_by_note: dict[int, dict[str, Any]] = {}
    for event in truth_recording["events"]:
        note_index = base.truth_note_index(positions, event)
        if note_index in events_by_note:
            raise ValueError(f"round6-truth-position-duplicate:{recording_id}:{note_index}")
        events_by_note[note_index] = event

    rows = []
    for position in positions:
        note_index = int(position["noteIndex"])
        signed_event = events_by_note.get(note_index)
        for gate in GATES:
            positive = bool(
                signed_event
                and signed_event["gate"] == gate
                and signed_event["label"] == "positive"
            )
            if positive:
                truth_role = "target-positive"
            elif signed_event and signed_event["gate"] == gate:
                truth_role = "target-confusion-negative"
            elif signed_event and signed_event["label"] == "positive":
                truth_role = "other-gate-positive"
            elif signed_event:
                truth_role = "other-gate-control"
            else:
                truth_role = "ordinary-unlisted"
            rows.append({
                "recordingId": recording_id,
                "pieceId": metadata["pieceId"],
                "performerId": metadata["performerId"],
                "deviceId": metadata["deviceId"],
                "roomId": metadata["roomId"],
                "split": metadata["split"],
                "gate": gate,
                "label": "positive" if positive else "confusion_negative",
                "truthRole": truth_role,
                "eventId": signed_event.get("eventId") if signed_event else None,
                "noteIndex": note_index,
                "features": features_by_note[note_index],
            })
    return rows


def build_dataset(manifest_path: Path, truth_path: Path) -> list[dict[str, Any]]:
    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        manifest = list(csv.DictReader(handle))
    truth = read_json(truth_path)["recordings"]
    dataset = []
    for metadata in manifest:
        recording_id = metadata["recordingId"]
        score_path = REPO / metadata["scorePath"]
        audio_path = REPO / metadata["audioPath"]
        take = analyze_take(score_path, audio_path)
        positions = base.score_positions(score_path)
        if len(positions) != len(take["notes"]):
            raise ValueError(f"round6-score-position-count-mismatch:{recording_id}")
        features_by_note = {
            int(position["noteIndex"]): base.extract_segment_features(
                take,
                int(position["noteIndex"]),
            )
            for position in positions
        }
        dataset.extend(expand_full_score_rows(
            recording_id=recording_id,
            metadata=metadata,
            positions=positions,
            features_by_note=features_by_note,
            truth_recording=truth[recording_id],
        ))
    return dataset


def denominator_summary(dataset: list[dict[str, Any]]) -> dict[str, Any]:
    summary = {}
    for split in ("calibration", "fresh-blind"):
        summary[split] = {}
        for gate in GATES:
            rows = [
                row for row in dataset
                if row["split"] == split and row["gate"] == gate
            ]
            roles = Counter(row["truthRole"] for row in rows)
            positive = sum(row["label"] == "positive" for row in rows)
            summary[split][gate] = {
                "allScorePositions": len(rows),
                "positivePositions": positive,
                "strictNegativePositions": len(rows) - positive,
                "ordinaryUnlistedPositions": roles["ordinary-unlisted"],
                "targetConfusionNegativePositions": roles["target-confusion-negative"],
                "otherGateOrControlPositions": (
                    roles["other-gate-positive"] + roles["other-gate-control"]
                ),
            }
    return summary


def run(
    contract_path: Path,
    manifest_path: Path,
    truth_path: Path,
    report_path: Path,
    model_path: Path,
) -> dict[str, Any]:
    intake.REPO = REPO
    base.REPO = REPO
    intake_report = intake.validate(contract_path, manifest_path, truth_path)
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "modelFamily": MODEL_FAMILY,
        "intakeContractVersion": intake_report.get("contractVersion"),
        "sourceHashes": intake_report.get("hashes", {}),
        "intakeReady": intake_report.get("ready") is True,
        "trainingPerformed": False,
        "evaluationPerformed": False,
        "strictFalseAccusationDenominator": (
            STRICT_FALSE_ACCUSATION_DENOMINATOR
        ),
        "promotedGates": [],
        "failedGates": list(GATES),
        "reviewAssistPromotionReady": False,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "blockingReasons": [],
    }
    if intake_report.get("ready") is not True:
        report["blockingReasons"] = [
            "round6-targeted-intake-not-ready",
            *intake_report.get("blockingReasons", []),
        ]
    else:
        contract = read_json(contract_path)
        dataset = build_dataset(manifest_path, truth_path)
        evaluation, models = base.train_and_evaluate(dataset, contract["promotion"])
        evaluation["modelType"] = MODEL_FAMILY
        frozen_rules = base.evaluate_frozen_gap_refinement(
            manifest_path,
            truth_path,
            contract["promotion"],
        )
        model_path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({
            "contract": CONTRACT,
            "featureNames": evaluation["featureNames"],
            "models": models,
        }, model_path)
        report.update({
            "trainingPerformed": True,
            "evaluationPerformed": True,
            "datasetRows": len(dataset),
            "denominators": denominator_summary(dataset),
            "evaluation": evaluation,
            "frozenRules": frozen_rules,
            "modelArtifact": {
                "path": str(model_path.resolve().relative_to(REPO.resolve())).replace("\\", "/"),
                "sha256": sha256(model_path),
            },
            "promotedGates": evaluation["promotedGates"],
            "failedGates": evaluation["failedGates"],
            "reviewAssistPromotionReady": evaluation["anyGateReady"],
            "blockingReasons": [] if evaluation["allGatesReady"] else sorted({
                reason
                for gate in evaluation["gates"].values()
                for reason in gate.get("blockingReasons", [])
            }),
        })
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report
