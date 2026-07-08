# -*- coding: utf-8 -*-
"""Eval-only confidence-model pilot for ordinary-upload western-string candidates.

This script answers one narrow question:

    Given the candidate features already emitted for ordinary uploaded audio, can
    a fail-closed model select a high-precision subset of candidates that are
    safe enough to auto-pass?

It does NOT wire any runtime gate. It trains only from teacher-reviewed
``usable``/``wrong`` labels and reports out-of-fold operating points. ``uncertain``
rows are retained in the input file but excluded from scoring.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.tree import DecisionTreeClassifier


REPO = Path(__file__).resolve().parents[2]
DEFAULT_LABELS = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "controlled-candidate-review-labels.csv"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "candidate-confidence-pilot.json"
)

LABEL_MAP = {"wrong": 0, "usable": 1}
THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9]
MIN_RELEASE_PRECISION = 0.9
MIN_RELEASE_COVERAGE = 0.2
MIN_RELEASE_SELECTED = 10

SCENARIO_SUFFIXES = [
    "correct",
    "wrong_pitch",
    "missing_note",
    "rhythm_shift",
    "weak_onset",
    "noisy",
]

NUMERIC_FEATURES = [
    "predictedOnsetSeconds",
    "voicedFrameCount",
    "medianObservedMidi",
    "midi",
    "centsError",
    "absCentsError",
    "midiDelta",
    "absMidiDelta",
    "noteIndex",
    "measureIndex",
    "pageNumber",
    "confidenceScore",
    "pitchSupportNumeric",
    "midiPitchClass",
    "noteIndexInMeasureApprox",
]
DEPLOYABLE_CATEGORICAL_FEATURES = [
    "method",
    "analysisMode",
    "pitchSupportWithin80Cents",
]
METADATA_CATEGORICAL_FEATURES = DEPLOYABLE_CATEGORICAL_FEATURES + [
    "piece",
    "scoreId",
    "recordingScenario",
]
FEATURE_SETS = {
    "deployable": DEPLOYABLE_CATEGORICAL_FEATURES,
    "diagnostic_with_metadata": METADATA_CATEGORICAL_FEATURES,
}


def safe_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def safe_string(value: Any) -> str:
    return value if isinstance(value, str) else ""


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def candidate_key(row: dict[str, Any]) -> str:
    return "::".join([
        safe_string(row.get("batchRunId")),
        safe_string(row.get("submissionId")),
        safe_string(row.get("candidateId")),
    ])


def scenario_from_recording_id(recording_id: str) -> str:
    for suffix in SCENARIO_SUFFIXES:
        if recording_id.endswith(f"-{suffix}"):
            return suffix
    return "unknown"


def enrich_from_candidate_artifact(row: dict[str, str]) -> dict[str, Any]:
    enriched: dict[str, Any] = dict(row)
    candidate_path = safe_string(row.get("candidateRowsPath"))
    candidate_id = safe_string(row.get("candidateId"))
    if not candidate_path or not candidate_id:
        return enriched
    artifact_path = (REPO / candidate_path).resolve()
    artifact = read_json(artifact_path)
    if not artifact:
        return enriched
    for candidate in artifact.get("candidateRows") or []:
        if safe_string(candidate.get("candidateId")) == candidate_id:
            for key, value in candidate.items():
                enriched.setdefault(key, value)
            break
    return enriched


def build_feature_row(row: dict[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = {}
    for key in NUMERIC_FEATURES:
        item[key] = 0.0
    for key in set(METADATA_CATEGORICAL_FEATURES):
        item[key] = ""

    midi = safe_float(row.get("midi"))
    observed = safe_float(row.get("medianObservedMidi"))
    cents = safe_float(row.get("centsError"))
    note_index = safe_float(row.get("noteIndex"))

    raw_numeric = {
        "predictedOnsetSeconds": row.get("predictedOnsetSeconds"),
        "voicedFrameCount": row.get("voicedFrameCount"),
        "medianObservedMidi": row.get("medianObservedMidi"),
        "midi": row.get("midi"),
        "centsError": row.get("centsError"),
        "noteIndex": row.get("noteIndex"),
        "measureIndex": row.get("measureIndex"),
        "pageNumber": row.get("pageNumber"),
        "confidenceScore": row.get("confidenceScore"),
    }
    for key, value in raw_numeric.items():
        item[key] = safe_float(value)

    item["absCentsError"] = abs(cents) if cents is not None else None
    item["midiDelta"] = (observed - midi) if observed is not None and midi is not None else None
    item["absMidiDelta"] = abs(item["midiDelta"]) if item["midiDelta"] is not None else None
    item["midiPitchClass"] = int(midi) % 12 if midi is not None else None
    item["noteIndexInMeasureApprox"] = int(note_index) % 16 if note_index is not None else None
    item["pitchSupportNumeric"] = 1.0 if safe_string(row.get("pitchSupportWithin80Cents")).lower() in {"yes", "true", "1"} else 0.0

    for key in DEPLOYABLE_CATEGORICAL_FEATURES:
        item[key] = safe_string(row.get(key))
    item["piece"] = safe_string(row.get("piece"))
    item["scoreId"] = safe_string(row.get("scoreId"))
    item["recordingScenario"] = scenario_from_recording_id(safe_string(row.get("recordingId")))
    return item


def load_dataset(labels_path: Path) -> tuple[list[dict[str, Any]], np.ndarray, list[dict[str, str]]]:
    rows = read_csv_rows(labels_path)
    usable_rows: list[dict[str, Any]] = []
    labels: list[int] = []
    source_rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        status = safe_string(row.get("teacherCandidateStatus")).strip().lower()
        if status not in LABEL_MAP:
            continue
        key = candidate_key(row)
        if key in seen:
            continue
        seen.add(key)
        enriched = enrich_from_candidate_artifact(row)
        usable_rows.append(build_feature_row(enriched))
        labels.append(LABEL_MAP[status])
        source_rows.append(row)
    return usable_rows, np.array(labels, dtype=int), source_rows


def group_values(rows: list[dict[str, str]], group_by: str) -> np.ndarray:
    values = []
    for row in rows:
        if group_by == "recordingScenario":
            values.append(scenario_from_recording_id(safe_string(row.get("recordingId"))))
        else:
            values.append(safe_string(row.get(group_by)) or "unknown")
    return np.array(values)


def make_pipeline(categorical_features: list[str], model_name: str) -> Pipeline:
    numeric_pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
    ])
    categorical_pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="constant", fill_value="")),
        ("onehot", OneHotEncoder(handle_unknown="ignore")),
    ])
    preprocessor = ColumnTransformer([
        ("num", numeric_pipe, NUMERIC_FEATURES),
        ("cat", categorical_pipe, categorical_features),
    ])
    if model_name == "dummy":
        model = DummyClassifier(strategy="prior")
    elif model_name == "logreg":
        model = LogisticRegression(max_iter=4000, class_weight="balanced", solver="liblinear")
    elif model_name == "tree":
        model = DecisionTreeClassifier(max_depth=4, min_samples_leaf=3, class_weight="balanced", random_state=7)
    elif model_name == "rf":
        model = RandomForestClassifier(
            n_estimators=400,
            max_depth=5,
            min_samples_leaf=3,
            class_weight="balanced",
            random_state=7,
        )
    else:
        raise ValueError(f"Unknown model: {model_name}")
    return Pipeline([
        ("features", preprocessor),
        ("model", model),
    ])


def row_matrix(rows: list[dict[str, Any]], feature_names: list[str]) -> pd.DataFrame:
    return pd.DataFrame([{key: row.get(key) for key in feature_names} for row in rows])


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path)


def fold_probabilities(
    rows: list[dict[str, Any]],
    labels: np.ndarray,
    groups: np.ndarray,
    categorical_features: list[str],
    model_name: str,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    all_features = NUMERIC_FEATURES + categorical_features
    probabilities = np.full(len(labels), np.nan)
    folds: list[dict[str, Any]] = []
    for group in sorted(set(groups)):
        test_mask = groups == group
        train_mask = ~test_mask
        train_y = labels[train_mask]
        test_y = labels[test_mask]
        if len(train_y) == 0 or len(test_y) == 0:
            continue
        if len(set(train_y.tolist())) < 2:
            probability = float(train_y[0])
            probabilities[test_mask] = probability
            folds.append({
                "heldOut": str(group),
                "trainRows": int(train_mask.sum()),
                "testRows": int(test_mask.sum()),
                "trainUsable": int(train_y.sum()),
                "testUsable": int(test_y.sum()),
                "constantProbability": probability,
            })
            continue
        pipeline = make_pipeline(categorical_features, model_name)
        pipeline.fit(row_matrix([rows[i] for i in np.where(train_mask)[0]], all_features), train_y)
        proba = pipeline.predict_proba(row_matrix([rows[i] for i in np.where(test_mask)[0]], all_features))[:, 1]
        probabilities[test_mask] = proba
        folds.append({
            "heldOut": str(group),
            "trainRows": int(train_mask.sum()),
            "testRows": int(test_mask.sum()),
            "trainUsable": int(train_y.sum()),
            "testUsable": int(test_y.sum()),
            "probabilityMin": round(float(np.min(proba)), 4),
            "probabilityMax": round(float(np.max(proba)), 4),
        })
    return probabilities, folds


def threshold_table(labels: np.ndarray, probabilities: np.ndarray) -> list[dict[str, Any]]:
    rows = []
    valid = np.isfinite(probabilities)
    denominator = int(valid.sum())
    for threshold in THRESHOLDS:
        selected = valid & (probabilities >= threshold)
        selected_count = int(selected.sum())
        correct = int(labels[selected].sum()) if selected_count else 0
        wrong = selected_count - correct
        precision = correct / selected_count if selected_count else None
        coverage = selected_count / denominator if denominator else 0.0
        recall_usable = correct / int(labels[valid].sum()) if int(labels[valid].sum()) else 0.0
        rows.append({
            "threshold": threshold,
            "selected": selected_count,
            "correctUsable": correct,
            "wrongSelected": wrong,
            "precision": round(precision, 4) if precision is not None else None,
            "coverage": round(coverage, 4),
            "recallUsable": round(recall_usable, 4),
        })
    return rows


def scalar_metrics(labels: np.ndarray, probabilities: np.ndarray) -> dict[str, Any]:
    valid = np.isfinite(probabilities)
    y = labels[valid]
    p = probabilities[valid]
    if len(y) == 0:
        return {"validRows": 0, "rocAuc": None, "averagePrecision": None}
    try:
        roc_auc = roc_auc_score(y, p) if len(set(y.tolist())) == 2 else None
    except ValueError:
        roc_auc = None
    try:
        avg_precision = average_precision_score(y, p) if len(set(y.tolist())) == 2 else None
    except ValueError:
        avg_precision = None
    return {
        "validRows": int(valid.sum()),
        "usableRows": int(y.sum()),
        "wrongRows": int(len(y) - y.sum()),
        "rocAuc": round(float(roc_auc), 4) if roc_auc is not None else None,
        "averagePrecision": round(float(avg_precision), 4) if avg_precision is not None else None,
    }


def release_candidate(table: list[dict[str, Any]]) -> dict[str, Any] | None:
    candidates = [
        row for row in table
        if row["precision"] is not None
        and row["precision"] >= MIN_RELEASE_PRECISION
        and row["coverage"] >= MIN_RELEASE_COVERAGE
        and row["selected"] >= MIN_RELEASE_SELECTED
    ]
    if not candidates:
        return None
    return sorted(candidates, key=lambda row: (row["coverage"], row["precision"], row["selected"]), reverse=True)[0]


def evaluate_feature_set(
    rows: list[dict[str, Any]],
    labels: np.ndarray,
    source_rows: list[dict[str, str]],
    feature_set_name: str,
    categorical_features: list[str],
    group_by: str,
) -> dict[str, Any]:
    groups = group_values(source_rows, group_by)
    models: dict[str, Any] = {}
    for model_name in ["dummy", "logreg", "tree", "rf"]:
        probabilities, folds = fold_probabilities(rows, labels, groups, categorical_features, model_name)
        table = threshold_table(labels, probabilities)
        scalar = scalar_metrics(labels, probabilities)
        models[model_name] = {
            "metrics": scalar,
            "thresholds": table,
            "releaseCandidate": release_candidate(table),
            "folds": folds,
        }
    return {
        "featureSet": feature_set_name,
        "groupBy": group_by,
        "categoricalFeatures": categorical_features,
        "groupCounts": dict(sorted(Counter(groups).items())),
        "models": models,
    }


def simple_rule_baselines(rows: list[dict[str, Any]], labels: np.ndarray) -> list[dict[str, Any]]:
    rules = [
        ("pitchSupport=yes", lambda row: row.get("pitchSupportNumeric") == 1.0),
        ("absCents<=80", lambda row: (row.get("absCentsError") is not None and row.get("absCentsError") <= 80)),
        ("absMidiDelta<=0.5", lambda row: (row.get("absMidiDelta") is not None and row.get("absMidiDelta") <= 0.5)),
        ("voicedFrames>=10", lambda row: (row.get("voicedFrameCount") is not None and row.get("voicedFrameCount") >= 10)),
        ("pitchSupport=yes AND absMidiDelta<=0.5", lambda row: row.get("pitchSupportNumeric") == 1.0 and row.get("absMidiDelta") is not None and row.get("absMidiDelta") <= 0.5),
    ]
    output = []
    total = len(labels)
    for name, predicate in rules:
        mask = np.array([bool(predicate(row)) for row in rows], dtype=bool)
        selected = int(mask.sum())
        correct = int(labels[mask].sum()) if selected else 0
        precision = correct / selected if selected else None
        output.append({
            "rule": name,
            "selected": selected,
            "correctUsable": correct,
            "wrongSelected": selected - correct,
            "precision": round(precision, 4) if precision is not None else None,
            "coverage": round(selected / total, 4) if total else 0.0,
        })
    return output


def write_debug_predictions(
    out_path: Path,
    source_rows: list[dict[str, str]],
    labels: np.ndarray,
    rows: list[dict[str, Any]],
    probabilities: np.ndarray,
) -> None:
    pred_path = out_path.with_name(out_path.stem + "-predictions.csv")
    headers = [
        "teacherCandidateStatus",
        "probabilityUsable",
        "piece",
        "recordingId",
        "recordingScenario",
        "candidateId",
        "measureIndex",
        "midi",
        "centsError",
        "absMidiDelta",
        "pitchSupportWithin80Cents",
    ]
    with pred_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for source, label, features, probability in zip(source_rows, labels, rows, probabilities):
            writer.writerow({
                "teacherCandidateStatus": "usable" if label == 1 else "wrong",
                "probabilityUsable": "" if not np.isfinite(probability) else f"{probability:.6f}",
                "piece": source.get("piece", ""),
                "recordingId": source.get("recordingId", ""),
                "recordingScenario": features.get("recordingScenario", ""),
                "candidateId": source.get("candidateId", ""),
                "measureIndex": source.get("measureIndex", ""),
                "midi": source.get("midi", ""),
                "centsError": source.get("centsError", ""),
                "absMidiDelta": "" if features.get("absMidiDelta") is None else f"{features.get('absMidiDelta'):.4f}",
                "pitchSupportWithin80Cents": source.get("pitchSupportWithin80Cents", ""),
            })


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate ML confidence models for reviewed ordinary-upload western-string candidates.")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    labels_path = Path(args.labels)
    out_path = Path(args.out)
    rows, labels, source_rows = load_dataset(labels_path)
    if len(rows) < 20:
        raise SystemExit(f"Need at least 20 usable/wrong labels for this pilot; found {len(rows)} in {labels_path}")

    results = []
    for feature_set_name, categorical_features in FEATURE_SETS.items():
        for group_by in ["recordingId", "piece", "recordingScenario"]:
            results.append(evaluate_feature_set(rows, labels, source_rows, feature_set_name, categorical_features, group_by))

    deployable_recording = next(
        result for result in results
        if result["featureSet"] == "deployable" and result["groupBy"] == "recordingId"
    )
    best_deployable = []
    for model_name, model_result in deployable_recording["models"].items():
        candidate = model_result.get("releaseCandidate")
        if candidate:
            best_deployable.append({"model": model_name, **candidate})

    recommendation = {
        "readyForStudentGate": bool(best_deployable),
        "studentGateReason": "release-candidate-found" if best_deployable else "no-out-of-fold-model-reaches-precision-coverage-floor",
        "releaseFloor": {
            "precision": MIN_RELEASE_PRECISION,
            "coverage": MIN_RELEASE_COVERAGE,
            "selected": MIN_RELEASE_SELECTED,
            "groupBy": "recordingId",
            "featureSet": "deployable",
        },
        "nextStep": (
            "Freeze the selected model and run a larger blind review batch before runtime wiring."
            if best_deployable
            else "Do not wire auto-pass. Improve candidate generation/features or collect more targeted labels; keep ordinary uploads review-only."
        ),
    }

    # Use the most realistic deployable RF predictions as a debugging CSV for inspection.
    rf_probabilities, _ = fold_probabilities(
        rows,
        labels,
        group_values(source_rows, "recordingId"),
        FEATURE_SETS["deployable"],
        "rf",
    )
    write_debug_predictions(out_path, source_rows, labels, rows, rf_probabilities)

    summary = {
        "ok": True,
        "labelsPath": repo_relative(labels_path),
        "reviewedRowsUsed": int(len(labels)),
        "usableRows": int(labels.sum()),
        "wrongRows": int(len(labels) - labels.sum()),
        "classBalance": {
            "usable": round(float(labels.mean()), 4),
            "wrong": round(float(1.0 - labels.mean()), 4),
        },
        "recordingScenarioCounts": dict(sorted(Counter(group_values(source_rows, "recordingScenario")).items())),
        "pieceCounts": dict(sorted(Counter(group_values(source_rows, "piece")).items())),
        "simpleRuleBaselines": simple_rule_baselines(rows, labels),
        "evaluations": results,
        "recommendation": recommendation,
        "warning": (
            "Eval-only pilot. diagnostic_with_metadata can overfit to piece/scenario and is not a deployable student gate. "
            "Release decisions should use deployable + leave-one-recording-out, then a new blind review batch."
        ),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "out": repo_relative(out_path),
        "reviewedRowsUsed": summary["reviewedRowsUsed"],
        "usableRows": summary["usableRows"],
        "wrongRows": summary["wrongRows"],
        "readyForStudentGate": recommendation["readyForStudentGate"],
        "studentGateReason": recommendation["studentGateReason"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
