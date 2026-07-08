from __future__ import annotations

import argparse
import json
import math
import sqlite3
import statistics
from pathlib import Path
from typing import Any

import librosa
import numpy as np


def safe_float(value: Any, fallback: float | None = None) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    return numeric if math.isfinite(numeric) else fallback


def safe_int(value: Any, fallback: int = 0) -> int:
    numeric = safe_float(value)
    return int(round(numeric)) if numeric is not None else fallback


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
    raw_units: list[float] = []
    last_unit = 0.0
    for index, note in enumerate(notes):
        measure = safe_int(note.get("measureIndex"), min_measure)
        beat_start = safe_float(note.get("beatStart"), 0.0) or 0.0
        unit = max(0.0, (measure - min_measure) * 4.0 + beat_start)
        if index and unit <= last_unit:
            unit = last_unit + max(0.05, safe_float(note.get("beatDuration"), 0.5) or 0.5)
        raw_units.append(unit)
        last_unit = unit
    start = raw_units[0]
    shifted = [unit - start for unit in raw_units]
    for note, unit in zip(notes, shifted):
        note["scoreUnit"] = unit
    return notes


def extract_f0(audio_path: Path) -> tuple[np.ndarray, np.ndarray, float]:
    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
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


def cents_error(observed_midi: float, target_midi: int) -> float:
    return float((observed_midi - target_midi) * 100.0)


def build_decisions(notes: list[dict[str, Any]], times: np.ndarray, midi_track: np.ndarray, audio_duration: float, limit: int) -> list[dict[str, Any]]:
    if not notes:
        return []
    score_span = max((safe_float(note.get("scoreUnit"), 0.0) or 0.0) for note in notes)
    scale = (audio_duration / score_span) if score_span > 0 else 0.0
    decisions: list[dict[str, Any]] = []
    for note in notes[: limit if limit > 0 else len(notes)]:
        score_unit = safe_float(note.get("scoreUnit"), 0.0) or 0.0
        predicted_onset = max(0.0, min(audio_duration, score_unit * scale)) if scale > 0 else 0.0
        window = np.abs(times - predicted_onset) <= 0.18
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
                "predictedOnsetSeconds": round(predicted_onset, 4),
                "autoDecision": "review_required",
                "reviewRequiredReason": "offline-feature-analysis-review-only",
                "confidenceScore": 0.0,
                "evidence": {
                    "analysisMode": "linear-score-pyin-review-v1",
                    "voicedFrameCount": voiced_frames,
                    "medianObservedMidi": round(median_midi, 4) if median_midi is not None else None,
                    "centsError": round(cents, 2) if cents is not None else None,
                    "pitchSupportWithin80Cents": support,
                },
            }
        )
    return decisions


def build_candidate_rows(decisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, decision in enumerate(decisions):
        evidence = decision.get("evidence") if isinstance(decision.get("evidence"), dict) else {}
        rows.append(
            {
                "candidateId": f"offline-pyin-linear:{decision.get('noteId', index)}",
                "noteId": decision.get("noteId"),
                "noteIndex": index,
                "sectionId": decision.get("sectionId"),
                "sectionTitle": decision.get("sectionTitle"),
                "measureIndex": decision.get("measureIndex"),
                "pageNumber": decision.get("pageNumber"),
                "midi": decision.get("midi"),
                "predictedOnsetSeconds": decision.get("predictedOnsetSeconds"),
                "method": "pyin-linear-score-window",
                "analysisMode": "linear-score-pyin-review-v1",
                "voicedFrameCount": evidence.get("voicedFrameCount"),
                "medianObservedMidi": evidence.get("medianObservedMidi"),
                "centsError": evidence.get("centsError"),
                "pitchSupportWithin80Cents": bool(evidence.get("pitchSupportWithin80Cents")),
                "autoDecision": "review_required",
                "reviewRequiredReason": "offline-feature-analysis-review-only",
                "studentSafeGateReady": False,
                "studentFacing": False,
            }
        )
    return rows


def summarize(decisions: list[dict[str, Any]], score: dict[str, Any], audio_duration: float, total_notes: int) -> dict[str, Any]:
    cents_values = [
        abs(float(item["evidence"]["centsError"]))
        for item in decisions
        if item.get("evidence", {}).get("centsError") is not None
    ]
    support_count = sum(1 for item in decisions if item.get("evidence", {}).get("pitchSupportWithin80Cents"))
    return {
        "analysisMode": "linear-score-pyin-review-v1",
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
        decisions = build_decisions(timeline, times, midi_track, audio_duration, max(0, args.limit))
        candidate_rows = build_candidate_rows(decisions)
        summary = summarize(decisions, score or {}, audio_duration, len(timeline))
        print(json.dumps({"ok": True, "summary": summary, "decisions": decisions, "candidateRows": candidate_rows}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "blockingReasons": ["controlled-batch-offline-feature-analysis-failed"],
            "error": str(exc),
            "summary": {"noteCount": len(notes), "autoPassCount": 0},
        }, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
