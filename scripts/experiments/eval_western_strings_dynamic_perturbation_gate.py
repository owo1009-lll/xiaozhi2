#!/usr/bin/env python3
"""Evaluate dynamic pitch/relative-IOI evidence on public waveform errors.

Threshold selection uses the development performer only. The holdout performer
fold is evaluated once with the frozen threshold. Synthetic waveform errors and
estimated public alignments cannot authorize a student-facing runtime gate.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_basic_pitch_transcription import filter_events, load_reference_rows  # noqa: E402
from eval_western_bach_violin_error_perturbations import HOLDOUT_SPLIT, rows_by_unit  # noqa: E402
from eval_western_bach_violin_raw_audio_perturbations import (  # noqa: E402
    CORE_SCENARIOS,
    PERTURBATION_VERSION,
    SCENARIOS,
    add_gold_offsets,
    attach_mutation_windows,
    read_candidate_rows,
    select_split_units,
    select_targets,
)
from run_western_strings_offline_feature_analysis import (  # noqa: E402
    assign_basic_pitch_events,
    compute_relative_ioi_features,
)


DEFAULT_AUDIT = REPO / "data/experiments/western-strings-bach-violin-dataset-audit.json"
DEFAULT_ROWS = REPO / "data/experiments/western-strings-bach-violin-chord-timing.csv"
DEFAULT_RECOGNITION = REPO / "data/experiments/western-strings-bach-violin-basic-pitch-transcription.json"
DEFAULT_EVENT_GATE = REPO / "data/experiments/western-strings-bach-violin-error-perturbations.json"
DEFAULT_DEVELOPMENT = REPO / "data/experiments/western-strings-bach-violin-raw-audio-perturbations-development"
DEFAULT_HOLDOUT = REPO / "data/experiments/western-strings-bach-violin-raw-audio-perturbations"
DEFAULT_OUT = REPO / "data/experiments/western-strings-m3/dynamic-perturbation-gate/report.json"
THRESHOLD_GRID = (0.05, 0.075, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def build_fold_inputs(
    *,
    split: str,
    perturbation_dir: Path,
    audit: dict[str, Any],
    all_rows: list[dict[str, Any]],
    min_confidence: float,
    min_duration: float,
    neighbor_threshold: float,
    neighbor_radius: int,
) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]], dict[str, dict[str, list[dict[str, Any]]]]]:
    sources = select_split_units(audit["rows"], split, 0)
    units = {str(source["unit"]) for source in sources}
    grouped = rows_by_unit([row for row in all_rows if str(row["unit"]) in units])
    original_cache = REPO / "data/experiments/western-strings-bach-violin-basic-pitch-cache"
    clean_events = {
        unit: filter_events(
            load_json(original_cache / f"{unit}.basic-pitch.json"),
            min_confidence,
            min_duration,
        )
        for unit in units
    }
    targets = select_targets(
        grouped,
        clean_events,
        units,
        neighbor_threshold,
        neighbor_radius,
        8,
        2.0,
        split,
    )
    attach_mutation_windows(targets, clean_events, neighbor_threshold)
    events_by_scenario = {"clean": clean_events}
    for scenario in SCENARIOS:
        events_by_scenario[scenario] = {
            unit: filter_events(
                load_json(
                    perturbation_dir
                    / "basic-pitch-cache"
                    / f"{unit}-{scenario}-{PERTURBATION_VERSION}.basic-pitch.json"
                ),
                min_confidence,
                min_duration,
            )
            for unit in units
        }
    return grouped, targets, events_by_scenario


def evaluate_scenario(
    grouped: dict[str, list[dict[str, Any]]],
    targets: list[dict[str, Any]],
    events_by_unit: dict[str, list[dict[str, Any]]],
    *,
    deviation_limit: float,
    min_event_confidence: float,
) -> dict[str, Any]:
    target_keys = {(str(target["unit"]), int(target["noteIndex"])) for target in targets}
    selected = 0
    correct = 0
    unsafe_targets = 0
    target_selected = 0
    rows: list[dict[str, Any]] = []
    for unit in sorted(grouped):
        score_rows = grouped[unit]
        notes = [
            {
                "midi": int(row["midi"]),
                "scoreUnit": float(row["scoreTime"]),
                "scoreOnsetUnit": float(row["scoreTime"]),
            }
            for row in score_rows
        ]
        assignments = assign_basic_pitch_events(notes, events_by_unit[unit])
        ioi_features = compute_relative_ioi_features(notes, assignments, consistency_limit=deviation_limit)
        for row_index, (row, assignment, ioi) in enumerate(zip(score_rows, assignments, ioi_features)):
            neighbor_confidences = [
                float(assignments[candidate]["confidence"])
                for candidate in range(max(0, row_index - 2), min(len(assignments), row_index + 3))
                if candidate != row_index and assignments[candidate] is not None
            ]
            neighbor_confidence = (
                sum(neighbor_confidences) / len(neighbor_confidences)
                if neighbor_confidences
                else None
            )
            relative_confidence = (
                float(assignment["confidence"]) / max(0.01, neighbor_confidence)
                if assignment is not None and neighbor_confidence is not None
                else None
            )
            is_selected = bool(
                assignment is not None
                and assignment["pitchDistanceSemitones"] == 0
                and float(assignment["confidence"]) >= min_event_confidence
                and ioi.get("relativeIoiEvidenceAvailable")
                and float(ioi["relativeIoiDeviationRatio"]) <= deviation_limit
            )
            key = (unit, int(row["noteIndex"]))
            if is_selected:
                selected += 1
                onset_error = abs(float(assignment["time"]) - float(row["goldTime"]))
                correct += int(onset_error <= 0.30)
                if key in target_keys:
                    target_selected += 1
                    unsafe_targets += 1
            else:
                onset_error = None
            rows.append(
                {
                    "unit": unit,
                    "noteIndex": int(row["noteIndex"]),
                    "target": key in target_keys,
                    "selected": is_selected,
                    "onsetErrorSeconds": round(onset_error, 6) if onset_error is not None else None,
                    "pitchDistanceSemitones": assignment.get("pitchDistanceSemitones") if assignment else None,
                    "eventConfidence": round(float(assignment["confidence"]), 6) if assignment else None,
                    "relativeEventConfidence": round(relative_confidence, 6) if relative_confidence is not None else None,
                    "relativeIoiDeviationRatio": ioi.get("relativeIoiDeviationRatio"),
                }
            )
    note_count = sum(len(items) for items in grouped.values())
    return {
        "noteCount": note_count,
        "selectedCount": selected,
        "correctWithin300msCount": correct,
        "precisionWithin300ms": correct / selected if selected else None,
        "coverage": selected / note_count if note_count else 0.0,
        "targetCount": len(target_keys),
        "targetSelectedCount": target_selected,
        "unsafeTargetAutoPassCount": unsafe_targets,
        "unsafeTargetAutoPassRate": unsafe_targets / len(target_keys) if target_keys else 0.0,
        "rows": rows,
    }


def evaluate_fold(
    grouped: dict[str, list[dict[str, Any]]],
    targets: list[dict[str, Any]],
    events_by_scenario: dict[str, dict[str, list[dict[str, Any]]]],
    *,
    deviation_limit: float,
    min_event_confidence: float,
) -> dict[str, Any]:
    clean = evaluate_scenario(
        grouped,
        targets,
        events_by_scenario["clean"],
        deviation_limit=deviation_limit,
        min_event_confidence=min_event_confidence,
    )
    scenarios = {
        scenario: evaluate_scenario(
            grouped,
            targets,
            events_by_scenario[scenario],
            deviation_limit=deviation_limit,
            min_event_confidence=min_event_confidence,
        )
        for scenario in SCENARIOS
    }
    core_unsafe = sum(int(scenarios[name]["unsafeTargetAutoPassCount"]) for name in CORE_SCENARIOS)
    return {"clean": clean, "scenarios": scenarios, "coreUnsafeTargetAutoPassCount": core_unsafe}


def select_development_threshold(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    eligible = [
        row
        for row in rows
        if row["clean"]["selectedCount"] >= 30
        and row["clean"]["precisionWithin300ms"] is not None
        and row["clean"]["precisionWithin300ms"] >= 0.90
        and row["clean"]["coverage"] >= 0.20
        and row["coreUnsafeTargetAutoPassCount"] == 0
    ]
    return max(eligible, key=lambda row: (row["clean"]["coverage"], -row["deviationLimit"])) if eligible else None


def compact(metrics: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in metrics.items() if key != "rows"}


def compact_fold(fold: dict[str, Any]) -> dict[str, Any]:
    return {
        "clean": compact(fold["clean"]),
        "scenarios": {key: compact(value) for key, value in fold["scenarios"].items()},
        "coreUnsafeTargetAutoPassCount": fold["coreUnsafeTargetAutoPassCount"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--rows", default=str(DEFAULT_ROWS))
    parser.add_argument("--recognition", default=str(DEFAULT_RECOGNITION))
    parser.add_argument("--event-gate", default=str(DEFAULT_EVENT_GATE))
    parser.add_argument("--development-dir", default=str(DEFAULT_DEVELOPMENT))
    parser.add_argument("--holdout-dir", default=str(DEFAULT_HOLDOUT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-event-confidence", type=float, default=0.40)
    args = parser.parse_args()

    audit = load_json(Path(args.audit))
    recognition = load_json(Path(args.recognition))
    event_gate = load_json(Path(args.event_gate))
    all_rows = read_candidate_rows(Path(args.rows))
    references = load_reference_rows(REPO / str(audit["datasetRoot"]))
    add_gold_offsets(all_rows, references)
    event_filter = ((recognition.get("eventFilterCalibration") or {}).get("selected") or {})
    min_confidence = float(event_filter.get("minConfidence", 0.38))
    min_duration = float(event_filter.get("minDurationSeconds", 0.08))
    neighbor_threshold = float(event_gate.get("selectedThresholdSeconds") or 0.30)
    neighbor_radius = int(event_gate.get("neighborRadius") or 2)

    development_inputs = build_fold_inputs(
        split="development-reference-performer",
        perturbation_dir=Path(args.development_dir),
        audit=audit,
        all_rows=all_rows,
        min_confidence=min_confidence,
        min_duration=min_duration,
        neighbor_threshold=neighbor_threshold,
        neighbor_radius=neighbor_radius,
    )
    development_sweep = []
    for threshold in THRESHOLD_GRID:
        metrics = evaluate_fold(
            *development_inputs,
            deviation_limit=threshold,
            min_event_confidence=float(args.min_event_confidence),
        )
        development_sweep.append({"deviationLimit": threshold, **compact_fold(metrics)})
    selected = select_development_threshold(development_sweep)
    frozen_threshold = float(selected["deviationLimit"]) if selected else min(THRESHOLD_GRID)

    holdout_inputs = build_fold_inputs(
        split=HOLDOUT_SPLIT,
        perturbation_dir=Path(args.holdout_dir),
        audit=audit,
        all_rows=all_rows,
        min_confidence=min_confidence,
        min_duration=min_duration,
        neighbor_threshold=neighbor_threshold,
        neighbor_radius=neighbor_radius,
    )
    holdout_full = evaluate_fold(
        *holdout_inputs,
        deviation_limit=frozen_threshold,
        min_event_confidence=float(args.min_event_confidence),
    )
    holdout = compact_fold(holdout_full)
    core_holdout_ready = bool(
        selected
        and holdout["clean"]["selectedCount"] >= 30
        and holdout["clean"]["precisionWithin300ms"] is not None
        and holdout["clean"]["precisionWithin300ms"] >= 0.90
        and holdout["clean"]["coverage"] >= 0.20
        and holdout["coreUnsafeTargetAutoPassCount"] == 0
    )
    weak_note_ready = bool(
        core_holdout_ready
        and holdout["scenarios"]["weak-note"]["unsafeTargetAutoPassCount"] == 0
    )
    report = {
        "ok": True,
        "evidenceType": "development-calibrated-holdout-public-waveform-perturbation",
        "method": "basic-pitch-one-to-one-dp-plus-relative-ioi",
        "thresholdGrid": list(THRESHOLD_GRID),
        "minEventConfidence": float(args.min_event_confidence),
        "developmentSweep": development_sweep,
        "developmentSelectedThreshold": frozen_threshold if selected else None,
        "developmentGateReady": bool(selected),
        "holdout": holdout,
        "publicCorePerturbationGateReady": core_holdout_ready,
        "weakNoteGateReady": weak_note_ready,
        "publicAllPerturbationGateReady": bool(core_holdout_ready and weak_note_ready),
        "studentGateReady": False,
        "blockingReasons": [
            "public-reference-times-are-estimated-not-human-note-level-truth",
            "waveform-errors-are-synthetic-not-real-student-errors",
            "independent-student-note-level-validation-required",
        ],
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in (
        "ok",
        "method",
        "developmentSelectedThreshold",
        "developmentGateReady",
        "holdout",
        "publicCorePerturbationGateReady",
        "weakNoteGateReady",
        "publicAllPerturbationGateReady",
        "studentGateReady",
        "blockingReasons",
    )}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
