# -*- coding: utf-8 -*-
"""Score ordinary-upload candidate rows with the validated confidence model.

This is the runtime-facing companion to the eval-only confidence pilot. It
trains the release-selected model from the cumulative reviewed labels and scores
new candidate rows produced by the offline feature analyzer. The caller decides
whether the resulting probabilities may be used for student-facing auto-pass.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pandas as pd

from eval_western_controlled_candidate_confidence import (
    DEPLOYABLE_CATEGORICAL_FEATURES,
    build_feature_row,
    load_dataset,
    make_pipeline,
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
DEFAULT_VALIDATION = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-validation-review"
    / "confidence-validation-eval.json"
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def normalize_candidate(row: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    normalized = {**context, **row}
    pitch_support = row.get("pitchSupportWithin80Cents")
    if isinstance(pitch_support, bool):
        normalized["pitchSupportWithin80Cents"] = "yes" if pitch_support else "no"
    return normalized


def load_candidate_rows(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    payload = read_json(path)
    if isinstance(payload, list):
        return payload, {}
    rows = payload.get("candidateRows") if isinstance(payload.get("candidateRows"), list) else []
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    return rows, context


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score ordinary-upload candidate rows with the validated confidence model.")
    parser.add_argument("--input", required=True, help="JSON file with candidateRows or a raw candidate row array.")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--pilot-json", default=str(DEFAULT_PILOT))
    parser.add_argument("--validation-json", default=str(DEFAULT_VALIDATION))
    parser.add_argument("--model", default="")
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--require-validation-pass", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    labels_path = Path(args.labels)
    pilot_path = Path(args.pilot_json)
    validation_path = Path(args.validation_json)

    validation = read_json(validation_path) if validation_path.exists() else {}
    if args.require_validation_pass and validation.get("blindValidationPassed") is not True:
        print(json.dumps({
            "ok": False,
            "reason": "confidence-validation-not-passed",
            "validation": repo_relative(validation_path),
            "rows": [],
        }, ensure_ascii=False))
        return 0

    pilot = read_json(pilot_path)
    selected_model, selected_threshold, feature_set, group_by = select_model_from_pilot(pilot)
    model_name = args.model or selected_model
    threshold = args.threshold if args.threshold is not None else selected_threshold

    train_rows, train_labels, _ = load_dataset(labels_path)
    if len(set(train_labels.tolist())) < 2:
        print(json.dumps({
            "ok": False,
            "reason": "confidence-training-labels-one-class",
            "rows": [],
        }, ensure_ascii=False))
        return 0

    candidate_rows, context = load_candidate_rows(input_path)
    normalized_rows = [normalize_candidate(row, context) for row in candidate_rows]
    pipeline = make_pipeline(DEPLOYABLE_CATEGORICAL_FEATURES, model_name)
    pipeline.fit(pd.DataFrame(train_rows), train_labels)
    feature_rows = [build_feature_row(row) for row in normalized_rows]
    probabilities = pipeline.predict_proba(pd.DataFrame(feature_rows))[:, 1] if feature_rows else []

    scored_rows = []
    auto_pass_count = 0
    for row, probability in zip(candidate_rows, probabilities):
        probability_value = float(probability)
        selected = probability_value >= threshold
        if selected:
            auto_pass_count += 1
        scored_rows.append({
            **row,
            "confidenceProbability": round(probability_value, 6),
            "confidenceModelName": model_name,
            "confidenceThreshold": threshold,
            "confidenceFeatureSet": feature_set,
            "confidenceGroupBy": group_by,
            "confidenceSelected": selected,
        })

    print(json.dumps({
        "ok": True,
        "input": repo_relative(input_path),
        "labels": repo_relative(labels_path),
        "pilotJson": repo_relative(pilot_path),
        "validationJson": repo_relative(validation_path),
        "modelName": model_name,
        "threshold": threshold,
        "featureSet": feature_set,
        "groupBy": group_by,
        "candidateCount": len(candidate_rows),
        "autoPassCandidateCount": auto_pass_count,
        "reviewRequiredCandidateCount": max(0, len(candidate_rows) - auto_pass_count),
        "rows": scored_rows,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
