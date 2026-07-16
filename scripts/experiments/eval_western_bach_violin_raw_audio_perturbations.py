from __future__ import annotations

import argparse
import bisect
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import soundfile as sf


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_basic_pitch_transcription import (  # noqa: E402
    filter_events,
    load_reference_rows,
)
from eval_western_bach_violin_error_perturbations import (  # noqa: E402
    HOLDOUT_SPLIT,
    accepted_rows,
    build_event_index,
    has_support,
    metrics,
    nearby_event_indices,
    rows_by_unit,
)
from eval_western_strings_m0_bach10 import basic_pitch_events  # noqa: E402


DEFAULT_AUDIT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
DEFAULT_ROWS = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-chord-timing.csv"
DEFAULT_RECOGNITION = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-transcription.json"
DEFAULT_EVENT_GATE = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-error-perturbations.json"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-raw-audio-perturbations"
SCENARIOS = ("missing-note", "weak-note", "wrong-pitch-plus2", "late-onset-800ms")
PERTURBATION_VERSION = "rawv2"
DEFAULT_CENTER_THRESHOLD_SECONDS = 0.01
DEFAULT_TARGET_EVENT_CONFIDENCE = 0.40
DEFAULT_SCORE_ISOLATION_SECONDS = 0.30
CORE_SCENARIOS = ("missing-note", "wrong-pitch-plus2", "late-onset-800ms")


def read_candidate_rows(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = [dict(row) for row in csv.DictReader(handle)]
    for row in rows:
        row["predictedTime"] = None if row.get("adjustedPredTime") in ("", None) else float(row["adjustedPredTime"])
        row["midi"] = int(row["midi"])
        row["noteIndex"] = int(row["noteIndex"])
        row["goldTime"] = float(row["goldTime"])
        row["doubleStop"] = str(row.get("doubleStop") or "").strip().lower() == "true"
    return rows


def select_split_units(
    audit_rows: list[dict[str, Any]],
    split: str,
    selection_rank: int = 0,
) -> list[dict[str, Any]]:
    by_work: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in audit_rows:
        if row.get("readyForEvalBenchmark") is True and row.get("benchmarkSplit") == split:
            by_work[str(row.get("work") or "unknown")].append(row)
    selected = []
    for work in sorted(by_work):
        candidates = sorted(
            by_work[work],
            key=lambda row: (
                float(row.get("referenceDoubleStopNoteCount") or 0)
                / max(1.0, float(row.get("referenceNoteCount") or 1)),
                float((row.get("audio") or {}).get("durationSeconds") or 10**9),
                str(row.get("unit") or ""),
            ),
        )
        selected.append(candidates[min(max(0, selection_rank), len(candidates) - 1)])
    return selected


def select_holdout_units(audit_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return select_split_units(audit_rows, HOLDOUT_SPLIT)


def add_gold_offsets(
    rows: list[dict[str, Any]],
    references: dict[str, list[dict[str, str]]],
) -> None:
    reference_lookup = {
        (piece_id.replace("bach-violin:", "", 1), int(item["noteIndex"])): item
        for piece_id, items in references.items()
        for item in items
    }
    for row in rows:
        reference = reference_lookup.get((str(row["unit"]), int(row["noteIndex"])))
        row["goldOffset"] = (
            float(reference["goldOffset"])
            if reference is not None else float(row["goldTime"]) + 0.1
        )


def select_targets(
    grouped_rows: dict[str, list[dict[str, Any]]],
    base_events: dict[str, list[dict[str, Any]]],
    selected_units: set[str],
    threshold: float,
    neighbor_radius: int,
    max_per_unit: int,
    min_spacing_seconds: float,
    split: str = HOLDOUT_SPLIT,
) -> list[dict[str, Any]]:
    accepted = accepted_rows(split, grouped_rows, base_events, threshold, neighbor_radius)
    by_unit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in accepted:
        if (
            str(row["unit"]) in selected_units
            and not bool(row.get("doubleStop"))
            and row.get("predictedTime") is not None
            and abs(float(row["predictedTime"]) - float(row["goldTime"])) <= 0.30
        ):
            duration = float(row["goldOffset"]) - float(row["goldTime"])
            if 0.08 <= duration <= 1.25:
                by_unit[str(row["unit"])].append(row)
    targets = []
    for unit in sorted(selected_units):
        previous_time = -10**9
        chosen = 0
        for row in sorted(by_unit.get(unit, []), key=lambda item: float(item["goldTime"])):
            if float(row["goldTime"]) - previous_time < min_spacing_seconds:
                continue
            targets.append(row)
            previous_time = float(row["goldTime"])
            chosen += 1
            if chosen >= max_per_unit:
                break
    return targets


def attach_mutation_windows(
    targets: list[dict[str, Any]],
    base_events: dict[str, list[dict[str, Any]]],
    support_threshold: float,
) -> None:
    """Cover both estimated reference time and the observed clean target event.

    Reference note times in this corpus are estimated, so muting only the gold
    interval can leave an earlier observed attack intact. The union makes the
    waveform mutation represent the intended missing/shifted/wrong note.
    """
    indexes = {
        unit: build_event_index(events)
        for unit, events in base_events.items()
    }
    for target in targets:
        unit = str(target["unit"])
        predicted_time = target.get("predictedTime")
        candidates = nearby_event_indices(
            indexes[unit],
            int(target["midi"]),
            predicted_time,
            support_threshold,
        )
        if not candidates:
            target["mutationStart"] = float(target["goldTime"])
            target["mutationEnd"] = float(target["goldOffset"])
            target["mutationEventFound"] = False
            continue
        event_index = min(
            candidates,
            key=lambda index: abs(
                float(base_events[unit][index]["start"]) - float(predicted_time)
            ),
        )
        event = base_events[unit][event_index]
        target["mutationStart"] = min(
            float(target["goldTime"]),
            float(event["start"]),
        )
        target["mutationEnd"] = max(
            float(target["goldOffset"]),
            float(event["end"]),
        )
        target["mutationEventFound"] = True


def strict_accepted_rows(
    split: str,
    grouped_rows: dict[str, list[dict[str, Any]]],
    events_by_unit: dict[str, list[dict[str, Any]]],
    center_threshold: float,
    neighbor_threshold: float,
    neighbor_radius: int,
    min_target_confidence: float,
    score_isolation_seconds: float,
) -> list[dict[str, Any]]:
    """Accept only one-to-one, near-center score/event evidence.

    The wider neighbor window establishes local continuity. The target itself must
    have a unique same-pitch event near its predicted onset, and that event may not
    also explain another same-pitch score note. This prevents a nearby repeated note
    from keeping a mutated target in auto-pass.
    """
    accepted: list[dict[str, Any]] = []
    for unit, unit_rows in grouped_rows.items():
        if not unit_rows or unit_rows[0].get("benchmarkSplit") != split:
            continue
        events = events_by_unit.get(unit) or []
        event_index = build_event_index(events)
        score_by_pitch: dict[int, tuple[list[float], list[int]]] = {}
        score_pairs: dict[int, list[tuple[float, int]]] = defaultdict(list)
        for row in unit_rows:
            predicted_time = row.get("predictedTime")
            if predicted_time is not None:
                score_pairs[int(row["midi"])].append(
                    (float(predicted_time), int(row["noteIndex"]))
                )
        for midi, pairs in score_pairs.items():
            pairs.sort()
            score_by_pitch[midi] = (
                [time for time, _ in pairs],
                [note_index for _, note_index in pairs],
            )

        for row_index, row in enumerate(unit_rows):
            predicted_time = row.get("predictedTime")
            if predicted_time is None:
                continue
            midi = int(row["midi"])
            center_events = nearby_event_indices(
                event_index,
                midi,
                float(predicted_time),
                center_threshold,
            )
            if len(center_events) != 1:
                continue
            event = events[center_events[0]]
            if float(event.get("confidence") or 0.0) < min_target_confidence:
                continue

            score_times, score_indices = score_by_pitch.get(midi, ([], []))
            event_time = float(event["start"])
            left = bisect.bisect_left(score_times, event_time - score_isolation_seconds)
            right = bisect.bisect_right(score_times, event_time + score_isolation_seconds)
            if score_indices[left:right] != [int(row["noteIndex"])]:
                continue

            start = max(0, row_index - neighbor_radius)
            stop = min(len(unit_rows), row_index + neighbor_radius + 1)
            if all(
                has_support(event_index, neighbor, neighbor_threshold)
                for neighbor in unit_rows[start:stop]
            ):
                accepted.append(row)
    return accepted


def strict_metrics(
    split: str,
    grouped_rows: dict[str, list[dict[str, Any]]],
    events_by_unit: dict[str, list[dict[str, Any]]],
    center_threshold: float,
    neighbor_threshold: float,
    neighbor_radius: int,
    min_target_confidence: float,
    score_isolation_seconds: float,
    targets: set[tuple[str, int]] | None = None,
) -> dict[str, Any]:
    accepted = strict_accepted_rows(
        split,
        grouped_rows,
        events_by_unit,
        center_threshold,
        neighbor_threshold,
        neighbor_radius,
        min_target_confidence,
        score_isolation_seconds,
    )
    total = sum(
        len(unit_rows)
        for unit_rows in grouped_rows.values()
        if unit_rows and unit_rows[0].get("benchmarkSplit") == split
    )
    correct = sum(
        abs(float(row["predictedTime"]) - float(row["goldTime"])) <= 0.30
        for row in accepted
    )
    target_set = targets or set()
    unsafe = sum(
        (str(row["unit"]), int(row["noteIndex"])) in target_set
        for row in accepted
    )
    return {
        "goldNotes": total,
        "autoPassCount": len(accepted),
        "correctWithin300ms": correct,
        "precisionWithin300ms": correct / len(accepted) if accepted else None,
        "coverage": len(accepted) / total if total else None,
        "targetCount": len(target_set),
        "unsafeTargetAutoPassCount": unsafe,
        "unsafeTargetAutoPassRate": unsafe / len(target_set) if target_set else 0.0,
    }


def smooth_mask(length: int, start: int, end: int, fade_samples: int) -> np.ndarray:
    mask = np.zeros(length, dtype=np.float32)
    start = max(0, min(length, start))
    end = max(start, min(length, end))
    if end <= start:
        return mask
    mask[start:end] = 1.0
    fade = min(max(0, fade_samples), max(0, (end - start) // 2))
    if fade > 0:
        mask[start:start + fade] = np.linspace(0.0, 1.0, fade, endpoint=False, dtype=np.float32)
        mask[end - fade:end] = np.linspace(1.0, 0.0, fade, endpoint=False, dtype=np.float32)
    return mask


def mutate_waveform(
    waveform: np.ndarray,
    sr: int,
    targets: list[dict[str, Any]],
    scenario: str,
) -> np.ndarray:
    source = np.asarray(waveform, dtype=np.float32)
    output = source.copy()
    fade_samples = max(1, int(round(sr * 0.02)))
    for target in targets:
        target_start = float(target.get("mutationStart", target["goldTime"]))
        target_end = float(target.get("mutationEnd", target["goldOffset"]))
        start = max(0, int(round((target_start - 0.02) * sr)))
        end = min(len(source), int(round((target_end + 0.02) * sr)))
        if end - start < max(8, fade_samples * 2):
            continue
        mask = smooth_mask(len(source), start, end, fade_samples)
        if scenario == "missing-note":
            output *= 1.0 - mask
        elif scenario == "weak-note":
            output *= 1.0 - 0.94 * mask
        elif scenario == "wrong-pitch-plus2":
            segment = source[start:end]
            shifted = librosa.effects.pitch_shift(segment, sr=sr, n_steps=2.0)
            if len(shifted) < len(segment):
                shifted = np.pad(shifted, (0, len(segment) - len(shifted)))
            shifted = shifted[: len(segment)].astype(np.float32)
            local_mask = mask[start:end]
            output[start:end] = output[start:end] * (1.0 - local_mask) + shifted * local_mask
        elif scenario == "late-onset-800ms":
            segment = source[start:end].copy()
            output *= 1.0 - mask
            delayed_start = start + int(round(0.8 * sr))
            delayed_end = min(len(output), delayed_start + len(segment))
            if delayed_end > delayed_start:
                segment = segment[: delayed_end - delayed_start]
                local = smooth_mask(len(segment), 0, len(segment), min(fade_samples, len(segment) // 2))
                output[delayed_start:delayed_end] += segment * local
        else:
            raise ValueError(f"unknown-raw-audio-scenario:{scenario}")
    return np.clip(output, -1.0, 1.0).astype(np.float32)


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Bach Violin Raw-Audio Perturbation Pilot",
            "",
            "Waveform mutations are applied to public recordings, then Basic Pitch is rerun from audio.",
            "Synthetic audio artifacts remain a limitation; this is not real student-error gold.",
            "",
            f"- units: {report['selectedUnits']}",
            f"- targets: {report['targetCount']}",
            f"- baseline clean: {report['baseline']['clean']}",
            f"- strict clean: {report['strictPolicy']['clean']}",
            f"- strict scenarios: {report['strictPolicy']['scenarios']}",
            f"- rawAudioCoreErrorGateReady: {str(report['rawAudioCoreErrorGateReady']).lower()}",
            f"- weakNoteAutoPassReady: {str(report['weakNoteAutoPassReady']).lower()}",
            f"- rawAudioPublicPerturbationGateReady: {str(report['rawAudioPublicPerturbationGateReady']).lower()}",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run waveform-level error perturbations on unseen-performer public Bach violin recordings.")
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--rows", default=str(DEFAULT_ROWS))
    parser.add_argument("--recognition", default=str(DEFAULT_RECOGNITION))
    parser.add_argument("--event-gate", default=str(DEFAULT_EVENT_GATE))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--max-targets-per-unit", type=int, default=8)
    parser.add_argument("--min-target-spacing", type=float, default=2.0)
    parser.add_argument("--split", choices=("development-reference-performer", HOLDOUT_SPLIT), default=HOLDOUT_SPLIT)
    parser.add_argument("--selection-rank", type=int, default=0)
    parser.add_argument("--center-threshold-seconds", type=float, default=DEFAULT_CENTER_THRESHOLD_SECONDS)
    parser.add_argument("--target-event-confidence", type=float, default=DEFAULT_TARGET_EVENT_CONFIDENCE)
    parser.add_argument("--score-isolation-seconds", type=float, default=DEFAULT_SCORE_ISOLATION_SECONDS)
    parser.add_argument("--required-gate", choices=("core", "all"), default="core")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
    recognition = json.loads(Path(args.recognition).read_text(encoding="utf-8"))
    event_gate = json.loads(Path(args.event_gate).read_text(encoding="utf-8"))
    split = str(args.split)
    selected_sources = select_split_units(audit["rows"], split, int(args.selection_rank))
    selected_units = {str(source["unit"]) for source in selected_sources}
    rows = [row for row in read_candidate_rows(Path(args.rows).resolve()) if str(row["unit"]) in selected_units]
    references = load_reference_rows(REPO_ROOT / str(audit["datasetRoot"]))
    add_gold_offsets(rows, references)
    grouped_rows = rows_by_unit(rows)
    selected_filter = ((recognition.get("eventFilterCalibration") or {}).get("selected") or {})
    min_confidence = float(selected_filter.get("minConfidence", 0.38))
    min_duration = float(selected_filter.get("minDurationSeconds", 0.08))
    threshold = float(event_gate.get("selectedThresholdSeconds") or 0.30)
    neighbor_radius = int(event_gate.get("neighborRadius") or 2)
    original_cache = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-cache"
    base_events = {
        unit: filter_events(
            json.loads((original_cache / f"{unit}.basic-pitch.json").read_text(encoding="utf-8")),
            min_confidence,
            min_duration,
        )
        for unit in selected_units
    }
    targets = select_targets(
        grouped_rows,
        base_events,
        selected_units,
        threshold,
        neighbor_radius,
        max(1, int(args.max_targets_per_unit)),
        max(0.5, float(args.min_target_spacing)),
        split,
    )
    attach_mutation_windows(targets, base_events, threshold)
    targets_by_unit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for target in targets:
        targets_by_unit[str(target["unit"])].append(target)
    target_keys = {(str(target["unit"]), int(target["noteIndex"])) for target in targets}

    output_dir = Path(args.output_dir).resolve()
    audio_dir = output_dir / "audio"
    cache_dir = output_dir / "basic-pitch-cache"
    audio_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    source_by_unit = {str(source["unit"]): source for source in selected_sources}
    scenario_metrics = {}
    scenario_events_by_name: dict[str, dict[str, list[dict[str, Any]]]] = {}
    generated_files = []
    for scenario in SCENARIOS:
        scenario_events = {}
        for unit in sorted(selected_units):
            source_path = REPO_ROOT / source_by_unit[unit]["audioPath"]
            output_path = audio_dir / f"{unit}-{scenario}-{PERTURBATION_VERSION}.wav"
            if not output_path.is_file():
                waveform, sr = librosa.load(str(source_path), sr=22050, mono=True)
                mutated = mutate_waveform(waveform, sr, targets_by_unit.get(unit, []), scenario)
                sf.write(output_path, mutated, sr, subtype="PCM_16")
            events = basic_pitch_events(output_path, cache_dir)
            scenario_events[unit] = filter_events(events, min_confidence, min_duration)
            generated_files.append(str(output_path.relative_to(REPO_ROOT)).replace("\\", "/"))
        scenario_events_by_name[scenario] = scenario_events
        scenario_metrics[scenario] = metrics(
            split,
            grouped_rows,
            scenario_events,
            threshold,
            neighbor_radius,
            target_keys,
        )
    clean = metrics(split, grouped_rows, base_events, threshold, neighbor_radius)
    baseline_unsafe = sum(item["unsafeTargetAutoPassCount"] for item in scenario_metrics.values())

    center_threshold = max(0.001, float(args.center_threshold_seconds))
    target_event_confidence = min(1.0, max(0.0, float(args.target_event_confidence)))
    score_isolation_seconds = max(0.0, float(args.score_isolation_seconds))
    strict_clean = strict_metrics(
        split,
        grouped_rows,
        base_events,
        center_threshold,
        threshold,
        neighbor_radius,
        target_event_confidence,
        score_isolation_seconds,
        target_keys,
    )
    strict_scenarios = {
        scenario: strict_metrics(
            split,
            grouped_rows,
            events,
            center_threshold,
            threshold,
            neighbor_radius,
            target_event_confidence,
            score_isolation_seconds,
            target_keys,
        )
        for scenario, events in scenario_events_by_name.items()
    }
    eligible_targets = int(strict_clean["unsafeTargetAutoPassCount"])
    core_unsafe = sum(
        int(strict_scenarios[scenario]["unsafeTargetAutoPassCount"])
        for scenario in CORE_SCENARIOS
    )
    weak_unsafe = int(strict_scenarios["weak-note"]["unsafeTargetAutoPassCount"])
    core_ready = bool(
        eligible_targets >= 30
        and strict_clean.get("precisionWithin300ms") is not None
        and strict_clean["precisionWithin300ms"] >= 0.90
        and strict_clean.get("coverage") is not None
        and strict_clean["coverage"] >= 0.20
        and core_unsafe == 0
    )
    weak_ready = bool(core_ready and weak_unsafe == 0)
    ready = bool(core_ready and weak_ready)
    report = {
        "ok": True,
        "evidenceType": f"{split}-public-waveform-perturbation",
        "selectionRank": int(args.selection_rank),
        "perturbationVersion": PERTURBATION_VERSION,
        "selectedUnits": sorted(selected_units),
        "targetCount": len(targets),
        "targetsPerUnit": {unit: len(targets_by_unit.get(unit, [])) for unit in sorted(selected_units)},
        "supportThresholdSeconds": threshold,
        "neighborRadius": neighbor_radius,
        "eventFilter": {"minConfidence": min_confidence, "minDurationSeconds": min_duration},
        "mutationWindowPolicy": "union-of-estimated-reference-note-and-nearest-clean-same-pitch-event",
        "baseline": {
            "clean": clean,
            "scenarios": scenario_metrics,
            "unsafeTargetAutoPassCount": baseline_unsafe,
        },
        "strictPolicy": {
            "centerThresholdSeconds": center_threshold,
            "neighborThresholdSeconds": threshold,
            "neighborRadius": neighbor_radius,
            "minTargetEventConfidence": target_event_confidence,
            "scoreIsolationSeconds": score_isolation_seconds,
            "clean": strict_clean,
            "eligibleTargetCount": eligible_targets,
            "scenarios": strict_scenarios,
            "coreUnsafeTargetAutoPassCount": core_unsafe,
            "weakUnsafeTargetAutoPassCount": weak_unsafe,
        },
        "rawAudioCoreErrorGateReady": core_ready,
        "weakNoteAutoPassReady": weak_ready,
        "rawAudioPublicPerturbationGateReady": ready,
        "rawAudioStudentErrorGateReady": False,
        "requiredGate": str(args.required_gate),
        "extraNoteDiagnosisReady": False,
        "generatedAudioFiles": generated_files,
        "limitations": [
            "waveform-errors-are-synthetic-not-human-performance-errors",
            "reference-note-times-are-estimated-cqt-dtw",
            "weak-note-diagnosis-is-review-only-unless-its-separate-gate-passes",
            "extra-note-diagnosis-remains-review-only",
        ],
    }
    report_path = output_dir / "report.json"
    markdown_path = output_dir / "report.md"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("ok", "evidenceType", "selectedUnits", "targetCount", "targetsPerUnit", "baseline", "strictPolicy", "rawAudioCoreErrorGateReady", "weakNoteAutoPassReady", "rawAudioPublicPerturbationGateReady", "rawAudioStudentErrorGateReady", "limitations")}, ensure_ascii=False, indent=2))
    required_ready = core_ready if args.required_gate == "core" else ready
    return 0 if required_ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
