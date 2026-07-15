#!/usr/bin/env python3
"""Evaluate teacher-style coarse pitch states on reviewed M3+ windows.

The probe asks progressively simpler questions using runtime-visible window
features: straight vs active, directional motion, and alternating motion.
Every prediction is out-of-recording. Thresholds remain exploratory until a
separate frozen confirmation set passes.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO / "data" / "experiments" / "western-strings-m3plus"
DEFAULT_LABELS = DEFAULT_ROOT / "pitch-mode-review-pack" / "m3plus-pitch-mode-review-labels.csv"
DEFAULT_FEATURE_PACKS = [
    DEFAULT_ROOT / "pitch-mode-review-pack" / "m3plus-pitch-mode-review.json",
    DEFAULT_ROOT / "pitch-mode-review-pack-round2" / "m3plus-pitch-mode-review.json",
    DEFAULT_ROOT / "pitch-mode-review-pack-candidate-quality" / "m3plus-pitch-mode-review.json",
]
DEFAULT_OUT = DEFAULT_ROOT / "m3plus-coarse-state-eval.json"

FEATURE_NAMES = [
    "logVoicedFrames",
    "logSpreadCents",
    "logAbsoluteNetMotionCents",
    "monotonicity",
    "logTrillSwitches",
    "durationSeconds",
    "spreadRecordingRobustZ",
    "motionRecordingRobustZ",
    "switchRecordingRobustZ",
]
KNOWN_BEHAVIORS = {"stable", "variable-f0", "slide", "trill"}
ACTIVE_BEHAVIORS = {"variable-f0", "slide", "trill"}
TASKS = {
    "straight": {
        "eligible": KNOWN_BEHAVIORS,
        "positive": {"stable"},
        "meaning": "window resembles the recording's straight/stable reference",
    },
    "active": {
        "eligible": KNOWN_BEHAVIORS,
        "positive": ACTIVE_BEHAVIORS,
        "meaning": "window contains material pitch activity rather than a straight tone",
    },
    "directional": {
        "eligible": ACTIVE_BEHAVIORS,
        "positive": {"slide"},
        "meaning": "active pitch mainly moves in one direction",
    },
    "alternating": {
        "eligible": ACTIVE_BEHAVIORS,
        "positive": {"trill"},
        "meaning": "active pitch alternates between two targets",
    },
}


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def finite(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def composite_key(row: dict[str, Any]) -> str:
    return "|".join([
        clean(row.get("recordingId")),
        clean(row.get("noteId")),
        f"{finite(row.get('predictedOnsetSeconds')):.6f}",
        clean(row.get("candidateMode")),
    ])


def read_labels(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_feature_rows(paths: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows.extend(payload.get("rows") or [])
    return rows


def robust_location(values: list[float]) -> tuple[float, float]:
    array = np.asarray(values, dtype=float)
    median = float(np.median(array)) if array.size else 0.0
    mad = float(np.median(np.abs(array - median))) if array.size else 0.0
    return median, max(1.0, 1.4826 * mad)


def merge_review_features(
    labels: list[dict[str, str]],
    feature_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    feature_map: dict[str, dict[str, Any]] = {}
    duplicate_keys: list[str] = []
    for row in feature_rows:
        key = composite_key(row)
        if key in feature_map:
            duplicate_keys.append(key)
        feature_map[key] = row

    merged: list[dict[str, Any]] = []
    missing_keys: list[str] = []
    for label in labels:
        key = composite_key(label)
        feature_row = feature_map.get(key)
        if feature_row is None:
            missing_keys.append(key)
            continue
        behavior = clean(label.get("observedPitchBehavior"))
        if clean(label.get("audioScoreMatch")) != "match" or behavior not in KNOWN_BEHAVIORS:
            continue
        metrics = feature_row.get("metrics") or {}
        merged.append({
            "key": key,
            "recordingId": clean(label.get("recordingId")),
            "noteId": clean(label.get("noteId")),
            "measureIndex": int(finite(label.get("measureIndex"))),
            "candidateMode": clean(label.get("candidateMode")),
            "observedPitchBehavior": behavior,
            "durationSeconds": finite(label.get("predictedDurationSeconds")),
            "voicedFrameCount": finite(metrics.get("voicedFrameCount")),
            "spreadCents": max(0.0, finite(metrics.get("spreadCentsP95P05"))),
            "absoluteNetMotionCents": abs(finite(metrics.get("netMotionCents"))),
            "monotonicity": min(1.0, max(0.0, finite(metrics.get("monotonicity")))),
            "trillSwitchCount": max(0.0, finite(metrics.get("trillSwitchCountApprox"))),
        })

    by_recording: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in merged:
        by_recording[row["recordingId"]].append(row)
    for rows in by_recording.values():
        spread_location = robust_location([row["spreadCents"] for row in rows])
        motion_location = robust_location([row["absoluteNetMotionCents"] for row in rows])
        switch_location = robust_location([row["trillSwitchCount"] for row in rows])
        for row in rows:
            row["features"] = [
                math.log1p(row["voicedFrameCount"]),
                math.log1p(row["spreadCents"]),
                math.log1p(row["absoluteNetMotionCents"]),
                row["monotonicity"],
                math.log1p(row["trillSwitchCount"]),
                row["durationSeconds"],
                (row["spreadCents"] - spread_location[0]) / spread_location[1],
                (row["absoluteNetMotionCents"] - motion_location[0]) / motion_location[1],
                (row["trillSwitchCount"] - switch_location[0]) / switch_location[1],
            ]

    diagnostics = {
        "labelRows": len(labels),
        "featureRows": len(feature_rows),
        "uniqueFeatureKeys": len(feature_map),
        "duplicateFeatureKeyCount": len(duplicate_keys),
        "missingFeatureKeyCount": len(missing_keys),
        "eligibleMatchedRows": len(merged),
        "eligibleRecordingCount": len(by_recording),
        "joinReady": not duplicate_keys and not missing_keys and len(labels) == len(feature_rows),
    }
    return merged, diagnostics


def out_of_recording_probabilities(model: Any, features: np.ndarray, labels: np.ndarray, groups: np.ndarray) -> np.ndarray:
    probabilities = np.zeros(len(labels), dtype=float)
    for train, test in LeaveOneGroupOut().split(features, labels, groups):
        training_labels = labels[train]
        if len(set(training_labels.tolist())) < 2:
            probabilities[test] = float(training_labels[0])
            continue
        model.fit(features[train], training_labels)
        probabilities[test] = model.predict_proba(features[test])[:, 1]
    return probabilities


def threshold_sweep(
    probabilities: np.ndarray,
    labels: np.ndarray,
    *,
    min_precision: float,
    min_recall: float,
    min_selected: int,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    points: list[dict[str, Any]] = []
    positives = max(1, int(labels.sum()))
    for threshold in sorted(set(float(value) for value in probabilities), reverse=True):
        selected = probabilities >= threshold
        selected_count = int(selected.sum())
        if not selected_count:
            continue
        true_positives = int(labels[selected].sum())
        precision = true_positives / selected_count
        recall = true_positives / positives
        point = {
            "threshold": round(threshold, 6),
            "selected": selected_count,
            "truePositive": true_positives,
            "falsePositive": selected_count - true_positives,
            "precision": round(precision, 6),
            "recall": round(recall, 6),
            "autoPositiveCoverage": round(selected_count / len(labels), 6),
            "passes": bool(selected_count >= min_selected and precision >= min_precision and recall >= min_recall),
        }
        points.append(point)
    passing = [point for point in points if point["passes"]]
    best = max(passing, key=lambda point: (point["recall"], point["precision"], point["selected"])) if passing else None
    return points, best


def evaluate_task(
    rows: list[dict[str, Any]],
    task_name: str,
    *,
    min_precision: float,
    min_recall: float,
    min_selected: int,
    min_positive_rows: int,
    min_positive_recordings: int,
) -> dict[str, Any]:
    spec = TASKS[task_name]
    task_rows = [row for row in rows if row["observedPitchBehavior"] in spec["eligible"]]
    if not task_rows:
        return {
            "task": task_name,
            "meaning": spec["meaning"],
            "eligibleRows": 0,
            "positiveRows": 0,
            "negativeRows": 0,
            "recordings": 0,
            "positiveRecordings": 0,
            "evidenceReady": False,
            "evalSafeSubsetReady": False,
            "releaseReady": False,
            "recommendedRuntimeState": "review-only",
            "blockingReasons": ["no-eligible-reviewed-rows"],
            "safeModels": [],
            "models": {},
        }
    features = np.asarray([row["features"] for row in task_rows], dtype=float)
    labels = np.asarray([int(row["observedPitchBehavior"] in spec["positive"]) for row in task_rows], dtype=int)
    groups = np.asarray([row["recordingId"] for row in task_rows])
    positive_recordings = len({row["recordingId"] for row, label in zip(task_rows, labels) if label})
    evidence_ready = bool(
        int(labels.sum()) >= min_positive_rows
        and positive_recordings >= min_positive_recordings
        and len(set(labels.tolist())) == 2
        and len(set(groups.tolist())) >= 3
    )
    models = {
        "logisticRegression": make_pipeline(
            SimpleImputer(), StandardScaler(),
            LogisticRegression(C=0.2, class_weight="balanced", max_iter=2000),
        ),
        "randomForest": RandomForestClassifier(
            n_estimators=400, max_depth=3, min_samples_leaf=3,
            class_weight="balanced", random_state=7, n_jobs=1,
        ),
    }
    model_results: dict[str, Any] = {}
    if len(set(labels.tolist())) < 2 or len(set(groups.tolist())) < 2:
        return {
            "task": task_name,
            "meaning": spec["meaning"],
            "eligibleRows": len(task_rows),
            "positiveRows": int(labels.sum()),
            "negativeRows": int((1 - labels).sum()),
            "recordings": len(set(groups.tolist())),
            "positiveRecordings": positive_recordings,
            "evidenceReady": False,
            "evalSafeSubsetReady": False,
            "releaseReady": False,
            "recommendedRuntimeState": "review-only",
            "blockingReasons": ["cross-recording-two-class-evidence-missing"],
            "safeModels": [],
            "models": {},
        }
    for model_name, model in models.items():
        probabilities = out_of_recording_probabilities(model, features, labels, groups)
        points, best = threshold_sweep(
            probabilities, labels,
            min_precision=min_precision, min_recall=min_recall, min_selected=min_selected,
        )
        auc = float(roc_auc_score(labels, probabilities)) if len(set(labels.tolist())) > 1 else None
        model_results[model_name] = {
            "leaveOneRecordingOutRocAuc": round(auc, 6) if auc is not None else None,
            "safeOperatingPointFound": best is not None,
            "bestSafeOperatingPoint": best,
            "bestObservedPoint": max(points, key=lambda point: (point["precision"], point["recall"])) if points else None,
            "thresholdSweep": points,
            "rows": [
                {
                    "key": row["key"], "recordingId": row["recordingId"],
                    "observedPitchBehavior": row["observedPitchBehavior"],
                    "positive": bool(label), "probability": round(float(probability), 6),
                }
                for row, label, probability in zip(task_rows, labels, probabilities)
            ],
        }
    safe_models = [name for name, result in model_results.items() if result["safeOperatingPointFound"]]
    exploratory_ready = bool(evidence_ready and safe_models)
    reasons: list[str] = []
    if int(labels.sum()) < min_positive_rows:
        reasons.append(f"positive-rows-below-min:{int(labels.sum())}<{min_positive_rows}")
    if positive_recordings < min_positive_recordings:
        reasons.append(f"positive-recordings-below-min:{positive_recordings}<{min_positive_recordings}")
    if not safe_models:
        reasons.append("safe-out-of-recording-operating-point-not-found")
    if exploratory_ready:
        reasons.append("independent-frozen-confirmation-still-required")
    return {
        "task": task_name, "meaning": spec["meaning"], "eligibleRows": len(task_rows),
        "positiveRows": int(labels.sum()), "negativeRows": int((1 - labels).sum()),
        "recordings": len(set(groups.tolist())), "positiveRecordings": positive_recordings,
        "evidenceReady": evidence_ready, "evalSafeSubsetReady": bool(safe_models),
        "releaseReady": False,
        "recommendedRuntimeState": "independent-confirmation-required" if exploratory_ready else "review-only",
        "blockingReasons": reasons, "safeModels": safe_models, "models": model_results,
    }


def evaluate(
    rows: list[dict[str, Any]],
    join_diagnostics: dict[str, Any],
    *,
    min_precision: float = 0.90,
    min_recall: float = 0.80,
    min_selected: int = 4,
    min_positive_rows: int = 8,
    min_positive_recordings: int = 4,
) -> dict[str, Any]:
    behavior_counts = Counter(row["observedPitchBehavior"] for row in rows)
    tasks = {
        name: evaluate_task(
            rows, name, min_precision=min_precision, min_recall=min_recall,
            min_selected=min_selected, min_positive_rows=min_positive_rows,
            min_positive_recordings=min_positive_recordings,
        )
        for name in TASKS
    }
    return {
        "ok": bool(join_diagnostics.get("joinReady")),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "claimScope": "eval-only teacher-style coarse pitch-state probe; no student runtime effect",
        "validation": "leave-one-recording-out predictions; pooled threshold exploration",
        "studentGateReady": False, "runtimeEffect": "none", "featureNames": FEATURE_NAMES,
        "thresholds": {
            "minPrecision": min_precision, "minRecall": min_recall, "minSelected": min_selected,
            "minPositiveRows": min_positive_rows, "minPositiveRecordings": min_positive_recordings,
        },
        "joinDiagnostics": join_diagnostics,
        "behaviorCounts": dict(sorted(behavior_counts.items())),
        "tasks": tasks, "coarseStateRuntimeReady": False,
        "blockingReasons": [
            "independent-frozen-confirmation-not-run",
            *([] if join_diagnostics.get("joinReady") else ["review-label-feature-join-not-ready"]),
        ],
        "caveats": [
            "Historical features are coarse note-window summaries, not the newer detrended pYIN supplemental features.",
            "Threshold selection is exploratory on pooled out-of-recording probabilities and is not a release threshold.",
            "Directional and alternating classes have too few independent positive recordings for release.",
            "Recording-relative robust features use no teacher labels but still require frozen confirmation.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--feature-pack", action="append", default=[])
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-precision", type=float, default=0.90)
    parser.add_argument("--min-recall", type=float, default=0.80)
    parser.add_argument("--min-selected", type=int, default=4)
    parser.add_argument("--min-positive-rows", type=int, default=8)
    parser.add_argument("--min-positive-recordings", type=int, default=4)
    args = parser.parse_args(argv)
    labels = read_labels(repo_path(args.labels))
    feature_paths = [repo_path(path) for path in args.feature_pack] if args.feature_pack else DEFAULT_FEATURE_PACKS
    rows, join_diagnostics = merge_review_features(labels, read_feature_rows(feature_paths))
    report = evaluate(
        rows, join_diagnostics, min_precision=args.min_precision, min_recall=args.min_recall,
        min_selected=args.min_selected, min_positive_rows=args.min_positive_rows,
        min_positive_recordings=args.min_positive_recordings,
    )
    out_path = repo_path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": report["ok"], "studentGateReady": False, "coarseStateRuntimeReady": False,
        "joinDiagnostics": report["joinDiagnostics"], "behaviorCounts": report["behaviorCounts"],
        "tasks": {
            name: {
                "positiveRows": result["positiveRows"],
                "positiveRecordings": result["positiveRecordings"],
                "evalSafeSubsetReady": result["evalSafeSubsetReady"],
                "recommendedRuntimeState": result["recommendedRuntimeState"],
                "blockingReasons": result["blockingReasons"],
            }
            for name, result in report["tasks"].items()
        },
        "artifact": str(out_path.relative_to(REPO) if out_path.is_relative_to(REPO) else out_path),
    }, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
