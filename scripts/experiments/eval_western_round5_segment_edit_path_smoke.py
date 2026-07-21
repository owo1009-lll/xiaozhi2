#!/usr/bin/env python3
"""Synthetic-to-real smoke test for the Round-5 segment model family.

r2-01 waveform injections are calibration, r2-08 injections are a piece-held
synthetic holdout, and inspected Round 4 is a real-domain diagnostic.  None of
these rows are eligible for Round-5 promotion or student-facing use.
"""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np

from eval_western_strings_duration_extra_quantization import (
    INJECT_DIR,
    PRIVATE,
    V2_SETS,
    analyze_take,
)
from train_western_round5_segment_edit_path import (
    GATES,
    binary_metrics,
    extract_segment_features,
    prepare_acoustic_context,
    score_positions,
    train_and_evaluate,
    truth_note_index,
)


REPO = Path(__file__).resolve().parents[2]
CONTRACT = "western-round5-segment-edit-path-smoke-v1"
ROUND4_MANIFEST = REPO / "data/private/western-strings-round4/manifest.csv"
ROUND4_TRUTH = REPO / "data/private/western-strings-round4/error-positions.json"
OUT = REPO / "data/experiments/western-strings-round5-segment-edit-path/smoke-report.json"
PROMOTION = {
    "minPrecision": 0.90,
    "minRecall": 0.50,
    "maxStrictFalseAccusations": 0,
}
INJECTION_GATE = {
    "wrong": "merged_substitution",
    "missing": "missing",
    "extra": "extra",
    "drag": "drag",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def source_binding() -> dict[str, Any]:
    files = {ROUND4_MANIFEST, ROUND4_TRUTH}
    for name in V2_SETS:
        piece = name.split("-injected")[0]
        files.update({
            PRIVATE / f"{piece}.musicxml",
            INJECT_DIR / f"{name}.wav",
            INJECT_DIR / f"{name}.labels.json",
        })
    with ROUND4_MANIFEST.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            files.add(REPO / row["scorePath"])
            files.add(REPO / row["audioPath"])
    ledger = [
        {
            "path": str(file.resolve().relative_to(REPO.resolve())).replace("\\", "/"),
            "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
        }
        for file in sorted(files)
    ]
    canonical = json.dumps(ledger, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        "fileCount": len(ledger),
        "aggregateSha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "files": ledger,
    }


def build_injected_dataset(include_acoustic: bool) -> list[dict[str, Any]]:
    dataset = []
    for name in V2_SETS:
        piece = name.split("-injected")[0]
        split = "calibration" if piece == "r2-01" else "fresh-blind"
        take = analyze_take(PRIVATE / f"{piece}.musicxml", INJECT_DIR / f"{name}.wav")
        acoustic_context = (
            prepare_acoustic_context(INJECT_DIR / f"{name}.wav")
            if include_acoustic else None
        )
        labels = read_json(INJECT_DIR / f"{name}.labels.json")
        injection_by_index = {
            int(injection["scoreEventIndex"]): injection
            for injection in labels["injections"]
        }
        for note_index in range(len(take["notes"])):
            injection = injection_by_index.get(note_index)
            positive_gate = INJECTION_GATE[injection["type"]] if injection else None
            features = extract_segment_features(take, note_index, acoustic_context)
            for gate in GATES:
                dataset.append({
                    "recordingId": name,
                    "pieceId": piece,
                    "performerId": "same-owner-source-performance",
                    "deviceId": "same-source-device",
                    "roomId": "same-source-room",
                    "split": split,
                    "gate": gate,
                    "label": "positive" if gate == positive_gate else "confusion_negative",
                    "negativeRole": None if gate == positive_gate else (
                        "other-error-confusion" if positive_gate else "unaltered-position-proxy"
                    ),
                    "noteIndex": note_index,
                    "features": features,
                })
    return dataset


def build_round4_dataset(include_acoustic: bool) -> list[dict[str, Any]]:
    with ROUND4_MANIFEST.open(encoding="utf-8-sig", newline="") as handle:
        manifest = list(csv.DictReader(handle))
    truth = read_json(ROUND4_TRUTH).get("recordings", {})
    dataset = []
    for metadata in manifest:
        recording_id = metadata["recordingId"]
        score_path = REPO / metadata["scorePath"]
        audio_path = REPO / metadata["audioPath"]
        take = analyze_take(score_path, audio_path)
        acoustic_context = prepare_acoustic_context(audio_path) if include_acoustic else None
        positions = score_positions(score_path)
        errors_by_index = {}
        for event in truth.get(recording_id, {}).get("errors", []):
            errors_by_index[truth_note_index(positions, event)] = INJECTION_GATE[event["kind"]]
        for note_index in range(len(take["notes"])):
            features = extract_segment_features(take, note_index, acoustic_context)
            truth_gate = errors_by_index.get(note_index)
            for gate in GATES:
                dataset.append({
                    "recordingId": recording_id,
                    "pieceId": metadata["pieceId"],
                    "split": "inspected-real",
                    "gate": gate,
                    "label": "positive" if gate == truth_gate else "confusion_negative",
                    "truthGate": truth_gate,
                    "noteIndex": note_index,
                    "features": features,
                })
    return dataset


def evaluate_frozen_models(
    dataset: list[dict[str, Any]],
    models: dict[str, Any],
    feature_names: list[str],
) -> dict[str, Any]:
    gate_results = {}
    predictions_by_position: dict[tuple[str, int], bool] = {}
    truth_by_position: dict[tuple[str, int], bool] = {}
    for gate in GATES:
        rows = [row for row in dataset if row["gate"] == gate]
        truth = np.asarray([int(row["label"] == "positive") for row in rows])
        matrix = np.asarray([
            [float(row["features"].get(name, 0.0)) for name in feature_names]
            for row in rows
        ])
        predicted = (models[gate].predict_proba(matrix)[:, 1] >= 0.5).astype(int)
        gate_metrics = binary_metrics(truth, predicted)
        gate_results[gate] = {
            **gate_metrics,
            "jointFloorReady": (
                gate_metrics["precision"] >= PROMOTION["minPrecision"]
                and gate_metrics["recall"] >= PROMOTION["minRecall"]
                and gate_metrics["falsePositive"] <= PROMOTION["maxStrictFalseAccusations"]
            ),
        }
        for row, flag in zip(rows, predicted):
            key = (row["recordingId"], int(row["noteIndex"]))
            predictions_by_position[key] = predictions_by_position.get(key, False) or bool(flag)
            truth_by_position[key] = truth_by_position.get(key, False) or row["truthGate"] is not None
    keys = sorted(truth_by_position)
    union_truth = np.asarray([int(truth_by_position[key]) for key in keys])
    union_predicted = np.asarray([int(predictions_by_position.get(key, False)) for key in keys])
    union = binary_metrics(union_truth, union_predicted)
    union["jointFloorReady"] = (
        union["precision"] >= PROMOTION["minPrecision"]
        and union["recall"] >= PROMOTION["minRecall"]
        and union["falsePositive"] <= PROMOTION["maxStrictFalseAccusations"]
    )
    return {"gates": gate_results, "union": union}


def evaluate_variant(include_acoustic: bool) -> dict[str, Any]:
    injected = build_injected_dataset(include_acoustic)
    synthetic, models = train_and_evaluate(injected, PROMOTION)
    round4 = evaluate_frozen_models(
        build_round4_dataset(include_acoustic),
        models,
        synthetic["featureNames"],
    )
    retained = synthetic["allGatesReady"] and round4["union"]["jointFloorReady"]
    return {
        "featureVariant": "alignment-plus-fixed-acoustic" if include_acoustic else "alignment-structure-only",
        "synthetic": synthetic,
        "round4InspectedReal": round4,
        "architectureCandidateRetained": retained,
    }


def main() -> int:
    structural = evaluate_variant(False)
    acoustic = evaluate_variant(True)
    retained = structural["architectureCandidateRetained"] or acoustic["architectureCandidateRetained"]
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "scope": "architecture-smoke-preGateOnly",
        "studentFacing": False,
        "automaticAccusationReady": False,
        "reviewAssistPromotionReady": False,
        "promotionEvidenceEligible": False,
        "splitDiscipline": {
            "calibration": "r2-01 waveform-injection-v2, three correlated seeds",
            "syntheticHoldout": "r2-08 waveform-injection-v2, three correlated seeds",
            "realDiagnostic": "inspected Round 4; never fresh-blind",
        },
        "sourceBinding": source_binding(),
        "variants": {
            "structuralAlignment": structural,
            "acousticAugmented": acoustic,
        },
        "architectureCandidateRetained": retained,
        "blockingReasons": [
            *([] if structural["synthetic"]["allGatesReady"] else ["segment-model-structural-synthetic-piece-holdout-failed"]),
            *([] if structural["round4InspectedReal"]["union"]["jointFloorReady"] else ["segment-model-structural-synthetic-to-real-transfer-failed"]),
            *([] if acoustic["synthetic"]["allGatesReady"] else ["segment-model-acoustic-synthetic-piece-holdout-failed"]),
            *([] if acoustic["round4InspectedReal"]["union"]["jointFloorReady"] else ["segment-model-acoustic-synthetic-to-real-transfer-failed"]),
            "round5-independent-real-confusion-pairs-missing",
            "round4-inspected-not-promotion-eligible",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "structural": {
            "syntheticAllGatesReady": structural["synthetic"]["allGatesReady"],
            "round4Union": structural["round4InspectedReal"]["union"],
        },
        "acousticAugmented": {
            "syntheticAllGatesReady": acoustic["synthetic"]["allGatesReady"],
            "round4Union": acoustic["round4InspectedReal"]["union"],
        },
        "architectureCandidateRetained": retained,
        "report": str(OUT.relative_to(REPO)).replace("\\", "/"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
