# -*- coding: utf-8 -*-
"""Export a fresh blind-review candidate list for the ordinary-upload confidence pilot.

This is eval-only. It trains the selected confidence model on already reviewed
``usable``/``wrong`` labels, scores unreviewed candidates from the latest offline
feature batch, and writes a selection file that the HTML review exporter can use.
It does not wire or alter any runtime student gate.
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

import pandas as pd

from eval_western_controlled_candidate_confidence import (
    DEPLOYABLE_CATEGORICAL_FEATURES,
    build_feature_row,
    load_dataset,
    make_pipeline,
    read_csv_rows,
    safe_string,
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
    / "offline-feature-candidate-review"
    / "candidate-confidence-validation-selection.json"
)


def repo_relative(path: Path) -> str:
    return str(path.resolve().relative_to(REPO)).replace("\\", "/")


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def candidate_key(row: dict[str, Any]) -> str:
    return "::".join([
        safe_string(row.get("batchRunId")),
        safe_string(row.get("submissionId")),
        safe_string(row.get("candidateId")),
    ])


def select_model_from_pilot(pilot: dict[str, Any]) -> tuple[str, float, str, str]:
    release_floor = (pilot.get("recommendation") or {}).get("releaseFloor") or {}
    required_feature_set = release_floor.get("featureSet") or "deployable"
    required_group_by = release_floor.get("groupBy") or "recordingId"
    candidates: list[dict[str, Any]] = []
    for evaluation in pilot.get("evaluations") or []:
        if evaluation.get("featureSet") != required_feature_set:
            continue
        if evaluation.get("groupBy") != required_group_by:
            continue
        for model_name, model in (evaluation.get("models") or {}).items():
            release_candidate = model.get("releaseCandidate")
            if not release_candidate:
                continue
            candidates.append({
                "modelName": model_name,
                "featureSet": evaluation.get("featureSet"),
                "groupBy": evaluation.get("groupBy"),
                **release_candidate,
            })
    if not candidates:
        raise SystemExit("No deployable release candidate found in confidence pilot JSON.")
    candidates.sort(
        key=lambda item: (
            float(item.get("precision") or 0.0),
            int(item.get("selected") or 0),
            str(item.get("modelName") or ""),
        ),
        reverse=True,
    )
    best = candidates[0]
    return (
        str(best["modelName"]),
        float(best["threshold"]),
        str(best["featureSet"]),
        str(best["groupBy"]),
    )


def reviewed_keys(labels_path: Path) -> set[str]:
    keys: set[str] = set()
    for row in read_csv_rows(labels_path):
        status = safe_string(row.get("teacherCandidateStatus")).strip().lower()
        if status not in {"usable", "wrong", "uncertain"}:
            continue
        key = candidate_key(row)
        if key.replace(":", ""):
            keys.add(key)
    return keys


def latest_valid_run(batch_runs_path: Path) -> dict[str, Any] | None:
    valid = [row for row in read_jsonl(batch_runs_path) if not row.get("_invalidJsonLine")]
    return valid[-1] if valid else None


def collect_unreviewed_candidates(batch_runs_path: Path, labels_path: Path) -> list[dict[str, Any]]:
    run = latest_valid_run(batch_runs_path)
    if not run:
        return []
    seen_reviewed = reviewed_keys(labels_path)
    rows: list[dict[str, Any]] = []
    for item in run.get("items") or []:
        if item.get("analysisStatus") != "offline_feature_review_ready":
            continue
        candidate_rows_path = safe_string(item.get("candidateRowsPath"))
        if not candidate_rows_path:
            continue
        artifact_path = (REPO / candidate_rows_path).resolve()
        artifact = read_json(artifact_path)
        for candidate in artifact.get("candidateRows") or []:
            row = {
                **candidate,
                "reviewRowNumber": len(rows) + 1,
                "batchRunId": safe_string(run.get("batchRunId")),
                "submissionId": safe_string(item.get("submissionId")),
                "scoreId": safe_string(item.get("scoreId")),
                "piece": safe_string(item.get("piece")),
                "recordingId": safe_string(item.get("recordingId")),
                "audioName": safe_string((item.get("audioSubmission") or {}).get("name")),
                "audioHash": safe_string(item.get("audioHash")),
                "candidateRowsPath": repo_relative(artifact_path),
                "candidateId": safe_string(candidate.get("candidateId")),
                "pitchSupportWithin80Cents": (
                    "yes" if candidate.get("pitchSupportWithin80Cents") is True else "no"
                ),
                "teacherCandidateStatus": "",
                "teacherCorrectOnsetSeconds": "",
                "teacherCorrectMeasureIndex": "",
                "teacherComments": "",
            }
            if candidate_key(row) in seen_reviewed:
                continue
            rows.append(row)
    return rows


def round_robin_top(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or len(rows) <= limit:
        return rows
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(safe_string(row.get("submissionId")) or "unknown-submission", []).append(row)
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


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    headers = [
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
    parser = argparse.ArgumentParser(description="Export confidence-model-selected candidates for fresh blind review.")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--batch-runs", default=str(DEFAULT_BATCH_RUNS))
    parser.add_argument("--pilot-json", default=str(DEFAULT_PILOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--model", default="")
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--limit", type=int, default=30)
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
    pipeline = make_pipeline(DEPLOYABLE_CATEGORICAL_FEATURES, model_name)
    pipeline.fit(pd.DataFrame(train_rows), labels)

    candidates = collect_unreviewed_candidates(batch_runs_path, labels_path)
    feature_rows = [build_feature_row(row) for row in candidates]
    if feature_rows:
        probabilities = pipeline.predict_proba(pd.DataFrame(feature_rows))[:, 1]
    else:
        probabilities = []

    scored: list[dict[str, Any]] = []
    for row, probability in zip(candidates, probabilities):
        enriched = {
            **row,
            "confidenceProbability": round(float(probability), 6),
            "confidenceModelName": model_name,
            "confidenceThreshold": threshold,
            "confidenceFeatureSet": feature_set,
            "confidenceGroupBy": group_by,
        }
        if probability >= threshold:
            scored.append(enriched)
    scored.sort(key=lambda row: float(row.get("confidenceProbability") or 0.0), reverse=True)
    selected = round_robin_top(scored, args.limit)

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
        "candidateCount": len(candidates),
        "selectedAboveThresholdCount": len(scored),
        "rowCount": len(selected),
        "sampleLimit": args.limit,
        "rows": selected,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(csv_path, selected)
    print(json.dumps({
        "ok": True,
        "modelName": model_name,
        "threshold": threshold,
        "candidateCount": len(candidates),
        "selectedAboveThresholdCount": len(scored),
        "rowCount": len(selected),
        "out": repo_relative(out_path),
        "csv": repo_relative(csv_path),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
