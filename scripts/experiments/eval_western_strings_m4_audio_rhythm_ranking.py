#!/usr/bin/env python3
"""Test whether relative audio IOI can rank clean gold above an OMR draft.

The probe is eval-only. It compares within-measure relative IOI shapes after
pitch-sequence alignment, so global tempo does not matter. It never edits a
score and cannot turn performance agreement into independent score truth.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = Path(__file__).resolve().parent
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_omr_benchmark import repo_path  # noqa: E402
from eval_western_strings_m4_rhythm_candidate_oracle import (  # noqa: E402
    COMMON_METER_QUARTERS,
    TICKS_PER_QUARTER,
    _best_part_measures,
    exact_pitch_measure_pairs,
    generate_visual_rhythm_candidates,
    parse_measure_rhythms_many,
)
from proto_western_strings_score_anchored_feedback import (  # noqa: E402
    PRIVATE,
    align,
    audio_events,
)


DEFAULT_BENCHMARK = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-source-benchmark"
    / "omr-benchmark.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "audio-rhythm-ranking"
)
MIN_INTERVALS = 12
MIN_INTERVAL_COVERAGE = 0.30
SELECTION_MARGIN = 0.05
MEASURE_MIN_INTERVALS = 2
MEASURE_MIN_INTERVAL_COVERAGE = 0.60
MEASURE_MARGIN_GRID = (0.0, 0.02, 0.05, 0.08, 0.12, 0.20, 0.30)
# The visual-oracle sweep found that 16/32 paths retain only 60% of gold
# rhythms, while 512 reaches 96% (48/50).  This is eval-only; runtime remains
# disabled until the independent selector gate passes.
GENERATED_TOP_K_PER_METER = 512


def timed_mxl_events(path: Path, *, offset: float = 0.0, measure_offset: int = 0) -> list[dict[str, Any]]:
    from music21 import converter

    score = converter.parse(str(path))
    events: dict[float, dict[str, Any]] = {}
    for note in score.flatten().notes:
        onset = round(float(note.offset) + offset, 6)
        event = events.setdefault(
            onset,
            {
                "offsetQuarters": onset,
                "measure": int(note.measureNumber or 0) + measure_offset,
                "midis": set(),
            },
        )
        event["midis"].update(int(pitch.midi) for pitch in note.pitches)
    return [
        {**events[key], "midis": sorted(events[key]["midis"])}
        for key in sorted(events)
    ]


def timed_mxl_events_many(paths: list[Path]) -> list[dict[str, Any]]:
    combined: list[dict[str, Any]] = []
    offset = 0.0
    measure_offset = 0
    for path in paths:
        events = timed_mxl_events(path, offset=offset, measure_offset=measure_offset)
        combined.extend(events)
        if events:
            local_offsets = [float(event["offsetQuarters"]) for event in events]
            positive_steps = [
                right - left
                for left, right in zip(local_offsets, local_offsets[1:])
                if right > left
            ]
            tail = float(np.median(positive_steps)) if positive_steps else 1.0
            offset = max(local_offsets) + max(0.125, tail)
            measure_offset = max(int(event["measure"]) for event in events)
    return combined


def normalized_ioi_error(score_ioi: list[float], audio_ioi: list[float]) -> float | None:
    if len(score_ioi) != len(audio_ioi) or len(score_ioi) < 2:
        return None
    score = np.asarray(score_ioi, dtype=np.float64)
    audio = np.asarray(audio_ioi, dtype=np.float64)
    valid = np.isfinite(score) & np.isfinite(audio) & (score > 0.0) & (audio > 0.0)
    score = score[valid]
    audio = audio[valid]
    if score.size < 2:
        return None
    score /= float(np.median(score))
    audio /= float(np.median(audio))
    return float(np.mean(np.abs(np.log2(audio / score))))


def extract_pyin_track(audio_path: Path) -> dict[str, Any]:
    import librosa

    waveform, sample_rate = librosa.load(str(audio_path), sr=22050, mono=True)
    hop_length = 256
    onset_frames = librosa.onset.onset_detect(
        y=waveform,
        sr=sample_rate,
        hop_length=hop_length,
        units="frames",
        backtrack=False,
    )
    f0, voiced, _ = librosa.pyin(
        waveform,
        fmin=float(librosa.note_to_hz("C3")),
        fmax=float(librosa.note_to_hz("A7")),
        sr=sample_rate,
        hop_length=hop_length,
        frame_length=2048,
    )
    frame_times = librosa.frames_to_time(np.arange(len(f0)), sr=sample_rate, hop_length=hop_length)
    valid = np.asarray(voiced, dtype=bool) & np.isfinite(f0)
    midi = np.full(len(f0), np.nan, dtype=np.float64)
    midi[valid] = librosa.hz_to_midi(f0[valid])
    return {
        "waveform": waveform,
        "sampleRate": sample_rate,
        "hopLength": hop_length,
        "f0": f0,
        "midi": midi,
        "valid": valid,
        "frameTimes": frame_times,
        "onsetFrames": onset_frames,
    }


def augment_audio_onsets(
    audio_path: Path,
    basic_events: list[dict[str, Any]],
    pyin_track: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Add pitch-supported flux/voicing onsets without trusting onset-only peaks."""

    import librosa

    track = pyin_track or extract_pyin_track(audio_path)
    sample_rate = int(track["sampleRate"])
    hop_length = int(track["hopLength"])
    onset_frames = np.asarray(track["onsetFrames"])
    f0 = np.asarray(track["f0"])
    frame_times = np.asarray(track["frameTimes"])
    valid = np.asarray(track["valid"], dtype=bool)
    voiced_starts = np.flatnonzero(valid & np.r_[True, ~valid[:-1]])
    candidate_times = sorted(
        set(float(value) for value in librosa.frames_to_time(onset_frames, sr=sample_rate, hop_length=hop_length))
        | set(float(frame_times[index]) for index in voiced_starts)
    )
    augmented = [dict(event) for event in basic_events]
    existing_starts = [float(event["start"]) for event in augmented]
    for start in candidate_times:
        if any(abs(start - existing) <= 0.08 for existing in existing_starts):
            continue
        indexes = np.flatnonzero(
            (frame_times >= max(0.0, start - 0.02))
            & (frame_times <= start + 0.18)
            & valid
        )
        if indexes.size < 4:
            continue
        midi_values = librosa.hz_to_midi(f0[indexes])
        if float(np.percentile(midi_values, 90) - np.percentile(midi_values, 10)) > 1.5:
            continue
        midi = int(round(float(np.median(midi_values))))
        augmented.append(
            {
                "start": start,
                "end": start + 0.15,
                "midis": [midi],
                "source": "spectral-flux-or-voicing-boundary",
            }
        )
        existing_starts.append(start)
    return sorted(augmented, key=lambda event: float(event["start"]))


def score_relative_ioi(events: list[dict[str, Any]], detected: list[dict[str, Any]]) -> dict[str, Any]:
    mapping, _ = align(events, detected)
    by_measure: dict[int, list[int]] = {}
    for index, event in enumerate(events):
        by_measure.setdefault(int(event.get("measure") or 0), []).append(index)
    possible_intervals = 0
    evaluated_intervals = 0
    measure_errors: list[tuple[float, int]] = []
    for measure, indexes in sorted(by_measure.items()):
        if measure <= 0 or len(indexes) < 3:
            continue
        possible_intervals += len(indexes) - 1
        score_ioi: list[float] = []
        audio_ioi: list[float] = []
        for left, right in zip(indexes, indexes[1:]):
            left_audio = mapping[left]
            right_audio = mapping[right]
            if left_audio is None or right_audio is None or right_audio <= left_audio:
                continue
            expected = float(events[right]["offsetQuarters"]) - float(events[left]["offsetQuarters"])
            observed = float(detected[right_audio]["start"]) - float(detected[left_audio]["start"])
            if expected <= 0.0 or observed <= 0.0:
                continue
            score_ioi.append(expected)
            audio_ioi.append(observed)
        error = normalized_ioi_error(score_ioi, audio_ioi)
        if error is not None:
            measure_errors.append((error, len(score_ioi)))
            evaluated_intervals += len(score_ioi)
    weighted_error = (
        sum(error * count for error, count in measure_errors)
        / sum(count for _, count in measure_errors)
        if measure_errors
        else None
    )
    coverage = evaluated_intervals / possible_intervals if possible_intervals else 0.0
    return {
        "relativeIoiError": round(weighted_error, 6) if weighted_error is not None else None,
        "evaluatedMeasureCount": len(measure_errors),
        "evaluatedIntervalCount": evaluated_intervals,
        "possibleIntervalCount": possible_intervals,
        "intervalCoverage": round(coverage, 6),
        "evidenceReady": bool(
            weighted_error is not None
            and evaluated_intervals >= MIN_INTERVALS
            and coverage >= MIN_INTERVAL_COVERAGE
        ),
    }


def select_candidate(gold: dict[str, Any], draft: dict[str, Any]) -> str:
    if not gold.get("evidenceReady") or not draft.get("evidenceReady"):
        return "uncertain"
    gold_error = float(gold["relativeIoiError"])
    draft_error = float(draft["relativeIoiError"])
    if gold_error + SELECTION_MARGIN < draft_error:
        return "gold"
    if draft_error + SELECTION_MARGIN < gold_error:
        return "draft"
    return "uncertain"


def score_measure_relative_ioi(
    events: list[dict[str, Any]],
    mapping: list[int | None],
    detected: list[dict[str, Any]],
    measure: int,
) -> dict[str, Any]:
    """Score one monophonic measure against aligned audio onset intervals."""

    indexes = [
        index
        for index, event in enumerate(events)
        if int(event.get("measure") or 0) == int(measure)
    ]
    if len(indexes) < 3 or any(len(events[index].get("midis") or []) != 1 for index in indexes):
        return {
            "relativeIoiError": None,
            "evaluatedIntervalCount": 0,
            "possibleIntervalCount": max(0, len(indexes) - 1),
            "intervalCoverage": 0.0,
            "evidenceReady": False,
        }
    score_ioi: list[float] = []
    audio_ioi: list[float] = []
    for left, right in zip(indexes, indexes[1:]):
        left_audio = mapping[left]
        right_audio = mapping[right]
        if left_audio is None or right_audio is None or right_audio <= left_audio:
            continue
        expected = float(events[right]["offsetQuarters"]) - float(events[left]["offsetQuarters"])
        observed = float(detected[right_audio]["start"]) - float(detected[left_audio]["start"])
        if expected <= 0.0 or observed <= 0.0:
            continue
        score_ioi.append(expected)
        audio_ioi.append(observed)
    error = normalized_ioi_error(score_ioi, audio_ioi)
    possible = len(indexes) - 1
    evaluated = len(score_ioi)
    coverage = evaluated / possible if possible else 0.0
    return {
        "relativeIoiError": round(error, 6) if error is not None else None,
        "evaluatedIntervalCount": evaluated,
        "possibleIntervalCount": possible,
        "intervalCoverage": round(coverage, 6),
        "evidenceReady": bool(
            error is not None
            and evaluated >= MEASURE_MIN_INTERVALS
            and coverage >= MEASURE_MIN_INTERVAL_COVERAGE
        ),
    }


def observed_measure_intervals(
    events: list[dict[str, Any]],
    mapping: list[int | None],
    detected: list[dict[str, Any]],
    measure: int,
) -> dict[str, Any]:
    indexes = [
        index
        for index, event in enumerate(events)
        if int(event.get("measure") or 0) == int(measure)
    ]
    possible = max(0, len(indexes) - 1)
    if len(indexes) < 3 or any(len(events[index].get("midis") or []) != 1 for index in indexes):
        return {"possibleIntervalCount": possible, "intervals": []}
    intervals = []
    for local_index, (left, right) in enumerate(zip(indexes, indexes[1:])):
        left_audio = mapping[left]
        right_audio = mapping[right]
        if left_audio is None or right_audio is None or right_audio <= left_audio:
            continue
        observed = float(detected[right_audio]["start"]) - float(detected[left_audio]["start"])
        if observed > 0.0:
            intervals.append({"intervalIndex": local_index, "observedSeconds": observed})
    return {"possibleIntervalCount": possible, "intervals": intervals}


def observed_measure_f0_shape(
    events: list[dict[str, Any]],
    mapping: list[int | None],
    detected: list[dict[str, Any]],
    measure: int,
    pyin_track: dict[str, Any],
) -> dict[str, Any]:
    """Return a pitch contour bounded by independently detected endpoint notes."""

    indexes = [
        index
        for index, event in enumerate(events)
        if int(event.get("measure") or 0) == int(measure)
    ]
    if len(indexes) < 3 or any(len(events[index].get("midis") or []) != 1 for index in indexes):
        return {"evidenceReady": False, "reason": "not-monophonic-or-too-short"}
    first_audio = mapping[indexes[0]]
    last_audio = mapping[indexes[-1]]
    if (
        first_audio is None
        or last_audio is None
        or last_audio < first_audio
        or first_audio >= len(detected)
        or last_audio >= len(detected)
    ):
        return {"evidenceReady": False, "reason": "endpoint-mapping-missing"}
    start = float(detected[first_audio]["start"])
    end = float(detected[last_audio].get("end") or detected[last_audio]["start"])
    if end - start < 0.25:
        return {"evidenceReady": False, "reason": "endpoint-span-too-short"}

    frame_times = np.asarray(pyin_track["frameTimes"], dtype=np.float64)
    frame_midi = np.asarray(pyin_track["midi"], dtype=np.float64)
    valid = np.asarray(pyin_track["valid"], dtype=bool)
    selected = (frame_times >= start) & (frame_times <= end)
    selected_count = int(selected.sum())
    voiced_count = int((selected & valid).sum())
    voiced_coverage = voiced_count / selected_count if selected_count else 0.0
    return {
        "evidenceReady": bool(selected_count >= 20 and voiced_count >= 12 and voiced_coverage >= 0.50),
        "reason": None if selected_count else "no-frames-in-window",
        "startSeconds": start,
        "endSeconds": end,
        "frameTimes": frame_times[selected],
        "frameMidi": frame_midi[selected],
        "frameValid": valid[selected],
        "frameCount": selected_count,
        "voicedFrameCount": voiced_count,
        "voicedCoverage": round(voiced_coverage, 6),
    }


def score_generated_candidate_f0(
    candidate: dict[str, Any],
    draft_measure: Any,
    observation: dict[str, Any],
) -> dict[str, Any]:
    """Score duration shape against continuous f0 without note-onset labels."""

    if not observation.get("evidenceReady"):
        return {
            "shapeError": None,
            "evaluatedFrameCount": 0,
            "frameCoverage": 0.0,
            "evidenceReady": False,
        }
    durations = [int(value) for value in candidate.get("durationTicks") or []]
    if len(durations) != len(draft_measure.tokens):
        return {
            "shapeError": None,
            "evaluatedFrameCount": 0,
            "frameCoverage": 0.0,
            "evidenceReady": False,
        }
    target_ticks = int(candidate.get("targetTicks") or 0)
    start = float(observation["startSeconds"])
    end = float(observation["endSeconds"])
    times = np.asarray(observation["frameTimes"], dtype=np.float64)
    midi = np.asarray(observation["frameMidi"], dtype=np.float64)
    valid = np.asarray(observation["frameValid"], dtype=bool)
    if target_ticks <= 0 or end <= start or not times.size:
        return {
            "shapeError": None,
            "evaluatedFrameCount": 0,
            "frameCoverage": 0.0,
            "evidenceReady": False,
        }

    phase_ticks = np.clip((times - start) / (end - start), 0.0, 1.0) * target_ticks
    expected = np.full(times.shape, np.nan, dtype=np.float64)
    cursor = 0
    pitch_index = 0
    for token, ticks in zip(draft_measure.tokens, durations):
        next_cursor = cursor + ticks
        if token.sounding_note:
            if pitch_index >= len(draft_measure.pitches):
                break
            mask = (phase_ticks >= cursor) & (
                (phase_ticks < next_cursor)
                | ((next_cursor == target_ticks) & (phase_ticks <= next_cursor))
            )
            expected[mask] = float(draft_measure.pitches[pitch_index])
            pitch_index += 1
        cursor = next_cursor
    comparable = valid & np.isfinite(midi) & np.isfinite(expected)
    evaluated = int(comparable.sum())
    expected_frames = int(np.isfinite(expected).sum())
    coverage = evaluated / expected_frames if expected_frames else 0.0
    if evaluated < 12:
        error = None
    else:
        # Cap gross tracker errors so one octave jump cannot dominate a whole
        # measure.  The score remains zero only when the contour agrees.
        error = float(np.mean(np.minimum(np.abs(midi[comparable] - expected[comparable]), 6.0)) / 6.0)
    return {
        "shapeError": round(error, 6) if error is not None else None,
        "evaluatedFrameCount": evaluated,
        "expectedFrameCount": expected_frames,
        "frameCoverage": round(coverage, 6),
        "evidenceReady": bool(error is not None and evaluated >= 20 and coverage >= 0.50),
    }


def score_generated_candidate(
    candidate: dict[str, Any],
    observation: dict[str, Any],
) -> dict[str, Any]:
    onsets = [int(value) for value in candidate.get("noteOnsetTicks") or []]
    expected: list[float] = []
    observed: list[float] = []
    for item in observation.get("intervals") or []:
        index = int(item["intervalIndex"])
        if index + 1 >= len(onsets):
            continue
        interval_ticks = onsets[index + 1] - onsets[index]
        if interval_ticks <= 0:
            continue
        expected.append(interval_ticks / TICKS_PER_QUARTER)
        observed.append(float(item["observedSeconds"]))
    error = normalized_ioi_error(expected, observed)
    possible = int(observation.get("possibleIntervalCount") or 0)
    evaluated = len(expected)
    coverage = evaluated / possible if possible else 0.0
    return {
        "relativeIoiError": round(error, 6) if error is not None else None,
        "evaluatedIntervalCount": evaluated,
        "possibleIntervalCount": possible,
        "intervalCoverage": round(coverage, 6),
        "evidenceReady": bool(
            error is not None
            and evaluated >= MEASURE_MIN_INTERVALS
            and coverage >= MEASURE_MIN_INTERVAL_COVERAGE
        ),
    }


def _generated_candidate_error(candidate: dict[str, Any], evidence_key: str) -> float | None:
    evidence = candidate.get(evidence_key, {})
    metric_key = "relativeIoiError" if evidence_key == "audio" else "shapeError"
    value = evidence.get(metric_key)
    if not evidence.get("evidenceReady") or value is None:
        return None
    return float(value)


def select_generated_candidate(
    row: dict[str, Any],
    margin: float,
    evidence_key: str = "audio",
) -> dict[str, Any] | None:
    ranked = [
        candidate
        for candidate in row.get("candidates") or []
        if _generated_candidate_error(candidate, evidence_key) is not None
    ]
    ranked.sort(
        key=lambda candidate: (
            float(_generated_candidate_error(candidate, evidence_key)),
            float(candidate.get("cost") or 0.0),
            int(candidate.get("changed") or 0),
        )
    )
    if not ranked:
        return None
    if len(ranked) > 1:
        gap = float(_generated_candidate_error(ranked[1], evidence_key)) - float(
            _generated_candidate_error(ranked[0], evidence_key)
        )
        # An exact audio tie is not independent evidence.  Structural cost may
        # order tied rows for diagnostics, but it must not turn a tie into an
        # automatic selection, even when the learned margin is zero.
        if gap <= margin:
            return None
    return ranked[0]


def summarize_generated_candidates(
    rows: list[dict[str, Any]],
    margin: float,
    evidence_key: str = "audio",
) -> dict[str, Any]:
    selected = [
        candidate
        for row in rows
        if (candidate := select_generated_candidate(row, margin, evidence_key))
    ]
    correct = sum(bool(candidate.get("isGold")) for candidate in selected)
    precision = correct / len(selected) if selected else None
    return {
        "margin": margin,
        "rowCount": len(rows),
        "correctCandidatePresentRows": sum(bool(row.get("correctCandidatePresent")) for row in rows),
        "evidenceReadyRows": sum(
            any(
                _generated_candidate_error(candidate, evidence_key) is not None
                for candidate in row.get("candidates") or []
            )
            for row in rows
        ),
        "selectedRows": len(selected),
        "correctSelectedRows": correct,
        "wrongSelectedRows": len(selected) - correct,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(len(selected) / len(rows), 6) if rows else 0.0,
    }


def choose_generated_margin(
    rows: list[dict[str, Any]],
    *,
    evidence_key: str = "audio",
    min_precision: float = 0.90,
    min_selected: int = 5,
) -> float | None:
    eligible = []
    for margin in MEASURE_MARGIN_GRID:
        summary = summarize_generated_candidates(rows, margin, evidence_key)
        if (
            summary["selectedRows"] >= min_selected
            and summary["selectionPrecision"] is not None
            and summary["selectionPrecision"] >= min_precision
        ):
            eligible.append((int(summary["selectedRows"]), float(margin)))
    if not eligible:
        return None
    eligible.sort(key=lambda item: (-item[0], item[1]))
    return eligible[0][1]


def leave_one_piece_out_generated_eval(
    rows: list[dict[str, Any]],
    evidence_key: str = "audio",
) -> dict[str, Any]:
    pieces = sorted({str(row.get("pieceId") or "") for row in rows if row.get("pieceId")})
    predictions = []
    folds = []
    for piece in pieces:
        training = [row for row in rows if row.get("pieceId") != piece]
        holdout = [row for row in rows if row.get("pieceId") == piece]
        margin = choose_generated_margin(training, evidence_key=evidence_key)
        fold_selected = []
        for row in holdout:
            candidate = (
                select_generated_candidate(row, margin, evidence_key)
                if margin is not None
                else None
            )
            prediction = {
                "pieceId": piece,
                "goldMeasure": row.get("goldMeasure"),
                "draftMeasure": row.get("draftMeasure"),
                "margin": margin,
                "selected": candidate is not None,
                "correct": bool(candidate and candidate.get("isGold")),
            }
            predictions.append(prediction)
            if candidate is not None:
                fold_selected.append(prediction)
        folds.append(
            {
                "holdoutPiece": piece,
                "selectedMargin": margin,
                "holdoutRowCount": len(holdout),
                "selectedRows": len(fold_selected),
                "correctSelectedRows": sum(row["correct"] for row in fold_selected),
            }
        )
    selected = [row for row in predictions if row["selected"]]
    correct = sum(row["correct"] for row in selected)
    precision = correct / len(selected) if selected else None
    coverage = len(selected) / len(rows) if rows else 0.0
    return {
        "validation": f"leave-one-piece-out-generated-candidate-margin:{evidence_key}",
        "pieceCount": len(pieces),
        "rowCount": len(rows),
        "selectedRows": len(selected),
        "correctSelectedRows": correct,
        "wrongSelectedRows": len(selected) - correct,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(coverage, 6),
        "evalOnlyGatePassed": bool(
            len(rows) >= 30
            and len(pieces) >= 5
            and len(selected) >= 10
            and precision is not None
            and precision >= 0.90
            and coverage >= 0.20
        ),
        "runtimeReady": False,
        "folds": folds,
        "predictions": predictions,
    }


def select_measure_candidate(row: dict[str, Any], margin: float) -> str:
    gold = row.get("gold") or {}
    draft = row.get("draft") or {}
    if not gold.get("evidenceReady") or not draft.get("evidenceReady"):
        return "uncertain"
    gold_error = float(gold["relativeIoiError"])
    draft_error = float(draft["relativeIoiError"])
    if gold_error + margin < draft_error:
        return "gold"
    if draft_error + margin < gold_error:
        return "draft"
    return "uncertain"


def summarize_measure_rows(rows: list[dict[str, Any]], margin: float) -> dict[str, Any]:
    selections = [select_measure_candidate(row, margin) for row in rows]
    selected = [value for value in selections if value != "uncertain"]
    correct = sum(value == "gold" for value in selected)
    wrong = sum(value == "draft" for value in selected)
    precision = correct / len(selected) if selected else None
    return {
        "margin": margin,
        "rowCount": len(rows),
        "evidenceReadyRows": sum(
            bool(row.get("gold", {}).get("evidenceReady"))
            and bool(row.get("draft", {}).get("evidenceReady"))
            for row in rows
        ),
        "selectedRows": len(selected),
        "goldSelectedRows": correct,
        "draftSelectedRows": wrong,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(len(selected) / len(rows), 6) if rows else 0.0,
    }


def measure_rows_at_coverage(
    rows: list[dict[str, Any]],
    minimum_coverage: float,
) -> list[dict[str, Any]]:
    adjusted: list[dict[str, Any]] = []
    for row in rows:
        candidate = dict(row)
        for key in ("gold", "draft"):
            metric = dict(row.get(key) or {})
            metric["evidenceReady"] = bool(
                metric.get("relativeIoiError") is not None
                and int(metric.get("evaluatedIntervalCount") or 0) >= MEASURE_MIN_INTERVALS
                and float(metric.get("intervalCoverage") or 0.0) >= minimum_coverage
            )
            candidate[key] = metric
        adjusted.append(candidate)
    return adjusted


def measure_coverage_sensitivity(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    reports = []
    for minimum_coverage in (0.30, 0.40, 0.50, 0.60, 0.70):
        adjusted = measure_rows_at_coverage(rows, minimum_coverage)
        reports.append(
            {
                "minimumIntervalCoverage": minimum_coverage,
                "fixedMargin": summarize_measure_rows(adjusted, SELECTION_MARGIN),
                "leaveOnePieceOut": leave_one_piece_out_measure_eval(adjusted),
            }
        )
    return reports


def choose_measure_margin(
    rows: list[dict[str, Any]],
    *,
    min_precision: float = 0.90,
    min_selected: int = 5,
) -> float | None:
    eligible: list[tuple[int, float]] = []
    for margin in MEASURE_MARGIN_GRID:
        summary = summarize_measure_rows(rows, margin)
        precision = summary["selectionPrecision"]
        if (
            summary["selectedRows"] >= min_selected
            and precision is not None
            and precision >= min_precision
        ):
            eligible.append((int(summary["selectedRows"]), float(margin)))
    if not eligible:
        return None
    eligible.sort(key=lambda item: (-item[0], item[1]))
    return eligible[0][1]


def leave_one_piece_out_measure_eval(rows: list[dict[str, Any]]) -> dict[str, Any]:
    pieces = sorted({str(row.get("pieceId") or "") for row in rows if row.get("pieceId")})
    predictions: list[dict[str, Any]] = []
    folds: list[dict[str, Any]] = []
    for piece in pieces:
        training = [row for row in rows if row.get("pieceId") != piece]
        holdout = [row for row in rows if row.get("pieceId") == piece]
        margin = choose_measure_margin(training)
        fold_predictions = []
        for row in holdout:
            selection = select_measure_candidate(row, margin) if margin is not None else "uncertain"
            prediction = {
                "pieceId": piece,
                "goldMeasure": row.get("goldMeasure"),
                "draftMeasure": row.get("draftMeasure"),
                "margin": margin,
                "selection": selection,
            }
            predictions.append(prediction)
            fold_predictions.append(prediction)
        folds.append(
            {
                "holdoutPiece": piece,
                "trainingRowCount": len(training),
                "holdoutRowCount": len(holdout),
                "selectedMargin": margin,
                "selectedRows": sum(row["selection"] != "uncertain" for row in fold_predictions),
                "goldSelectedRows": sum(row["selection"] == "gold" for row in fold_predictions),
                "draftSelectedRows": sum(row["selection"] == "draft" for row in fold_predictions),
            }
        )
    selected = [row for row in predictions if row["selection"] != "uncertain"]
    correct = sum(row["selection"] == "gold" for row in selected)
    wrong = sum(row["selection"] == "draft" for row in selected)
    precision = correct / len(selected) if selected else None
    coverage = len(selected) / len(rows) if rows else 0.0
    return {
        "validation": "leave-one-piece-out-margin-selection",
        "pieceCount": len(pieces),
        "rowCount": len(rows),
        "selectedRows": len(selected),
        "goldSelectedRows": correct,
        "draftSelectedRows": wrong,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(coverage, 6),
        "evalOnlyGatePassed": bool(
            len(rows) >= 30
            and len(pieces) >= 5
            and len(selected) >= 10
            and precision is not None
            and precision >= 0.90
            and coverage >= 0.20
        ),
        "runtimeReady": False,
        "folds": folds,
        "predictions": predictions,
    }


def summarize_method(rows: list[dict[str, Any]], key: str) -> dict[str, Any]:
    ready_rows = [row for row in rows if row[key]["selection"] != "uncertain"]
    gold_selected = sum(row[key]["selection"] == "gold" for row in rows)
    draft_selected = sum(row[key]["selection"] == "draft" for row in rows)
    precision = gold_selected / len(ready_rows) if ready_rows else None
    coverage = len(ready_rows) / len(rows) if rows else 0.0
    return {
        "pieceCount": len(rows),
        "readySelectionCount": len(ready_rows),
        "goldSelectedCount": gold_selected,
        "draftSelectedCount": draft_selected,
        "selectionPrecision": round(precision, 6) if precision is not None else None,
        "selectionCoverage": round(coverage, 6),
        "evalOnlyGatePassed": bool(
            len(rows) >= 5
            and len(ready_rows) >= 3
            and precision is not None
            and precision >= 0.90
            and draft_selected == 0
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", default=str(DEFAULT_BENCHMARK))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    benchmark = json.loads(Path(args.benchmark).read_text(encoding="utf-8"))
    rows = []
    measure_rows: list[dict[str, Any]] = []
    generated_candidate_rows: list[dict[str, Any]] = []
    failures = []
    for source in benchmark["rows"]:
        if not source.get("benchmarkUsable"):
            continue
        piece = str(source["pieceId"])
        try:
            gold_events = timed_mxl_events(repo_path(source["goldPath"]))
            draft_paths = [repo_path(value) for value in str(source["draftPath"]).split("|") if value]
            draft_events = timed_mxl_events_many(draft_paths)
            audio_path = PRIVATE / f"{piece}.m4a"
            detected = audio_events(audio_path)
            pyin_track = extract_pyin_track(audio_path)
            augmented = augment_audio_onsets(audio_path, detected, pyin_track)
            gold_metric = score_relative_ioi(gold_events, detected)
            draft_metric = score_relative_ioi(draft_events, detected)
            ensemble_gold = score_relative_ioi(gold_events, augmented)
            ensemble_draft = score_relative_ioi(draft_events, augmented)
            rows.append(
                {
                    "pieceId": piece,
                    "gold": gold_metric,
                    "draft": draft_metric,
                    "selection": select_candidate(gold_metric, draft_metric),
                    "basicEventCount": len(detected),
                    "ensembleEventCount": len(augmented),
                    "ensemble": {
                        "gold": ensemble_gold,
                        "draft": ensemble_draft,
                        "selection": select_candidate(ensemble_gold, ensemble_draft),
                    },
                }
            )
            gold_mapping, _ = align(gold_events, detected)
            draft_mapping, _ = align(draft_events, detected)
            ensemble_gold_mapping, _ = align(gold_events, augmented)
            ensemble_draft_mapping, _ = align(draft_events, augmented)
            gold_measures = _best_part_measures(repo_path(source["goldPath"]))
            draft_measures = parse_measure_rhythms_many(draft_paths)
            comparable_pairs = exact_pitch_measure_pairs(
                repo_path(source["goldPath"]),
                draft_paths,
                gold_measures,
                draft_measures,
            )
            for gold_measure, draft_measure in comparable_pairs:
                gold_measure_metric = score_measure_relative_ioi(
                    gold_events,
                    gold_mapping,
                    detected,
                    gold_measure.measure_index,
                )
                draft_measure_metric = score_measure_relative_ioi(
                    draft_events,
                    draft_mapping,
                    detected,
                    draft_measure.measure_index,
                )
                ensemble_gold_measure_metric = score_measure_relative_ioi(
                    gold_events,
                    ensemble_gold_mapping,
                    augmented,
                    gold_measure.measure_index,
                )
                ensemble_draft_measure_metric = score_measure_relative_ioi(
                    draft_events,
                    ensemble_draft_mapping,
                    augmented,
                    draft_measure.measure_index,
                )
                measure_rows.append(
                    {
                        "pieceId": piece,
                        "goldMeasure": gold_measure.measure_index,
                        "draftMeasure": draft_measure.measure_index,
                        "noteCount": len(gold_measure.pitches),
                        "gold": gold_measure_metric,
                        "draft": draft_measure_metric,
                        "ensembleGold": ensemble_gold_measure_metric,
                        "ensembleDraft": ensemble_draft_measure_metric,
                        "fixedMarginSelection": select_measure_candidate(
                            {"gold": gold_measure_metric, "draft": draft_measure_metric},
                            SELECTION_MARGIN,
                        ),
                    }
                )
                observation = observed_measure_intervals(
                    draft_events,
                    draft_mapping,
                    detected,
                    draft_measure.measure_index,
                )
                f0_observation = observed_measure_f0_shape(
                    draft_events,
                    draft_mapping,
                    detected,
                    draft_measure.measure_index,
                    pyin_track,
                )
                generated: dict[tuple[int, tuple[int, ...]], dict[str, Any]] = {}
                for meter_quarters in COMMON_METER_QUARTERS:
                    target_ticks = int(round(meter_quarters * TICKS_PER_QUARTER))
                    for candidate in generate_visual_rhythm_candidates(
                        draft_measure,
                        target_ticks,
                        top_k=GENERATED_TOP_K_PER_METER,
                    ):
                        key = (
                            int(candidate["targetTicks"]),
                            tuple(int(value) for value in candidate["noteOnsetTicks"]),
                        )
                        previous = generated.get(key)
                        if previous is None or (
                            float(candidate["cost"]),
                            int(candidate["changed"]),
                        ) < (
                            float(previous["cost"]),
                            int(previous["changed"]),
                        ):
                            generated[key] = candidate
                candidates = []
                for candidate in generated.values():
                    is_gold = bool(
                        int(candidate["targetTicks"]) == int(gold_measure.expected_ticks)
                        and tuple(int(value) for value in candidate["noteOnsetTicks"])
                        == tuple(int(value) for value in gold_measure.note_onset_ticks)
                    )
                    candidates.append(
                        {
                            **candidate,
                            "isGold": is_gold,
                            "audio": score_generated_candidate(candidate, observation),
                            "f0Audio": score_generated_candidate_f0(
                                candidate,
                                draft_measure,
                                f0_observation,
                            ),
                        }
                    )
                generated_candidate_rows.append(
                    {
                        "pieceId": piece,
                        "goldMeasure": gold_measure.measure_index,
                        "draftMeasure": draft_measure.measure_index,
                        "noteCount": len(gold_measure.pitches),
                        "candidateCount": len(candidates),
                        "correctCandidatePresent": any(
                            candidate["isGold"] for candidate in candidates
                        ),
                        "observation": observation,
                        "f0Observation": {
                            key: value
                            for key, value in f0_observation.items()
                            if key not in {"frameTimes", "frameMidi", "frameValid"}
                        },
                        "candidates": candidates,
                    }
                )
        except Exception as error:
            failures.append({"pieceId": piece, "error": f"{type(error).__name__}: {error}"})
    summary = summarize_method(
        [{"basic": {"selection": row["selection"]}} for row in rows], "basic"
    )
    ensemble_summary = summarize_method(rows, "ensemble")
    measure_fixed_summary = summarize_measure_rows(measure_rows, SELECTION_MARGIN)
    measure_lopo = leave_one_piece_out_measure_eval(measure_rows)
    measure_ensemble_rows = [
        {
            **row,
            "gold": row["ensembleGold"],
            "draft": row["ensembleDraft"],
        }
        for row in measure_rows
    ]
    measure_ensemble_fixed_summary = summarize_measure_rows(
        measure_ensemble_rows,
        SELECTION_MARGIN,
    )
    measure_ensemble_lopo = leave_one_piece_out_measure_eval(measure_ensemble_rows)
    generated_fixed_summary = summarize_generated_candidates(
        generated_candidate_rows,
        SELECTION_MARGIN,
    )
    generated_lopo = leave_one_piece_out_generated_eval(generated_candidate_rows)
    generated_f0_fixed_summary = summarize_generated_candidates(
        generated_candidate_rows,
        SELECTION_MARGIN,
        "f0Audio",
    )
    generated_f0_lopo = leave_one_piece_out_generated_eval(
        generated_candidate_rows,
        "f0Audio",
    )
    report = {
        "schemaVersion": 3,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "evalOnly": True,
        "studentFacing": False,
        "purpose": "relative-IOI evaluation of OMR draft and bounded visual top-k candidates",
        "thresholds": {
            "minIntervals": MIN_INTERVALS,
            "minIntervalCoverage": MIN_INTERVAL_COVERAGE,
            "selectionMargin": SELECTION_MARGIN,
            "minSelectionPrecision": 0.90,
        },
        "summary": summary,
        "ensembleSummary": ensemble_summary,
        "measureLevel": {
            "scope": "exact-pitch monophonic gold/draft measure pairs",
            "fixedMarginSummary": measure_fixed_summary,
            "leaveOnePieceOut": measure_lopo,
            "ensembleFixedMarginSummary": measure_ensemble_fixed_summary,
            "ensembleLeaveOnePieceOut": measure_ensemble_lopo,
            "basicCoverageSensitivity": measure_coverage_sensitivity(measure_rows),
            "ensembleCoverageSensitivity": measure_coverage_sensitivity(measure_ensemble_rows),
            "rows": measure_rows,
            "runtimeReady": False,
        },
        "generatedCandidateRanking": {
            "scope": "bounded visual top-k candidates across common meters; gold used only for scoring",
            "topKPerMeter": GENERATED_TOP_K_PER_METER,
            "commonMeterQuarters": list(COMMON_METER_QUARTERS),
            "fixedMarginSummary": generated_fixed_summary,
            "leaveOnePieceOut": generated_lopo,
            "f0ShapeFixedMarginSummary": generated_f0_fixed_summary,
            "f0ShapeLeaveOnePieceOut": generated_f0_lopo,
            "rows": generated_candidate_rows,
            "runtimeReady": False,
        },
        "rows": rows,
        "failures": failures,
        "limitations": [
            "clean gold is used only for evaluation and is unavailable to the production ranker",
            "performance can follow an erroneous score, so audio agreement remains correlated evidence",
            "Basic Pitch onset misses and expressive timing reduce interval coverage",
            "measure-level rows use independent gold only to score which of the two candidates was correct; gold is never a runtime feature",
            "a passing measure-level eval proves relative-IOI ranking signal, not that production can generate a complete correct candidate set",
            "generated candidates use only draft notation, adjacent beam ambiguity, repeated local tuplet evidence, and common meter totals; independent gold is used only to mark evaluation correctness",
        ],
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# M4 audio relative-IOI candidate ranking",
        "",
        "Eval-only; no score was edited.",
        "",
        f"- basic gold / draft / uncertain: {summary['goldSelectedCount']} / {summary['draftSelectedCount']} / {len(rows) - summary['readySelectionCount']}",
        f"- selection precision / coverage: {summary['selectionPrecision']} / {summary['selectionCoverage']}",
        f"- basic eval-only gate passed: {summary['evalOnlyGatePassed']}",
        f"- ensemble gold / draft / uncertain: {ensemble_summary['goldSelectedCount']} / {ensemble_summary['draftSelectedCount']} / {len(rows) - ensemble_summary['readySelectionCount']}",
        f"- ensemble precision / coverage: {ensemble_summary['selectionPrecision']} / {ensemble_summary['selectionCoverage']}",
        f"- ensemble eval-only gate passed: {ensemble_summary['evalOnlyGatePassed']}",
        f"- measure rows / evidence-ready: {measure_fixed_summary['rowCount']} / {measure_fixed_summary['evidenceReadyRows']}",
        f"- measure fixed-margin precision / coverage: {measure_fixed_summary['selectionPrecision']} / {measure_fixed_summary['selectionCoverage']}",
        f"- measure LOPO precision / coverage: {measure_lopo['selectionPrecision']} / {measure_lopo['selectionCoverage']}",
        f"- measure LOPO eval-only gate passed: {measure_lopo['evalOnlyGatePassed']}",
        f"- measure onset-ensemble fixed precision / coverage: {measure_ensemble_fixed_summary['selectionPrecision']} / {measure_ensemble_fixed_summary['selectionCoverage']}",
        f"- measure onset-ensemble LOPO precision / coverage: {measure_ensemble_lopo['selectionPrecision']} / {measure_ensemble_lopo['selectionCoverage']}",
        f"- measure onset-ensemble LOPO eval-only gate passed: {measure_ensemble_lopo['evalOnlyGatePassed']}",
        f"- generated candidate rows / correct candidate present: {generated_fixed_summary['rowCount']} / {generated_fixed_summary['correctCandidatePresentRows']}",
        f"- generated fixed-margin precision / coverage: {generated_fixed_summary['selectionPrecision']} / {generated_fixed_summary['selectionCoverage']}",
        f"- generated LOPO precision / coverage: {generated_lopo['selectionPrecision']} / {generated_lopo['selectionCoverage']}",
        f"- generated LOPO eval-only gate passed: {generated_lopo['evalOnlyGatePassed']}",
        "- measure runtime ready: False",
        "",
        "| piece | basic selection | ensemble selection | basic events | ensemble events |",
        "|---|---|---|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['pieceId']} | {row['selection']} | {row['ensemble']['selection']} | "
            f"{row['basicEventCount']} | {row['ensembleEventCount']} |"
        )
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": not failures,
        "summary": summary,
        "ensembleSummary": ensemble_summary,
        "measureFixedMarginSummary": measure_fixed_summary,
        "measureLeaveOnePieceOut": {
            key: value
            for key, value in measure_lopo.items()
            if key not in {"folds", "predictions"}
        },
        "measureEnsembleFixedMarginSummary": measure_ensemble_fixed_summary,
        "measureEnsembleLeaveOnePieceOut": {
            key: value
            for key, value in measure_ensemble_lopo.items()
            if key not in {"folds", "predictions"}
        },
        "generatedCandidateFixedMarginSummary": generated_fixed_summary,
        "generatedCandidateLeaveOnePieceOut": {
            key: value
            for key, value in generated_lopo.items()
            if key not in {"folds", "predictions"}
        },
        "generatedCandidateF0FixedMarginSummary": generated_f0_fixed_summary,
        "generatedCandidateF0LeaveOnePieceOut": {
            key: value
            for key, value in generated_f0_lopo.items()
            if key not in {"folds", "predictions"}
        },
        "failures": failures,
        "out": str(out),
    }, ensure_ascii=False, indent=2))
    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
