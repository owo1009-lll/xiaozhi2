#!/usr/bin/env python3
"""Evaluate the four fixed-sequence M3+ supplemental recordings.

The evaluator is intentionally fail-closed. It aligns voiced F0 frames to the
known note order with a monotonic dynamic program, reports localization and
mode-candidate metrics, and never enables student feedback by itself.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path
from typing import Any

import librosa
import numpy as np

from eval_western_strings_m3plus_pitch_modes import analyze_pitch_window
from run_western_strings_offline_feature_analysis import load_audio_mono


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE = REPO / "音频" / "m3plus-supplemental"
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3plus"
    / "supplemental-machine-eval"
)
MODE_NAMES = ("vibrato", "trill", "ornament", "slide")
MIN_MODE_PRECISION = 0.90
MIN_MODE_RECALL = 0.80
MIN_POSITIVES_PER_MODE = 4
MIN_NEGATIVES_PER_MODE = 4
DEFAULT_LOCALIZATION_PITCH_TOLERANCE_CENTS = 100.0
DEFAULT_MAX_NORMALIZED_PATH_COST = 1.20
ORNAMENT_TAGS = {
    "trill-mark": "trill",
    "mordent": "ornament",
    "inverted-mordent": "ornament",
    "turn": "ornament",
    "inverted-turn": "ornament",
    "delayed-turn": "ornament",
    "shake": "ornament",
    "schleifer": "ornament",
}


def xml_local_name(node: ET.Element) -> str:
    return node.tag.rsplit("}", 1)[-1]


def text_technique_intent(text: str) -> tuple[set[str], bool]:
    normalized = " ".join(str(text or "").lower().split())
    explicit_control = any(
        token in normalized
        for token in (
            "straight tone",
            "plain",
            "senza vibrato",
            "non vibrato",
            "without vibrato",
            "no vibrato",
        )
    )
    if any(token in normalized for token in ("senza vibrato", "non vibrato", "without vibrato", "no vibrato")):
        return set(), True
    modes: set[str] = set()
    if "vibrato" in normalized or "vib." in normalized:
        modes.add("vibrato")
    if "trill" in normalized:
        modes.add("trill")
    if any(token in normalized for token in ("mordent", "ornament", "turn")):
        modes.add("ornament")
    if any(token in normalized for token in ("gliss", "slide", "portamento")):
        modes.add("slide")
    return modes, explicit_control


def extract_score_technique_intent(score_path: Path) -> dict[tuple[int, int], dict[str, Any]]:
    """Extract explicit technique expectations from one controlled MusicXML score.

    The score declares what should be played. Audio analysis later verifies
    whether the declaration was actually executed; score intent is never used
    as performance gold by itself.
    """
    root = ET.fromstring(score_path.read_text(encoding="utf-8"))
    part = next((node for node in root.iter() if xml_local_name(node) == "part"), None)
    if part is None:
        raise ValueError(f"MusicXML has no part: {score_path}")
    result: dict[tuple[int, int], dict[str, Any]] = {}
    fallback_measure = 0
    for measure in (node for node in list(part) if xml_local_name(node) == "measure"):
        fallback_measure += 1
        try:
            measure_index = int(str(measure.attrib.get("number") or fallback_measure).strip())
        except ValueError:
            measure_index = fallback_measure
        pending_words: list[str] = []
        note_index = 0
        for element in list(measure):
            local_tag = xml_local_name(element)
            if local_tag == "direction":
                pending_words.extend(
                    str(node.text or "").strip()
                    for node in element.iter()
                    if xml_local_name(node) == "words" and str(node.text or "").strip()
                )
                continue
            if local_tag != "note":
                continue
            child_tags = {xml_local_name(node) for node in list(element)}
            if child_tags.intersection({"rest", "grace", "cue"}):
                pending_words.clear()
                continue
            note_index += 1
            modes: set[str] = set()
            for node in element.iter():
                tag = xml_local_name(node)
                mapped = ORNAMENT_TAGS.get(tag)
                if mapped:
                    modes.add(mapped)
                elif tag in {"glissando", "slide"}:
                    modes.add("slide")
            explicit_control = False
            for text in pending_words:
                text_modes, is_control = text_technique_intent(text)
                modes.update(text_modes)
                explicit_control = explicit_control or is_control
            result[(measure_index, note_index)] = {
                "modes": sorted(modes),
                "explicitControl": explicit_control,
                "texts": list(pending_words),
            }
            pending_words.clear()
    return result


def validate_score_technique_intent(source: Path, recording: dict[str, Any]) -> dict[str, Any]:
    recording_id = str(recording.get("recordingId") or "").strip()
    score_file = str(recording.get("scoreFile") or f"{recording_id}.musicxml")
    score_path = source / score_file
    if not score_path.is_file():
        return {
            "ready": False,
            "scorePath": str(score_path),
            "checkedLabelCount": 0,
            "mismatches": [{"reason": "score-file-missing"}],
        }
    try:
        extracted = extract_score_technique_intent(score_path)
    except Exception as error:
        return {
            "ready": False,
            "scorePath": str(score_path),
            "checkedLabelCount": 0,
            "mismatches": [{"reason": "score-intent-parse-failed", "error": f"{type(error).__name__}: {error}"}],
        }
    mismatches: list[dict[str, Any]] = []
    labels = list(recording.get("labels") or [])
    for label in labels:
        key = (int(label.get("measure") or 0), int(label.get("noteIndex") or 0))
        score_note = extracted.get(key, {"modes": [], "explicitControl": False, "texts": []})
        expected = {str(mode) for mode in label.get("expectedPositiveModes", []) if str(mode) in MODE_NAMES}
        actual = set(score_note.get("modes") or [])
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        negative_control_unmarked = not expected and not bool(score_note.get("explicitControl"))
        if missing or unexpected or negative_control_unmarked:
            mismatches.append(
                {
                    "measure": key[0],
                    "noteIndex": key[1],
                    "expectedModes": sorted(expected),
                    "scoreModes": sorted(actual),
                    "texts": score_note.get("texts") or [],
                    "missingModes": missing,
                    "unexpectedModes": unexpected,
                    "reason": "negative-control-unmarked" if negative_control_unmarked else "score-mode-mismatch",
                }
            )
    return {
        "ready": not mismatches,
        "scorePath": str(score_path),
        "checkedLabelCount": len(labels),
        "mismatches": mismatches,
    }


def note_to_midi(note_name: str) -> float:
    value = float(librosa.note_to_midi(str(note_name).strip()))
    if not math.isfinite(value):
        raise ValueError(f"invalid pitch name: {note_name}")
    return value


def build_alignment_units(recording: dict[str, Any]) -> list[dict[str, Any]]:
    labels = list(recording.get("labels") or [])
    label_indexes = {id(label): index for index, label in enumerate(labels)}
    target_by_pair = {
        str(label.get("pairId")): label
        for label in labels
        if label.get("pairId") and label.get("pairRole") == "target"
    }
    units: list[dict[str, Any]] = []
    for label_index, label in enumerate(labels):
        pair_id = str(label.get("pairId") or "")
        pair_role = str(label.get("pairRole") or "")
        if pair_role == "target":
            continue
        source_labels = [label]
        auxiliary_pitch = label.get("trillUpperPitch") or label.get("ornamentUpperPitch")
        if pair_role == "source":
            target = target_by_pair.get(pair_id)
            if target is None:
                raise ValueError(f"slide pair is missing target: {pair_id}")
            source_labels.append(target)
            auxiliary_pitch = target.get("writtenPitch")
        positive_modes = sorted(
            {
                str(mode)
                for source in source_labels
                for mode in source.get("expectedPositiveModes", [])
                if str(mode) in MODE_NAMES
            }
        )
        negative_modes = sorted(
            {
                str(mode)
                for source in source_labels
                for mode in source.get("expectedNegativeModes", [])
                if str(mode) in MODE_NAMES
            }
            - set(positive_modes)
        )
        base_midi = note_to_midi(label["writtenPitch"])
        auxiliary_midi = note_to_midi(auxiliary_pitch) if auxiliary_pitch else None
        units.append(
            {
                "unitIndex": len(units),
                "recordingId": recording.get("recordingId"),
                "measure": label.get("measure"),
                "noteIndex": label.get("noteIndex"),
                "labelIndexes": [label_indexes[id(source)] for source in source_labels],
                "expectedBehavior": label.get("expectedBehavior"),
                "basePitch": label.get("writtenPitch"),
                "baseMidi": base_midi,
                "auxiliaryPitch": auxiliary_pitch,
                "auxiliaryMidi": auxiliary_midi,
                "pairId": pair_id or None,
                "expectedPositiveModes": positive_modes,
                "expectedNegativeModes": negative_modes,
            }
        )
    return units


def pitch_distance(unit: dict[str, Any], values: np.ndarray) -> np.ndarray:
    base = float(unit["baseMidi"])
    auxiliary = unit.get("auxiliaryMidi")
    behavior = str(unit.get("expectedBehavior") or "")
    if behavior == "slide-source" and auxiliary is not None:
        low, high = sorted((base, float(auxiliary)))
        return np.maximum(low - values, np.maximum(values - high, 0.0))
    distance = np.abs(values - base)
    if auxiliary is not None:
        distance = np.minimum(distance, np.abs(values - float(auxiliary)))
    return distance


def align_units_to_track(
    units: list[dict[str, Any]],
    times: np.ndarray,
    midi_track: np.ndarray,
    *,
    pitch_tolerance_cents: float = DEFAULT_LOCALIZATION_PITCH_TOLERANCE_CENTS,
    max_normalized_path_cost: float = DEFAULT_MAX_NORMALIZED_PATH_COST,
) -> dict[str, Any]:
    valid = np.isfinite(times) & np.isfinite(midi_track)
    voiced_times = np.asarray(times[valid], dtype=np.float64)
    voiced_midi = np.asarray(midi_track[valid], dtype=np.float64)
    unit_count = len(units)
    frame_count = len(voiced_midi)
    pitch_tolerance_semitones = max(0.1, float(pitch_tolerance_cents) / 100.0)
    if unit_count == 0:
        raise ValueError("score-intent contains no alignment units")
    if frame_count < unit_count * 4:
        raise ValueError(
            f"insufficient voiced frames for alignment: {frame_count} < {unit_count * 4}"
        )

    frame_positions = (np.arange(frame_count, dtype=np.float64) + 0.5) / frame_count
    costs = np.empty((unit_count, frame_count), dtype=np.float64)
    for unit_index, unit in enumerate(units):
        expected_position = (unit_index + 0.5) / unit_count
        raw_pitch_distance = pitch_distance(unit, voiced_midi)
        # Pitch variation inside the localization tolerance must not pull a
        # frame into an adjacent score note. Intonation is assessed later from
        # raw cents; this DP only needs a stable score-to-audio window.
        spectral_cost = np.minimum(
            np.maximum(raw_pitch_distance - pitch_tolerance_semitones, 0.0),
            4.0,
        )
        position_cost = 0.4 * np.abs(frame_positions - expected_position)
        costs[unit_index] = spectral_cost + position_cost

    infinity = np.inf
    scores = np.full((unit_count, frame_count), infinity, dtype=np.float64)
    advanced = np.zeros((unit_count, frame_count), dtype=np.bool_)
    scores[0, 0] = costs[0, 0]
    for frame_index in range(1, frame_count):
        scores[0, frame_index] = scores[0, frame_index - 1] + costs[0, frame_index]
        max_unit = min(unit_count - 1, frame_index)
        for unit_index in range(1, max_unit + 1):
            stay_score = scores[unit_index, frame_index - 1]
            advance_score = scores[unit_index - 1, frame_index - 1]
            if advance_score < stay_score:
                scores[unit_index, frame_index] = advance_score + costs[unit_index, frame_index]
                advanced[unit_index, frame_index] = True
            else:
                scores[unit_index, frame_index] = stay_score + costs[unit_index, frame_index]
    final_score = float(scores[-1, -1])
    if not math.isfinite(final_score):
        raise ValueError("no monotonic path covers every supplemental unit")

    assignments = np.empty(frame_count, dtype=np.int32)
    unit_index = unit_count - 1
    for frame_index in range(frame_count - 1, -1, -1):
        assignments[frame_index] = unit_index
        if frame_index > 0 and unit_index > 0 and advanced[unit_index, frame_index]:
            unit_index -= 1
    if unit_index != 0:
        raise ValueError("alignment backtrack did not reach the first unit")

    aligned_units: list[dict[str, Any]] = []
    for index, unit in enumerate(units):
        frame_indexes = np.flatnonzero(assignments == index)
        if frame_indexes.size == 0:
            raise ValueError(f"alignment unit received no voiced frames: {index}")
        values = voiced_midi[frame_indexes]
        support = pitch_distance(unit, values) <= pitch_tolerance_semitones
        aligned_units.append(
            {
                **unit,
                "firstVoicedSeconds": float(voiced_times[frame_indexes[0]]),
                "lastVoicedSeconds": float(voiced_times[frame_indexes[-1]]),
                "assignedVoicedFrameCount": int(frame_indexes.size),
                "pitchSupportRate": float(np.mean(support)),
            }
        )

    for index, unit in enumerate(aligned_units):
        if index == 0:
            start = float(voiced_times[0])
        else:
            start = (
                aligned_units[index - 1]["lastVoicedSeconds"]
                + unit["firstVoicedSeconds"]
            ) / 2.0
        if index == len(aligned_units) - 1:
            end = float(voiced_times[-1])
        else:
            end = (
                unit["lastVoicedSeconds"]
                + aligned_units[index + 1]["firstVoicedSeconds"]
            ) / 2.0
        unit["startSeconds"] = max(0.0, start)
        unit["endSeconds"] = max(start, end)
        unit["durationSeconds"] = max(0.0, end - start)

    durations = [unit["durationSeconds"] for unit in aligned_units]
    median_duration = float(np.median(durations)) if durations else 0.0
    for unit in aligned_units:
        ratio = unit["durationSeconds"] / max(0.001, median_duration)
        unit["durationRatioToMedian"] = ratio
        unit["localizationUnitReady"] = bool(
            unit["assignedVoicedFrameCount"] >= 4
            and unit["pitchSupportRate"] >= 0.65
            and 0.2 <= ratio <= 5.0
        )
    ready_units = sum(bool(unit["localizationUnitReady"]) for unit in aligned_units)
    support_rates = [unit["pitchSupportRate"] for unit in aligned_units]
    normalized_cost = final_score / max(1, frame_count)
    localization_ready = bool(
        ready_units / unit_count >= 0.90
        and float(np.median(support_rates)) >= 0.75
        and normalized_cost <= max_normalized_path_cost
    )
    return {
        "units": aligned_units,
        "voicedFrameCount": frame_count,
        "normalizedPathCost": normalized_cost,
        "readyUnitCount": ready_units,
        "unitCount": unit_count,
        "medianPitchSupportRate": float(np.median(support_rates)),
        "pitchToleranceCents": float(pitch_tolerance_cents),
        "maxNormalizedPathCost": float(max_normalized_path_cost),
        "localizationReady": localization_ready,
    }


def binary_switch_stats(labels: np.ndarray) -> tuple[int, int]:
    if labels.size == 0:
        return 0, 0
    switches = int(np.sum(labels[1:] != labels[:-1])) if labels.size > 1 else 0
    upper_bouts = int(labels[0] == 1)
    if labels.size > 1:
        upper_bouts += int(np.sum((labels[1:] == 1) & (labels[:-1] == 0)))
    return switches, upper_bouts


def infer_modes(
    unit: dict[str, Any],
    times: np.ndarray,
    midi_track: np.ndarray,
    *,
    pitch_tolerance_cents: float = DEFAULT_LOCALIZATION_PITCH_TOLERANCE_CENTS,
) -> tuple[list[str], dict[str, Any]]:
    start = float(unit["startSeconds"])
    end = float(unit["endSeconds"])
    base = float(unit["baseMidi"])
    features = analyze_pitch_window(
        times=times,
        midi_track=midi_track,
        target_midi=int(round(base)),
        start_seconds=start,
        end_seconds=end,
    )
    predicted: set[str] = set()
    feature_flags = set(features.get("flags") or [])
    if "vibrato-like" in feature_flags:
        predicted.add("vibrato")
    if "slide-like" in feature_flags:
        predicted.add("slide")

    mask = (times >= start) & (times <= end) & np.isfinite(midi_track)
    values = np.asarray(midi_track[mask], dtype=np.float64)
    auxiliary = unit.get("auxiliaryMidi")
    switch_count = 0
    upper_bouts = 0
    upper_ratio = 0.0
    tail_base_ratio = 0.0
    known_pair_net_motion = 0.0
    known_pair_monotonicity = 0.0
    if auxiliary is not None and values.size:
        auxiliary = float(auxiliary)
        base_distance = np.abs(values - base)
        upper_distance = np.abs(values - auxiliary)
        close = np.minimum(base_distance, upper_distance) <= max(
            0.1, float(pitch_tolerance_cents) / 100.0
        )
        labels = (upper_distance[close] < base_distance[close]).astype(np.int8)
        switch_count, upper_bouts = binary_switch_stats(labels)
        upper_ratio = float(np.mean(labels == 1)) if labels.size else 0.0
        tail = labels[-max(1, labels.size // 4) :] if labels.size else labels
        tail_base_ratio = float(np.mean(tail == 0)) if tail.size else 0.0
        head_values = values[: max(1, values.size // 10)]
        tail_values = values[-max(1, values.size // 10) :]
        head_median = float(np.median(head_values))
        tail_median = float(np.median(tail_values))
        direction = math.copysign(1.0, auxiliary - base)
        known_pair_net_motion = (tail_median - head_median) * direction
        total_motion = float(np.sum(np.abs(np.diff(values)))) if values.size > 1 else 0.0
        known_pair_monotonicity = (
            abs(tail_median - head_median) / total_motion if total_motion > 0 else 0.0
        )
        if 0.12 <= upper_ratio <= 0.80 and switch_count >= 4 and upper_bouts >= 2:
            predicted.add("trill")
        if (
            0.02 <= upper_ratio <= 0.40
            and 1 <= upper_bouts <= 2
            and 2 <= switch_count <= 4
            and tail_base_ratio >= 0.70
        ):
            predicted.add("ornament")
        interval = abs(auxiliary - base)
        if (
            interval >= 0.8
            and known_pair_net_motion >= 0.70 * interval
            and abs(head_median - base) <= 0.5
            and abs(tail_median - auxiliary) <= 0.5
            and known_pair_monotonicity >= 0.45
        ):
            predicted.add("slide")

    # A resolved two-pitch oscillation is a trill, not a wide vibrato. Likewise,
    # a resolved one-way transition is a slide. This prevents the broad legacy
    # vibrato envelope from double-labeling semitone trills and slides.
    if "trill" in predicted or "slide" in predicted:
        predicted.discard("vibrato")

    diagnostics = {
        **features,
        "knownPitchSwitchCount": switch_count,
        "knownUpperBoutCount": upper_bouts,
        "knownUpperFrameRatio": round(upper_ratio, 6),
        "knownTailBaseRatio": round(tail_base_ratio, 6),
        "knownPairNetMotionSemitones": round(known_pair_net_motion, 6),
        "knownPairMonotonicity": round(known_pair_monotonicity, 6),
    }
    return sorted(predicted), diagnostics


def evaluate_track(
    recording: dict[str, Any],
    times: np.ndarray,
    midi_track: np.ndarray,
    audio_duration: float,
    *,
    pitch_tolerance_cents: float = DEFAULT_LOCALIZATION_PITCH_TOLERANCE_CENTS,
    max_normalized_path_cost: float = DEFAULT_MAX_NORMALIZED_PATH_COST,
) -> dict[str, Any]:
    units = build_alignment_units(recording)
    alignment = align_units_to_track(
        units,
        times,
        midi_track,
        pitch_tolerance_cents=pitch_tolerance_cents,
        max_normalized_path_cost=max_normalized_path_cost,
    )
    rows: list[dict[str, Any]] = []
    for unit in alignment["units"]:
        predicted_modes, diagnostics = infer_modes(
            unit,
            times,
            midi_track,
            pitch_tolerance_cents=pitch_tolerance_cents,
        )
        rows.append(
            {
                **unit,
                "startSeconds": round(float(unit["startSeconds"]), 4),
                "endSeconds": round(float(unit["endSeconds"]), 4),
                "durationSeconds": round(float(unit["durationSeconds"]), 4),
                "durationRatioToMedian": round(float(unit["durationRatioToMedian"]), 4),
                "pitchSupportRate": round(float(unit["pitchSupportRate"]), 6),
                "predictedModes": predicted_modes,
                "modeDiagnostics": diagnostics,
                "studentDecision": "review_required",
                "studentFacing": False,
            }
        )
    return {
        "recordingId": recording.get("recordingId"),
        "title": recording.get("title"),
        "status": "ok" if alignment["localizationReady"] else "localization-failed",
        "audioDurationSeconds": round(float(audio_duration), 4),
        "expectedUnitCount": len(units),
        "analyzedUnitCount": len(rows),
        "localization": {
            "ready": alignment["localizationReady"],
            "readyUnitCount": alignment["readyUnitCount"],
            "unitCount": alignment["unitCount"],
            "voicedFrameCount": alignment["voicedFrameCount"],
            "normalizedPathCost": round(float(alignment["normalizedPathCost"]), 6),
            "medianPitchSupportRate": round(
                float(alignment["medianPitchSupportRate"]), 6
            ),
            "pitchToleranceCents": alignment["pitchToleranceCents"],
            "maxNormalizedPathCost": alignment["maxNormalizedPathCost"],
        },
        "rows": rows,
    }


def extract_f0(audio_path: Path) -> tuple[np.ndarray, np.ndarray, float]:
    waveform, sample_rate = load_audio_mono(audio_path, target_sr=22050)
    if waveform.size == 0:
        raise ValueError("audio-empty")
    hop_length = 256
    f0, voiced, _ = librosa.pyin(
        waveform,
        fmin=librosa.note_to_hz("C3"),
        fmax=librosa.note_to_hz("A6"),
        sr=sample_rate,
        hop_length=hop_length,
        frame_length=2048,
    )
    times = librosa.frames_to_time(np.arange(len(f0)), sr=sample_rate, hop_length=hop_length)
    valid = np.isfinite(f0) & np.asarray(voiced, dtype=bool)
    midi_track = np.full_like(f0, np.nan, dtype=np.float64)
    midi_track[valid] = librosa.hz_to_midi(f0[valid])
    return times.astype(np.float64), midi_track, float(waveform.size / sample_rate)


def mode_metrics(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for mode in MODE_NAMES:
        tp = fp = tn = fn = 0
        for row in rows:
            positives = set(row.get("expectedPositiveModes") or [])
            negatives = set(row.get("expectedNegativeModes") or [])
            if mode not in positives and mode not in negatives:
                continue
            expected = mode in positives
            predicted = mode in set(row.get("predictedModes") or [])
            if expected and predicted:
                tp += 1
            elif expected:
                fn += 1
            elif predicted:
                fp += 1
            else:
                tn += 1
        positive_count = tp + fn
        negative_count = tn + fp
        precision = tp / (tp + fp) if tp + fp else None
        recall = tp / positive_count if positive_count else None
        specificity = tn / negative_count if negative_count else None
        passed = bool(
            positive_count >= MIN_POSITIVES_PER_MODE
            and negative_count >= MIN_NEGATIVES_PER_MODE
            and precision is not None
            and precision >= MIN_MODE_PRECISION
            and recall is not None
            and recall >= MIN_MODE_RECALL
        )
        result[mode] = {
            "positiveCount": positive_count,
            "negativeCount": negative_count,
            "truePositive": tp,
            "falsePositive": fp,
            "trueNegative": tn,
            "falseNegative": fn,
            "precision": round(precision, 6) if precision is not None else None,
            "recall": round(recall, 6) if recall is not None else None,
            "specificity": round(specificity, 6) if specificity is not None else None,
            "passed": passed,
        }
    return result


def flatten_rows(recording_reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for report in recording_reports:
        for row in report.get("rows", []):
            diagnostics = row.get("modeDiagnostics") or {}
            flattened = {key: value for key, value in row.items() if key != "modeDiagnostics"}
            flattened["expectedPositiveModes"] = "|".join(row.get("expectedPositiveModes") or [])
            flattened["expectedNegativeModes"] = "|".join(row.get("expectedNegativeModes") or [])
            flattened["predictedModes"] = "|".join(row.get("predictedModes") or [])
            for key, value in diagnostics.items():
                if isinstance(value, (str, int, float, bool)) or value is None:
                    flattened[f"feature_{key}"] = value
                elif isinstance(value, list):
                    flattened[f"feature_{key}"] = "|".join(str(item) for item in value)
            rows.append(flattened)
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields: list[str] = []
    for row in rows:
        for key in row:
            if key not in fields:
                fields.append(key)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def run_evaluation(
    source: Path,
    *,
    performance_confirmed: bool,
    pitch_tolerance_cents: float = DEFAULT_LOCALIZATION_PITCH_TOLERANCE_CENTS,
    max_normalized_path_cost: float = DEFAULT_MAX_NORMALIZED_PATH_COST,
) -> dict[str, Any]:
    intent_path = source / "score-intent.json"
    if not intent_path.is_file():
        raise FileNotFoundError(f"score intent not found: {intent_path}")
    intent = json.loads(intent_path.read_text(encoding="utf-8"))
    recordings = list(intent.get("recordings") or [])
    reports: list[dict[str, Any]] = []
    blockers: list[str] = []
    score_intent_reports: list[dict[str, Any]] = []
    for recording in recordings:
        recording_id = str(recording.get("recordingId") or "").strip()
        score_intent_report = validate_score_technique_intent(source, recording)
        score_intent_report["recordingId"] = recording_id
        score_intent_reports.append(score_intent_report)
        if not score_intent_report["ready"]:
            blockers.append(f"{recording_id}:score-technique-intent-invalid")
        audio_path = source / f"{recording_id}.m4a"
        if not audio_path.is_file():
            reports.append(
                {
                    "recordingId": recording_id,
                    "title": recording.get("title"),
                    "status": "audio-missing",
                    "audioPath": str(audio_path),
                    "scoreTechniqueIntent": score_intent_report,
                    "rows": [],
                }
            )
            blockers.append(f"{recording_id}:audio-missing")
            continue
        try:
            times, midi_track, duration = extract_f0(audio_path)
            recording_report = evaluate_track(
                recording,
                times,
                midi_track,
                duration,
                pitch_tolerance_cents=pitch_tolerance_cents,
                max_normalized_path_cost=max_normalized_path_cost,
            )
            recording_report["audioPath"] = str(audio_path)
            recording_report["scoreTechniqueIntent"] = score_intent_report
            reports.append(recording_report)
            if recording_report["status"] != "ok":
                blockers.append(f"{recording_id}:localization-failed")
        except Exception as error:
            reports.append(
                {
                    "recordingId": recording_id,
                    "title": recording.get("title"),
                    "status": "analysis-failed",
                    "audioPath": str(audio_path),
                    "scoreTechniqueIntent": score_intent_report,
                    "error": f"{type(error).__name__}: {error}",
                    "rows": [],
                }
            )
            blockers.append(f"{recording_id}:analysis-failed")

    rows = flatten_rows(reports)
    metrics = mode_metrics(
        [row for report in reports for row in report.get("rows", [])]
    )
    score_intent_ready = bool(
        len(score_intent_reports) == 4
        and all(report.get("ready") is True for report in score_intent_reports)
    )
    machine_complete = bool(
        score_intent_ready
        and len(reports) == 4
        and all(report.get("status") == "ok" for report in reports)
    )
    mode_gate_passed = bool(
        machine_complete
        and metrics
        and all(metric.get("passed") is True for metric in metrics.values())
    )
    if machine_complete and not mode_gate_passed:
        blockers.append("m3plus-supplemental-mode-threshold-failed")
    if not performance_confirmed:
        blockers.append("m3plus-supplemental-performance-intent-unconfirmed")
    teacher_review_allowed = bool(
        score_intent_ready and machine_complete and mode_gate_passed and performance_confirmed
    )
    status_counts = Counter(str(report.get("status") or "unknown") for report in reports)
    return {
        "schemaVersion": 2,
        "purpose": "M3+ score-conditioned fixed-sequence audio verification",
        "evalOnly": True,
        "studentFacing": False,
        "studentGateReady": False,
        "performanceConfirmedByOwner": bool(performance_confirmed),
        "performanceGoldReady": False,
        "scoreTechniqueIntentReady": score_intent_ready,
        "machineAnalysisComplete": machine_complete,
        "machineModeThresholdPassed": mode_gate_passed,
        "teacherReviewAllowed": teacher_review_allowed,
        "humanTask": (
            "record-m3plus-supplemental-takes"
            if any(report.get("status") == "audio-missing" for report in reports)
            else "confirm-recording-protocol"
            if machine_complete and not performance_confirmed
            else "fix-score-technique-markings"
            if not score_intent_ready
            else "none-engineering-fix-first"
            if not mode_gate_passed
            else "professional-review"
        ),
        "thresholds": {
            "minModePrecision": MIN_MODE_PRECISION,
            "minModeRecall": MIN_MODE_RECALL,
            "minPositivesPerMode": MIN_POSITIVES_PER_MODE,
            "minNegativesPerMode": MIN_NEGATIVES_PER_MODE,
            "localizationPitchToleranceCents": float(pitch_tolerance_cents),
            "maxNormalizedPathCost": float(max_normalized_path_cost),
            "intonationRule": "localization-only; does not certify intonation accuracy",
        },
        "counts": {
            "recordingCount": len(reports),
            "recordingStatusCounts": dict(sorted(status_counts.items())),
            "analyzedUnitCount": len(rows),
        },
        "modeMetrics": metrics,
        "scoreTechniqueIntent": score_intent_reports,
        "blockingReasons": sorted(set(blockers)),
        "recordings": reports,
        "rows": rows,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--performance-confirmed", action="store_true")
    parser.add_argument(
        "--pitch-tolerance-cents",
        type=float,
        default=DEFAULT_LOCALIZATION_PITCH_TOLERANCE_CENTS,
    )
    parser.add_argument(
        "--max-normalized-path-cost",
        type=float,
        default=DEFAULT_MAX_NORMALIZED_PATH_COST,
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    output = args.out.resolve()
    pitch_tolerance_cents = float(args.pitch_tolerance_cents)
    max_normalized_path_cost = float(args.max_normalized_path_cost)
    if not math.isfinite(pitch_tolerance_cents) or pitch_tolerance_cents < 10.0:
        raise SystemExit("--pitch-tolerance-cents must be a finite number >= 10")
    if not math.isfinite(max_normalized_path_cost) or max_normalized_path_cost <= 0.0:
        raise SystemExit("--max-normalized-path-cost must be a finite number > 0")
    report = run_evaluation(
        source,
        performance_confirmed=bool(args.performance_confirmed),
        pitch_tolerance_cents=pitch_tolerance_cents,
        max_normalized_path_cost=max_normalized_path_cost,
    )
    output.mkdir(parents=True, exist_ok=True)
    report_path = output / "supplemental-machine-eval.json"
    csv_path = output / "supplemental-machine-eval.csv"
    report["artifacts"] = {
        "json": str(report_path),
        "csv": str(csv_path),
        "scoreIntent": str(source / "score-intent.json"),
    }
    write_csv(csv_path, report.pop("rows"))
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not report["machineAnalysisComplete"]:
        return 2
    if not report["machineModeThresholdPassed"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
