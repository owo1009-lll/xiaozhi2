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
import os
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
MIN_MODE_DECISION_COVERAGE = 0.80
MIN_POSITIVES_PER_MODE = 4
MIN_NEGATIVES_PER_MODE = 4
CALIBRATION_MAX_MEASURE = 4
MIN_SESSION_STRAIGHT_CONTROLS = 4
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


def periodic_pitch_features(
    times: np.ndarray,
    values: np.ndarray,
    *,
    center_midi: float,
) -> dict[str, float | int | None]:
    """Measure frame-level pitch modulation without quantizing it to notes."""

    if values.size < 12 or times.size != values.size:
        return {
            "periodicDurationSeconds": 0.0,
            "periodicAmplitudeCents": None,
            "periodicDominantRateHz": None,
            "periodicBandEnergyRatio4To8Hz": None,
            "periodicCycleCount": 0.0,
        }
    order = np.argsort(times)
    times = np.asarray(times[order], dtype=np.float64)
    cents = (np.asarray(values[order], dtype=np.float64) - float(center_midi)) * 100.0
    unique = np.r_[True, np.diff(times) > 1e-6]
    times = times[unique]
    cents = cents[unique]
    if times.size < 12:
        return {
            "periodicDurationSeconds": 0.0,
            "periodicAmplitudeCents": None,
            "periodicDominantRateHz": None,
            "periodicBandEnergyRatio4To8Hz": None,
            "periodicCycleCount": 0.0,
        }
    duration = float(times[-1] - times[0])
    frame_step = float(np.median(np.diff(times)))
    if duration <= 0.0 or not math.isfinite(frame_step) or frame_step <= 0.0:
        return {
            "periodicDurationSeconds": max(0.0, duration),
            "periodicAmplitudeCents": None,
            "periodicDominantRateHz": None,
            "periodicBandEnergyRatio4To8Hz": None,
            "periodicCycleCount": 0.0,
        }

    grid = np.arange(times[0], times[-1] + frame_step * 0.5, frame_step)
    regular = np.interp(grid, times, cents)
    elapsed = grid - grid[0]
    if regular.size >= 3:
        slope, intercept = np.polyfit(elapsed, regular, 1)
        residual = regular - (slope * elapsed + intercept)
    else:
        residual = regular - np.median(regular)
    amplitude = float((np.percentile(residual, 95) - np.percentile(residual, 5)) / 2.0)
    if residual.size < 8 or float(np.std(residual)) < 1e-6:
        return {
            "periodicDurationSeconds": duration,
            "periodicAmplitudeCents": amplitude,
            "periodicDominantRateHz": None,
            "periodicBandEnergyRatio4To8Hz": 0.0,
            "periodicCycleCount": 0.0,
        }

    spectrum = np.abs(np.fft.rfft((residual - np.mean(residual)) * np.hanning(residual.size))) ** 2
    frequencies = np.fft.rfftfreq(residual.size, d=frame_step)
    reference = (frequencies >= 1.0) & (frequencies <= 12.0)
    band = (frequencies >= 4.0) & (frequencies <= 8.0)
    reference_power = float(np.sum(spectrum[reference]))
    band_power = float(np.sum(spectrum[band]))
    band_ratio = band_power / reference_power if reference_power > 0.0 else 0.0
    dominant_rate: float | None = None
    if np.any(reference):
        indexes = np.flatnonzero(reference)
        dominant_rate = float(frequencies[indexes[int(np.argmax(spectrum[reference]))]])
    return {
        "periodicDurationSeconds": duration,
        "periodicAmplitudeCents": amplitude,
        "periodicDominantRateHz": dominant_rate,
        "periodicBandEnergyRatio4To8Hz": band_ratio,
        "periodicCycleCount": (dominant_rate or 0.0) * duration,
    }


def mode_state(confirmed: bool, absent: bool) -> str:
    if confirmed:
        return "confirmed"
    if absent:
        return "absent"
    return "uncertain"


def is_vibrato_signature(features: dict[str, float | int | None]) -> bool:
    amplitude = features.get("periodicAmplitudeCents")
    rate = features.get("periodicDominantRateHz")
    band_ratio = features.get("periodicBandEnergyRatio4To8Hz")
    return bool(
        float(features.get("periodicDurationSeconds") or 0.0) >= 0.50
        and amplitude is not None
        and 20.0 <= float(amplitude) <= 80.0
        and rate is not None
        and 4.0 <= float(rate) <= 8.0
        and band_ratio is not None
        and float(band_ratio) >= 0.35
        and float(features.get("periodicCycleCount") or 0.0) >= 2.0
    )


def overlapping_vibrato_support(
    times: np.ndarray,
    midi_track: np.ndarray,
    *,
    start: float,
    end: float,
    center_midi: float,
) -> tuple[int, int]:
    duration = max(0.0, end - start)
    if duration < 0.50:
        return 0, 0
    windows = ((0.0, 0.60), (0.20, 0.80), (0.40, 1.0))
    supporting = 0
    evaluated = 0
    for left, right in windows:
        sub_start = start + duration * left
        sub_end = start + duration * right
        mask = (times >= sub_start) & (times <= sub_end) & np.isfinite(midi_track)
        sub_times = np.asarray(times[mask], dtype=np.float64)
        sub_values = np.asarray(midi_track[mask], dtype=np.float64)
        if sub_values.size < 12:
            continue
        evaluated += 1
        if is_vibrato_signature(
            periodic_pitch_features(sub_times, sub_values, center_midi=center_midi)
        ):
            supporting += 1
    return supporting, evaluated


def infer_modes(
    unit: dict[str, Any],
    times: np.ndarray,
    midi_track: np.ndarray,
    *,
    pitch_tolerance_cents: float = DEFAULT_LOCALIZATION_PITCH_TOLERANCE_CENTS,
) -> tuple[list[str], dict[str, str], dict[str, Any]]:
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
    decisions = {mode: "uncertain" for mode in MODE_NAMES}
    feature_flags = set(features.get("flags") or [])

    mask = (times >= start) & (times <= end) & np.isfinite(midi_track)
    all_frame_mask = (times >= start) & (times <= end)
    local_times = np.asarray(times[mask], dtype=np.float64)
    values = np.asarray(midi_track[mask], dtype=np.float64)
    all_frame_count = int(np.sum(all_frame_mask))
    voiced_coverage = values.size / all_frame_count if all_frame_count else 0.0
    octave_jump_count = int(np.sum(np.abs(np.diff(values)) >= 8.0)) if values.size >= 2 else 0
    octave_jump_rate = octave_jump_count / max(1, values.size - 1)
    f0_quality_ready = bool(
        values.size >= 12 and voiced_coverage >= 0.70 and octave_jump_rate <= 0.05
    )
    periodic = periodic_pitch_features(local_times, values, center_midi=base)
    vibrato_supporting_subwindows, vibrato_evaluated_subwindows = overlapping_vibrato_support(
        times,
        midi_track,
        start=start,
        end=end,
        center_midi=base,
    )
    auxiliary = unit.get("auxiliaryMidi")
    switch_count = 0
    upper_bouts = 0
    upper_ratio = 0.0
    tail_base_ratio = 0.0
    known_pair_net_motion = 0.0
    known_pair_monotonicity = 0.0
    known_pair_switch_rate_hz = 0.0
    known_pair_support_rate = 0.0
    known_pair_directional_step_rate = 0.0
    known_pair_transition_seconds = 0.0
    ornament_upper_seconds = 0.0
    ornament_first_upper_offset_seconds: float | None = None
    if auxiliary is not None and values.size:
        auxiliary = float(auxiliary)
        base_distance = np.abs(values - base)
        upper_distance = np.abs(values - auxiliary)
        close = np.minimum(base_distance, upper_distance) <= max(
            0.1, float(pitch_tolerance_cents) / 100.0
        )
        close_times = local_times[close]
        labels = (upper_distance[close] < base_distance[close]).astype(np.int8)
        switch_count, upper_bouts = binary_switch_stats(labels)
        upper_ratio = float(np.mean(labels == 1)) if labels.size else 0.0
        known_pair_support_rate = float(np.mean(close)) if close.size else 0.0
        pair_duration = float(close_times[-1] - close_times[0]) if close_times.size >= 2 else 0.0
        known_pair_switch_rate_hz = switch_count / max(0.001, 2.0 * pair_duration)
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
        interval = abs(auxiliary - base)
        direction = math.copysign(1.0, auxiliary - base)
        progress = (values - base) * direction / max(0.001, interval)
        if progress.size >= 2:
            directional_steps = np.diff(progress)
            meaningful_steps = directional_steps[np.abs(directional_steps) >= 0.01]
            if meaningful_steps.size:
                known_pair_directional_step_rate = float(np.mean(meaningful_steps >= 0.0))
            transition_mask = (progress >= 0.10) & (progress <= 0.90)
            transition_times = local_times[transition_mask]
            if transition_times.size >= 2:
                known_pair_transition_seconds = float(transition_times[-1] - transition_times[0])
        if labels.size:
            frame_step = (
                float(np.median(np.diff(close_times))) if close_times.size >= 2 else 0.0
            )
            ornament_upper_seconds = float(np.sum(labels == 1) * max(0.0, frame_step))
            upper_indexes = np.flatnonzero(labels == 1)
            if upper_indexes.size:
                ornament_first_upper_offset_seconds = float(
                    close_times[upper_indexes[0]] - start
                )

        trill_confirmed = bool(
            0.8 <= interval <= 2.2
            and 0.10 <= upper_ratio <= 0.90
            and switch_count >= 4
            and upper_bouts >= 2
            and 4.0 <= known_pair_switch_rate_hz <= 12.0
            and known_pair_support_rate >= 0.60
        )
        trill_absent = bool(upper_ratio < 0.03 or switch_count < 2)
        decisions["trill"] = mode_state(trill_confirmed, trill_absent)

        ornament_confirmed = bool(
            0.02 <= upper_ratio <= 0.40
            and 1 <= upper_bouts <= 2
            and 2 <= switch_count <= 4
            and tail_base_ratio >= 0.70
            and 0.04 <= ornament_upper_seconds <= 0.25
            and ornament_first_upper_offset_seconds is not None
            and ornament_first_upper_offset_seconds <= 0.25
        )
        ornament_absent = bool(upper_ratio < 0.02 or upper_bouts == 0)
        decisions["ornament"] = mode_state(ornament_confirmed, ornament_absent)

        slide_confirmed = bool(
            interval >= 0.8
            and known_pair_net_motion >= 0.70 * interval
            and abs(head_median - base) <= 0.5
            and abs(tail_median - auxiliary) <= 0.5
            and known_pair_monotonicity >= 0.45
            and known_pair_directional_step_rate >= 0.65
            and known_pair_transition_seconds >= 0.10
        )
        slide_absent = bool(
            known_pair_net_motion < 0.35 * interval
            or known_pair_transition_seconds < 0.05
        )
        decisions["slide"] = mode_state(slide_confirmed, slide_absent)
    else:
        decisions["trill"] = "confirmed" if "trill-like" in feature_flags else "absent"
        decisions["slide"] = "confirmed" if "slide-like" in feature_flags else "absent"
        decisions["ornament"] = "absent" if values.size >= 12 else "uncertain"

    periodic_duration = float(periodic["periodicDurationSeconds"] or 0.0)
    periodic_amplitude = periodic["periodicAmplitudeCents"]
    periodic_band_ratio = periodic["periodicBandEnergyRatio4To8Hz"]
    vibrato_confirmed = bool(
        auxiliary is None
        and is_vibrato_signature(periodic)
        and vibrato_evaluated_subwindows >= 2
        and vibrato_supporting_subwindows >= 2
    )
    vibrato_absent = bool(
        periodic_duration >= 0.50
        and periodic_amplitude is not None
        and (
            float(periodic_amplitude) <= 12.0
            or periodic_band_ratio is None
            or float(periodic_band_ratio) < 0.15
        )
    )
    decisions["vibrato"] = mode_state(vibrato_confirmed, vibrato_absent)

    # Resolved score-conditioned trill/slide evidence takes precedence over the
    # broad periodic envelope. This avoids double-labeling square-wave trills.
    if decisions["trill"] == "confirmed" or decisions["slide"] == "confirmed":
        decisions["vibrato"] = "absent"

    if not bool(unit.get("localizationUnitReady")) or not f0_quality_ready:
        decisions = {mode: "uncertain" for mode in MODE_NAMES}
    predicted = {mode for mode, state in decisions.items() if state == "confirmed"}

    diagnostics = {
        **features,
        **periodic,
        "windowFrameCount": all_frame_count,
        "voicedCoverageRate": round(voiced_coverage, 6),
        "octaveJumpCount": octave_jump_count,
        "octaveJumpRate": round(octave_jump_rate, 6),
        "f0QualityReady": f0_quality_ready,
        "vibratoSupportingSubwindows": vibrato_supporting_subwindows,
        "vibratoEvaluatedSubwindows": vibrato_evaluated_subwindows,
        "knownPitchSwitchCount": switch_count,
        "knownUpperBoutCount": upper_bouts,
        "knownUpperFrameRatio": round(upper_ratio, 6),
        "knownTailBaseRatio": round(tail_base_ratio, 6),
        "knownPairNetMotionSemitones": round(known_pair_net_motion, 6),
        "knownPairMonotonicity": round(known_pair_monotonicity, 6),
        "knownPairSwitchRateHz": round(known_pair_switch_rate_hz, 6),
        "knownPairSupportRate": round(known_pair_support_rate, 6),
        "knownPairDirectionalStepRate": round(known_pair_directional_step_rate, 6),
        "knownPairTransitionSeconds": round(known_pair_transition_seconds, 6),
        "ornamentUpperSeconds": round(ornament_upper_seconds, 6),
        "ornamentFirstUpperOffsetSeconds": (
            round(ornament_first_upper_offset_seconds, 6)
            if ornament_first_upper_offset_seconds is not None
            else None
        ),
    }
    return sorted(predicted), decisions, diagnostics


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
        predicted_modes, mode_decisions, diagnostics = infer_modes(
            unit,
            times,
            midi_track,
            pitch_tolerance_cents=pitch_tolerance_cents,
        )
        rows.append(
            {
                **unit,
                "evaluationSplit": (
                    "calibration"
                    if int(unit.get("measure") or 0) <= CALIBRATION_MAX_MEASURE
                    else "holdout"
                ),
                "startSeconds": round(float(unit["startSeconds"]), 4),
                "endSeconds": round(float(unit["endSeconds"]), 4),
                "durationSeconds": round(float(unit["durationSeconds"]), 4),
                "durationRatioToMedian": round(float(unit["durationRatioToMedian"]), 4),
                "pitchSupportRate": round(float(unit["pitchSupportRate"]), 6),
                "predictedModes": predicted_modes,
                "modeDecisions": mode_decisions,
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


def robust_center_scale(values: list[float]) -> tuple[float | None, float | None]:
    finite = np.asarray([value for value in values if math.isfinite(value)], dtype=np.float64)
    if finite.size == 0:
        return None, None
    center = float(np.median(finite))
    mad = float(np.median(np.abs(finite - center)))
    return center, 1.4826 * mad


def attach_session_pitch_baseline(recording_reports: list[dict[str, Any]]) -> dict[str, Any]:
    """Attach a coarse straight/active comparison without changing mode labels.

    Only explicitly instructed straight-tone calibration units are eligible.
    The baseline is descriptive until real recordings prove that relative
    activity improves held-out precision and recall.
    """

    rows = [row for report in recording_reports for row in report.get("rows", [])]
    controls = [
        row
        for row in rows
        if row.get("evaluationSplit") == "calibration"
        and row.get("expectedBehavior") == "stable"
        and bool((row.get("modeDiagnostics") or {}).get("f0QualityReady"))
    ]
    amplitude_values = [
        float((row.get("modeDiagnostics") or {}).get("periodicAmplitudeCents"))
        for row in controls
        if (row.get("modeDiagnostics") or {}).get("periodicAmplitudeCents") is not None
    ]
    band_values = [
        float((row.get("modeDiagnostics") or {}).get("periodicBandEnergyRatio4To8Hz"))
        for row in controls
        if (row.get("modeDiagnostics") or {}).get("periodicBandEnergyRatio4To8Hz") is not None
    ]
    amplitude_center, amplitude_scale = robust_center_scale(amplitude_values)
    band_center, band_scale = robust_center_scale(band_values)
    ready = bool(
        len(controls) >= MIN_SESSION_STRAIGHT_CONTROLS
        and amplitude_center is not None
        and band_center is not None
    )
    baseline = {
        "ready": ready,
        "source": "explicit-straight-calibration-units",
        "controlCount": len(controls),
        "minControlCount": MIN_SESSION_STRAIGHT_CONTROLS,
        "amplitudeMedianCents": round(amplitude_center, 6) if amplitude_center is not None else None,
        "amplitudeRobustScaleCents": round(amplitude_scale, 6) if amplitude_scale is not None else None,
        "bandEnergyMedian4To8Hz": round(band_center, 6) if band_center is not None else None,
        "bandEnergyRobustScale4To8Hz": round(band_scale, 6) if band_scale is not None else None,
        "decisionUse": "diagnostic-only-until-heldout-validation",
    }
    for row in rows:
        diagnostics = row.get("modeDiagnostics") or {}
        diagnostics["sessionPitchBaselineReady"] = ready
        diagnostics["relativePitchActivityState"] = "uncertain"
        if not ready or not bool(diagnostics.get("f0QualityReady")):
            continue
        amplitude = diagnostics.get("periodicAmplitudeCents")
        band_ratio = diagnostics.get("periodicBandEnergyRatio4To8Hz")
        if amplitude is None or band_ratio is None:
            continue
        amplitude = float(amplitude)
        band_ratio = float(band_ratio)
        amp_scale = float(amplitude_scale or 0.0)
        local_band_scale = float(band_scale or 0.0)
        amp_margin = max(8.0, 3.0 * amp_scale)
        band_margin = max(0.10, 3.0 * local_band_scale)
        diagnostics["relativeAmplitudeDeltaCents"] = round(amplitude - float(amplitude_center), 6)
        diagnostics["relativeBandEnergyDelta4To8Hz"] = round(band_ratio - float(band_center), 6)
        if amplitude <= float(amplitude_center) + amp_margin and band_ratio <= float(band_center) + band_margin:
            diagnostics["relativePitchActivityState"] = "straight"
        elif amplitude >= float(amplitude_center) + amp_margin and band_ratio >= float(band_center) + band_margin:
            diagnostics["relativePitchActivityState"] = "active"
    return baseline


def resolve_f0_backend(requested: str) -> str:
    backend = str(requested or "auto").strip().lower()
    if backend not in {"auto", "crepe", "pyin"}:
        raise ValueError(f"unsupported-f0-backend:{backend}")
    if backend != "auto":
        return backend
    try:
        import torchcrepe  # noqa: F401
    except ImportError:
        return "pyin"
    return "crepe"


def _extract_pyin_f0(audio_path: Path) -> tuple[np.ndarray, np.ndarray, float]:
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


def _extract_crepe_f0(audio_path: Path) -> tuple[np.ndarray, np.ndarray, float]:
    """Extract an unsmoothed frame-level F0 track for technique evidence.

    Median/Viterbi smoothing is deliberately omitted because it can erase the
    fast pitch alternation that distinguishes a trill from vibrato. Runtime
    thread limits come from ``ERHU_CPU_THREAD_LIMIT`` and the shared npm/Python
    launchers, so this remains a bounded offline calibration step.
    """

    try:
        import torch
        import torchcrepe
    except ImportError as error:
        raise RuntimeError("torchcrepe-unavailable") from error

    sample_rate = 16000
    hop_length = 160
    waveform, _ = load_audio_mono(audio_path, target_sr=sample_rate)
    if waveform.size == 0:
        raise ValueError("audio-empty")
    thread_limit = max(1, int(os.getenv("ERHU_CPU_THREAD_LIMIT", "2") or 2))
    torch.set_num_threads(thread_limit)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    audio = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0).to(device)
    with torch.no_grad():
        f0, periodicity = torchcrepe.predict(
            audio,
            sample_rate,
            hop_length,
            130.0,
            2000.0,
            model="tiny",
            batch_size=1024,
            device=device,
            return_periodicity=True,
        )
    f0_values = f0.squeeze(0).detach().cpu().numpy().astype(np.float64)
    periodicity_values = (
        periodicity.squeeze(0).detach().cpu().numpy().astype(np.float64)
    )
    times = np.arange(f0_values.size, dtype=np.float64) * (hop_length / sample_rate)
    valid = (
        np.isfinite(f0_values)
        & (f0_values > 0.0)
        & np.isfinite(periodicity_values)
        & (periodicity_values >= 0.30)
    )
    midi_track = np.full_like(f0_values, np.nan, dtype=np.float64)
    midi_track[valid] = librosa.hz_to_midi(f0_values[valid])
    return times, midi_track, float(waveform.size / sample_rate)


def extract_f0(
    audio_path: Path,
    *,
    backend: str = "pyin",
) -> tuple[np.ndarray, np.ndarray, float]:
    resolved = resolve_f0_backend(backend)
    if resolved == "crepe":
        return _extract_crepe_f0(audio_path)
    return _extract_pyin_f0(audio_path)


def mode_metrics(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for mode in MODE_NAMES:
        tp = fp = tn = fn = 0
        uncertain_positive = uncertain_negative = 0
        for row in rows:
            positives = set(row.get("expectedPositiveModes") or [])
            negatives = set(row.get("expectedNegativeModes") or [])
            if mode not in positives and mode not in negatives:
                continue
            expected = mode in positives
            decision = str((row.get("modeDecisions") or {}).get(mode) or "uncertain")
            if decision == "uncertain":
                if expected:
                    uncertain_positive += 1
                else:
                    uncertain_negative += 1
            elif expected and decision == "confirmed":
                tp += 1
            elif expected and decision == "absent":
                fn += 1
            elif decision == "confirmed":
                fp += 1
            else:
                tn += 1
        positive_count = tp + fn + uncertain_positive
        negative_count = tn + fp + uncertain_negative
        precision = tp / (tp + fp) if tp + fp else None
        recall = tp / positive_count if positive_count else None
        specificity = tn / negative_count if negative_count else None
        labeled_count = positive_count + negative_count
        decided_count = tp + fp + tn + fn
        decision_coverage = decided_count / labeled_count if labeled_count else 0.0
        passed = bool(
            positive_count >= MIN_POSITIVES_PER_MODE
            and negative_count >= MIN_NEGATIVES_PER_MODE
            and precision is not None
            and precision >= MIN_MODE_PRECISION
            and recall is not None
            and recall >= MIN_MODE_RECALL
            and decision_coverage >= MIN_MODE_DECISION_COVERAGE
        )
        result[mode] = {
            "positiveCount": positive_count,
            "negativeCount": negative_count,
            "truePositive": tp,
            "falsePositive": fp,
            "trueNegative": tn,
            "falseNegative": fn,
            "uncertainPositive": uncertain_positive,
            "uncertainNegative": uncertain_negative,
            "precision": round(precision, 6) if precision is not None else None,
            "recall": round(recall, 6) if recall is not None else None,
            "specificity": round(specificity, 6) if specificity is not None else None,
            "decisionCoverage": round(decision_coverage, 6),
            "passed": passed,
        }
    return result


def flatten_rows(recording_reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for report in recording_reports:
        for row in report.get("rows", []):
            diagnostics = row.get("modeDiagnostics") or {}
            decisions = row.get("modeDecisions") or {}
            flattened = {
                key: value
                for key, value in row.items()
                if key not in {"modeDiagnostics", "modeDecisions"}
            }
            flattened["expectedPositiveModes"] = "|".join(row.get("expectedPositiveModes") or [])
            flattened["expectedNegativeModes"] = "|".join(row.get("expectedNegativeModes") or [])
            flattened["predictedModes"] = "|".join(row.get("predictedModes") or [])
            for mode in MODE_NAMES:
                flattened[f"decision_{mode}"] = decisions.get(mode, "uncertain")
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
    f0_backend: str = "auto",
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
    resolved_f0_backend = resolve_f0_backend(f0_backend)
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
            times, midi_track, duration = extract_f0(
                audio_path,
                backend=resolved_f0_backend,
            )
            recording_report = evaluate_track(
                recording,
                times,
                midi_track,
                duration,
                pitch_tolerance_cents=pitch_tolerance_cents,
                max_normalized_path_cost=max_normalized_path_cost,
            )
            recording_report["audioPath"] = str(audio_path)
            recording_report["f0Backend"] = resolved_f0_backend
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

    session_pitch_baseline = attach_session_pitch_baseline(reports)
    raw_rows = [row for report in reports for row in report.get("rows", [])]
    rows = flatten_rows(reports)
    metrics_all = mode_metrics(raw_rows)
    metrics_calibration = mode_metrics(
        [row for row in raw_rows if row.get("evaluationSplit") == "calibration"]
    )
    metrics_holdout = mode_metrics(
        [row for row in raw_rows if row.get("evaluationSplit") == "holdout"]
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
        and metrics_holdout
        and all(metric.get("passed") is True for metric in metrics_holdout.values())
    )
    release_ready_modes = sorted(
        mode
        for mode, metric in metrics_holdout.items()
        if machine_complete and metric.get("passed") is True
    )
    review_only_modes = sorted(mode for mode in MODE_NAMES if mode not in release_ready_modes)
    if machine_complete and not mode_gate_passed:
        blockers.append("m3plus-supplemental-mode-threshold-failed")
    if not performance_confirmed:
        blockers.append("m3plus-supplemental-performance-intent-unconfirmed")
    teacher_review_allowed = bool(
        score_intent_ready and machine_complete and mode_gate_passed and performance_confirmed
    )
    teacher_review_allowed_modes = (
        release_ready_modes if score_intent_ready and machine_complete and performance_confirmed else []
    )
    status_counts = Counter(str(report.get("status") or "unknown") for report in reports)
    return {
        "schemaVersion": 3,
        "purpose": "M3+ score-conditioned fixed-sequence audio verification",
        "evalOnly": True,
        "studentFacing": False,
        "studentGateReady": False,
        "performanceConfirmedByOwner": bool(performance_confirmed),
        "performanceGoldReady": False,
        "scoreTechniqueIntentReady": score_intent_ready,
        "f0Backend": resolved_f0_backend,
        "machineAnalysisComplete": machine_complete,
        "machineModeThresholdPassed": mode_gate_passed,
        "machineReleaseReadyModes": release_ready_modes,
        "machineReviewOnlyModes": review_only_modes,
        "teacherReviewAllowed": teacher_review_allowed,
        "teacherReviewAllowedModes": teacher_review_allowed_modes,
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
            "minModeDecisionCoverage": MIN_MODE_DECISION_COVERAGE,
            "minPositivesPerMode": MIN_POSITIVES_PER_MODE,
            "minNegativesPerMode": MIN_NEGATIVES_PER_MODE,
            "localizationPitchToleranceCents": float(pitch_tolerance_cents),
            "maxNormalizedPathCost": float(max_normalized_path_cost),
            "intonationRule": "localization-only; does not certify intonation accuracy",
            "evaluationPolicy": "measures-1-to-4-calibration; measures-5-to-8-holdout",
            "f0BackendPolicy": "CREPE tiny preferred when installed; pYIN is the bounded fallback",
        },
        "counts": {
            "recordingCount": len(reports),
            "recordingStatusCounts": dict(sorted(status_counts.items())),
            "analyzedUnitCount": len(rows),
        },
        "sessionPitchBaseline": session_pitch_baseline,
        "modeMetrics": metrics_holdout,
        "modeMetricsHoldout": metrics_holdout,
        "modeMetricsCalibration": metrics_calibration,
        "modeMetricsAll": metrics_all,
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
        "--f0-backend",
        choices=("auto", "crepe", "pyin"),
        default="auto",
        help="frame-level F0 backend; auto prefers CREPE and falls back to pYIN",
    )
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
        f0_backend=str(args.f0_backend),
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
