#!/usr/bin/env python3
"""Audit whether measure-level auto-pass preserves the note-level safety gate.

The policy is intentionally evaluated on cached public waveform perturbations.
It does not alter runtime behavior. A measure passes when its fraction of
strictly confirmed notes reaches a threshold; any auto-passed measure that
contains a known mutated target is counted as unsafe.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_bach_violin_basic_pitch_transcription import (  # noqa: E402
    filter_events,
    load_reference_rows,
)
from eval_western_bach_violin_error_perturbations import (  # noqa: E402
    rows_by_unit,
)
from eval_western_bach_violin_raw_audio_perturbations import (  # noqa: E402
    CORE_SCENARIOS,
    DEFAULT_AUDIT,
    DEFAULT_EVENT_GATE,
    DEFAULT_RECOGNITION,
    DEFAULT_ROWS,
    PERTURBATION_VERSION,
    SCENARIOS,
    add_gold_offsets,
    attach_mutation_windows,
    build_event_index,
    nearby_event_indices,
    read_candidate_rows,
    select_targets,
    strict_accepted_rows,
)


DEFAULT_RAW_ROOT = (
    REPO / "data" / "experiments" / "western-strings-bach-violin-raw-audio-perturbations"
)
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m3" / "measure-policy-audit"
THRESHOLDS = (0.80, 0.90, 1.00)
EVENT_CONFIDENCE_FLOORS = (0.50, 0.60, 0.65, 0.70)


def score_measure_intervals(score_path: Path) -> list[tuple[float, float, int]]:
    from music21 import converter

    score = converter.parse(str(score_path))
    part = score.parts[0] if score.parts else score
    try:
        part = part.expandRepeats()
    except Exception:
        # Scores without a complete repeat bracket still retain their original
        # linear timeline; the final unmapped-row guard catches real mismatch.
        pass
    measures = list(part.getElementsByClass("Measure"))
    intervals: list[tuple[float, float, int]] = []
    for index, measure in enumerate(measures):
        start = float(measure.offset)
        if index + 1 < len(measures):
            end = float(measures[index + 1].offset)
        else:
            end = start + max(0.001, float(measure.barDuration.quarterLength))
        # Use occurrence order, not printed measure number. Repeated printed
        # measures are separate performance windows in the unfolded gold.
        intervals.append((start, end, index + 1))
    return intervals


def assign_measure(score_time: float, intervals: list[tuple[float, float, int]]) -> int:
    for start, end, number in intervals:
        if start <= score_time < end:
            return number
    if intervals and abs(score_time - intervals[-1][1]) < 1e-6:
        return intervals[-1][2]
    return 0


def measure_policy_metrics(
    rows: list[dict[str, Any]],
    accepted_note_keys: set[tuple[str, int]],
    target_note_keys: set[tuple[str, int]],
    threshold: float,
    accepted_note_evidence: dict[tuple[str, int], dict[str, float]] | None = None,
    min_event_confidence: float | None = None,
) -> dict[str, Any]:
    effective_accepted_keys = set(accepted_note_keys)
    if min_event_confidence is not None:
        evidence = accepted_note_evidence or {}
        effective_accepted_keys = {
            key
            for key in effective_accepted_keys
            if float((evidence.get(key) or {}).get("eventConfidence") or 0.0)
            >= min_event_confidence
        }
    by_measure: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_measure[(str(row["unit"]), int(row["measureIndex"]))].append(row)
    auto_pass_measures: set[tuple[str, int]] = set()
    measure_rows = []
    for key, notes in sorted(by_measure.items()):
        note_keys = {(str(row["unit"]), int(row["noteIndex"])) for row in notes}
        confirmed = len(note_keys & effective_accepted_keys)
        coverage = confirmed / len(note_keys) if note_keys else 0.0
        auto_pass = coverage >= threshold
        if auto_pass:
            auto_pass_measures.add(key)
        measure_rows.append(
            {
                "unit": key[0],
                "measureIndex": key[1],
                "goldNoteCount": len(note_keys),
                "confirmedNoteCount": confirmed,
                "confirmedFraction": round(coverage, 6),
                "autoPass": auto_pass,
                "measureDecision": "confirmed_clean" if auto_pass else "insufficient_evidence",
                "studentMessageAllowed": auto_pass,
            }
        )
    target_measures = {
        (str(row["unit"]), int(row["measureIndex"]))
        for row in rows
        if (str(row["unit"]), int(row["noteIndex"])) in target_note_keys
    }
    unsafe = auto_pass_measures & target_measures
    return {
        "threshold": threshold,
        "minEventConfidence": min_event_confidence,
        "measureCount": len(by_measure),
        "autoPassMeasureCount": len(auto_pass_measures),
        "autoPassMeasureCoverage": round(len(auto_pass_measures) / len(by_measure), 6)
        if by_measure
        else 0.0,
        "decisionCounts": {
            "confirmed_clean": len(auto_pass_measures),
            "insufficient_evidence": len(by_measure) - len(auto_pass_measures),
            "issue_detected": 0,
        },
        "targetMeasureCount": len(target_measures),
        "unsafeTargetMeasureCount": len(unsafe),
        "unsafeTargetMeasureRate": round(len(unsafe) / len(target_measures), 6)
        if target_measures
        else 0.0,
        "unsafeTargetMeasures": [
            {"unit": unit, "measureIndex": measure}
            for unit, measure in sorted(unsafe)
        ],
        "rows": measure_rows,
    }


def accepted_note_evidence(
    grouped_rows: dict[str, list[dict[str, Any]]],
    events_by_unit: dict[str, list[dict[str, Any]]],
    accepted_keys: set[tuple[str, int]],
    center_threshold: float,
) -> dict[tuple[str, int], dict[str, float]]:
    """Recover runtime-visible event strength for already accepted notes."""

    result: dict[tuple[str, int], dict[str, float]] = {}
    indexes = {
        unit: build_event_index(events)
        for unit, events in events_by_unit.items()
    }
    for unit, rows in grouped_rows.items():
        events = events_by_unit.get(unit) or []
        event_index = indexes.get(unit) or {}
        for row in rows:
            key = (str(unit), int(row["noteIndex"]))
            if key not in accepted_keys or row.get("predictedTime") is None:
                continue
            candidates = nearby_event_indices(
                event_index,
                int(row["midi"]),
                float(row["predictedTime"]),
                center_threshold,
            )
            if len(candidates) != 1:
                continue
            event = events[candidates[0]]
            result[key] = {
                "eventConfidence": float(event.get("confidence") or 0.0),
                "eventDurationSeconds": max(
                    0.0,
                    float(event.get("end") or 0.0) - float(event.get("start") or 0.0),
                ),
                "centerErrorSeconds": abs(
                    float(event.get("start") or 0.0) - float(row["predictedTime"])
                ),
            }
    return result


def load_cached_events(cache_path: Path, min_confidence: float, min_duration: float) -> list[dict[str, Any]]:
    return filter_events(
        json.loads(cache_path.read_text(encoding="utf-8")),
        min_confidence,
        min_duration,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--rows", default=str(DEFAULT_ROWS))
    parser.add_argument("--recognition", default=str(DEFAULT_RECOGNITION))
    parser.add_argument("--event-gate", default=str(DEFAULT_EVENT_GATE))
    parser.add_argument("--raw-root", default=str(DEFAULT_RAW_ROOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
    recognition = json.loads(Path(args.recognition).read_text(encoding="utf-8"))
    event_gate = json.loads(Path(args.event_gate).read_text(encoding="utf-8"))
    raw_report = json.loads((Path(args.raw_root) / "report.json").read_text(encoding="utf-8"))
    selected_units = set(str(value) for value in raw_report["selectedUnits"])
    source_by_unit = {
        str(row["unit"]): row for row in audit["rows"] if str(row["unit"]) in selected_units
    }
    rows = [row for row in read_candidate_rows(Path(args.rows)) if str(row["unit"]) in selected_units]
    measure_intervals = {
        unit: score_measure_intervals(Path(source["scorePath"]))
        for unit, source in source_by_unit.items()
    }
    for row in rows:
        intervals = measure_intervals[str(row["unit"])]
        row["measureIndex"] = assign_measure(float(row["scoreTime"]), intervals)
    unmapped = [row for row in rows if int(row["measureIndex"]) <= 0]
    if unmapped:
        raise ValueError(f"score-time-to-measure-unmapped:{len(unmapped)}")
    references = load_reference_rows(REPO / str(audit["datasetRoot"]))
    add_gold_offsets(rows, references)
    grouped = rows_by_unit(rows)

    selected_filter = ((recognition.get("eventFilterCalibration") or {}).get("selected") or {})
    min_confidence = float(selected_filter.get("minConfidence", 0.38))
    min_duration = float(selected_filter.get("minDurationSeconds", 0.08))
    neighbor_threshold = float(event_gate.get("selectedThresholdSeconds") or 0.30)
    neighbor_radius = int(event_gate.get("neighborRadius") or 2)
    strict_policy = raw_report["strictPolicy"]
    center_threshold = float(strict_policy["centerThresholdSeconds"])
    target_confidence = float(strict_policy["minTargetEventConfidence"])
    score_isolation = float(strict_policy["scoreIsolationSeconds"])

    clean_cache = REPO / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-cache"
    base_events = {
        unit: load_cached_events(clean_cache / f"{unit}.basic-pitch.json", min_confidence, min_duration)
        for unit in selected_units
    }
    targets = select_targets(
        grouped,
        base_events,
        selected_units,
        neighbor_threshold,
        neighbor_radius,
        max(int(value) for value in raw_report["targetsPerUnit"].values()),
        2.0,
        str(raw_report["evidenceType"]).split("-public", 1)[0],
    )
    attach_mutation_windows(targets, base_events, neighbor_threshold)
    target_keys = {(str(row["unit"]), int(row["noteIndex"])) for row in targets}

    def accepted_keys(events_by_unit: dict[str, list[dict[str, Any]]]) -> set[tuple[str, int]]:
        accepted = strict_accepted_rows(
            str(raw_report["evidenceType"]).split("-public", 1)[0],
            grouped,
            events_by_unit,
            center_threshold,
            neighbor_threshold,
            neighbor_radius,
            target_confidence,
            score_isolation,
        )
        return {(str(row["unit"]), int(row["noteIndex"])) for row in accepted}

    clean_keys = accepted_keys(base_events)
    clean_evidence = accepted_note_evidence(
        grouped,
        base_events,
        clean_keys,
        center_threshold,
    )
    raw_cache = Path(args.raw_root) / "basic-pitch-cache"
    scenarios: dict[str, Any] = {}
    scenario_runtime_evidence: dict[
        str,
        tuple[set[tuple[str, int]], dict[tuple[str, int], dict[str, float]]],
    ] = {}
    for scenario in SCENARIOS:
        events = {
            unit: load_cached_events(
                raw_cache / f"{unit}-{scenario}-{PERTURBATION_VERSION}.basic-pitch.json",
                min_confidence,
                min_duration,
            )
            for unit in selected_units
        }
        keys = accepted_keys(events)
        evidence = accepted_note_evidence(
            grouped,
            events,
            keys,
            center_threshold,
        )
        scenario_runtime_evidence[scenario] = (keys, evidence)
        scenarios[scenario] = {
            str(threshold): measure_policy_metrics(rows, keys, target_keys, threshold)
            for threshold in THRESHOLDS
        }
    clean = {
        str(threshold): measure_policy_metrics(rows, clean_keys, set(), threshold)
        for threshold in THRESHOLDS
    }
    safety = {
        str(threshold): {
            "coreUnsafeTargetMeasureCount": sum(
                int(scenarios[scenario][str(threshold)]["unsafeTargetMeasureCount"])
                for scenario in CORE_SCENARIOS
            ),
            "allUnsafeTargetMeasureCount": sum(
                int(scenarios[scenario][str(threshold)]["unsafeTargetMeasureCount"])
                for scenario in SCENARIOS
            ),
        }
        for threshold in THRESHOLDS
    }
    confidence_floor_sweep: dict[str, Any] = {}
    for floor in EVENT_CONFIDENCE_FLOORS:
        floor_clean = {
            str(threshold): measure_policy_metrics(
                rows,
                clean_keys,
                set(),
                threshold,
                clean_evidence,
                floor,
            )
            for threshold in THRESHOLDS
        }
        floor_scenarios: dict[str, dict[str, Any]] = {}
        for scenario, (keys, evidence) in scenario_runtime_evidence.items():
            floor_scenarios[scenario] = {
                str(threshold): measure_policy_metrics(
                    rows,
                    keys,
                    target_keys,
                    threshold,
                    evidence,
                    floor,
                )
                for threshold in THRESHOLDS
            }
        floor_safety = {
            str(threshold): {
                "coreUnsafeTargetMeasureCount": sum(
                    int(floor_scenarios[scenario][str(threshold)]["unsafeTargetMeasureCount"])
                    for scenario in CORE_SCENARIOS
                ),
                "allUnsafeTargetMeasureCount": sum(
                    int(floor_scenarios[scenario][str(threshold)]["unsafeTargetMeasureCount"])
                    for scenario in SCENARIOS
                ),
            }
            for threshold in THRESHOLDS
        }
        confidence_floor_sweep[str(floor)] = {
            "clean": {
                key: {
                    "autoPassMeasureCount": value["autoPassMeasureCount"],
                    "autoPassMeasureCoverage": value["autoPassMeasureCoverage"],
                }
                for key, value in floor_clean.items()
            },
            "safety": floor_safety,
            "safeCoverageGatePassed": any(
                floor_clean[str(threshold)]["autoPassMeasureCoverage"] >= 0.20
                and floor_safety[str(threshold)]["allUnsafeTargetMeasureCount"] == 0
                for threshold in THRESHOLDS
            ),
        }
    report = {
        "schemaVersion": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "evalOnly": True,
        "studentFacing": False,
        "purpose": "measure-level auto-pass safety audit on public waveform perturbations",
        "selectedUnits": sorted(selected_units),
        "targetNoteCount": len(target_keys),
        "clean": clean,
        "scenarios": scenarios,
        "safety": safety,
        "eventConfidenceFloorSweep": confidence_floor_sweep,
        "measureAggregationReleaseReady": any(
            value["safeCoverageGatePassed"]
            for value in confidence_floor_sweep.values()
        ),
        "studentGateReady": False,
        "limitations": [
            "waveform perturbations are synthetic rather than human mistakes",
            "measure auto-pass is unsafe when one missed note leaves the confirmed fraction above threshold",
            "relative IOI can normalize tempo but cannot independently prove pitch or missing-note correctness",
            "event-confidence floors are runtime-visible, but a safe floor must retain at least 20% clean-measure coverage before it can expand release scope",
        ],
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Measure-level auto-pass safety audit", "", "Eval-only; runtime is unchanged.", ""]
    lines += [
        "| threshold | clean measure coverage | core unsafe target measures | all unsafe target measures |",
        "|---:|---:|---:|---:|",
    ]
    for threshold in THRESHOLDS:
        key = str(threshold)
        lines.append(
            f"| {threshold:.2f} | {clean[key]['autoPassMeasureCoverage']} | "
            f"{safety[key]['coreUnsafeTargetMeasureCount']} | {safety[key]['allUnsafeTargetMeasureCount']} |"
        )
    lines += [
        "",
        "## Runtime-visible event-confidence sweep",
        "",
        "| event confidence | measure threshold | clean coverage | all unsafe target measures |",
        "|---:|---:|---:|---:|",
    ]
    for floor, result in confidence_floor_sweep.items():
        for threshold in THRESHOLDS:
            key = str(threshold)
            lines.append(
                f"| {floor} | {threshold:.2f} | "
                f"{result['clean'][key]['autoPassMeasureCoverage']} | "
                f"{result['safety'][key]['allUnsafeTargetMeasureCount']} |"
            )
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "targetNoteCount": len(target_keys),
        "cleanMeasureCoverage": {
            key: value["autoPassMeasureCoverage"] for key, value in clean.items()
        },
        "safety": safety,
        "eventConfidenceFloorSweep": confidence_floor_sweep,
        "measureAggregationReleaseReady": report["measureAggregationReleaseReady"],
        "out": str(out),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
