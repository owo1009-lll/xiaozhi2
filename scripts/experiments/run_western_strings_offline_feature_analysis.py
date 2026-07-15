from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sqlite3
import statistics
import subprocess
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from numba import njit


RELATIVE_IOI_CONSISTENCY_LIMIT = 0.35


def safe_float(value: Any, fallback: float | None = None) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    return numeric if math.isfinite(numeric) else fallback


def safe_int(value: Any, fallback: int = 0) -> int:
    numeric = safe_float(value)
    return int(round(numeric)) if numeric is not None else fallback


def meter_quarter_span(value: Any, fallback: float = 4.0) -> float:
    text = str(value or "").strip()
    if "/" not in text:
        return fallback
    numerator_text, denominator_text = text.split("/", 1)
    numerator = safe_float(numerator_text)
    denominator = safe_float(denominator_text)
    if numerator is None or denominator is None or numerator <= 0 or denominator <= 0:
        return fallback
    return numerator * 4.0 / denominator


def load_store(repo_root: Path) -> dict[str, Any]:
    sqlite_path = repo_root / "data" / "erhu-score-imports.sqlite"
    if sqlite_path.exists():
        connection = sqlite3.connect(sqlite_path)
        try:
            rows = connection.execute(
                "SELECT payload FROM imported_scores WHERE archived = 0 ORDER BY updated_at DESC"
            ).fetchall()
            return {"scores": [json.loads(row[0]) for row in rows]}
        finally:
            connection.close()
    store_path = repo_root / "data" / "erhu-score-imports.json"
    with store_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def note_position(note: dict[str, Any]) -> dict[str, Any]:
    position = note.get("notePosition") if isinstance(note.get("notePosition"), dict) else {}
    return {
        "pageNumber": safe_int(position.get("pageNumber"), 0) or None,
        "measureIndex": safe_int(position.get("globalMeasureIndex"), safe_int(note.get("measureIndex"), 0)) or None,
        "localMeasureIndex": safe_int(position.get("localMeasureIndex"), safe_int(note.get("measureIndex"), 0)) or None,
        "systemIndex": safe_int(position.get("systemIndex"), 0) or None,
        "normalizedX": safe_float(position.get("normalizedX")),
        "normalizedY": safe_float(position.get("normalizedY")),
    }


def collect_score_notes(store: dict[str, Any], score_id: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    score = next((item for item in store.get("scores", []) if str(item.get("scoreId", "")).strip() == score_id), None)
    if not score:
        return None, []
    notes: list[dict[str, Any]] = []
    order = 0
    for section in score.get("sections", []) or []:
        section_tempo = safe_float(section.get("tempo"), 72.0) or 72.0
        measure_span = meter_quarter_span(section.get("meter"), 4.0)
        for note in section.get("notes", []) or []:
            midi = safe_int(note.get("midiPitch"), -1)
            if midi <= 0:
                continue
            measure = safe_int(note.get("measureIndex"), 0)
            beat_start = safe_float(note.get("beatStart"), 0.0) or 0.0
            beat_duration = max(0.05, safe_float(note.get("beatDuration"), 1.0) or 1.0)
            tempo = safe_float(note.get("activeTempo"), section_tempo) or section_tempo
            notes.append(
                {
                    "noteId": str(note.get("noteId") or f"note-{order}"),
                    "sectionId": str(section.get("sectionId") or ""),
                    "sectionTitle": str(section.get("title") or ""),
                    "order": order,
                    "midi": midi,
                    "measureIndex": measure,
                    "beatStart": beat_start,
                    "beatDuration": beat_duration,
                    "tempo": tempo,
                    "measureQuarterSpan": measure_span,
                    "position": note_position(note),
                }
            )
            order += 1
    notes.sort(key=lambda item: (
        safe_int(item["position"].get("pageNumber"), 0),
        safe_int(item.get("measureIndex"), 0),
        safe_float(item.get("beatStart"), 0.0) or 0.0,
        safe_int(item.get("order"), 0),
    ))
    return score, notes


def build_symbolic_timeline(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not notes:
        return []
    min_measure = min(safe_int(note.get("measureIndex"), 0) for note in notes)
    max_measure = max(safe_int(note.get("measureIndex"), min_measure) for note in notes)
    spans_by_measure: dict[int, float] = {}
    for note in notes:
        measure = safe_int(note.get("measureIndex"), min_measure)
        span = safe_float(note.get("measureQuarterSpan"), 4.0) or 4.0
        spans_by_measure.setdefault(measure, max(0.25, span))
    measure_starts: dict[int, float] = {min_measure: 0.0}
    previous_span = spans_by_measure.get(min_measure, 4.0)
    for measure in range(min_measure + 1, max_measure + 1):
        measure_starts[measure] = measure_starts[measure - 1] + spans_by_measure.get(measure - 1, previous_span)
        previous_span = spans_by_measure.get(measure, previous_span)
    raw_units: list[float] = []
    onset_units: list[float] = []
    last_unit = 0.0
    for index, note in enumerate(notes):
        measure = safe_int(note.get("measureIndex"), min_measure)
        beat_start = safe_float(note.get("beatStart"), 0.0) or 0.0
        onset_unit = max(0.0, measure_starts.get(measure, 0.0) + beat_start)
        unit = onset_unit
        if index and unit <= last_unit:
            unit = last_unit + max(0.05, safe_float(note.get("beatDuration"), 0.5) or 0.5)
        raw_units.append(unit)
        onset_units.append(onset_unit)
        last_unit = unit
    start = raw_units[0]
    shifted = [unit - start for unit in raw_units]
    onset_start = onset_units[0]
    shifted_onsets = [unit - onset_start for unit in onset_units]
    for note, unit, onset_unit in zip(notes, shifted, shifted_onsets):
        note["scoreUnit"] = unit
        note["scoreOnsetUnit"] = onset_unit
    return notes


def resolve_ffmpeg_executable() -> str | None:
    candidates = [os.getenv("ERHU_FFMPEG_PATH", ""), shutil.which("ffmpeg")]
    try:
        import imageio_ffmpeg

        candidates.append(imageio_ffmpeg.get_ffmpeg_exe())
    except (ImportError, RuntimeError):
        pass
    return next((str(candidate) for candidate in candidates if candidate and Path(candidate).exists()), None)


def decode_audio_with_ffmpeg(audio_path: Path, target_sr: int = 22050) -> tuple[np.ndarray, int]:
    ffmpeg = resolve_ffmpeg_executable()
    if not ffmpeg:
        raise RuntimeError("ffmpeg-unavailable-for-compressed-audio")
    result = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(audio_path),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "1",
            "-ar",
            str(target_sr),
            "pipe:1",
        ],
        capture_output=True,
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()[:500]
        raise RuntimeError(f"ffmpeg-audio-decode-failed:{detail or result.returncode}")
    waveform = np.frombuffer(result.stdout, dtype="<f4").copy()
    if waveform.size == 0:
        raise ValueError("audio-empty-after-ffmpeg-decode")
    return waveform, target_sr


def load_audio_mono(audio_path: Path, target_sr: int = 22050) -> tuple[np.ndarray, int]:
    if audio_path.suffix.lower() in {".aac", ".m4a", ".mp4"}:
        return decode_audio_with_ffmpeg(audio_path, target_sr)
    try:
        return librosa.load(str(audio_path), sr=target_sr, mono=True)
    except Exception as librosa_error:
        try:
            return decode_audio_with_ffmpeg(audio_path, target_sr)
        except Exception as ffmpeg_error:
            raise RuntimeError(
                f"audio-decode-failed:librosa={type(librosa_error).__name__}:{librosa_error};"
                f"ffmpeg={type(ffmpeg_error).__name__}:{ffmpeg_error}"
            ) from ffmpeg_error


def extract_f0(audio_path: Path) -> tuple[np.ndarray, np.ndarray, float]:
    y, sr = load_audio_mono(audio_path, target_sr=22050)
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
    return times.astype(np.float64), midi.astype(np.float64), float(y.size / sr)


def load_basic_pitch_events(audio_path: Path, cache_dir: Path) -> list[dict[str, Any]]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{audio_path.stem}.basic-pitch.json"
    if cache_path.is_file():
        return read_basic_pitch_events(cache_path)
    from basic_pitch.inference import predict

    _, _, raw_events = predict(
        str(audio_path),
        minimum_frequency=float(librosa.note_to_hz("G3")),
        maximum_frequency=float(librosa.note_to_hz("A7")),
        minimum_note_length=80.0,
    )
    events = sorted(
        [
            {
                "start": float(start),
                "end": float(end),
                "midi": int(pitch),
                "confidence": float(confidence),
            }
            for start, end, pitch, confidence, *_ in raw_events
        ],
        key=lambda item: (float(item["start"]), float(item["end"]), int(item["midi"])),
    )
    cache_path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
    return events


def read_basic_pitch_events(path: Path) -> list[dict[str, Any]]:
    return sorted(
        json.loads(path.read_text(encoding="utf-8")),
        key=lambda item: (float(item["start"]), float(item["end"]), int(item["midi"])),
    )


def basic_pitch_match_cost(score_midi: int, event_midi: int) -> float:
    diff = abs(score_midi - event_midi)
    if diff == 0:
        return 0.0
    if diff == 1:
        return 0.85
    if diff == 2:
        return 1.35
    return min(4.0, 2.2 + diff * 0.18)


@njit(cache=False)
def compute_pitch_alignment_backtrace(
    score_midis: np.ndarray,
    event_midis: np.ndarray,
    skip_score_cost: float,
    skip_event_cost: float,
) -> np.ndarray:
    """Return the exact gap-penalty DP backtrace using two cost rows."""

    n = score_midis.size
    m = event_midis.size
    back = np.zeros((n + 1, m + 1), dtype=np.uint8)
    previous = np.empty(m + 1, dtype=np.float64)
    current = np.empty(m + 1, dtype=np.float64)
    previous[0] = 0.0
    for j in range(1, m + 1):
        previous[j] = previous[j - 1] + skip_event_cost
        back[0, j] = 3
    for i in range(1, n + 1):
        current[0] = previous[0] + skip_score_cost
        back[i, 0] = 2
        score_midi = int(score_midis[i - 1])
        for j in range(1, m + 1):
            diff = abs(score_midi - int(event_midis[j - 1]))
            if diff == 0:
                match_cost = 0.0
            elif diff == 1:
                match_cost = 0.85
            elif diff == 2:
                match_cost = 1.35
            else:
                match_cost = min(4.0, 2.2 + diff * 0.18)
            match = previous[j - 1] + match_cost + j * 1e-7
            skip_score = previous[j] + skip_score_cost
            skip_event = current[j - 1] + skip_event_cost
            if match <= skip_score and match <= skip_event:
                current[j] = match
                back[i, j] = 1
            elif skip_score <= skip_event:
                current[j] = skip_score
                back[i, j] = 2
            else:
                current[j] = skip_event
                back[i, j] = 3
        swap = previous
        previous = current
        current = swap
    return back


def assign_basic_pitch_events(
    notes: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> list[dict[str, Any] | None]:
    """Assign events one-to-one while allowing explicit score/event gaps."""

    if not notes or not events:
        return [None for _ in notes]
    n, m = len(notes), len(events)
    skip_score_cost = 1.35
    skip_event_cost = 0.75
    score_midis = np.asarray([safe_int(note.get("midi"), 0) for note in notes], dtype=np.int16)
    event_midis = np.asarray([safe_int(event.get("midi"), 0) for event in events], dtype=np.int16)
    back = compute_pitch_alignment_backtrace(
        score_midis,
        event_midis,
        skip_score_cost,
        skip_event_cost,
    )
    assignments: list[dict[str, Any] | None] = [None for _ in notes]
    i, j = n, m
    while i > 0 or j > 0:
        action = int(back[i, j])
        if action == 1 and i > 0 and j > 0:
            note = notes[i - 1]
            event = events[j - 1]
            target = safe_int(note.get("midi"), 0)
            event_midi = safe_int(event.get("midi"), 0)
            assignments[i - 1] = {
                "eventIndex": j - 1,
                "time": float(event["start"]),
                "end": float(event["end"]),
                "eventMidi": event_midi,
                "confidence": float(event.get("confidence", 0.0)),
                "pitchDistanceSemitones": abs(event_midi - target),
            }
            i -= 1
            j -= 1
        elif action == 2 and i > 0:
            i -= 1
        elif action == 3 and j > 0:
            j -= 1
        else:
            break
    return assignments


def compute_relative_ioi_features(
    notes: list[dict[str, Any]],
    assignments: list[dict[str, Any] | None],
    *,
    consistency_limit: float = RELATIVE_IOI_CONSISTENCY_LIMIT,
    neighbor_search: int = 8,
) -> list[dict[str, Any]]:
    """Compare local audio timing with score-relative timing.

    The interpolation uses assigned events on both sides of a note, so the
    feature is insensitive to global tempo and local affine tempo changes. It
    remains review evidence until independent note-level truth validates a
    release threshold.
    """

    features: list[dict[str, Any]] = []
    for index, assignment in enumerate(assignments):
        empty = {
            "relativeIoiEvidenceAvailable": False,
            "relativeIoiResidualSeconds": None,
            "relativeIoiDeviationRatio": None,
            "relativeIoiConsistent": None,
        }
        if assignment is None:
            features.append(empty)
            continue
        score_time = safe_float(notes[index].get("scoreOnsetUnit"), safe_float(notes[index].get("scoreUnit")))
        if score_time is None:
            features.append(empty)
            continue
        previous_index = None
        next_index = None
        for distance in range(1, neighbor_search + 1):
            candidate = index - distance
            if candidate < 0:
                break
            candidate_time = safe_float(
                notes[candidate].get("scoreOnsetUnit"),
                safe_float(notes[candidate].get("scoreUnit")),
            )
            if assignments[candidate] is not None and candidate_time is not None and candidate_time < score_time - 1e-6:
                previous_index = candidate
                break
        for distance in range(1, neighbor_search + 1):
            candidate = index + distance
            if candidate >= len(assignments):
                break
            candidate_time = safe_float(
                notes[candidate].get("scoreOnsetUnit"),
                safe_float(notes[candidate].get("scoreUnit")),
            )
            if assignments[candidate] is not None and candidate_time is not None and candidate_time > score_time + 1e-6:
                next_index = candidate
                break
        if previous_index is None or next_index is None:
            features.append(empty)
            continue
        previous_score = safe_float(
            notes[previous_index].get("scoreOnsetUnit"),
            safe_float(notes[previous_index].get("scoreUnit"), 0.0),
        ) or 0.0
        next_score = safe_float(
            notes[next_index].get("scoreOnsetUnit"),
            safe_float(notes[next_index].get("scoreUnit"), 0.0),
        ) or 0.0
        previous_audio = float(assignments[previous_index]["time"])
        next_audio = float(assignments[next_index]["time"])
        if next_score <= previous_score or next_audio <= previous_audio:
            features.append(empty)
            continue
        fraction = (score_time - previous_score) / (next_score - previous_score)
        expected_audio = previous_audio + fraction * (next_audio - previous_audio)
        local_scale = (next_audio - previous_audio) / (next_score - previous_score)
        local_spacing = min(score_time - previous_score, next_score - score_time) * local_scale
        if local_spacing <= 0:
            features.append(empty)
            continue
        residual = abs(float(assignment["time"]) - expected_audio)
        deviation = residual / max(0.08, local_spacing)
        features.append(
            {
                "relativeIoiEvidenceAvailable": True,
                "relativeIoiResidualSeconds": round(residual, 6),
                "relativeIoiDeviationRatio": round(deviation, 6),
                "relativeIoiConsistent": bool(deviation <= consistency_limit),
            }
        )
    return features


def cents_error(observed_midi: float, target_midi: int) -> float:
    return float((observed_midi - target_midi) * 100.0)


def build_decisions(
    notes: list[dict[str, Any]],
    times: np.ndarray,
    midi_track: np.ndarray,
    audio_duration: float,
    limit: int,
    *,
    audio_start_seconds: float = 0.0,
    audio_end_seconds: float | None = None,
    timing_assignments: list[dict[str, Any] | None] | None = None,
    analysis_mode: str = "linear-score-pyin-review-v1",
) -> list[dict[str, Any]]:
    if not notes:
        return []
    score_span = max((safe_float(note.get("scoreUnit"), 0.0) or 0.0) for note in notes)
    active_start = max(0.0, min(audio_duration, float(audio_start_seconds)))
    active_end = (
        audio_duration
        if audio_end_seconds is None
        else max(active_start, min(audio_duration, float(audio_end_seconds)))
    )
    scale = ((active_end - active_start) / score_span) if score_span > 0 else 0.0
    decisions: list[dict[str, Any]] = []
    selected_notes = notes[: limit if limit > 0 else len(notes)]
    relative_ioi = (
        compute_relative_ioi_features(notes, timing_assignments)
        if timing_assignments is not None
        else [{} for _ in notes]
    )
    for note_index, note in enumerate(selected_notes):
        score_unit = safe_float(note.get("scoreUnit"), 0.0) or 0.0
        assignment = timing_assignments[note_index] if timing_assignments is not None else None
        if assignment is not None:
            predicted_onset = float(assignment["time"])
        elif timing_assignments is not None:
            predicted_onset = None
        else:
            predicted_onset = (
                max(active_start, min(active_end, active_start + score_unit * scale))
                if scale > 0
                else active_start
            )
        if assignment is not None:
            event_start = float(assignment["time"])
            event_end = max(event_start, float(assignment["end"]))
            event_duration = event_end - event_start
            stable_start = event_start + min(0.12, event_duration * 0.25)
            stable_end = event_end - min(0.08, event_duration * 0.15)
            if stable_end <= stable_start:
                stable_start, stable_end = event_start, event_end
            measurement_time = (stable_start + stable_end) / 2.0
            window = (times >= stable_start) & (times <= stable_end)
        elif predicted_onset is not None:
            measurement_time = predicted_onset
            window = np.abs(times - predicted_onset) <= 0.18
        else:
            measurement_time = None
            window = np.zeros_like(times, dtype=bool)
        observed = midi_track[window]
        observed = observed[np.isfinite(observed)]
        voiced_frames = int(observed.size)
        median_midi = float(np.median(observed)) if voiced_frames else None
        cents = cents_error(median_midi, safe_int(note.get("midi"), 0)) if median_midi is not None else None
        support = bool(voiced_frames >= 2 and cents is not None and abs(cents) <= 80.0)
        decisions.append(
            {
                "noteId": note["noteId"],
                "sectionId": note["sectionId"],
                "sectionTitle": note["sectionTitle"],
                "measureIndex": note["position"].get("measureIndex") or note.get("measureIndex"),
                "pageNumber": note["position"].get("pageNumber"),
                "midi": note["midi"],
                "predictedOnsetSeconds": round(predicted_onset, 4) if predicted_onset is not None else None,
                "autoDecision": "review_required",
                "reviewRequiredReason": "offline-feature-analysis-review-only",
                "confidenceScore": 0.0,
                "evidence": {
                    "analysisMode": analysis_mode,
                    "voicedFrameCount": voiced_frames,
                    "medianObservedMidi": round(median_midi, 4) if median_midi is not None else None,
                    "centsError": round(cents, 2) if cents is not None else None,
                    "pitchSupportWithin80Cents": support,
                    "timingAssignmentAvailable": assignment is not None if timing_assignments is not None else True,
                    "pitchMeasurementTimeSeconds": round(measurement_time, 4) if measurement_time is not None else None,
                    "basicPitchEventMidi": assignment.get("eventMidi") if assignment else None,
                    "basicPitchEventConfidence": round(float(assignment["confidence"]), 6) if assignment else None,
                    "basicPitchPitchDistanceSemitones": assignment.get("pitchDistanceSemitones") if assignment else None,
                    **relative_ioi[note_index],
                },
            }
        )
    return decisions


def aggregate_measure_evidence(decisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for decision in decisions:
        measure = safe_int(decision.get("measureIndex"), 0)
        if measure <= 0:
            continue
        key = (str(decision.get("sectionId") or ""), measure)
        grouped.setdefault(key, []).append(decision)
    rows: list[dict[str, Any]] = []
    for (section_id, measure), items in sorted(grouped.items(), key=lambda item: (item[0][0], item[0][1])):
        note_count = len(items)
        assigned = [item for item in items if item.get("evidence", {}).get("timingAssignmentAvailable")]
        supported = [item for item in items if item.get("evidence", {}).get("pitchSupportWithin80Cents")]
        pitch_conflicts = [
            item
            for item in assigned
            if item.get("evidence", {}).get("basicPitchPitchDistanceSemitones") != 0
            or not item.get("evidence", {}).get("pitchSupportWithin80Cents")
        ]
        ioi_items = [item for item in items if item.get("evidence", {}).get("relativeIoiEvidenceAvailable")]
        ioi_consistent = [item for item in ioi_items if item.get("evidence", {}).get("relativeIoiConsistent")]
        assignment_rate = len(assigned) / note_count if note_count else 0.0
        pitch_support_rate = len(supported) / note_count if note_count else 0.0
        ioi_opportunity_count = max(1, note_count - 2)
        ioi_evidence_rate = min(1.0, len(ioi_items) / ioi_opportunity_count)
        ioi_consistency_rate = len(ioi_consistent) / len(ioi_items) if ioi_items else 0.0
        pitch_ready = bool(note_count >= 3 and assignment_rate >= 0.8 and pitch_support_rate >= 0.8 and not pitch_conflicts)
        rhythm_ready = bool(note_count >= 3 and ioi_evidence_rate >= 0.8 and ioi_items and len(ioi_consistent) == len(ioi_items))
        rows.append(
            {
                "sectionId": section_id,
                "measureIndex": measure,
                "noteCount": note_count,
                "timingAssignmentCount": len(assigned),
                "timingAssignmentRate": round(assignment_rate, 6),
                "pitchSupportCount": len(supported),
                "pitchSupportRate": round(pitch_support_rate, 6),
                "pitchConflictCount": len(pitch_conflicts),
                "relativeIoiEvidenceCount": len(ioi_items),
                "relativeIoiOpportunityCount": ioi_opportunity_count,
                "relativeIoiEvidenceRate": round(ioi_evidence_rate, 6),
                "relativeIoiConsistentCount": len(ioi_consistent),
                "relativeIoiConsistencyRate": round(ioi_consistency_rate, 6),
                "measurePitchReviewEvidenceReady": pitch_ready,
                "measureRhythmReviewEvidenceReady": rhythm_ready,
                "measureCombinedReviewEvidenceReady": bool(pitch_ready and rhythm_ready),
                "autoDecision": "review_required",
                "studentFacing": False,
            }
        )
    return rows


def build_candidate_rows(decisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, decision in enumerate(decisions):
        evidence = decision.get("evidence") if isinstance(decision.get("evidence"), dict) else {}
        rows.append(
            {
                "candidateId": (
                    f"offline-basic-pitch-dtw:{decision.get('noteId', index)}"
                    if evidence.get("analysisMode") == "basic-pitch-dtw-pyin-review-v1"
                    else f"offline-pyin-linear:{decision.get('noteId', index)}"
                ),
                "noteId": decision.get("noteId"),
                "noteIndex": index,
                "sectionId": decision.get("sectionId"),
                "sectionTitle": decision.get("sectionTitle"),
                "measureIndex": decision.get("measureIndex"),
                "pageNumber": decision.get("pageNumber"),
                "midi": decision.get("midi"),
                "predictedOnsetSeconds": decision.get("predictedOnsetSeconds"),
                "method": (
                    "basic-pitch-dtw-pyin-window"
                    if evidence.get("analysisMode") == "basic-pitch-dtw-pyin-review-v1"
                    else "pyin-linear-score-window"
                ),
                "analysisMode": evidence.get("analysisMode"),
                "voicedFrameCount": evidence.get("voicedFrameCount"),
                "medianObservedMidi": evidence.get("medianObservedMidi"),
                "centsError": evidence.get("centsError"),
                "pitchSupportWithin80Cents": bool(evidence.get("pitchSupportWithin80Cents")),
                "timingAssignmentAvailable": bool(evidence.get("timingAssignmentAvailable")),
                "pitchMeasurementTimeSeconds": evidence.get("pitchMeasurementTimeSeconds"),
                "basicPitchEventMidi": evidence.get("basicPitchEventMidi"),
                "basicPitchEventConfidence": evidence.get("basicPitchEventConfidence"),
                "basicPitchPitchDistanceSemitones": evidence.get("basicPitchPitchDistanceSemitones"),
                "relativeIoiEvidenceAvailable": bool(evidence.get("relativeIoiEvidenceAvailable")),
                "relativeIoiResidualSeconds": evidence.get("relativeIoiResidualSeconds"),
                "relativeIoiDeviationRatio": evidence.get("relativeIoiDeviationRatio"),
                "relativeIoiConsistent": evidence.get("relativeIoiConsistent"),
                "autoDecision": "review_required",
                "reviewRequiredReason": "offline-feature-analysis-review-only",
                "studentSafeGateReady": False,
                "studentFacing": False,
            }
        )
    return rows


def summarize(
    decisions: list[dict[str, Any]],
    score: dict[str, Any],
    audio_duration: float,
    total_notes: int,
    analysis_mode: str,
) -> dict[str, Any]:
    cents_values = [
        abs(float(item["evidence"]["centsError"]))
        for item in decisions
        if item.get("evidence", {}).get("centsError") is not None
    ]
    support_count = sum(1 for item in decisions if item.get("evidence", {}).get("pitchSupportWithin80Cents"))
    assignment_count = sum(
        bool(item.get("evidence", {}).get("timingAssignmentAvailable")) for item in decisions
    )
    exact_assignment_count = sum(
        item.get("evidence", {}).get("basicPitchPitchDistanceSemitones") == 0
        for item in decisions
        if item.get("evidence", {}).get("timingAssignmentAvailable")
    )
    measure_rows = aggregate_measure_evidence(decisions)
    measure_pitch_ready = sum(bool(row["measurePitchReviewEvidenceReady"]) for row in measure_rows)
    measure_rhythm_ready = sum(bool(row["measureRhythmReviewEvidenceReady"]) for row in measure_rows)
    measure_combined_ready = sum(bool(row["measureCombinedReviewEvidenceReady"]) for row in measure_rows)
    return {
        "analysisMode": analysis_mode,
        "scoreId": score.get("scoreId"),
        "scoreTitle": score.get("title") or score.get("scoreId"),
        "audioDurationSeconds": round(audio_duration, 4),
        "noteCount": total_notes,
        "decisionCount": len(decisions),
        "candidateRowCount": len(decisions),
        "autoPassCount": 0,
        "reviewRequiredCount": len(decisions),
        "reviewOnlyCandidateCount": len(decisions),
        "coverage": 0,
        "pitchSupportWithin80CentsCount": support_count,
        "timingAssignmentCount": assignment_count,
        "unassignedNoteCount": len(decisions) - assignment_count,
        "exactEventPitchAssignmentCount": exact_assignment_count,
        "eventPitchConflictCount": assignment_count - exact_assignment_count,
        "measureCount": len(measure_rows),
        "measurePitchReviewEvidenceReadyCount": measure_pitch_ready,
        "measureRhythmReviewEvidenceReadyCount": measure_rhythm_ready,
        "measureCombinedReviewEvidenceReadyCount": measure_combined_ready,
        "measureCombinedReviewEvidenceCoverage": round(measure_combined_ready / len(measure_rows), 6) if measure_rows else 0.0,
        "medianAbsCents": round(statistics.median(cents_values), 2) if cents_values else None,
        "studentSafeGateReady": False,
        "studentFacing": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--score-id", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument(
        "--timing-mode",
        choices=("linear", "basic-pitch-dtw"),
        default=os.getenv("WESTERN_STRINGS_OFFLINE_TIMING_MODE", "linear"),
    )
    parser.add_argument(
        "--basic-pitch-cache",
        default="data/experiments/western-strings-m3/offline-basic-pitch-cache",
    )
    parser.add_argument("--basic-pitch-events", help="Reuse an existing Basic Pitch JSON event cache.")
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    audio_path = Path(args.audio).resolve()
    blocking: list[str] = []
    if not audio_path.exists():
        blocking.append("controlled-batch-missing-audio")
    try:
        store = load_store(repo_root)
    except Exception:
        store = {}
        blocking.append("controlled-batch-score-store-unreadable")
    score, notes = collect_score_notes(store, args.score_id)
    if not score:
        blocking.append("controlled-batch-score-not-found")
    if not notes:
        blocking.append("controlled-batch-score-notes-empty")
    if blocking:
        print(json.dumps({"ok": False, "blockingReasons": blocking, "summary": {"noteCount": 0, "autoPassCount": 0}}, ensure_ascii=False))
        return 0

    try:
        timeline = build_symbolic_timeline(notes)
        times, midi_track, audio_duration = extract_f0(audio_path)
        assignments = None
        analysis_mode = "linear-score-pyin-review-v1"
        if args.timing_mode == "basic-pitch-dtw":
            events = (
                read_basic_pitch_events((repo_root / args.basic_pitch_events).resolve())
                if args.basic_pitch_events
                else load_basic_pitch_events(audio_path, repo_root / args.basic_pitch_cache)
            )
            assignments = assign_basic_pitch_events(timeline, events)
            analysis_mode = "basic-pitch-dtw-pyin-review-v1"
        decisions = build_decisions(
            timeline,
            times,
            midi_track,
            audio_duration,
            max(0, args.limit),
            timing_assignments=assignments,
            analysis_mode=analysis_mode,
        )
        candidate_rows = build_candidate_rows(decisions)
        summary = summarize(decisions, score or {}, audio_duration, len(timeline), analysis_mode)
        payload = {"ok": True, "summary": summary}
        if not args.summary_only:
            payload.update({
                "decisions": decisions,
                "candidateRows": candidate_rows,
                "measureEvidenceRows": aggregate_measure_evidence(decisions),
            })
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "blockingReasons": ["controlled-batch-offline-feature-analysis-failed"],
            "error": f"{type(exc).__name__}: {exc}",
            "summary": {"noteCount": len(notes), "autoPassCount": 0},
        }, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
