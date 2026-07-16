#!/usr/bin/env python3
"""Measure-level upper-bound audit for joint pitch, IOI, and energy evidence.

This is eval-only. It reuses the frozen three-stage dynamic/weak-note gate and
asks whether any runtime-visible measure rule can reach 20% clean coverage
while producing zero unsafe target-measure passes on every evaluated fold.
Thresholds are swept across all folds only to estimate an oracle upper bound;
the selected row must never be treated as a deployable policy.
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import eval_western_bach_violin_measure_policy as measure_policy  # noqa: E402
import eval_western_bach_violin_weak_note_gate as weak  # noqa: E402
import eval_western_strings_combined_dynamic_weak_gate as combined  # noqa: E402
import eval_western_strings_combined_dynamic_weak_gate_confirmation as confirmation  # noqa: E402
import eval_western_strings_dynamic_perturbation_gate as dynamic  # noqa: E402
from eval_western_bach_violin_basic_pitch_transcription import load_reference_rows  # noqa: E402
from eval_western_bach_violin_error_perturbations import (  # noqa: E402
    DEVELOPMENT_SPLIT,
    HOLDOUT_SPLIT,
)
from eval_western_bach_violin_raw_audio_perturbations import (  # noqa: E402
    SCENARIOS,
    add_gold_offsets,
    read_candidate_rows,
    select_split_units,
)


DEFAULT_CONFIRMATION_REPORT = (
    REPO
    / "data/experiments/western-strings-m3"
    / "dynamic-weak-combined-gate-confirmation/report.json"
)
DEFAULT_OUT = (
    REPO
    / "data/experiments/western-strings-m3"
    / "measure-joint-evidence-audit"
)
NOTE_CONFIRMED_THRESHOLDS = (0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00)
IOI_CONSISTENCY_THRESHOLDS = (0.50, 0.60, 0.70, 0.80, 0.90, 1.00)
ENERGY_SUPPORT_THRESHOLDS = (0.70, 0.80, 0.90, 1.00)
MIN_RELEASE_COVERAGE = 0.20
ENERGY_ACCEPT_VALUE = 0.50


def _score_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def build_measure_lookup(
    audit: dict[str, Any],
    all_rows: list[dict[str, Any]],
) -> tuple[dict[tuple[str, int], int], set[tuple[str, int]]]:
    source_by_unit = {str(row["unit"]): row for row in audit["rows"]}
    intervals = {
        unit: measure_policy.score_measure_intervals(_score_path(str(source["scorePath"])))
        for unit, source in source_by_unit.items()
    }
    by_unit: dict[str, list[tuple[str, int]]] = defaultdict(list)
    lookup: dict[tuple[str, int], int] = {}
    for row in all_rows:
        key = (str(row["unit"]), int(row["noteIndex"]))
        measure = measure_policy.assign_measure(float(row["scoreTime"]), intervals[key[0]])
        if measure <= 0:
            raise ValueError(f"score-time-to-measure-unmapped:{key[0]}:{key[1]}")
        lookup[key] = measure
        by_unit[key[0]].append(key)

    ioi_opportunities: set[tuple[str, int]] = set()
    for keys in by_unit.values():
        ordered = sorted(keys, key=lambda item: item[1])
        ioi_opportunities.update(ordered[1:-1])
    return lookup, ioi_opportunities


def evaluate_measure_rows(
    rows: list[dict[str, Any]],
    *,
    measure_lookup: dict[tuple[str, int], int],
    ioi_opportunities: set[tuple[str, int]],
    dynamic_point: dict[str, Any],
    energy_probabilities: dict[tuple[str, int], float] | None,
    note_confirmed_threshold: float,
    ioi_consistency_threshold: float,
    energy_support_threshold: float,
) -> dict[str, Any]:
    """Evaluate one fold/scenario without using target labels in decisions."""

    grouped: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        key = (str(row["unit"]), int(row["noteIndex"]))
        grouped[(key[0], measure_lookup[key])].append(row)

    passed: set[tuple[str, int]] = set()
    target_measures: set[tuple[str, int]] = set()
    compact_rows = []
    for measure_key, measure_rows in sorted(grouped.items()):
        note_count = len(measure_rows)
        confirmed = 0
        energy_supported = 0
        ioi_ready = 0
        ioi_opportunity_count = 0
        explicit_pitch_conflict = False
        for row in measure_rows:
            key = (str(row["unit"]), int(row["noteIndex"]))
            energy_ready = (
                energy_probabilities is None
                or energy_probabilities.get(key, -1.0) >= ENERGY_ACCEPT_VALUE
            )
            if energy_ready:
                energy_supported += 1
            if combined.dynamic_selected(row, dynamic_point) and energy_ready:
                confirmed += 1
            if key in ioi_opportunities:
                ioi_opportunity_count += 1
                deviation = row.get("relativeIoiDeviationRatio")
                if deviation is not None and float(deviation) <= float(dynamic_point["deviationLimit"]):
                    ioi_ready += 1
            pitch_distance = row.get("pitchDistanceSemitones")
            if pitch_distance is not None and int(pitch_distance) != 0:
                explicit_pitch_conflict = True

        confirmed_fraction = confirmed / note_count if note_count else 0.0
        energy_fraction = energy_supported / note_count if note_count else 0.0
        ioi_fraction = ioi_ready / ioi_opportunity_count if ioi_opportunity_count else 0.0
        auto_pass = bool(
            confirmed_fraction >= note_confirmed_threshold
            and ioi_fraction >= ioi_consistency_threshold
            and energy_fraction >= energy_support_threshold
            and not explicit_pitch_conflict
        )
        if auto_pass:
            passed.add(measure_key)
        if any(bool(row.get("target")) for row in measure_rows):
            target_measures.add(measure_key)
        compact_rows.append({
            "unit": measure_key[0],
            "measureIndex": measure_key[1],
            "noteCount": note_count,
            "confirmedFraction": round(confirmed_fraction, 6),
            "relativeIoiConsistencyFraction": round(ioi_fraction, 6),
            "energySupportFraction": round(energy_fraction, 6),
            "explicitPitchConflict": explicit_pitch_conflict,
            "autoPass": auto_pass,
        })

    unsafe = passed & target_measures
    return {
        "measureCount": len(grouped),
        "autoPassMeasureCount": len(passed),
        "autoPassMeasureCoverage": round(len(passed) / len(grouped), 6) if grouped else 0.0,
        "targetMeasureCount": len(target_measures),
        "unsafeTargetMeasureCount": len(unsafe),
        "unsafeTargetMeasures": [
            {"unit": unit, "measureIndex": measure}
            for unit, measure in sorted(unsafe)
        ],
        "rows": compact_rows,
    }


def evaluate_candidate(
    folds: dict[str, tuple[dict[str, Any], tuple[dict[tuple[str, int], float], dict[tuple[str, int], float]]]],
    *,
    measure_lookup: dict[tuple[str, int], int],
    ioi_opportunities: set[tuple[str, int]],
    dynamic_point: dict[str, Any],
    note_confirmed_threshold: float,
    ioi_consistency_threshold: float,
    energy_support_threshold: float,
) -> dict[str, Any]:
    fold_metrics = {}
    for fold_name, (fold, probabilities) in folds.items():
        clean = evaluate_measure_rows(
            fold["dynamicRows"]["clean"],
            measure_lookup=measure_lookup,
            ioi_opportunities=ioi_opportunities,
            dynamic_point=dynamic_point,
            energy_probabilities=probabilities[0],
            note_confirmed_threshold=note_confirmed_threshold,
            ioi_consistency_threshold=ioi_consistency_threshold,
            energy_support_threshold=energy_support_threshold,
        )
        scenarios = {}
        for scenario in SCENARIOS:
            scenarios[scenario] = evaluate_measure_rows(
                fold["dynamicRows"][scenario],
                measure_lookup=measure_lookup,
                ioi_opportunities=ioi_opportunities,
                dynamic_point=dynamic_point,
                energy_probabilities=probabilities[1] if scenario == "weak-note" else None,
                note_confirmed_threshold=note_confirmed_threshold,
                ioi_consistency_threshold=ioi_consistency_threshold,
                energy_support_threshold=energy_support_threshold,
            )
        fold_metrics[fold_name] = {
            "clean": clean,
            "scenarios": scenarios,
            "allUnsafeTargetMeasureCount": sum(
                item["unsafeTargetMeasureCount"] for item in scenarios.values()
            ),
        }
    min_coverage = min(
        fold["clean"]["autoPassMeasureCoverage"] for fold in fold_metrics.values()
    )
    all_unsafe = sum(fold["allUnsafeTargetMeasureCount"] for fold in fold_metrics.values())
    return {
        "policy": {
            "noteConfirmedFractionMin": note_confirmed_threshold,
            "relativeIoiConsistencyFractionMin": ioi_consistency_threshold,
            "energySupportFractionMin": energy_support_threshold,
            "explicitPitchConflictVeto": True,
        },
        "folds": fold_metrics,
        "minimumCleanMeasureCoverage": min_coverage,
        "allFoldUnsafeTargetMeasureCount": all_unsafe,
        "safeAcrossAllFolds": all_unsafe == 0,
        "releaseFloorReached": min_coverage >= MIN_RELEASE_COVERAGE,
        "releaseCandidate": all_unsafe == 0 and min_coverage >= MIN_RELEASE_COVERAGE,
    }


def compact_candidate(candidate: dict[str, Any] | None) -> dict[str, Any] | None:
    if candidate is None:
        return None
    return {
        "policy": candidate["policy"],
        "minimumCleanMeasureCoverage": candidate["minimumCleanMeasureCoverage"],
        "allFoldUnsafeTargetMeasureCount": candidate["allFoldUnsafeTargetMeasureCount"],
        "safeAcrossAllFolds": candidate["safeAcrossAllFolds"],
        "releaseFloorReached": candidate["releaseFloorReached"],
        "releaseCandidate": candidate["releaseCandidate"],
        "folds": {
            name: {
                "cleanMeasureCoverage": fold["clean"]["autoPassMeasureCoverage"],
                "cleanAutoPassMeasureCount": fold["clean"]["autoPassMeasureCount"],
                "cleanMeasureCount": fold["clean"]["measureCount"],
                "allUnsafeTargetMeasureCount": fold["allUnsafeTargetMeasureCount"],
                "unsafeByScenario": {
                    scenario: metrics["unsafeTargetMeasureCount"]
                    for scenario, metrics in fold["scenarios"].items()
                },
            }
            for name, fold in candidate["folds"].items()
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirmation-report", default=str(DEFAULT_CONFIRMATION_REPORT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    frozen_report = json.loads(Path(args.confirmation_report).read_text(encoding="utf-8"))
    dynamic_point = frozen_report.get("selectedPolicy")
    if not isinstance(dynamic_point, dict):
        raise RuntimeError("frozen-three-stage-policy-missing")

    audit = dynamic.load_json(dynamic.DEFAULT_AUDIT)
    recognition = dynamic.load_json(dynamic.DEFAULT_RECOGNITION)
    event_gate = dynamic.load_json(dynamic.DEFAULT_EVENT_GATE)
    all_rows = read_candidate_rows(dynamic.DEFAULT_ROWS)
    add_gold_offsets(
        all_rows,
        load_reference_rows(dynamic.REPO / str(audit["datasetRoot"])),
    )
    measure_lookup, ioi_opportunities = build_measure_lookup(audit, all_rows)

    out = Path(args.out).resolve()
    cache_dir = out / "feature-cache"
    development = combined.build_fold(
        DEVELOPMENT_SPLIT,
        dynamic.DEFAULT_DEVELOPMENT,
        cache_dir,
        audit,
        recognition,
        event_gate,
        all_rows,
    )
    rank0 = combined.build_fold(
        HOLDOUT_SPLIT,
        dynamic.DEFAULT_HOLDOUT,
        cache_dir,
        audit,
        recognition,
        event_gate,
        all_rows,
    )
    rank1_all = combined.build_fold(
        HOLDOUT_SPLIT,
        confirmation.DEFAULT_CONFIRMATION_DIR,
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
    rank1 = confirmation.filter_fold_units(rank1_all, rank1_units - rank0_units)

    examples = weak.load_split_examples(
        DEVELOPMENT_SPLIT,
        audit,
        recognition,
        event_gate,
        weak.DEFAULT_ROWS,
        weak.DEFAULT_DEVELOPMENT_RAW,
    )
    models, energy_thresholds = confirmation.fit_energy_models(examples)
    folds = {
        "development": (
            development,
            confirmation.fold_probabilities(development, models, energy_thresholds),
        ),
        "rank0": (
            rank0,
            confirmation.fold_probabilities(rank0, models, energy_thresholds),
        ),
        "rank1Fresh": (
            rank1,
            confirmation.fold_probabilities(rank1, models, energy_thresholds),
        ),
    }

    candidates = [
        evaluate_candidate(
            folds,
            measure_lookup=measure_lookup,
            ioi_opportunities=ioi_opportunities,
            dynamic_point=dynamic_point,
            note_confirmed_threshold=note_threshold,
            ioi_consistency_threshold=ioi_threshold,
            energy_support_threshold=energy_threshold,
        )
        for note_threshold, ioi_threshold, energy_threshold in itertools.product(
            NOTE_CONFIRMED_THRESHOLDS,
            IOI_CONSISTENCY_THRESHOLDS,
            ENERGY_SUPPORT_THRESHOLDS,
        )
    ]
    safe = [candidate for candidate in candidates if candidate["safeAcrossAllFolds"]]
    release = [candidate for candidate in candidates if candidate["releaseCandidate"]]
    at_floor = [candidate for candidate in candidates if candidate["releaseFloorReached"]]
    best_safe = max(
        safe,
        key=lambda candidate: candidate["minimumCleanMeasureCoverage"],
        default=None,
    )
    best_floor_tradeoff = min(
        at_floor,
        key=lambda candidate: (
            candidate["allFoldUnsafeTargetMeasureCount"],
            -candidate["minimumCleanMeasureCoverage"],
        ),
        default=None,
    )

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "evalOnly": True,
        "studentFacing": False,
        "productionPolicyChanged": False,
        "purpose": "oracle upper bound for measure-level pitch plus relative-IOI plus energy evidence",
        "selectionDiscipline": {
            "noteGate": "frozen three-stage public confirmation policy",
            "energyModels": "fit on development-reference performer only",
            "measureSweep": "all folds used only for an oracle upper bound; no threshold is deployable",
            "targetLabelsUsedInDecision": False,
        },
        "thresholdGrid": {
            "noteConfirmedFraction": list(NOTE_CONFIRMED_THRESHOLDS),
            "relativeIoiConsistencyFraction": list(IOI_CONSISTENCY_THRESHOLDS),
            "energySupportFraction": list(ENERGY_SUPPORT_THRESHOLDS),
            "releaseCoverageFloor": MIN_RELEASE_COVERAGE,
        },
        "evaluatedCandidateCount": len(candidates),
        "safeCandidateCount": len(safe),
        "releaseCandidateCount": len(release),
        "bestSafeCandidate": compact_candidate(best_safe),
        "bestCoverageFloorTradeoff": compact_candidate(best_floor_tradeoff),
        "measureJointEvidenceReleaseReady": bool(release),
        "studentGateReady": False,
        "blockingReasons": [] if release else [
            "measure-joint-evidence-oracle-safe-coverage-below-20-percent"
            if best_safe is not None
            and best_safe["minimumCleanMeasureCoverage"] < MIN_RELEASE_COVERAGE
            else "measure-joint-evidence-no-zero-unsafe-candidate",
            "public-reference-times-are-estimated-not-human-note-level-truth",
            "waveform-errors-are-synthetic-not-real-student-errors",
        ],
        "limitations": [
            "the sweep is an oracle upper bound, not a valid threshold-selection procedure",
            "relative IOI normalizes tempo but cannot prove a missing or weak note by itself",
            "requiring energy support for every expected note protects precision but sharply reduces coverage",
            "student release still requires independent real-student validation",
        ],
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "ok": True,
        "evaluatedCandidateCount": report["evaluatedCandidateCount"],
        "safeCandidateCount": report["safeCandidateCount"],
        "releaseCandidateCount": report["releaseCandidateCount"],
        "bestSafeCandidate": report["bestSafeCandidate"],
        "bestCoverageFloorTradeoff": report["bestCoverageFloorTradeoff"],
        "measureJointEvidenceReleaseReady": report["measureJointEvidenceReleaseReady"],
        "out": str(out / "report.json"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
