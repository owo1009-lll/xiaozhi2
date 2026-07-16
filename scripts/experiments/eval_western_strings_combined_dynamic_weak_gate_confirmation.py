#!/usr/bin/env python3
"""Confirm a wider M3 candidate gate on a fresh public-performer rank.

The energy classifiers are fit on the development performer only. Dynamic
thresholds are selected using development plus the already-consumed rank-0
holdout. Rank-1 recordings that overlap rank 0 are removed before the final
confirmation is evaluated once.
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


REPO = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import eval_western_bach_violin_weak_note_gate as weak  # noqa: E402
import eval_western_strings_combined_dynamic_weak_gate as combined  # noqa: E402
import eval_western_strings_dynamic_perturbation_gate as dynamic  # noqa: E402
from eval_western_bach_violin_basic_pitch_transcription import load_reference_rows  # noqa: E402
from eval_western_bach_violin_error_perturbations import (  # noqa: E402
    DEVELOPMENT_SPLIT,
    HOLDOUT_SPLIT,
)
from eval_western_bach_violin_raw_audio_perturbations import (  # noqa: E402
    add_gold_offsets,
    read_candidate_rows,
    select_split_units,
)


DEFAULT_CONFIRMATION_DIR = (
    REPO
    / "data/experiments/western-strings-bach-violin-raw-audio-perturbations-confirmation-rank1"
)
DEFAULT_OUT = (
    REPO
    / "data/experiments/western-strings-m3/dynamic-weak-combined-gate-confirmation/report.json"
)
MIN_SAME_PITCH_SCORE_DISTANCE_QUARTERS = 0.5
MIN_CONFIRMATION_UNITS = 4
MIN_CONFIRMATION_TARGETS = 30
MIN_PRECISION = 0.90
MIN_COVERAGE = 0.20


def compact_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    compact = dict(metrics)
    compact.pop("unsafeTargets", None)
    return compact


def filter_fold_units(fold: dict[str, Any], included_units: set[str]) -> dict[str, Any]:
    mask = np.asarray([str(unit) in included_units for unit, _ in fold["keys"]], dtype=bool)
    return {
        **fold,
        "keys": [key for key, keep in zip(fold["keys"], mask) if keep],
        "cleanFeatures": fold["cleanFeatures"][mask],
        "weakFeatures": fold["weakFeatures"][mask],
        "dynamicRows": {
            scenario: [row for row in rows if str(row["unit"]) in included_units]
            for scenario, rows in fold["dynamicRows"].items()
        },
    }


def fit_energy_models(
    examples: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, float]]:
    features = np.asarray([row["features"] for row in examples], dtype=np.float64)
    labels = np.asarray([row["label"] for row in examples], dtype=np.int64)
    models: dict[str, Any] = {}
    thresholds: dict[str, float] = {}
    for model_name, model in weak.build_models().items():
        model.fit(features, labels)
        selected = weak.choose_zero_unsafe_threshold(
            examples,
            model.predict_proba(features)[:, 1],
        )
        if selected is None:
            continue
        models[model_name] = model
        thresholds[model_name] = float(selected["threshold"])
    if not models:
        raise RuntimeError("development-energy-models-not-evaluable")
    return models, thresholds


def fold_probabilities(
    fold: dict[str, Any],
    models: dict[str, Any],
    thresholds: dict[str, float],
) -> tuple[dict[tuple[str, int], float], dict[tuple[str, int], float]]:
    clean_by_model = {
        name: dict(zip(fold["keys"], model.predict_proba(fold["cleanFeatures"])[:, 1]))
        for name, model in models.items()
    }
    weak_by_model = {
        name: dict(zip(fold["keys"], model.predict_proba(fold["weakFeatures"])[:, 1]))
        for name, model in models.items()
    }
    return (
        combined.intersection_probabilities(fold["keys"], clean_by_model, thresholds),
        combined.intersection_probabilities(fold["keys"], weak_by_model, thresholds),
    )


def evaluate_policy(
    fold: dict[str, Any],
    probabilities: tuple[dict[tuple[str, int], float], dict[tuple[str, int], float]],
    point: dict[str, Any],
) -> dict[str, Any]:
    return combined.evaluate_point(
        fold["dynamicRows"],
        probabilities[0],
        probabilities[1],
        point,
        0.5,
    )


def policy_is_safe(metrics: dict[str, Any]) -> bool:
    clean = metrics["clean"]
    return bool(
        clean["selectedCount"] >= 30
        and clean["precisionWithin300ms"] is not None
        and clean["precisionWithin300ms"] >= MIN_PRECISION
        and metrics["allErrorUnsafeTargetAutoPassCount"] == 0
    )


def choose_joint_policy(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [
        candidate
        for candidate in candidates
        if policy_is_safe(candidate["development"])
        and policy_is_safe(candidate["selection"])
    ]
    if not eligible:
        return None
    return max(
        eligible,
        key=lambda candidate: (
            min(
                candidate["development"]["clean"]["coverage"],
                candidate["selection"]["clean"]["coverage"],
            ),
            (
                candidate["development"]["clean"]["coverage"]
                + candidate["selection"]["clean"]["coverage"]
            )
            / 2.0,
        ),
    )


def confirmation_passed(metrics: dict[str, Any], unit_count: int) -> bool:
    clean = metrics["clean"]
    return bool(
        unit_count >= MIN_CONFIRMATION_UNITS
        and clean["targetCount"] >= MIN_CONFIRMATION_TARGETS
        and clean["selectedCount"] >= 30
        and clean["precisionWithin300ms"] is not None
        and clean["precisionWithin300ms"] >= MIN_PRECISION
        and clean["coverage"] >= MIN_COVERAGE
        and metrics["allErrorUnsafeTargetAutoPassCount"] == 0
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirmation-dir", default=str(DEFAULT_CONFIRMATION_DIR))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    confirmation_dir = Path(args.confirmation_dir).resolve()
    raw_report_path = confirmation_dir / "report.json"
    if not raw_report_path.is_file():
        raise RuntimeError("rank1-confirmation-raw-report-missing")
    raw_report = dynamic.load_json(raw_report_path)
    if int(raw_report.get("selectionRank", -1)) != 1:
        raise RuntimeError("rank1-confirmation-provenance-missing")

    audit = dynamic.load_json(dynamic.DEFAULT_AUDIT)
    recognition = dynamic.load_json(dynamic.DEFAULT_RECOGNITION)
    event_gate = dynamic.load_json(dynamic.DEFAULT_EVENT_GATE)
    all_rows = read_candidate_rows(dynamic.DEFAULT_ROWS)
    add_gold_offsets(
        all_rows,
        load_reference_rows(dynamic.REPO / str(audit["datasetRoot"])),
    )

    out = Path(args.out).resolve()
    cache_dir = out.parent / "feature-cache"
    development = combined.build_fold(
        DEVELOPMENT_SPLIT,
        dynamic.DEFAULT_DEVELOPMENT,
        cache_dir,
        audit,
        recognition,
        event_gate,
        all_rows,
    )
    selection = combined.build_fold(
        HOLDOUT_SPLIT,
        dynamic.DEFAULT_HOLDOUT,
        cache_dir,
        audit,
        recognition,
        event_gate,
        all_rows,
    )
    confirmation_all = combined.build_fold(
        HOLDOUT_SPLIT,
        confirmation_dir,
        cache_dir,
        audit,
        recognition,
        event_gate,
        all_rows,
        selection_rank=1,
    )

    rank0_units = {
        str(row["unit"])
        for row in select_split_units(audit["rows"], HOLDOUT_SPLIT, 0)
    }
    rank1_units = {
        str(row["unit"])
        for row in select_split_units(audit["rows"], HOLDOUT_SPLIT, 1)
    }
    fresh_units = rank1_units - rank0_units
    confirmation = filter_fold_units(confirmation_all, fresh_units)

    examples = weak.load_split_examples(
        DEVELOPMENT_SPLIT,
        audit,
        recognition,
        event_gate,
        weak.DEFAULT_ROWS,
        weak.DEFAULT_DEVELOPMENT_RAW,
    )
    models, energy_thresholds = fit_energy_models(examples)
    development_probabilities = fold_probabilities(
        development, models, energy_thresholds
    )
    selection_probabilities = fold_probabilities(selection, models, energy_thresholds)
    confirmation_probabilities = fold_probabilities(
        confirmation, models, energy_thresholds
    )

    candidates = []
    for values in itertools.product(
        dynamic.THRESHOLD_GRID,
        dynamic.EVENT_CONFIDENCE_GRID,
        dynamic.RELATIVE_EVENT_CONFIDENCE_GRID,
        dynamic.MIN_EVENT_DURATION_GRID,
    ):
        point = {
            "deviationLimit": values[0],
            "minEventConfidence": values[1],
            "minRelativeEventConfidence": values[2],
            "minEventDurationSeconds": values[3],
            "minSamePitchScoreDistanceQuarters": MIN_SAME_PITCH_SCORE_DISTANCE_QUARTERS,
        }
        candidates.append(
            {
                "point": point,
                "development": evaluate_policy(
                    development, development_probabilities, point
                ),
                "selection": evaluate_policy(
                    selection, selection_probabilities, point
                ),
            }
        )

    selected = choose_joint_policy(candidates)
    confirmation_metrics = (
        evaluate_policy(
            confirmation,
            confirmation_probabilities,
            selected["point"],
        )
        if selected is not None
        else None
    )
    passed = bool(
        confirmation_metrics is not None
        and confirmation_passed(confirmation_metrics, len(fresh_units))
    )
    report = {
        "ok": True,
        "evidenceType": "three-stage-public-waveform-perturbation-confirmation",
        "method": "joint-dynamic-energy-gate-with-score-pitch-isolation",
        "selectionDiscipline": {
            "energyModelFit": "development-reference-performer-only",
            "dynamicPolicySelection": "development-plus-consumed-rank0-holdout",
            "finalConfirmation": "rank1-minus-all-rank0-overlap-evaluated-once",
        },
        "thresholds": {
            "minPrecision": MIN_PRECISION,
            "minCoverage": MIN_COVERAGE,
            "minConfirmationUnits": MIN_CONFIRMATION_UNITS,
            "minConfirmationTargets": MIN_CONFIRMATION_TARGETS,
            "minSamePitchScoreDistanceQuarters": MIN_SAME_PITCH_SCORE_DISTANCE_QUARTERS,
        },
        "evaluatedPointCount": len(candidates),
        "eligibleSelectionPointCount": sum(
            policy_is_safe(candidate["development"])
            and policy_is_safe(candidate["selection"])
            for candidate in candidates
        ),
        "energyThresholds": energy_thresholds,
        "selectedPolicy": selected["point"] if selected is not None else None,
        "development": (
            {
                "clean": compact_metrics(selected["development"]["clean"]),
                "weakNote": compact_metrics(selected["development"]["weakNote"]),
                "coreScenarios": selected["development"]["coreScenarios"],
                "allErrorUnsafeTargetAutoPassCount": selected["development"][
                    "allErrorUnsafeTargetAutoPassCount"
                ],
            }
            if selected is not None
            else None
        ),
        "selectionRank0": (
            {
                "clean": compact_metrics(selected["selection"]["clean"]),
                "weakNote": compact_metrics(selected["selection"]["weakNote"]),
                "coreScenarios": selected["selection"]["coreScenarios"],
                "allErrorUnsafeTargetAutoPassCount": selected["selection"][
                    "allErrorUnsafeTargetAutoPassCount"
                ],
            }
            if selected is not None
            else None
        ),
        "confirmationRank1": (
            {
                "rank1Units": sorted(rank1_units),
                "excludedOverlapUnits": sorted(rank1_units & rank0_units),
                "freshUnits": sorted(fresh_units),
                "clean": compact_metrics(confirmation_metrics["clean"]),
                "weakNote": compact_metrics(confirmation_metrics["weakNote"]),
                "coreScenarios": confirmation_metrics["coreScenarios"],
                "allErrorUnsafeTargetAutoPassCount": confirmation_metrics[
                    "allErrorUnsafeTargetAutoPassCount"
                ],
            }
            if confirmation_metrics is not None
            else None
        ),
        "freshPublicSyntheticConfirmationReady": passed,
        "releaseCoverageReady": passed,
        "studentGateReady": False,
        "blockingReasons": [
            *([] if selected is not None else ["joint-selection-policy-not-found"]),
            *([] if passed else ["fresh-public-confirmation-gate-failed"]),
            "public-reference-times-are-estimated-not-human-note-level-truth",
            "waveform-errors-are-synthetic-not-real-student-errors",
            "independent-student-note-level-validation-required",
        ],
        "limitations": [
            "score-pitch-isolation sends close repeated pitches to review instead of auto-pass",
            "confirmation recordings are public professional performances",
            "the result validates a research gate, not the default student runtime",
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
