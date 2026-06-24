# -*- coding: utf-8 -*-
"""Export segment-level technique features from manual-anchor labels.

This is an eval-only bridge for the technique classifier bake-off:

  manual-anchor labels (segment-level) -> audio-window features -> CSV/JSONL

It intentionally does NOT train a model and does NOT write back to teacher packs.
The labels are segment-level "technique exists in this window" annotations, so the
features here are also segment-level aggregates.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from basic_pitch.inference import predict


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LABEL_ROOT = REPO_ROOT / "data" / "teacher-validation" / "technique-labeling-export"
DEFAULT_OUT_ROOT = REPO_ROOT / "data" / "experiments" / "technique-features"
TECHNIQUE_LABELS = ["glide", "vibrato", "trill", "ornament", "position-shift", "bowing"]
SR = 22050


def latest_label_csv() -> Path:
    candidates = sorted(DEFAULT_LABEL_ROOT.glob("*/manual-anchor-labels.csv"), reverse=True)
    if not candidates:
        raise SystemExit(f"no manual-anchor label export found under {DEFAULT_LABEL_ROOT}")
    return candidates[0]


def as_float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def percentile(values, pct: float, default: float = 0.0) -> float:
    arr = np.asarray(list(values), dtype=np.float32)
    if arr.size == 0:
        return default
    return float(np.percentile(arr, pct))


def mean(values, default: float = 0.0) -> float:
    values = list(values)
    if not values:
        return default
    return float(statistics.fmean(values))


def std(values, default: float = 0.0) -> float:
    values = list(values)
    if len(values) < 2:
        return default
    return float(statistics.pstdev(values))


def count_bend_sign_changes(bends: list[int]) -> int:
    if len(bends) < 3:
        return 0
    diffs = np.diff(np.asarray(bends, dtype=np.float32))
    signs = np.sign(diffs)
    signs = signs[signs != 0]
    if signs.size < 2:
        return 0
    return int(np.sum(signs[:-1] != signs[1:]))


def note_feature_summary(note_events: list[tuple], duration: float) -> dict[str, float | int]:
    notes = []
    bend_abs = []
    bend_ranges = []
    bend_active_frames = 0
    bend_frames = 0
    bend_sign_changes = []
    glide_like_notes = 0
    vibrato_like_notes = 0

    for note in note_events:
        start, end, midi, amp, bends = note
        note_duration = max(0.0, float(end) - float(start))
        notes.append({
            "duration": note_duration,
            "midi": float(midi),
            "amplitude": float(amp),
        })
        if bends:
            bend_arr = [int(item) for item in bends]
            abs_arr = [abs(item) for item in bend_arr]
            bend_abs.extend(abs_arr)
            bend_frames += len(bend_arr)
            bend_active_frames += sum(1 for item in abs_arr if item >= 1)
            bend_range = max(bend_arr) - min(bend_arr)
            bend_ranges.append(float(bend_range))
            sign_changes = count_bend_sign_changes(bend_arr)
            bend_sign_changes.append(float(sign_changes))
            if note_duration >= 0.25 and (abs(bend_arr[-1] - bend_arr[0]) >= 2 or bend_range >= 4) and sign_changes <= 2:
                glide_like_notes += 1
            if note_duration >= 0.30 and bend_range >= 3 and sign_changes >= 3:
                vibrato_like_notes += 1

    midi_values = [item["midi"] for item in notes]
    durations = [item["duration"] for item in notes]
    amplitudes = [item["amplitude"] for item in notes]
    note_count = len(notes)
    pitch_range = max(midi_values) - min(midi_values) if midi_values else 0.0

    return {
        "basicPitchNoteCount": note_count,
        "basicPitchNoteDensityPerSec": round(note_count / max(duration, 1e-6), 4),
        "basicPitchMedianMidi": round(float(np.median(midi_values)), 3) if midi_values else 0.0,
        "basicPitchPitchRangeSemitones": round(float(pitch_range), 3),
        "basicPitchPitchStdSemitones": round(std(midi_values), 3),
        "basicPitchMeanNoteDurationSec": round(mean(durations), 4),
        "basicPitchMedianNoteDurationSec": round(float(np.median(durations)), 4) if durations else 0.0,
        "basicPitchMeanAmplitude": round(mean(amplitudes), 4),
        "basicPitchPitchBendFrameCount": bend_frames,
        "basicPitchPitchBendActiveRatio": round(bend_active_frames / max(bend_frames, 1), 4),
        "basicPitchPitchBendAbsMean": round(mean(bend_abs), 4),
        "basicPitchPitchBendAbsP90": round(percentile(bend_abs, 90), 4),
        "basicPitchPitchBendAbsMax": int(max(bend_abs)) if bend_abs else 0,
        "basicPitchPitchBendRangeMean": round(mean(bend_ranges), 4),
        "basicPitchPitchBendSignChangeMean": round(mean(bend_sign_changes), 4),
        "basicPitchGlideLikeNoteRatio": round(glide_like_notes / max(note_count, 1), 4),
        "basicPitchVibratoLikeNoteRatio": round(vibrato_like_notes / max(note_count, 1), 4),
    }


def audio_feature_summary(y: np.ndarray, sr: int, duration: float) -> dict[str, float | int]:
    if y.size == 0:
        return {
            "audioRmsMean": 0.0,
            "audioRmsStd": 0.0,
            "audioRmsP95": 0.0,
            "audioOnsetCount": 0,
            "audioOnsetRatePerSec": 0.0,
            "audioZeroCrossingRateMean": 0.0,
            "audioSpectralCentroidMean": 0.0,
        }
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    onset_frames = librosa.onset.onset_detect(y=y, sr=sr, hop_length=512, units="frames")
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=2048, hop_length=512)[0]
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=512)[0]
    return {
        "audioRmsMean": round(mean(rms), 6),
        "audioRmsStd": round(std(rms), 6),
        "audioRmsP95": round(percentile(rms, 95), 6),
        "audioOnsetCount": int(len(onset_frames)),
        "audioOnsetRatePerSec": round(len(onset_frames) / max(duration, 1e-6), 4),
        "audioZeroCrossingRateMean": round(mean(zcr), 6),
        "audioSpectralCentroidMean": round(mean(centroid), 3),
    }


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def write_outputs(rows: list[dict], out_csv: Path) -> None:
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(rows[0].keys()) if rows else []
    with out_csv.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    jsonl_path = out_csv.with_suffix(".jsonl")
    with jsonl_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def extract_segment(row: dict[str, str]) -> tuple[np.ndarray, float]:
    source = REPO_ROOT / row["sourceAudioPath"]
    start = as_float(row.get("audioStartSeconds", "0"))
    end = as_float(row.get("audioEndSeconds", "0"))
    duration = max(0.0, end - start)
    if not source.exists():
        raise FileNotFoundError(source)
    y, sr = librosa.load(source, sr=SR, mono=True, offset=start, duration=duration)
    return y, duration


def build_feature_row(row: dict[str, str], temp_dir: Path) -> dict:
    start = as_float(row.get("audioStartSeconds", "0"))
    end = as_float(row.get("audioEndSeconds", "0"))
    duration = max(0.0, end - start)
    tags = [tag for tag in row.get("teacherTechniqueTags", "").split("|") if tag]
    match_status = row.get("teacherMatchStatus", "").strip()
    base = {
        "packId": row.get("packId", ""),
        "caseId": row.get("caseId", ""),
        "pieceTitle": row.get("pieceTitle", ""),
        "sectionId": row.get("sectionId", ""),
        "sectionTitle": row.get("sectionTitle", ""),
        "sourceAudioPath": row.get("sourceAudioPath", ""),
        "audioStartSeconds": start,
        "audioEndSeconds": end,
        "durationSeconds": round(duration, 3),
        "teacherMatchStatus": match_status,
        "teacherMatchStatusEffective": match_status or "unknown",
        "teacherTechniqueTags": row.get("teacherTechniqueTags", ""),
        "teacherTechniqueConfidence": row.get("teacherTechniqueConfidence", ""),
        "teacherTechniqueUncertain": row.get("teacherTechniqueUncertain", ""),
        "overallAgreement": row.get("overallAgreement", ""),
        "teacherPrimaryPath": row.get("teacherPrimaryPath", ""),
        "comments": row.get("comments", ""),
    }
    for label in TECHNIQUE_LABELS:
        base[f"label_{label}"] = 1 if label in tags else 0

    try:
        y, loaded_duration = extract_segment(row)
        if duration <= 0:
            duration = loaded_duration
            base["durationSeconds"] = round(duration, 3)
        base.update(audio_feature_summary(y, SR, duration))

        wav_path = temp_dir / f"{row.get('caseId', 'segment')[:48]}.wav"
        sf.write(wav_path, y, SR)
        _, _, note_events = predict(
            str(wav_path),
            minimum_frequency=120.0,
            maximum_frequency=2000.0,
            multiple_pitch_bends=True,
        )
        base.update(note_feature_summary(note_events, duration))
        base["featureError"] = ""
    except Exception as exc:  # keep batch usable; errors are surfaced in CSV.
        base.update(audio_feature_summary(np.asarray([], dtype=np.float32), SR, duration))
        base.update(note_feature_summary([], duration))
        base["featureError"] = f"{type(exc).__name__}: {exc}"
    return base


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--labels", default="", help="manual-anchor-labels.csv; defaults to latest export")
    parser.add_argument("--out", default="", help="output CSV path")
    parser.add_argument("--max-rows", type=int, default=0, help="limit rows for smoke testing")
    args = parser.parse_args()

    labels_path = Path(args.labels) if args.labels else latest_label_csv()
    if not labels_path.is_absolute():
        labels_path = REPO_ROOT / labels_path
    rows = load_rows(labels_path)
    rows = [row for row in rows if row.get("teacherMatchStatus", "").strip() != "mismatch"]
    if args.max_rows > 0:
        rows = rows[: args.max_rows]
    if not rows:
        raise SystemExit("no matched manual-anchor rows to featurize")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_csv = Path(args.out) if args.out else DEFAULT_OUT_ROOT / f"basic-pitch-segment-features-{stamp}.csv"
    if not out_csv.is_absolute():
        out_csv = REPO_ROOT / out_csv

    feature_rows = []
    with tempfile.TemporaryDirectory(prefix="erhu-basic-pitch-") as td:
        temp_dir = Path(td)
        for index, row in enumerate(rows, start=1):
            print(f"[{index}/{len(rows)}] {row.get('packId')} {row.get('sectionId')} {row.get('audioStartSeconds')}-{row.get('audioEndSeconds')}s")
            feature_rows.append(build_feature_row(row, temp_dir))

    write_outputs(feature_rows, out_csv)
    errors = sum(1 for row in feature_rows if row.get("featureError"))
    label_counts = {
        label: int(sum(row.get(f"label_{label}", 0) for row in feature_rows))
        for label in TECHNIQUE_LABELS
    }
    print(json.dumps({
        "ok": errors == 0,
        "rows": len(feature_rows),
        "errors": errors,
        "labels": str(labels_path),
        "outCsv": str(out_csv),
        "outJsonl": str(out_csv.with_suffix(".jsonl")),
        "labelCounts": label_counts,
    }, ensure_ascii=False, indent=2))
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
