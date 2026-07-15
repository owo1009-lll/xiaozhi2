#!/usr/bin/env python3
"""Evaluate whether runtime-visible OMR signals can safely select strict-pass scores.

This is an eval-only confidence probe. Gold precision/recall create the target label,
but every model feature is available before gold is known. Validation leaves out one
complete BWV work at a time to reduce movement-level leakage.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SUMMARY = REPO / "data" / "experiments" / "western-strings-m4" / "render-gold-omr" / "render-gold-omr-summary.json"
DEFAULT_ARTIFACT_ROOT = REPO / "data" / "experiments" / "western-strings-m4" / "render-gold-omr"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "omr-confidence-probe.json"

FEATURE_NAMES = [
    "logRecognizedNotes",
    "logRecognizedMeasures",
    "pageCount",
    "notesPerMeasure",
    "measuresPerPage",
    "notesPerPage",
    "warningsPerPage",
    "rhythmErrorsPerMeasure",
    "noTargetDurationPerMeasure",
    "rawMeasureRatio",
    "logBytesPerNote",
]


def threshold_sweep(probabilities, labels, min_precision=0.90, min_coverage=0.20, min_selected=3):
    probabilities = np.asarray(probabilities, dtype=float)
    labels = np.asarray(labels, dtype=int)
    points = []
    for threshold in sorted(set(float(value) for value in probabilities), reverse=True):
        selected = probabilities >= threshold
        count = int(selected.sum())
        if count == 0:
            continue
        precision = float(labels[selected].mean())
        coverage = count / len(labels)
        points.append({
            "threshold": round(threshold, 6),
            "selected": count,
            "precision": round(precision, 6),
            "coverage": round(coverage, 6),
            "passes": bool(
                count >= min_selected
                and precision >= min_precision
                and coverage >= min_coverage
            ),
        })
    passing = [point for point in points if point["passes"]]
    best_safe = max(passing, key=lambda point: (point["coverage"], point["precision"])) if passing else None
    best_observed = max(points, key=lambda point: (point["precision"], point["coverage"])) if points else None
    return points, best_safe, best_observed


def _page_count(tiff_path: Path) -> int:
    try:
        with Image.open(tiff_path) as image:
            return max(1, int(getattr(image, "n_frames", 1)))
    except Exception:
        return 1


def _extract_row(piece_row: dict, artifact_root: Path, strict_precision: float, strict_recall: float):
    piece = str(piece_row.get("piece") or "")
    piece_dir = artifact_root / piece
    log_path = piece_dir / "omr" / "audiveris.log"
    log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
    recognized_path = Path(str(piece_row.get("recognizedMxl") or ""))
    if not recognized_path.is_absolute():
        recognized_path = REPO / recognized_path
    recognized_notes = max(0.0, float(piece_row.get("recNotes") or 0))
    recognized_measures = max(1.0, float(piece_row.get("recMeasures") or 0))
    pages = _page_count(piece_dir / f"{piece}.tiff")
    warnings = len(re.findall(r"(?m)^WARN ", log_text))
    rhythm_errors = len(re.findall(r"no correct rhythm|too long|too short", log_text))
    no_target_duration = len(re.findall(r"No target duration", log_text))
    raw_measures = sum(int(value) for value in re.findall(r"\| (\d+) raw measures:", log_text))
    features = [
        math.log1p(recognized_notes),
        math.log1p(recognized_measures),
        float(pages),
        recognized_notes / recognized_measures,
        recognized_measures / pages,
        recognized_notes / pages,
        warnings / pages,
        rhythm_errors / recognized_measures,
        no_target_duration / recognized_measures,
        raw_measures / recognized_measures,
        len(log_text.encode("utf-8")) / max(1.0, recognized_notes),
    ]
    precision = float(piece_row.get("pitchPrecision") or 0)
    recall = float(piece_row.get("pitchRecall") or 0)
    return {
        "piece": piece,
        "group": piece.split("_")[0],
        "features": features,
        "strictPass": bool(precision >= strict_precision and recall >= strict_recall),
        "goldMetrics": {"pitchPrecision": precision, "pitchRecall": recall},
        "runtimeEvidence": {
            "recognizedNotes": int(recognized_notes),
            "recognizedMeasures": int(recognized_measures),
            "pages": pages,
            "warningCount": warnings,
            "rhythmErrorCount": rhythm_errors,
            "noTargetDurationCount": no_target_duration,
            "rawMeasureCount": raw_measures,
            "recognizedMxlExists": recognized_path.exists(),
            "audiverisLogExists": log_path.exists(),
        },
    }


def _out_of_group_probabilities(model, features, labels, groups):
    probabilities = np.zeros(len(labels), dtype=float)
    splitter = LeaveOneGroupOut()
    for train, test in splitter.split(features, labels, groups):
        if len(set(labels[train])) < 2:
            probabilities[test] = float(labels[train][0])
            continue
        model.fit(features[train], labels[train])
        probabilities[test] = model.predict_proba(features[test])[:, 1]
    return probabilities


def evaluate(rows, min_precision=0.90, min_coverage=0.20, min_selected=3):
    features = np.asarray([row["features"] for row in rows], dtype=float)
    labels = np.asarray([int(row["strictPass"]) for row in rows], dtype=int)
    groups = np.asarray([row["group"] for row in rows])
    models = {
        "logisticRegression": make_pipeline(
            SimpleImputer(),
            StandardScaler(),
            LogisticRegression(C=0.2, class_weight="balanced", max_iter=2000),
        ),
        "randomForest": RandomForestClassifier(
            n_estimators=500,
            max_depth=2,
            min_samples_leaf=3,
            class_weight="balanced",
            random_state=1,
            n_jobs=1,
        ),
    }
    results = {}
    for name, model in models.items():
        probabilities = _out_of_group_probabilities(model, features, labels, groups)
        points, best_safe, best_observed = threshold_sweep(
            probabilities,
            labels,
            min_precision=min_precision,
            min_coverage=min_coverage,
            min_selected=min_selected,
        )
        auc = float(roc_auc_score(labels, probabilities)) if len(set(labels)) > 1 else None
        results[name] = {
            "leaveOneWorkOutRocAuc": round(auc, 6) if auc is not None else None,
            "safeSubsetReady": best_safe is not None,
            "bestSafePoint": best_safe,
            "bestObservedPoint": best_observed,
            "thresholdSweep": points,
            "rows": [
                {
                    "piece": row["piece"],
                    "group": row["group"],
                    "strictPass": row["strictPass"],
                    "probability": round(float(probability), 6),
                }
                for row, probability in zip(rows, probabilities)
            ],
        }
    safe_models = [name for name, result in results.items() if result["safeSubsetReady"]]
    return {
        "safeSubsetReady": bool(safe_models),
        "safeModels": safe_models,
        "models": results,
        "counts": {
            "rows": len(rows),
            "groups": len(set(groups)),
            "strictPassRows": int(labels.sum()),
            "strictFailRows": int((1 - labels).sum()),
        },
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", default=str(DEFAULT_SUMMARY))
    parser.add_argument("--artifact-root", default=str(DEFAULT_ARTIFACT_ROOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--strict-precision", type=float, default=0.98)
    parser.add_argument("--strict-recall", type=float, default=0.95)
    parser.add_argument("--min-auto-precision", type=float, default=0.90)
    parser.add_argument("--min-coverage", type=float, default=0.20)
    parser.add_argument("--min-selected", type=int, default=3)
    args = parser.parse_args(argv)

    summary = json.loads(Path(args.summary).read_text(encoding="utf-8"))
    source_rows = [row for row in summary.get("pieces", []) if row.get("status") == "ok"]
    rows = [
        _extract_row(row, Path(args.artifact_root), args.strict_precision, args.strict_recall)
        for row in source_rows
    ]
    evaluation = evaluate(
        rows,
        min_precision=args.min_auto_precision,
        min_coverage=args.min_coverage,
        min_selected=args.min_selected,
    )
    report = {
        "ok": True,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "claimScope": "eval-only digital-render confidence probe; not real-photo or student-runtime approval",
        "validation": "leave-one-BWV-work-out",
        "runtimeFeatureOnly": True,
        "goldFeatureLeakage": False,
        "featureNames": FEATURE_NAMES,
        "thresholds": {
            "strictPiecePrecision": args.strict_precision,
            "strictPieceRecall": args.strict_recall,
            "minAutoPrecision": args.min_auto_precision,
            "minCoverage": args.min_coverage,
            "minSelected": args.min_selected,
        },
        **evaluation,
        "blockingReasons": [] if evaluation["safeSubsetReady"] else ["m4-runtime-safe-subset-not-found"],
        "caveats": [
            "Only 32 clean digital-render pieces are available; photo-domain behavior is unmeasured.",
            "Gold metrics are used only to create strict-pass labels, never as model inputs.",
            "A positive probe would still require a fresh independent confirmation set before runtime adoption.",
        ],
        "sourceRows": [
            {
                "piece": row["piece"],
                "group": row["group"],
                "strictPass": row["strictPass"],
                "runtimeEvidence": row["runtimeEvidence"],
                "goldMetrics": row["goldMetrics"],
            }
            for row in rows
        ],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "safeSubsetReady": report["safeSubsetReady"],
        "counts": report["counts"],
        "models": {
            name: {
                "auc": result["leaveOneWorkOutRocAuc"],
                "safeSubsetReady": result["safeSubsetReady"],
                "bestSafePoint": result["bestSafePoint"],
                "bestObservedPoint": result["bestObservedPoint"],
            }
            for name, result in report["models"].items()
        },
        "blockingReasons": report["blockingReasons"],
        "out": str(out.relative_to(REPO)).replace("\\", "/"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
