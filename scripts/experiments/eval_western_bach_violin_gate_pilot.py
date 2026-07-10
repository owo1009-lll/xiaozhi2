from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from bisect import bisect_right
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import librosa
from music21 import chord, converter, note


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_controlled_candidate_confidence import (  # noqa: E402
    DEPLOYABLE_CATEGORICAL_FEATURES,
    add_candidate_context_features,
    build_feature_row,
    load_dataset,
    make_pipeline,
)
from run_western_strings_offline_feature_analysis import (  # noqa: E402
    build_candidate_rows,
    build_decisions,
    build_symbolic_timeline,
    extract_f0,
)


DEFAULT_DATASET_ROOT = REPO_ROOT / "音频" / "Bach独奏小提琴数据集"
DEFAULT_AUDIT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
DEFAULT_RELEASE = REPO_ROOT / "models" / "western-strings" / "ordinary-upload-confidence-rf-v1" / "release.json"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-gate-pilot.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-gate-pilot.md"
DEFAULT_CACHE = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-cache"
MAX_ONSET_ERROR_SECONDS = 0.300
MIN_PILOT_PRECISION = 0.90
MIN_PILOT_COVERAGE = 0.20
MIN_PILOT_SELECTED = 10


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def safe_float(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def select_pilot_units(rows: list[dict[str, Any]], max_units: int = 6) -> list[dict[str, Any]]:
    eligible = [
        row for row in rows
        if row.get("readyForEvalBenchmark") is True and str(row.get("license") or "") == "PD"
    ]
    by_work: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in eligible:
        by_work[str(row.get("work") or "unknown")].append(row)
    selected: list[dict[str, Any]] = []
    for work in sorted(by_work):
        ranked = sorted(
            by_work[work],
            key=lambda row: (
                safe_float(row.get("referenceDoubleStopNoteCount"))
                / max(1.0, safe_float(row.get("referenceNoteCount"), 1.0)),
                safe_float((row.get("audio") or {}).get("durationSeconds"), 10**9),
                str(row.get("unit") or ""),
            ),
        )
        selected.append(ranked[0])
        if len(selected) >= max_units:
            break
    return selected


def select_all_eval_units(rows: list[dict[str, Any]], max_units: int = 0) -> list[dict[str, Any]]:
    eligible = [row for row in rows if row.get("readyForEvalBenchmark") is True]
    eligible.sort(
        key=lambda row: (
            str(row.get("work") or ""),
            str(row.get("movement") or ""),
            str(row.get("violinist") or ""),
            str(row.get("unit") or ""),
        )
    )
    return eligible[:max_units] if max_units > 0 else eligible


def load_reference_by_piece(dataset_root: Path) -> dict[str, list[dict[str, str]]]:
    rows = read_csv_rows(dataset_root / "bach-violin-gold-notes.csv")
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("pieceId") or "")].append(row)
    for piece_rows in grouped.values():
        piece_rows.sort(key=lambda row: int(row.get("noteIndex") or 0))
    return grouped


def parse_score_positions(score_path: Path) -> dict[tuple[int, int], deque[dict[str, Any]]]:
    score = converter.parse(str(score_path))
    if len(score.parts) != 1:
        raise ValueError(f"expected-one-violin-part:found={len(score.parts)}")
    part = score.parts[0].expandRepeats().stripTies(inPlace=False)
    measure_starts = []
    for global_measure_index, measure in enumerate(part.getElementsByClass("Measure"), start=1):
        measure_starts.append((float(measure.getOffsetInHierarchy(part)), global_measure_index))
    measure_offsets = [item[0] for item in measure_starts]
    buckets: dict[tuple[int, int], deque[dict[str, Any]]] = defaultdict(deque)
    expanded: list[tuple[int, int, dict[str, Any]]] = []
    for element in part.flatten().notes:
        global_offset = float(element.offset)
        onset_tick = int(round(global_offset * 24.0))
        measure_slot = max(0, bisect_right(measure_offsets, global_offset + 1e-9) - 1)
        measure_start, measure = measure_starts[measure_slot] if measure_starts else (0.0, 1)
        beat_start = max(0.0, global_offset - measure_start)
        duration = max(0.05, safe_float(element.quarterLength, 0.25))
        pitches = element.pitches if isinstance(element, chord.Chord) else [element.pitch] if isinstance(element, note.Note) else []
        for pitch in pitches:
            expanded.append(
                (
                    onset_tick,
                    int(pitch.midi),
                    {
                        "measureIndex": measure,
                        "beatStart": beat_start,
                        "beatDuration": duration,
                        "globalQuarterOffset": global_offset,
                    },
                )
            )
    expanded.sort(key=lambda item: (item[0], item[1]))
    for onset_tick, midi, position in expanded:
        buckets[(onset_tick, midi)].append(position)
    return buckets


def build_runtime_notes(score_path: Path, reference_rows: list[dict[str, str]]) -> tuple[list[dict[str, Any]], int]:
    positions = parse_score_positions(score_path)
    runtime_notes: list[dict[str, Any]] = []
    missing = 0
    for row in reference_rows:
        key = (int(row.get("scoreOnsetTick") or 0), int(row.get("midi") or 0))
        if not positions.get(key):
            missing += 1
            continue
        position = positions[key].popleft()
        note_index = int(row.get("noteIndex") or len(runtime_notes))
        measure = int(position["measureIndex"])
        runtime_notes.append(
            {
                "noteId": f"reference-{note_index}",
                "sectionId": "movement",
                "sectionTitle": "Bach violin movement",
                "order": note_index,
                "referenceNoteIndex": note_index,
                "scoreOnsetTick": int(row.get("scoreOnsetTick") or 0),
                "referenceTime": safe_float(row.get("goldTime")),
                "referenceOffset": safe_float(row.get("goldOffset")),
                "doubleStop": str(row.get("doubleStop") or "").strip().lower() == "true",
                "midi": int(row.get("midi") or 0),
                "measureIndex": measure,
                "beatStart": float(position["beatStart"]),
                "beatDuration": float(position["beatDuration"]),
                "globalQuarterOffset": float(position["globalQuarterOffset"]),
                "tempo": 72.0,
                "position": {
                    "pageNumber": None,
                    "measureIndex": measure,
                    "localMeasureIndex": measure,
                    "systemIndex": None,
                    "normalizedX": None,
                    "normalizedY": None,
                },
            }
        )
    runtime_notes.sort(key=lambda item: item["referenceNoteIndex"])
    return runtime_notes, missing


def extract_f0_prefix(audio_path: Path, analysis_seconds: float) -> tuple[np.ndarray, np.ndarray, float]:
    y, sr = librosa.load(
        str(audio_path),
        sr=22050,
        mono=True,
        duration=max(1.0, float(analysis_seconds)),
    )
    if y.size == 0:
        raise ValueError("audio-empty")
    hop_length = 512
    f0, voiced, _ = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("A7"),
        sr=sr,
        hop_length=hop_length,
        frame_length=2048,
    )
    times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop_length)
    valid = np.isfinite(f0) & voiced
    midi = np.full_like(f0, np.nan, dtype=np.float64)
    midi[valid] = librosa.hz_to_midi(f0[valid])
    full_duration = float(librosa.get_duration(path=str(audio_path)))
    return times.astype(np.float64), midi.astype(np.float64), full_duration


def load_or_extract_f0(
    audio_path: Path,
    cache_dir: Path,
    audio_sha1: str,
    *,
    analysis_seconds: float | None = None,
) -> tuple[np.ndarray, np.ndarray, float]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    scope_suffix = ""
    if analysis_seconds is not None and analysis_seconds > 0:
        scope_suffix = f"-prefix{int(round(analysis_seconds * 1000.0))}ms"
    cache_path = cache_dir / f"{audio_path.stem}-{audio_sha1[:12]}{scope_suffix}.npz"
    if cache_path.is_file():
        cached = np.load(cache_path)
        return cached["times"], cached["midi"], float(cached["duration"])
    if analysis_seconds is not None and analysis_seconds > 0:
        times, midi, duration = extract_f0_prefix(audio_path, analysis_seconds)
    else:
        times, midi, duration = extract_f0(audio_path)
    np.savez_compressed(cache_path, times=times, midi=midi, duration=np.asarray(duration))
    return times, midi, duration


def detect_score_pitch_start(
    times: np.ndarray,
    midi_track: np.ndarray,
    runtime_notes: list[dict[str, Any]],
    *,
    search_seconds: float = 10.0,
    pitch_tolerance_semitones: float = 0.8,
) -> float | None:
    if not runtime_notes or times.size == 0 or midi_track.size == 0:
        return None
    first_tick = min(int(item.get("scoreOnsetTick") or 0) for item in runtime_notes)
    first_pitches = sorted({int(item["midi"]) for item in runtime_notes if int(item.get("scoreOnsetTick") or 0) == first_tick})
    if not first_pitches:
        return None
    pitch_array = np.asarray(first_pitches, dtype=np.float64)
    absolute_delta = np.abs(midi_track[:, None] - pitch_array[None, :])
    octave_equivalent_delta = np.minimum.reduce(
        [np.abs(absolute_delta - 12.0 * octave) for octave in range(5)]
    )
    support = (
        np.isfinite(midi_track)
        & (times <= search_seconds)
        & np.any(octave_equivalent_delta <= pitch_tolerance_semitones, axis=1)
    )
    indices = np.flatnonzero(support)
    for index in indices:
        end = min(len(support), int(index) + 3)
        if int(support[int(index):end].sum()) >= 2:
            return float(times[int(index)])
    return None


def detect_violin_activity_start(
    times: np.ndarray,
    midi_track: np.ndarray,
    *,
    search_seconds: float = 10.0,
    min_midi: float = 54.5,
    max_midi: float = 105.0,
) -> float | None:
    if times.size == 0 or midi_track.size == 0:
        return None
    support = (
        np.isfinite(midi_track)
        & (times <= search_seconds)
        & (midi_track >= min_midi)
        & (midi_track <= max_midi)
    )
    for index in np.flatnonzero(support):
        end = min(len(support), int(index) + 4)
        if int(support[int(index):end].sum()) >= 3:
            return float(times[int(index)])
    return None


def train_release_model(release: dict[str, Any]):
    labels_path = REPO_ROOT / str((release.get("trainingLabels") or {}).get("source") or "")
    train_rows, train_labels, _ = load_dataset(labels_path)
    if len(set(train_labels.tolist())) < 2:
        raise ValueError("confidence-training-labels-one-class")
    model_name = str(release.get("modelName") or "rf")
    pipeline = make_pipeline(DEPLOYABLE_CATEGORICAL_FEATURES, model_name)
    pipeline.fit(pd.DataFrame(train_rows), train_labels)
    return pipeline, labels_path


def evaluate_unit(
    row: dict[str, Any],
    reference_rows: list[dict[str, str]],
    pipeline,
    *,
    cache_dir: Path,
    min_confidence: float,
    timing_mode: str,
    f0_analysis_seconds: float | None,
) -> dict[str, Any]:
    score_path = REPO_ROOT / str(row["scorePath"])
    audio_path = REPO_ROOT / str(row["audioPath"])
    runtime_notes, missing_mapping = build_runtime_notes(score_path, reference_rows)
    mapping_rate = len(runtime_notes) / max(1, len(reference_rows))
    if mapping_rate < 0.98:
        return {
            "unit": row["unit"],
            "work": row.get("work"),
            "movement": row.get("movement"),
            "violinist": row.get("violinist"),
            "ok": False,
            "blockingReasons": ["score-reference-note-mapping-below-98pct"],
            "referenceNotes": len(reference_rows),
            "mappedNotes": len(runtime_notes),
            "mappingRate": mapping_rate,
        }

    timeline = build_symbolic_timeline(runtime_notes)
    times, midi_track, audio_duration = load_or_extract_f0(
        audio_path,
        cache_dir,
        str((row.get("audioHashes") or {}).get("sha1") or "nohash"),
        analysis_seconds=f0_analysis_seconds,
    )
    detected_start = 0.0
    if timing_mode == "score-pitch-anchor":
        score_pitch_start = detect_score_pitch_start(times, midi_track, runtime_notes)
        if score_pitch_start is None:
            return {
                "unit": row["unit"],
                "work": row.get("work"),
                "movement": row.get("movement"),
                "ok": False,
                "blockingReasons": ["score-pitch-start-not-found"],
                "referenceNotes": len(reference_rows),
                "mappedNotes": len(runtime_notes),
                "mappingRate": mapping_rate,
            }
        detected_start = score_pitch_start
    elif timing_mode == "violin-activity-anchor":
        activity_start = detect_violin_activity_start(times, midi_track)
        if activity_start is None:
            return {
                "unit": row["unit"],
                "work": row.get("work"),
                "movement": row.get("movement"),
                "ok": False,
                "blockingReasons": ["violin-activity-start-not-found"],
                "referenceNotes": len(reference_rows),
                "mappedNotes": len(runtime_notes),
                "mappingRate": mapping_rate,
            }
        detected_start = activity_start
    elif timing_mode == "reference-start-oracle":
        detected_start = min(float(item["referenceTime"]) for item in runtime_notes)
    decisions = build_decisions(
        timeline,
        times,
        midi_track,
        audio_duration,
        0,
        audio_start_seconds=detected_start,
    )
    candidates = build_candidate_rows(decisions)
    note_lookup = {item["noteId"]: item for item in runtime_notes}
    for index, candidate in enumerate(candidates):
        add_candidate_context_features(candidate, candidates, index)
    confidence_metrics_evaluable = f0_analysis_seconds is None
    if confidence_metrics_evaluable:
        feature_rows = [build_feature_row(candidate) for candidate in candidates]
        probabilities: list[float | None] = (
            pipeline.predict_proba(pd.DataFrame(feature_rows))[:, 1].tolist()
            if feature_rows else []
        )
    else:
        probabilities = [None] * len(candidates)

    first_measure_rows = []
    for candidate, probability in zip(candidates, probabilities):
        note_source = note_lookup.get(str(candidate.get("noteId") or ""))
        if not note_source or int(candidate.get("measureIndex") or 999999) > 1:
            continue
        error = abs(float(candidate.get("predictedOnsetSeconds") or 0.0) - float(note_source["referenceTime"]))
        selected = (
            probability is not None
            and float(probability) >= min_confidence
            and candidate.get("pitchSupportWithin80Cents") is True
        )
        first_measure_rows.append(
            {
                "noteId": candidate.get("noteId"),
                "noteIndex": note_source["referenceNoteIndex"],
                "midi": candidate.get("midi"),
                "doubleStop": note_source["doubleStop"],
                "predictedOnsetSeconds": candidate.get("predictedOnsetSeconds"),
                "referenceTime": note_source["referenceTime"],
                "absoluteOnsetErrorSeconds": round(error, 6),
                "confidenceProbability": round(float(probability), 6) if probability is not None else None,
                "pitchSupportWithin80Cents": candidate.get("pitchSupportWithin80Cents") is True,
                "selected": selected,
                "correctWithin300ms": error <= MAX_ONSET_ERROR_SECONDS,
            }
        )

    selected_rows = [item for item in first_measure_rows if item["selected"]]
    correct_rows = [item for item in selected_rows if item["correctWithin300ms"]]
    errors = [item["absoluteOnsetErrorSeconds"] for item in first_measure_rows]
    selected_errors = [item["absoluteOnsetErrorSeconds"] for item in selected_rows]
    return {
        "unit": row["unit"],
        "work": row["work"],
        "movement": row["movement"],
        "violinist": row["violinist"],
        "license": row["license"],
        "audioPath": row["audioPath"],
        "scorePath": row["scorePath"],
        "ok": True,
        "referenceAlignmentType": "estimated-cqt-dtw-not-human-gold",
        "timingMode": timing_mode,
        "confidenceMetricsEvaluable": confidence_metrics_evaluable,
        "detectedAudioStartSeconds": round(detected_start, 6),
        "referenceNotes": len(reference_rows),
        "mappedNotes": len(runtime_notes),
        "missingMappedNotes": missing_mapping,
        "mappingRate": round(mapping_rate, 6),
        "audioDurationSeconds": round(audio_duration, 6),
        "firstMeasureCandidateCount": len(first_measure_rows),
        "selectedCount": len(selected_rows),
        "correctSelectedCount": len(correct_rows),
        "wrongSelectedCount": len(selected_rows) - len(correct_rows),
        "precisionWithin300ms": len(correct_rows) / len(selected_rows) if selected_rows else None,
        "coverage": len(selected_rows) / len(first_measure_rows) if first_measure_rows else 0.0,
        "medianAllOnsetErrorSeconds": float(np.median(errors)) if errors else None,
        "medianSelectedOnsetErrorSeconds": float(np.median(selected_errors)) if selected_errors else None,
        "rows": first_measure_rows,
        "blockingReasons": [],
    }


def summarize_units(units: list[dict[str, Any]]) -> dict[str, Any]:
    valid = [unit for unit in units if unit.get("ok") is True]
    confidence_metrics_evaluable = bool(valid) and all(
        unit.get("confidenceMetricsEvaluable") is True for unit in valid
    )
    first_measure = [row for unit in valid for row in unit.get("rows", [])]
    selected = [row for row in first_measure if row.get("selected") is True]
    correct = [row for row in selected if row.get("correctWithin300ms") is True]
    wrong = [row for row in selected if row.get("correctWithin300ms") is not True]
    precision = len(correct) / len(selected) if selected and confidence_metrics_evaluable else None
    coverage = (
        len(selected) / len(first_measure)
        if first_measure and confidence_metrics_evaluable else None
    )
    all_errors = [float(row["absoluteOnsetErrorSeconds"]) for row in first_measure]
    all_correct = [row for row in first_measure if row.get("correctWithin300ms") is True]
    pitch_supported = [row for row in first_measure if row.get("pitchSupportWithin80Cents") is True]
    confidence_ge_runtime = [row for row in first_measure if safe_float(row.get("confidenceProbability")) >= 0.8]
    confidence_ge_scope = [row for row in first_measure if safe_float(row.get("confidenceProbability")) >= 0.95]
    ready_to_expand = (
        confidence_metrics_evaluable
        and
        precision is not None
        and precision >= MIN_PILOT_PRECISION
        and coverage >= MIN_PILOT_COVERAGE
        and len(selected) >= MIN_PILOT_SELECTED
        and len({unit.get("work") for unit in valid}) >= 2
    )
    return {
        "evaluatedUnitCount": len(valid),
        "failedUnitCount": len(units) - len(valid),
        "distinctWorks": len({unit.get("work") for unit in valid}),
        "firstMeasureCandidateCount": len(first_measure),
        "confidenceMetricsEvaluable": confidence_metrics_evaluable,
        "selectedCount": len(selected),
        "correctSelectedCount": len(correct),
        "wrongSelectedCount": len(wrong),
        "precisionWithin300ms": precision,
        "coverage": coverage,
        "allCandidateCorrectWithin300msCount": len(all_correct),
        "allCandidateCorrectWithin300msRate": len(all_correct) / len(first_measure) if first_measure else 0.0,
        "allCandidateMedianOnsetErrorSeconds": float(np.median(all_errors)) if all_errors else None,
        "allCandidateP90OnsetErrorSeconds": float(np.percentile(all_errors, 90)) if all_errors else None,
        "pitchSupportCount": len(pitch_supported),
        "pitchSupportRate": len(pitch_supported) / len(first_measure) if first_measure else 0.0,
        "confidenceAtLeastRuntimeThresholdCount": len(confidence_ge_runtime) if confidence_metrics_evaluable else None,
        "confidenceAtLeastScopeThresholdCount": len(confidence_ge_scope) if confidence_metrics_evaluable else None,
        "medianSelectedOnsetErrorSeconds": float(np.median([row["absoluteOnsetErrorSeconds"] for row in selected])) if selected else None,
        "readyToExpandExternalEval": ready_to_expand,
        "releaseEligible": False,
        "releaseBlocker": "professional-public-recordings-with-estimated-alignments-are-eval-only",
    }


def render_markdown(report: dict[str, Any]) -> str:
    metrics = report.get("metrics") or {}
    units = report.get("units") or []
    return "\n".join(
        [
            "# Bach Violin External Gate Pilot",
            "",
            "## Evidence Boundary",
            "",
            "Professional public recordings with estimated CQT-DTW note times; this is an external stress test, not fresh student-domain blind evidence.",
            "",
            "## Metrics",
            "",
            f"- evaluated units: {metrics.get('evaluatedUnitCount', 0)}",
            f"- first-measure candidates: {metrics.get('firstMeasureCandidateCount', 0)}",
            f"- selected: {metrics.get('selectedCount', 0)}",
            f"- correct selected: {metrics.get('correctSelectedCount', 0)}",
            f"- wrong selected: {metrics.get('wrongSelectedCount', 0)}",
            f"- precision within 300 ms: {metrics.get('precisionWithin300ms')}",
            f"- coverage: {metrics.get('coverage')}",
            f"- all-candidate correct within 300 ms: {metrics.get('allCandidateCorrectWithin300msCount', 0)} / {metrics.get('firstMeasureCandidateCount', 0)}",
            f"- all-candidate median onset error: {metrics.get('allCandidateMedianOnsetErrorSeconds')}",
            f"- all-candidate p90 onset error: {metrics.get('allCandidateP90OnsetErrorSeconds')}",
            f"- pitch-support rate: {metrics.get('pitchSupportRate')}",
            f"- confidence >= 0.95: {metrics.get('confidenceAtLeastScopeThresholdCount', 0)}",
            f"- median selected onset error: {metrics.get('medianSelectedOnsetErrorSeconds')}",
            f"- readyToExpandExternalEval: {str(metrics.get('readyToExpandExternalEval', False)).lower()}",
            f"- releaseEligible: false",
            "",
            "## Per Movement",
            "",
            "| Unit | Work | Movement | First-measure | Selected | Correct | Wrong | Precision | Coverage |",
            "|---|---|---|---:|---:|---:|---:|---:|---:|",
            *[
                "| {unit} | {work} | {movement} | {candidates} | {selected} | {correct} | {wrong} | {precision} | {coverage} |".format(
                    unit=unit.get("unit", ""),
                    work=unit.get("work", ""),
                    movement=unit.get("movement", ""),
                    candidates=unit.get("firstMeasureCandidateCount", 0),
                    selected=unit.get("selectedCount", 0),
                    correct=unit.get("correctSelectedCount", 0),
                    wrong=unit.get("wrongSelectedCount", 0),
                    precision=unit.get("precisionWithin300ms"),
                    coverage=unit.get("coverage"),
                )
                for unit in units
            ],
            "",
            "## Decision",
            "",
            (
                "Pilot meets the external-eval expansion gate. Run a larger evaluation, but do not count it as student-domain release evidence."
                if metrics.get("readyToExpandExternalEval")
                else "Pilot does not meet the expansion gate. Diagnose candidate timing/model transfer before running all 65 movements."
            ),
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a small external stress test on the local Bach Violin Dataset.")
    parser.add_argument("--dataset-root", default=str(DEFAULT_DATASET_ROOT))
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--release", default=str(DEFAULT_RELEASE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    parser.add_argument("--max-units", type=int, default=6)
    parser.add_argument("--selection", choices=["pilot", "all-eval-ready"], default="pilot")
    parser.add_argument("--unit", action="append", default=[])
    parser.add_argument(
        "--f0-analysis-seconds",
        type=float,
        default=0.0,
        help="Analyze only this leading audio duration while retaining full-track duration; 0 keeps full-audio F0.",
    )
    parser.add_argument(
        "--timing-mode",
        choices=["full", "score-pitch-anchor", "violin-activity-anchor", "reference-start-oracle"],
        default="full",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dataset_root = Path(args.dataset_root).resolve()
    audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
    release = json.loads(Path(args.release).read_text(encoding="utf-8"))
    reference = load_reference_by_piece(dataset_root)
    requested = {str(item).strip() for item in args.unit if str(item).strip()}
    if requested:
        selected = [row for row in audit.get("rows", []) if row.get("unit") in requested]
        selection_policy = "explicit unit list"
    elif args.selection == "all-eval-ready":
        selected = select_all_eval_units(audit.get("rows", []), max(0, args.max_units))
        selection_policy = "all eval-ready movements, deterministic work/movement/violinist order"
    else:
        selected = select_pilot_units(audit.get("rows", []), max(1, args.max_units))
        selection_policy = "one public-domain movement per BWV work, ranked by lower double-stop ratio then shorter duration"
    if not selected:
        raise SystemExit("No eval-ready public-domain Bach violin units were selected.")
    pipeline, labels_path = train_release_model(release)
    min_confidence = safe_float(((release.get("runtimePolicy") or {}).get("controlledPilotScope") or {}).get("minConfidence"), 0.95)
    unit_reports = []
    for unit_index, row in enumerate(selected, start=1):
        print(
            f"[{unit_index}/{len(selected)}] {row.get('unit', 'unknown-unit')}",
            file=sys.stderr,
            flush=True,
        )
        unit_reports.append(
            evaluate_unit(
                row,
                reference.get(row["pieceId"], []),
                pipeline,
                cache_dir=Path(args.cache_dir).resolve(),
                min_confidence=min_confidence,
                timing_mode=args.timing_mode,
                f0_analysis_seconds=args.f0_analysis_seconds if args.f0_analysis_seconds > 0 else None,
            )
        )
    metrics = summarize_units(unit_reports)
    report = {
        "ok": True,
        "evidenceType": "external-eval-professional-public-estimated-alignment",
        "selectionPolicy": selection_policy,
        "timingMode": args.timing_mode,
        "f0AnalysisSeconds": args.f0_analysis_seconds if args.f0_analysis_seconds > 0 else None,
        "modelVersion": release.get("modelVersion"),
        "modelName": release.get("modelName"),
        "runtimeThreshold": release.get("threshold"),
        "controlledScopeMinConfidence": min_confidence,
        "maxOnsetErrorSeconds": MAX_ONSET_ERROR_SECONDS,
        "trainingLabels": str(labels_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        "metrics": metrics,
        "units": unit_reports,
    }
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({"ok": True, "evidenceType": report["evidenceType"], "selectionPolicy": report["selectionPolicy"], "timingMode": report["timingMode"], "metrics": metrics, "units": [{key: unit.get(key) for key in ("unit", "work", "movement", "ok", "detectedAudioStartSeconds", "firstMeasureCandidateCount", "selectedCount", "correctSelectedCount", "wrongSelectedCount", "precisionWithin300ms", "coverage", "medianSelectedOnsetErrorSeconds", "blockingReasons")} for unit in unit_reports], "out": str(out_path), "markdown": str(markdown_path)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
