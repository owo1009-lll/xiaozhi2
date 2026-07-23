#!/usr/bin/env python3
"""Diagnose failed Round 5 gates using calibration rows only.

The consumed fresh-blind split is intentionally excluded before audio feature
extraction and before any model/rule selection.  Results can nominate a
candidate for a future untouched split, but can never promote a gate directly.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import RandomForestClassifier

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import train_western_round5_segment_edit_path as segment  # noqa: E402

CONTRACT = "western-round5-calibration-failure-audit-v1"
FAILED_GATES = ("merged_substitution", "missing", "drag")
MANIFEST = REPO / "data/private/western-strings-round5/manifest.csv"
TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
OUT = (
    REPO
    / "data/experiments"
    / "western-strings-round5-calibration-failure-audit"
    / "report.json"
)
MIN_PRECISION = 0.90
MIN_RECALL = 0.50
MAX_FALSE_POSITIVE = 0
SCORE_CONTEXT_FEATURES = frozenset({
    "scorePreviousInterval",
    "scoreNextInterval",
    "n_m2OutOfRange",
    "n_m1OutOfRange",
    "n_0OutOfRange",
    "n_p1OutOfRange",
    "n_p2OutOfRange",
})


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metrics(rows: list[dict[str, Any]], predicted: list[int]) -> dict[str, Any]:
    truth = np.asarray([int(row["label"] == "positive") for row in rows], dtype=np.int8)
    estimate = np.asarray(predicted, dtype=np.int8)
    result = segment.binary_metrics(truth, estimate)
    result["passesCandidateFloor"] = bool(
        result["precision"] >= MIN_PRECISION
        and result["recall"] >= MIN_RECALL
        and result["falsePositive"] <= MAX_FALSE_POSITIVE
    )
    return result


def feature_names(
    rows: list[dict[str, Any]],
    *,
    performance_only: bool = False,
) -> list[str]:
    names = {key for row in rows for key in row["features"]}
    if performance_only:
        names -= SCORE_CONTEXT_FEATURES
    return sorted(names)


def matrix(rows: list[dict[str, Any]], names: list[str]) -> np.ndarray:
    return np.asarray(
        [[float(row["features"].get(name, 0.0)) for name in names] for row in rows],
        dtype=np.float64,
    )


def random_forest_loro(
    rows: list[dict[str, Any]],
    *,
    performance_only: bool,
) -> dict[str, Any]:
    names = feature_names(rows, performance_only=performance_only)
    predictions: dict[tuple[str, str], int] = {}
    probabilities: dict[tuple[str, str], float] = {}
    recordings = sorted({row["recordingId"] for row in rows})
    for held_out in recordings:
        train = [row for row in rows if row["recordingId"] != held_out]
        test = [row for row in rows if row["recordingId"] == held_out]
        model = RandomForestClassifier(**segment.MODEL_PARAMS)
        model.fit(matrix(train, names), [int(row["label"] == "positive") for row in train])
        probability = model.predict_proba(matrix(test, names))[:, 1]
        for row, score in zip(test, probability):
            key = (row["recordingId"], str(row["eventId"]))
            probabilities[key] = float(score)
            predictions[key] = int(score >= 0.5)
    ordered = [
        predictions[(row["recordingId"], str(row["eventId"]))]
        for row in rows
    ]
    return {
        "method": (
            "performance-only-random-forest-leave-one-recording-out"
            if performance_only
            else "original-random-forest-leave-one-recording-out"
        ),
        "scoreContextFeaturesExcluded": performance_only,
        "excludedFeatures": sorted(SCORE_CONTEXT_FEATURES) if performance_only else [],
        "decisionThreshold": 0.5,
        "metrics": metrics(rows, ordered),
        "rows": [
            {
                "recordingId": row["recordingId"],
                "eventId": row["eventId"],
                "label": row["label"],
                "probability": round(
                    probabilities[(row["recordingId"], str(row["eventId"]))],
                    6,
                ),
                "predictedPositive": bool(
                    predictions[(row["recordingId"], str(row["eventId"]))]
                ),
            }
            for row in rows
        ],
    }


def thresholds(values: list[float]) -> list[float]:
    unique = sorted(set(values))
    if not unique:
        return [0.0]
    candidates = [unique[0] - 1e-9, unique[-1] + 1e-9]
    candidates.extend((left + right) / 2.0 for left, right in zip(unique, unique[1:]))
    candidates.extend(unique)
    return sorted(set(candidates))


def select_univariate_rule(
    rows: list[dict[str, Any]],
    allowed_features: set[str],
) -> dict[str, Any] | None:
    candidates = []
    for name in sorted(allowed_features):
        values = [float(row["features"].get(name, 0.0)) for row in rows]
        for threshold in thresholds(values):
            for direction in ("gte", "lte"):
                predicted = [
                    int(value >= threshold) if direction == "gte" else int(value <= threshold)
                    for value in values
                ]
                result = metrics(rows, predicted)
                if not result["passesCandidateFloor"]:
                    continue
                candidates.append({
                    "feature": name,
                    "direction": direction,
                    "threshold": threshold,
                    "metrics": result,
                })
    if not candidates:
        return None
    candidates.sort(key=lambda item: (
        -item["metrics"]["recall"],
        -item["metrics"]["precision"],
        item["feature"],
        item["direction"],
        item["threshold"],
    ))
    return candidates[0]


def apply_rule(row: dict[str, Any], rule: dict[str, Any] | None) -> int:
    if rule is None:
        return 0
    value = float(row["features"].get(rule["feature"], 0.0))
    if rule["direction"] == "gte":
        return int(value >= float(rule["threshold"]))
    return int(value <= float(rule["threshold"]))


def nested_univariate_loro(
    rows: list[dict[str, Any]],
    *,
    allowed_features: set[str],
    method: str,
) -> dict[str, Any]:
    predictions: dict[tuple[str, str], int] = {}
    selected_rules = []
    recordings = sorted({row["recordingId"] for row in rows})
    for held_out in recordings:
        train = [row for row in rows if row["recordingId"] != held_out]
        test = [row for row in rows if row["recordingId"] == held_out]
        rule = select_univariate_rule(train, allowed_features)
        selected_rules.append({
            "heldOutRecordingId": held_out,
            "feature": rule["feature"] if rule else None,
            "direction": rule["direction"] if rule else None,
            "threshold": round(float(rule["threshold"]), 6) if rule else None,
            "trainingMetrics": rule["metrics"] if rule else None,
        })
        for row in test:
            predictions[(row["recordingId"], str(row["eventId"]))] = apply_rule(row, rule)
    ordered = [
        predictions[(row["recordingId"], str(row["eventId"]))]
        for row in rows
    ]
    families = {
        (item["feature"], item["direction"])
        for item in selected_rules
        if item["feature"] is not None
    }
    result = metrics(rows, ordered)
    stable_family = len(families) == 1 and all(
        item["feature"] is not None for item in selected_rules
    )
    return {
        "method": method,
        "selectionUsesHeldOutRows": False,
        "selectedRules": selected_rules,
        "stableFeatureDirectionAcrossFolds": stable_family,
        "metrics": result,
        "candidateReadyForNewFreshBlind": bool(
            result["passesCandidateFloor"] and stable_family
        ),
    }


def full_calibration_feature_summary(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summary = []
    for name in feature_names(rows):
        positives = [
            float(row["features"].get(name, 0.0))
            for row in rows
            if row["label"] == "positive"
        ]
        negatives = [
            float(row["features"].get(name, 0.0))
            for row in rows
            if row["label"] != "positive"
        ]
        summary.append({
            "feature": name,
            "positiveMedian": round(float(np.median(positives)), 6),
            "negativeMedian": round(float(np.median(negatives)), 6),
            "medianDifference": round(
                float(np.median(positives) - np.median(negatives)),
                6,
            ),
        })
    summary.sort(key=lambda item: (-abs(item["medianDifference"]), item["feature"]))
    return summary[:12]


def run(manifest_path: Path, truth_path: Path, out_path: Path) -> dict[str, Any]:
    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        manifest_rows = list(csv.DictReader(handle))
    selected_ids = [
        row["recordingId"] for row in manifest_rows if row["split"] == "calibration"
    ]
    excluded_fresh_ids = [
        row["recordingId"] for row in manifest_rows if row["split"] == "fresh-blind"
    ]
    dataset = segment.build_dataset(
        manifest_path,
        truth_path,
        allowed_splits={"calibration"},
    )
    if {row["split"] for row in dataset} != {"calibration"}:
        raise RuntimeError("round5-calibration-audit-split-leak")
    gates = {}
    for gate in FAILED_GATES:
        rows = [row for row in dataset if row["gate"] == gate]
        baseline_rf = random_forest_loro(rows, performance_only=False)
        performance_rf = random_forest_loro(rows, performance_only=True)
        univariate = nested_univariate_loro(
            rows,
            allowed_features=set(feature_names(rows, performance_only=True)),
            method="nested-performance-feature-rule-leave-one-recording-out",
        )
        gates[gate] = {
            "rows": len(rows),
            "positiveRows": sum(row["label"] == "positive" for row in rows),
            "confusionNegativeRows": sum(
                row["label"] == "confusion_negative" for row in rows
            ),
            "consumedFreshBaselineRandomForest": {
                **baseline_rf,
                "alreadyFailedConsumedFreshBlind": True,
                "candidateReadyForNewFreshBlind": False,
            },
            "performanceOnlyRandomForest": performance_rf,
            "nestedUnivariateRule": univariate,
            "topCalibrationMedianDifferences": full_calibration_feature_summary(rows),
            "candidateReadyForNewFreshBlind": bool(
                performance_rf["metrics"]["passesCandidateFloor"]
                or univariate["candidateReadyForNewFreshBlind"]
            ),
        }
    retained = [
        gate for gate, result in gates.items()
        if result["candidateReadyForNewFreshBlind"]
    ]
    position_confounding = {}
    for gate in segment.GATES:
        rows = [row for row in dataset if row["gate"] == gate]
        score_features = set(feature_names(rows)) & set(SCORE_CONTEXT_FEATURES)
        score_rule = nested_univariate_loro(
            rows,
            allowed_features=score_features,
            method="nested-score-context-only-rule-leave-one-recording-out",
        )
        position_confounding[gate] = {
            "scoreContextOnlyRule": score_rule,
            "detected": bool(score_rule["candidateReadyForNewFreshBlind"]),
        }
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "evidenceRole": "calibration-only-candidate-selection-not-promotion",
        "sourceHashes": {
            "manifestSha256": sha256(manifest_path),
            "truthSha256": sha256(truth_path),
        },
        "splitDiscipline": {
            "allowedSplits": ["calibration"],
            "selectedRecordingIds": selected_ids,
            "excludedFreshBlindRecordingIds": excluded_fresh_ids,
            "freshBlindRowsUsed": 0,
            "freshBlindLabelsAccessed": False,
            "promotionEvidenceEligible": False,
        },
        "thresholds": {
            "minPrecision": MIN_PRECISION,
            "minRecall": MIN_RECALL,
            "maxFalsePositive": MAX_FALSE_POSITIVE,
        },
        "gates": gates,
        "positionConfoundingByGate": position_confounding,
        "positionConfoundingDetectedGates": [
            gate for gate, result in position_confounding.items()
            if result["detected"]
        ],
        "retainedCandidateGates": retained,
        "additionalCalibrationRequiredGates": [
            gate for gate in FAILED_GATES
            if position_confounding[gate]["detected"]
            or gate not in retained
        ],
        "nextCalibrationRequirements": {
            "matchPositiveAndConfusionRowsOn": [
                "scorePreviousInterval",
                "scoreNextInterval",
                "segmentEdgeStatus",
            ],
            "prohibitCandidateFeatures": sorted(SCORE_CONTEXT_FEATURES),
            "minimumIndependentRecordingsPerGate": 6,
            "reason": (
                "score-only context predicts calibration labels for three failed gates; "
                "current calibration cannot support another model-selection round"
            ),
        },
        "newUntouchedFreshBlindRequired": True,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "productionAdoptionReady": False,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--truth", type=Path, default=TRUTH)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    report = run(args.manifest, args.truth, args.out)
    print(json.dumps({
        "contract": report["contract"],
        "splitDiscipline": report["splitDiscipline"],
        "retainedCandidateGates": report["retainedCandidateGates"],
        "positionConfoundingDetectedGates": (
            report["positionConfoundingDetectedGates"]
        ),
        "additionalCalibrationRequiredGates": (
            report["additionalCalibrationRequiredGates"]
        ),
        "gates": {
            gate: {
                "consumedFreshBaselineRandomForest": (
                    result["consumedFreshBaselineRandomForest"]["metrics"]
                ),
                "performanceOnlyRandomForest": (
                    result["performanceOnlyRandomForest"]["metrics"]
                ),
                "nestedUnivariateRule": result["nestedUnivariateRule"]["metrics"],
                "stableFeatureDirectionAcrossFolds": (
                    result["nestedUnivariateRule"]["stableFeatureDirectionAcrossFolds"]
                ),
                "candidateReadyForNewFreshBlind": (
                    result["candidateReadyForNewFreshBlind"]
                ),
            }
            for gate, result in report["gates"].items()
        },
        "out": args.out.relative_to(REPO).as_posix(),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
