from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import pandas as pd

from eval_western_controlled_candidate_confidence import (
    DEPLOYABLE_CATEGORICAL_FEATURES,
    build_feature_row,
    load_dataset,
)
from export_western_controlled_confidence_validation_batch import (
    collect_unreviewed_candidates,
    repo_relative,
    select_model_from_pilot,
)


REPO = Path(__file__).resolve().parents[2]
DEFAULT_LABELS = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "controlled-candidate-review-labels.csv"
)
DEFAULT_BATCH_RUNS = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "controlled-submission-batch-runs.jsonl"
)
DEFAULT_PILOT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "candidate-confidence-pilot.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-threshold-pool-review"
    / "candidate-confidence-threshold-pool-selection.json"
)


STRATA = [
    ("high", 0.90, 1.01),
    ("above-threshold", 0.70, 0.90),
    ("near-threshold", 0.50, 0.70),
    ("low", 0.00, 0.50),
]


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def stratum_for_probability(probability: float) -> str:
    for name, low, high in STRATA:
        if low <= probability < high:
            return name
    return "low"


def target_counts(total_limit: int) -> dict[str, int]:
    # Keep enough high/above-threshold rows to estimate release safety, while
    # deliberately sampling near/below threshold rows so validation coverage is
    # not confused with a prefiltered-only review batch.
    weights = {
        "high": 0.25,
        "above-threshold": 0.35,
        "near-threshold": 0.25,
        "low": 0.15,
    }
    counts = {name: int(total_limit * weight) for name, weight in weights.items()}
    remaining = total_limit - sum(counts.values())
    for name in ["above-threshold", "near-threshold", "high", "low"]:
        if remaining <= 0:
            break
        counts[name] += 1
        remaining -= 1
    return counts


def round_robin_by_submission(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or len(rows) <= limit:
        return rows
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row.get("submissionId") or "unknown-submission")].append(row)
    for group_rows in groups.values():
        group_rows.sort(key=lambda row: float(row.get("confidenceProbability") or 0.0), reverse=True)
    selected: list[dict[str, Any]] = []
    cursor = 0
    group_values = list(groups.values())
    while len(selected) < limit:
        added = False
        for group_rows in group_values:
            if cursor < len(group_rows):
                selected.append(group_rows[cursor])
                added = True
                if len(selected) >= limit:
                    break
        if not added:
            break
        cursor += 1
    return selected


def rebalance_with_backfill(
    by_stratum: dict[str, list[dict[str, Any]]],
    counts: dict[str, int],
    limit: int,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    selected_keys: set[str] = set()
    for name, _, _ in STRATA:
        picked = round_robin_by_submission(by_stratum.get(name, []), counts.get(name, 0))
        selected.extend(picked)
        selected_keys.update(str(row.get("_selectionKey")) for row in picked)
    if len(selected) < limit:
        leftovers = [
            row
            for name, _, _ in STRATA
            for row in by_stratum.get(name, [])
            if str(row.get("_selectionKey")) not in selected_keys
        ]
        leftovers.sort(key=lambda row: float(row.get("confidenceProbability") or 0.0), reverse=True)
        selected.extend(leftovers[: max(0, limit - len(selected))])
    selected.sort(key=lambda row: (
        str(row.get("confidenceStratum") or ""),
        str(row.get("submissionId") or ""),
        -float(row.get("confidenceProbability") or 0.0),
    ))
    for index, row in enumerate(selected, start=1):
        row["reviewRowNumber"] = index
    return selected[:limit]


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    headers = [
        "confidenceStratum",
        "batchRunId",
        "submissionId",
        "candidateId",
        "confidenceProbability",
        "confidenceModelName",
        "confidenceThreshold",
        "piece",
        "recordingId",
        "measureIndex",
        "pageNumber",
        "midi",
        "predictedOnsetSeconds",
        "candidateRowsPath",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in headers})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a stratified confidence-threshold review selection.")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--batch-runs", default=str(DEFAULT_BATCH_RUNS))
    parser.add_argument("--pilot-json", default=str(DEFAULT_PILOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("--model", default="")
    parser.add_argument("--threshold", type=float, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    labels_path = Path(args.labels)
    batch_runs_path = Path(args.batch_runs)
    pilot_path = Path(args.pilot_json)
    out_path = Path(args.out)
    pilot = read_json(pilot_path)
    selected_model, selected_threshold, feature_set, group_by = select_model_from_pilot(pilot)
    model_name = args.model or selected_model
    threshold = args.threshold if args.threshold is not None else selected_threshold

    train_rows, labels, _ = load_dataset(labels_path)
    if len(set(labels.tolist())) < 2:
        raise SystemExit("Need both usable and wrong labels to train confidence model.")
    from eval_western_controlled_candidate_confidence import make_pipeline

    pipeline = make_pipeline(DEPLOYABLE_CATEGORICAL_FEATURES, model_name)
    pipeline.fit(pd.DataFrame(train_rows), labels)

    candidates = collect_unreviewed_candidates(batch_runs_path, labels_path)
    feature_rows = [build_feature_row(row) for row in candidates]
    probabilities = pipeline.predict_proba(pd.DataFrame(feature_rows))[:, 1] if feature_rows else []

    by_stratum: dict[str, list[dict[str, Any]]] = defaultdict(list)
    all_scored: list[dict[str, Any]] = []
    for row_index, (row, probability) in enumerate(zip(candidates, probabilities), start=1):
        probability_value = float(probability)
        stratum = stratum_for_probability(probability_value)
        enriched = {
            **row,
            "_selectionKey": f"{row.get('batchRunId')}::{row.get('submissionId')}::{row.get('candidateId')}::{row_index}",
            "confidenceProbability": round(probability_value, 6),
            "confidenceModelName": model_name,
            "confidenceThreshold": threshold,
            "confidenceFeatureSet": feature_set,
            "confidenceGroupBy": group_by,
            "confidenceStratum": stratum,
            "teacherCandidateStatus": "",
            "teacherCorrectOnsetSeconds": "",
            "teacherCorrectMeasureIndex": "",
            "teacherComments": "",
        }
        by_stratum[stratum].append(enriched)
        all_scored.append(enriched)

    for rows in by_stratum.values():
        rows.sort(key=lambda row: float(row.get("confidenceProbability") or 0.0), reverse=True)

    limit = max(0, int(args.limit))
    counts = target_counts(limit)
    selected = rebalance_with_backfill(by_stratum, counts, limit)
    for row in selected:
        row.pop("_selectionKey", None)

    pool_counts = Counter(row["confidenceStratum"] for row in all_scored)
    selected_counts = Counter(row["confidenceStratum"] for row in selected)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path = out_path.with_suffix(".csv")
    out_path.write_text(json.dumps({
        "ok": True,
        "source": repo_relative(batch_runs_path),
        "labels": repo_relative(labels_path),
        "pilotJson": repo_relative(pilot_path),
        "modelName": model_name,
        "threshold": threshold,
        "featureSet": feature_set,
        "groupBy": group_by,
        "candidateCount": len(all_scored),
        "selectedAboveThresholdCount": int(sum(1 for row in all_scored if float(row.get("confidenceProbability") or 0.0) >= threshold)),
        "thresholdPoolCoverage": round(
            sum(1 for row in all_scored if float(row.get("confidenceProbability") or 0.0) >= threshold) / len(all_scored),
            6,
        ) if all_scored else 0.0,
        "strata": [
            {
                "name": name,
                "lowInclusive": low,
                "highExclusive": high,
                "poolCount": int(pool_counts.get(name, 0)),
                "targetCount": int(counts.get(name, 0)),
                "selectedCount": int(selected_counts.get(name, 0)),
            }
            for name, low, high in STRATA
        ],
        "rowCount": len(selected),
        "sampleLimit": limit,
        "selectionPurpose": "threshold-pool-stratified-review",
        "rows": selected,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(csv_path, selected)
    print(json.dumps({
        "ok": True,
        "out": repo_relative(out_path),
        "csv": repo_relative(csv_path),
        "candidateCount": len(all_scored),
        "selectedAboveThresholdCount": int(sum(1 for row in all_scored if float(row.get("confidenceProbability") or 0.0) >= threshold)),
        "thresholdPoolCoverage": round(
            sum(1 for row in all_scored if float(row.get("confidenceProbability") or 0.0) >= threshold) / len(all_scored),
            6,
        ) if all_scored else 0.0,
        "rowCount": len(selected),
        "selectedStrata": dict(sorted(selected_counts.items())),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
