from __future__ import annotations

import argparse
import csv
import json
import math
import sqlite3
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import librosa
import numpy as np


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recordings-manifest.csv"
DEFAULT_OUT_DIR = REPO / "data" / "experiments" / "western-strings-m3plus"


def safe_float(value: Any, fallback: float | None = None) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    return numeric if math.isfinite(numeric) else fallback


def safe_int(value: Any, fallback: int = 0) -> int:
    numeric = safe_float(value)
    return int(round(numeric)) if numeric is not None else fallback


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def load_score_store(repo_root: Path) -> dict[str, Any]:
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


def normalize_techniques(note: dict[str, Any]) -> list[str]:
    values: list[str] = []
    raw = note.get("techniques")
    if isinstance(raw, list):
        values.extend(str(item).strip().lower() for item in raw if str(item).strip())
    elif raw:
        values.append(str(raw).strip().lower())
    for key in ["ornaments", "articulations", "notations"]:
        raw_value = note.get(key)
        if isinstance(raw_value, list):
            values.extend(str(item).strip().lower() for item in raw_value if str(item).strip())
        elif raw_value:
            values.append(str(raw_value).strip().lower())
    return sorted(set(values))


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
                    "techniques": normalize_techniques(note),
                    "position": note_position(note),
                }
            )
            order += 1
    notes.sort(
        key=lambda item: (
            safe_int(item["position"].get("pageNumber"), 0),
            safe_int(item.get("measureIndex"), 0),
            safe_float(item.get("beatStart"), 0.0) or 0.0,
            safe_int(item.get("order"), 0),
        )
    )
    add_symbolic_units(notes)
    mark_double_stops(notes)
    return score, notes


def add_symbolic_units(notes: list[dict[str, Any]]) -> None:
    if not notes:
        return
    min_measure = min(safe_int(note.get("measureIndex"), 0) for note in notes)
    last_unit = 0.0
    for index, note in enumerate(notes):
        measure = safe_int(note.get("measureIndex"), min_measure)
        beat_start = safe_float(note.get("beatStart"), 0.0) or 0.0
        unit = max(0.0, (measure - min_measure) * 4.0 + beat_start)
        if index and unit <= last_unit:
            unit = last_unit + max(0.05, safe_float(note.get("beatDuration"), 0.5) or 0.5)
        note["scoreUnit"] = unit
        note["scoreDurationUnit"] = max(0.05, safe_float(note.get("beatDuration"), 1.0) or 1.0)
        last_unit = unit
    first_unit = safe_float(notes[0].get("scoreUnit"), 0.0) or 0.0
    for note in notes:
        note["scoreUnit"] = (safe_float(note.get("scoreUnit"), 0.0) or 0.0) - first_unit


def mark_double_stops(notes: list[dict[str, Any]]) -> None:
    groups: dict[tuple[int, float], list[dict[str, Any]]] = defaultdict(list)
    for note in notes:
        key = (safe_int(note.get("measureIndex"), 0), round(safe_float(note.get("beatStart"), 0.0) or 0.0, 3))
        groups[key].append(note)
    for group in groups.values():
        midi_values = {safe_int(note.get("midi"), 0) for note in group}
        is_double_stop = len(group) > 1 and len(midi_values) > 1
        for note in group:
            note["doubleStopCandidate"] = is_double_stop


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


def count_sign_changes(values: np.ndarray, threshold: float) -> int:
    if values.size < 3:
        return 0
    signs = np.sign(np.where(np.abs(values) >= threshold, values, 0.0))
    signs = signs[signs != 0]
    if signs.size < 2:
        return 0
    return int(np.sum(signs[1:] != signs[:-1]))


def switch_count(labels: np.ndarray) -> int:
    if labels.size < 2:
        return 0
    return int(np.sum(labels[1:] != labels[:-1]))


def analyze_pitch_window(
    *,
    times: np.ndarray,
    midi_track: np.ndarray,
    target_midi: int,
    start_seconds: float,
    end_seconds: float,
) -> dict[str, Any]:
    mask = (times >= start_seconds) & (times <= end_seconds)
    values = midi_track[mask]
    local_times = times[mask]
    valid = np.isfinite(values)
    values = values[valid]
    local_times = local_times[valid]
    if values.size < 4:
        return {
            "voicedFrameCount": int(values.size),
            "windowDurationSeconds": round(max(0.0, end_seconds - start_seconds), 4),
            "primaryMode": "insufficient-f0",
            "flags": ["insufficient-f0"],
            "reviewOnly": True,
        }

    cents = (values - float(target_midi)) * 100.0
    duration = max(0.001, float(local_times[-1] - local_times[0]))
    p05, p10, p25, p50, p75, p90, p95 = np.percentile(cents, [5, 10, 25, 50, 75, 90, 95])
    spread = float(p95 - p05)
    iqr = float(p75 - p25)
    head = cents[: max(1, values.size // 4)]
    tail = cents[-max(1, values.size // 4) :]
    entry = float(np.median(head))
    exit_ = float(np.median(tail))
    net_motion = exit_ - entry
    diffs = np.diff(cents)
    total_motion = float(np.sum(np.abs(diffs))) if diffs.size else 0.0
    monotonicity = abs(net_motion) / total_motion if total_motion > 0 else 0.0
    centered = cents - p50
    zero_crossings = count_sign_changes(centered, 5.0)
    vibrato_rate_hz = zero_crossings / max(0.001, 2.0 * duration)
    vibrato_amplitude = spread / 2.0

    low = cents <= p50
    low_values = cents[low]
    high_values = cents[~low]
    trill_gap = 0.0
    trill_switches = 0
    if low_values.size >= 2 and high_values.size >= 2:
        low_center = float(np.median(low_values))
        high_center = float(np.median(high_values))
        trill_gap = high_center - low_center
        labels = np.where(cents <= (low_center + high_center) / 2.0, 0, 1)
        trill_switches = switch_count(labels)

    flags: list[str] = []
    stable_like = spread <= 60.0 and abs(float(p50)) <= 80.0
    vibrato_like = (
        18.0 <= vibrato_amplitude <= 90.0
        and 3.0 <= vibrato_rate_hz <= 9.0
        and zero_crossings >= 4
        and abs(net_motion) <= 120.0
    )
    slide_like = abs(net_motion) >= 80.0 and monotonicity >= 0.45 and not vibrato_like
    trill_like = trill_gap >= 120.0 and trill_switches >= 3 and duration >= 0.18

    if stable_like:
        flags.append("stable")
    if vibrato_like:
        flags.append("vibrato-like")
    if slide_like:
        flags.append("slide-like")
    if trill_like:
        flags.append("trill-like")

    primary = "stable" if stable_like else "variable-f0"
    for candidate in ["trill-like", "vibrato-like", "slide-like"]:
        if candidate in flags:
            primary = candidate
            break
    return {
        "voicedFrameCount": int(values.size),
        "windowDurationSeconds": round(max(0.0, end_seconds - start_seconds), 4),
        "medianCents": round(float(p50), 2),
        "absMedianCents": round(abs(float(p50)), 2),
        "spreadCentsP95P05": round(spread, 2),
        "iqrCents": round(iqr, 2),
        "entryCents": round(entry, 2),
        "exitCents": round(exit_, 2),
        "netMotionCents": round(float(net_motion), 2),
        "monotonicity": round(float(monotonicity), 4),
        "zeroCrossings": int(zero_crossings),
        "vibratoRateHzApprox": round(float(vibrato_rate_hz), 3),
        "vibratoAmplitudeCentsApprox": round(float(vibrato_amplitude), 2),
        "trillGapCentsApprox": round(float(trill_gap), 2),
        "trillSwitchCountApprox": int(trill_switches),
        "primaryMode": primary,
        "flags": flags or ["variable-f0"],
        "reviewOnly": True,
    }


def is_harmonic_candidate(note: dict[str, Any]) -> bool:
    text = " ".join(note.get("techniques") or [])
    return "harmonic" in text or "flageolet" in text


def is_ornament_candidate(note: dict[str, Any], duration_seconds: float) -> bool:
    text = " ".join(note.get("techniques") or [])
    if any(token in text for token in ["grace", "trill-mark", "mordent", "turn", "ornament"]):
        return True
    beat_duration = safe_float(note.get("beatDuration"), 1.0) or 1.0
    # Do not treat ordinary sixteenth-note passages as ornaments. In the absence
    # of score markings, only flag truly tiny grace-like notes for review.
    return beat_duration <= 0.125 or duration_seconds <= 0.12


def classify_recording(
    *,
    repo_root: Path,
    manifest_row: dict[str, str],
    store: dict[str, Any],
    note_limit: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    score_id = str(manifest_row.get("scoreId") or "").strip()
    audio_text = str(manifest_row.get("audioPath") or "").strip()
    audio_path = Path(audio_text)
    if not audio_path.is_absolute():
        audio_path = repo_root / audio_path
    score, notes = collect_score_notes(store, score_id)
    if not score:
        return [], {"recordingId": manifest_row.get("recordingId"), "ok": False, "reason": "score-not-found"}
    if not audio_path.exists():
        return [], {"recordingId": manifest_row.get("recordingId"), "ok": False, "reason": "audio-not-found"}
    times, midi_track, audio_duration = extract_f0(audio_path)
    score_span = max((safe_float(note.get("scoreUnit"), 0.0) or 0.0) for note in notes) if notes else 0.0
    scale = audio_duration / score_span if score_span > 0 else 0.0
    rows: list[dict[str, Any]] = []
    selected_notes = notes[: note_limit if note_limit > 0 else len(notes)]
    for note_index, note in enumerate(selected_notes):
        score_unit = safe_float(note.get("scoreUnit"), 0.0) or 0.0
        score_duration_unit = safe_float(note.get("scoreDurationUnit"), 0.5) or 0.5
        onset = max(0.0, min(audio_duration, score_unit * scale)) if scale > 0 else 0.0
        duration = max(0.18, min(2.5, score_duration_unit * scale if scale > 0 else 0.5))
        start = max(0.0, onset - 0.04)
        end = min(audio_duration, onset + duration + 0.04)
        features = analyze_pitch_window(
            times=times,
            midi_track=midi_track,
            target_midi=safe_int(note.get("midi"), 0),
            start_seconds=start,
            end_seconds=end,
        )
        flags = list(features.get("flags") or [])
        if note.get("doubleStopCandidate"):
            flags.append("double-stop-candidate")
        if is_harmonic_candidate(note):
            flags.append("harmonic-candidate")
        if is_ornament_candidate(note, duration):
            flags.append("ornament-candidate")
        primary = str(features.get("primaryMode") or "variable-f0")
        for candidate in ["double-stop-candidate", "harmonic-candidate", "trill-like", "vibrato-like", "slide-like", "ornament-candidate"]:
            if candidate in flags:
                primary = candidate
                break
        rows.append(
            {
                "recordingId": manifest_row.get("recordingId"),
                "scenario": manifest_row.get("scenario"),
                "scoreId": score_id,
                "pieceId": manifest_row.get("pieceId"),
                "noteIndex": note_index,
                "noteId": note.get("noteId"),
                "measureIndex": note.get("position", {}).get("measureIndex") or note.get("measureIndex"),
                "pageNumber": note.get("position", {}).get("pageNumber"),
                "midi": note.get("midi"),
                "predictedOnsetSeconds": round(onset, 4),
                "predictedDurationSeconds": round(duration, 4),
                "primaryMode": primary,
                "flags": "|".join(sorted(set(flags))),
                "studentDecision": "review_required",
                "reason": "m3plus-pitch-mode-inventory-only",
                **{key: value for key, value in features.items() if key not in {"flags", "primaryMode"}},
            }
        )
    return rows, {
        "recordingId": manifest_row.get("recordingId"),
        "ok": True,
        "scoreId": score_id,
        "audioPath": str(audio_path.relative_to(repo_root) if audio_path.is_relative_to(repo_root) else audio_path),
        "audioDurationSeconds": round(audio_duration, 4),
        "scoreNoteCount": len(notes),
        "analyzedNoteCount": len(rows),
        "alignmentAssumption": "linear-scoretime-review-only",
    }


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


def summarize(rows: list[dict[str, Any]], recording_summaries: list[dict[str, Any]], manifest_rows: list[dict[str, str]]) -> dict[str, Any]:
    primary_counts = Counter(str(row.get("primaryMode") or "") for row in rows)
    flag_counts: Counter[str] = Counter()
    for row in rows:
        for flag in str(row.get("flags") or "").split("|"):
            if flag:
                flag_counts[flag] += 1
    behavior_flags = {
        "vibrato-like",
        "slide-like",
        "trill-like",
        "ornament-candidate",
        "double-stop-candidate",
        "harmonic-candidate",
    }
    behavior_candidate_count = sum(
        1
        for row in rows
        if behavior_flags.intersection(set(str(row.get("flags") or "").split("|")))
    )
    voiced_counts = [safe_int(row.get("voicedFrameCount"), 0) for row in rows]
    return {
        "ok": True,
        "gate": {
            "name": "western-strings-m3plus-pitch-mode-inventory",
            "studentGateReady": False,
            "reason": "inventory-only-no-human-mode-labels",
            "runtimeEffect": "none",
        },
        "inputs": {
            "manifestRows": len(manifest_rows),
            "recordingsAnalyzed": sum(1 for item in recording_summaries if item.get("ok")),
            "recordingsFailed": [item for item in recording_summaries if not item.get("ok")],
        },
        "notes": {
            "analyzedNoteCount": len(rows),
            "behaviorCandidateCount": behavior_candidate_count,
            "behaviorCandidateRatio": round(behavior_candidate_count / max(len(rows), 1), 6),
            "medianVoicedFrameCount": statistics.median(voiced_counts) if voiced_counts else 0,
        },
        "primaryModeCounts": dict(sorted(primary_counts.items())),
        "flagCounts": dict(sorted(flag_counts.items())),
        "recordings": recording_summaries,
        "caveats": [
            "This is eval-only inventory. It does not validate M3+ precision.",
            "Windows are based on linear score-time mapping, so every row remains review_required.",
            "Next gate requires human labels or gold annotations for each pitch behavior mode.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inventory Western Strings M3+ pitch-behavior candidates.")
    parser.add_argument("--repo-root", type=Path, default=REPO)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--note-limit", type=int, default=0, help="Limit notes per recording; 0 means all notes.")
    parser.add_argument("--max-recordings", type=int, default=0, help="Limit recordings for a quick smoke run; 0 means all.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    manifest_path = args.manifest if args.manifest.is_absolute() else repo_root / args.manifest
    manifest_rows = read_csv(manifest_path)
    if args.max_recordings > 0:
        manifest_rows = manifest_rows[: args.max_recordings]
    store = load_score_store(repo_root)
    all_rows: list[dict[str, Any]] = []
    recording_summaries: list[dict[str, Any]] = []
    for manifest_row in manifest_rows:
        rows, summary = classify_recording(
            repo_root=repo_root,
            manifest_row=manifest_row,
            store=store,
            note_limit=max(0, args.note_limit),
        )
        all_rows.extend(rows)
        recording_summaries.append(summary)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.out_dir / "m3plus-pitch-mode-inventory.csv"
    json_path = args.out_dir / "m3plus-pitch-mode-summary.json"
    write_csv(csv_path, all_rows)
    summary = summarize(all_rows, recording_summaries, manifest_rows)
    summary["artifacts"] = {
        "csv": str(csv_path.relative_to(repo_root) if csv_path.is_relative_to(repo_root) else csv_path),
        "json": str(json_path.relative_to(repo_root) if json_path.is_relative_to(repo_root) else json_path),
    }
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
