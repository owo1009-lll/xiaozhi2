# -*- coding: utf-8 -*-
"""Evaluate the fresh blind confidence-validation review batch.

This script is intentionally eval-only. It does not merge the completed review
CSV into the cumulative training labels. That separation keeps the fresh blind
batch usable as an independent validation set for the frozen confidence model
and threshold selected by ``candidate-confidence-pilot.json``.
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from eval_western_controlled_candidate_confidence import (
    DEPLOYABLE_CATEGORICAL_FEATURES,
    build_feature_row,
    load_dataset,
    make_pipeline,
    read_csv_rows,
    safe_string,
)
from export_western_controlled_confidence_validation_batch import select_model_from_pilot


REPO = Path(__file__).resolve().parents[2]
DEFAULT_LABELS = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "controlled-candidate-review-labels.csv"
)
DEFAULT_PILOT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "candidate-confidence-pilot.json"
)
DEFAULT_COMPLETED = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-validation-review"
    / "controlled-candidate-review.completed.csv"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-validation-review"
    / "confidence-validation-eval.json"
)

LABEL_MAP = {"wrong": 0, "usable": 1}


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def status_value(row: dict[str, Any]) -> str:
    return safe_string(row.get("teacherCandidateStatus")).strip().lower()


def count_statuses(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"usable": 0, "wrong": 0, "uncertain": 0, "blank": 0, "other": 0}
    for row in rows:
        status = status_value(row)
        if status in counts:
            counts[status] += 1
        elif not status:
            counts["blank"] += 1
        else:
            counts["other"] += 1
    return counts


def exclude_known_bad_sources(
    rows: list[dict[str, Any]],
    recording_ids: set[str],
    pieces: set[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not recording_ids and not pieces:
        return rows, []
    kept: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for row in rows:
        recording_id = safe_string(row.get("recordingId")).strip()
        piece = safe_string(row.get("piece")).strip()
        if recording_id in recording_ids or piece in pieces:
            excluded.append(row)
        else:
            kept.append(row)
    return kept, excluded


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_rows_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    headers = [
        "reviewRowNumber",
        "piece",
        "recordingId",
        "candidateId",
        "teacherCandidateStatus",
        "predictedUsableProbability",
        "selectedByThreshold",
        "modelName",
        "threshold",
        "measureIndex",
        "pageNumber",
        "midi",
        "predictedOnsetSeconds",
        "centsError",
        "pitchSupportWithin80Cents",
        "candidateRowsPath",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in headers})


def empty_report(args: argparse.Namespace, reason: str, blocking_reasons: list[str]) -> dict[str, Any]:
    return {
        "ok": True,
        "source": repo_relative(Path(args.reviews)),
        "sourceExists": Path(args.reviews).exists(),
        "labels": repo_relative(Path(args.labels)),
        "pilotJson": repo_relative(Path(args.pilot_json)),
        "blindValidationPassed": False,
        "readyForRuntimeGate": False,
        "reason": reason,
        "blockingReasons": blocking_reasons,
        "thresholds": {
            "minScoredRows": args.min_scored_rows,
            "minSelectedRows": args.min_selected_rows,
            "minPrecision": args.min_precision,
        },
        "counts": {
            "reviewedRows": 0,
            "scoredRows": 0,
            "usableRows": 0,
            "wrongRows": 0,
            "uncertainRows": 0,
            "blankRows": 0,
            "selectedRows": 0,
            "selectedScoredRows": 0,
            "selectedUsableRows": 0,
            "selectedWrongRows": 0,
        },
        "metrics": {
            "precision": None,
            "coverage": 0.0,
        },
    }


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    reviews_path = Path(args.reviews)
    labels_path = Path(args.labels)
    pilot_path = Path(args.pilot_json)
    if not reviews_path.exists():
        return empty_report(
            args,
            "confidence-validation-completed-csv-missing",
            ["confidence-validation-completed-csv-missing"],
        )
    raw_rows = read_csv_rows(reviews_path)
    exclude_recording_ids = {value.strip() for value in (args.exclude_recording_id or []) if value.strip()}
    exclude_pieces = {value.strip() for value in (args.exclude_piece or []) if value.strip()}
    rows, excluded_rows = exclude_known_bad_sources(raw_rows, exclude_recording_ids, exclude_pieces)
    status_counts = count_statuses(rows)
    reviewed_rows = [row for row in rows if status_value(row) in {"usable", "wrong", "uncertain"}]
    scored_rows = [row for row in rows if status_value(row) in LABEL_MAP]
    labels_numeric = np.array([LABEL_MAP[status_value(row)] for row in scored_rows], dtype=int)

    blocking_reasons: list[str] = []
    if len(reviewed_rows) < args.min_scored_rows:
        blocking_reasons.append("confidence-validation-reviewed-too-low")
    if len(scored_rows) < args.min_scored_rows:
        blocking_reasons.append("confidence-validation-scored-too-low")

    pilot = read_json(pilot_path)
    selected_model, selected_threshold, feature_set, group_by = select_model_from_pilot(pilot)
    model_name = args.model or selected_model
    threshold = args.threshold if args.threshold is not None else selected_threshold

    train_rows, train_labels, _ = load_dataset(labels_path)
    if len(set(train_labels.tolist())) < 2:
        blocking_reasons.append("confidence-validation-training-labels-one-class")
        selected_scored_rows: list[dict[str, Any]] = []
        evaluated_rows: list[dict[str, Any]] = []
    else:
        pipeline = make_pipeline(DEPLOYABLE_CATEGORICAL_FEATURES, model_name)
        pipeline.fit(pd.DataFrame(train_rows), train_labels)
        feature_rows = [build_feature_row(row) for row in scored_rows]
        probabilities = (
            pipeline.predict_proba(pd.DataFrame(feature_rows))[:, 1]
            if feature_rows
            else np.array([], dtype=float)
        )
        evaluated_rows = []
        for row, probability in zip(scored_rows, probabilities):
            selected = float(probability) >= threshold
            evaluated_rows.append({
                **row,
                "predictedUsableProbability": f"{float(probability):.6f}",
                "selectedByThreshold": "yes" if selected else "no",
                "modelName": model_name,
                "threshold": threshold,
            })
        selected_scored_rows = [
            row for row in evaluated_rows
            if row.get("selectedByThreshold") == "yes"
        ]

    selected_labels = [LABEL_MAP[status_value(row)] for row in selected_scored_rows]
    selected_count = len(selected_scored_rows)
    selected_usable = int(sum(selected_labels)) if selected_labels else 0
    selected_wrong = selected_count - selected_usable
    precision = selected_usable / selected_count if selected_count else None
    coverage = selected_count / len(scored_rows) if scored_rows else 0.0
    if selected_count < args.min_selected_rows:
        blocking_reasons.append("confidence-validation-selected-too-low")
    if precision is None:
        blocking_reasons.append("confidence-validation-no-selected-scored-rows")
    elif precision < args.min_precision:
        blocking_reasons.append("confidence-validation-precision-too-low")

    blind_validation_passed = not blocking_reasons
    rows_out_path = Path(args.rows_out) if args.rows_out else Path(args.out).with_name("confidence-validation-eval-rows.csv")
    if evaluated_rows:
        write_rows_csv(rows_out_path, evaluated_rows)
    report = {
        "ok": True,
        "source": repo_relative(reviews_path),
        "sourceExists": True,
        "labels": repo_relative(labels_path),
        "pilotJson": repo_relative(pilot_path),
        "rowsOut": repo_relative(rows_out_path),
        "modelName": model_name,
        "threshold": threshold,
        "featureSet": feature_set,
        "groupBy": group_by,
        "blindValidationPassed": blind_validation_passed,
        "readyForRuntimeGate": False,
        "reason": (
            "confidence-validation-passed-runtime-gate-still-disabled"
            if blind_validation_passed
            else "confidence-validation-not-ready"
        ),
        "blockingReasons": sorted(set(blocking_reasons)),
        "thresholds": {
            "minScoredRows": args.min_scored_rows,
            "minSelectedRows": args.min_selected_rows,
            "minPrecision": args.min_precision,
        },
        "counts": {
            "rawReviewedRows": len(raw_rows),
            "excludedRows": len(excluded_rows),
            "reviewedRows": len(reviewed_rows),
            "scoredRows": len(scored_rows),
            "usableRows": int(labels_numeric.sum()) if len(labels_numeric) else 0,
            "wrongRows": int(len(labels_numeric) - labels_numeric.sum()) if len(labels_numeric) else 0,
            "uncertainRows": status_counts["uncertain"],
            "blankRows": status_counts["blank"],
            "otherRows": status_counts["other"],
            "selectedRows": selected_count,
            "selectedScoredRows": selected_count,
            "selectedUsableRows": selected_usable,
            "selectedWrongRows": selected_wrong,
        },
        "statusCounts": status_counts,
        "metrics": {
            "precision": round(float(precision), 4) if precision is not None else None,
            "coverage": round(float(coverage), 4),
        },
        "excludedKnownBadSources": {
            "recordingIds": sorted(exclude_recording_ids),
            "pieces": sorted(exclude_pieces),
            "rows": len(excluded_rows),
        },
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a completed blind confidence-validation review CSV without merging it into training labels.")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--reviews", default=str(DEFAULT_COMPLETED))
    parser.add_argument("--pilot-json", default=str(DEFAULT_PILOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--rows-out", default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--exclude-recording-id", action="append", default=[])
    parser.add_argument("--exclude-piece", action="append", default=[])
    parser.add_argument("--min-scored-rows", type=int, default=30)
    parser.add_argument("--min-selected-rows", type=int, default=10)
    parser.add_argument("--min-precision", type=float, default=0.9)
    parser.add_argument("--fail-on-not-ready", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_path = Path(args.out)
    report = evaluate(args)
    write_json(out_path, report)
    print(json.dumps({
        "ok": report["ok"],
        "blindValidationPassed": report["blindValidationPassed"],
        "readyForRuntimeGate": report["readyForRuntimeGate"],
        "reason": report["reason"],
        "blockingReasons": report["blockingReasons"],
        "counts": report["counts"],
        "metrics": report["metrics"],
        "out": repo_relative(out_path),
    }, ensure_ascii=False, indent=2))
    if args.fail_on_not_ready and not report["blindValidationPassed"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
