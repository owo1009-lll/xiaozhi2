from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from scipy.signal import find_peaks


REPO = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from create_western_strings_m2f_results_review_pack import (  # noqa: E402
    align_score_to_events_dtw,
    parse_score_notes,
)
from eval_western_strings_m3plus_pitch_modes import (  # noqa: E402
    collect_score_notes,
    load_score_store,
)


DEFAULT_MANIFEST = REPO / "data" / "private" / "western-strings-round2" / "manifest.csv"
DEFAULT_HUMAN_GOLD = REPO / "docs" / "western-strings-round2-m3plus-human-gold.json"
DEFAULT_CACHE_DIR = REPO / "data" / "experiments" / "western-strings-round2" / "m3plus-basic-pitch-cache"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-round2" / "m3plus-trill-vibrato-diagnostic.json"
DEFAULT_RECORDING_ID = "round2-r2-06-20260715"


def safe_div(numerator: float, denominator: float) -> float:
    return float(numerator / denominator) if denominator else 0.0


def read_manifest_row(path: Path, recording_id: str) -> dict[str, str]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        row = next((item for item in csv.DictReader(handle) if item.get("recordingId") == recording_id), None)
    if row is None:
        raise ValueError(f"recording-not-found:{recording_id}")
    return row


def read_human_gold(path: Path, recording_id: str) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    row = next((item for item in payload.get("recordings", []) if item.get("recordingId") == recording_id), None)
    if row is None:
        raise ValueError(f"human-gold-not-found:{recording_id}")
    return row


def resolve_repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def derive_activity_anchored_windows(
    score_notes: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> tuple[list[dict[str, float]], dict[str, float]]:
    if not score_notes or not events:
        return [], {}
    score_min = min(int(note["midi"]) for note in score_notes)
    score_max = max(int(note["midi"]) for note in score_notes)
    activity_events = [
        event
        for event in events
        if score_min - 12 <= int(event.get("midi", -999)) <= score_max + 12
        and float(event.get("confidence", 0.0)) >= 0.4
    ]
    if not activity_events:
        raise ValueError("performance-activity-span-missing")
    performance_start = min(float(event["start"]) for event in activity_events)
    performance_end = max(float(event["end"]) for event in activity_events)
    score_start = min(float(note["scoreBeat"]) for note in score_notes)
    score_end = max(float(note["scoreBeat"]) + float(note["durationBeats"]) for note in score_notes)
    seconds_per_beat = safe_div(performance_end - performance_start, score_end - score_start)
    windows = []
    for note in score_notes:
        start = performance_start + (float(note["scoreBeat"]) - score_start) * seconds_per_beat
        end = performance_start + (
            float(note["scoreBeat"]) + float(note["durationBeats"]) - score_start
        ) * seconds_per_beat
        trim = min(0.1, max(0.0, (end - start) * 0.04))
        windows.append({"start": start + trim, "end": end - trim})
    return windows, {
        "performanceStartSeconds": round(performance_start, 6),
        "performanceEndSeconds": round(performance_end, 6),
        "secondsPerScoreBeat": round(seconds_per_beat, 6),
    }


def dtw_window_diagnostics(
    score_notes: list[dict[str, Any]],
    matched: list[dict[str, Any] | None],
    seconds_per_beat: float,
) -> dict[str, Any]:
    rows = []
    for index, note in enumerate(score_notes):
        event = matched[index]
        expected_duration = float(note["durationBeats"]) * seconds_per_beat
        if event is None:
            rows.append({
                "noteIndex": index,
                "measureIndex": int(note["measure"]),
                "midi": int(note["midi"]),
                "status": "unmatched",
                "expectedDurationSeconds": round(expected_duration, 4),
                "windowDurationSeconds": None,
                "durationRatio": None,
            })
            continue
        next_start = next(
            (float(candidate["start"]) for candidate in matched[index + 1 :] if candidate is not None),
            float(event["end"]),
        )
        duration = max(0.0, next_start - float(event["start"]))
        ratio = safe_div(duration, expected_duration)
        rows.append({
            "noteIndex": index,
            "measureIndex": int(note["measure"]),
            "midi": int(note["midi"]),
            "status": "matched",
            "expectedDurationSeconds": round(expected_duration, 4),
            "windowDurationSeconds": round(duration, 4),
            "durationRatio": round(ratio, 4),
        })
    implausible = [
        row for row in rows
        if row["status"] != "matched"
        or row["durationRatio"] is None
        or float(row["durationRatio"]) < 0.5
        or float(row["durationRatio"]) > 1.75
    ]
    return {
        "matchedNoteCount": sum(row["status"] == "matched" for row in rows),
        "unmatchedNoteCount": sum(row["status"] == "unmatched" for row in rows),
        "implausibleWindowCount": len(implausible),
        "implausibleWindowRate": round(safe_div(len(implausible), len(rows)), 6),
        "diagnosticBounds": {"minimumDurationRatio": 0.5, "maximumDurationRatio": 1.75},
        "rows": rows,
    }


def event_feature_row(
    events: list[dict[str, Any]],
    onset_envelope: np.ndarray,
    chroma: np.ndarray,
    frame_times: np.ndarray,
    start: float,
    end: float,
) -> dict[str, float]:
    duration = max(0.01, end - start)
    local_events = sorted(
        [
            event for event in events
            if float(event["start"]) < end
            and float(event["end"]) > start
            and 36 <= int(event.get("midi", -999)) <= 96
            and float(event.get("confidence", 0.0)) >= 0.25
        ],
        key=lambda event: (float(event["start"]), float(event["end"])),
    )
    pitch_classes = [int(event["midi"]) % 12 for event in local_events]
    pitch_switches = sum(left != right for left, right in zip(pitch_classes, pitch_classes[1:]))

    mask = (frame_times >= start) & (frame_times < end)
    local_onset = onset_envelope[mask]
    local_chroma = chroma[:, mask]
    peak_count = 0
    if local_onset.size:
        median = float(np.median(local_onset))
        mad = float(np.median(np.abs(local_onset - median)))
        peak_indices, _ = find_peaks(local_onset, height=median + 1.5 * mad, distance=7)
        peak_count = int(len(peak_indices))

    chroma_switches = 0
    chroma_entropy = 0.0
    secondary_ratio = 0.0
    if local_chroma.shape[1]:
        dominant = np.argmax(local_chroma, axis=0)
        if dominant.size >= 5:
            dominant = np.array([
                np.bincount(
                    dominant[max(0, index - 2): min(dominant.size, index + 3)],
                    minlength=12,
                ).argmax()
                for index in range(dominant.size)
            ])
        chroma_switches = int(np.sum(dominant[1:] != dominant[:-1])) if dominant.size > 1 else 0
        average = np.mean(local_chroma, axis=1)
        total = float(np.sum(average))
        probabilities = average / total if total > 0 else average
        positive = probabilities[probabilities > 0]
        chroma_entropy = float(-np.sum(positive * np.log2(positive)) / math.log2(12)) if positive.size else 0.0
        ordered = np.sort(average)
        secondary_ratio = safe_div(float(ordered[-2]), float(ordered[-1])) if ordered.size >= 2 else 0.0

    return {
        "eventRateHz": round(safe_div(len(local_events), duration), 6),
        "eventPitchClassSwitchRateHz": round(safe_div(pitch_switches, duration), 6),
        "onsetPeakRateHz": round(safe_div(peak_count, duration), 6),
        "onsetStrengthMean": round(float(np.mean(local_onset)) if local_onset.size else 0.0, 6),
        "chromaSwitchRateHz": round(safe_div(chroma_switches, duration), 6),
        "chromaEntropy": round(chroma_entropy, 6),
        "secondaryChromaRatio": round(secondary_ratio, 6),
    }


def classification_metrics(labels: list[int], predictions: list[int]) -> dict[str, float | int]:
    tp = sum(label == 1 and prediction == 1 for label, prediction in zip(labels, predictions))
    fp = sum(label == 0 and prediction == 1 for label, prediction in zip(labels, predictions))
    tn = sum(label == 0 and prediction == 0 for label, prediction in zip(labels, predictions))
    fn = sum(label == 1 and prediction == 0 for label, prediction in zip(labels, predictions))
    precision = safe_div(tp, tp + fp)
    recall = safe_div(tp, tp + fn)
    specificity = safe_div(tn, tn + fp)
    return {
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "specificity": round(specificity, 6),
        "balancedAccuracy": round((recall + specificity) / 2.0, 6),
        "f1": round(safe_div(2.0 * precision * recall, precision + recall), 6),
    }


def best_single_feature_threshold(values: list[float], labels: list[int]) -> dict[str, Any]:
    unique = sorted(set(float(value) for value in values))
    thresholds = unique if len(unique) == 1 else [
        (left + right) / 2.0 for left, right in zip(unique, unique[1:])
    ]
    candidates = []
    for threshold in thresholds:
        for direction in ["greater-or-equal", "less-or-equal"]:
            predictions = [
                int(value >= threshold) if direction == "greater-or-equal" else int(value <= threshold)
                for value in values
            ]
            metrics = classification_metrics(labels, predictions)
            candidates.append({"threshold": round(threshold, 6), "direction": direction, **metrics})
    return max(candidates, key=lambda row: (row["balancedAccuracy"], row["f1"], row["precision"]))


def summarize_features(rows: list[dict[str, Any]]) -> dict[str, Any]:
    feature_names = [
        "eventRateHz",
        "eventPitchClassSwitchRateHz",
        "onsetPeakRateHz",
        "onsetStrengthMean",
        "chromaSwitchRateHz",
        "chromaEntropy",
        "secondaryChromaRatio",
    ]
    labels = [1 if row["humanLabel"] == "trill" else 0 for row in rows]
    thresholds = {}
    medians = {}
    for feature in feature_names:
        values = [float(row[feature]) for row in rows]
        thresholds[feature] = best_single_feature_threshold(values, labels)
        medians[feature] = {
            "trill": round(float(np.median([row[feature] for row in rows if row["humanLabel"] == "trill"])), 6),
            "vibrato": round(float(np.median([row[feature] for row in rows if row["humanLabel"] == "vibrato"])), 6),
        }
    ranked = sorted(
        ({"feature": feature, **result} for feature, result in thresholds.items()),
        key=lambda row: (row["balancedAccuracy"], row["f1"]),
        reverse=True,
    )
    return {"classMedians": medians, "trainingOnlySingleFeatureThresholds": ranked}


def render_markdown(report: dict[str, Any]) -> str:
    dtw = report["dtwWindowDiagnostics"]
    best = report["featureDiagnostics"]["trainingOnlySingleFeatureThresholds"][:3]
    lines = [
        "# 第二轮 r2-06 颤音/揉弦诊断",
        "",
        "本报告只用于定位窗口和候选特征。阈值是在同一条录音上选择的训练内结果,不是发布证据。",
        "",
        f"- 人工金标:颤音 {report['goldCounts']['trill']},揉弦长音 {report['goldCounts']['vibrato']}",
        f"- Basic Pitch DTW:匹配 {dtw['matchedNoteCount']}/{report['scoreNoteCount']},不合理窗口 {dtw['implausibleWindowCount']}/{report['scoreNoteCount']}",
        f"- 金标计数一致:{report['goldCountConsistent']}",
        "",
        "| 训练内候选特征 | 方向/阈值 | Precision | Recall | Balanced accuracy |",
        "|---|---|---:|---:|---:|",
    ]
    for row in best:
        lines.append(
            f"| {row['feature']} | {row['direction']} {row['threshold']} | "
            f"{row['precision']:.3f} | {row['recall']:.3f} | {row['balancedAccuracy']:.3f} |"
        )
    lines.extend([
        "",
        "- 当前结论:旧颤音/揉弦漏检首先受错误音符窗口影响,不能通过调低阈值修复。",
        "- 任何候选规则必须在新增无颤音/无揉弦负例和另一条独立录音上复验;此前保持 review-only。",
        "",
    ])
    return "\n".join(lines)


def run(
    manifest_path: Path,
    human_gold_path: Path,
    cache_dir: Path,
    out_path: Path,
    recording_id: str,
) -> dict[str, Any]:
    row = read_manifest_row(manifest_path, recording_id)
    human_gold = read_human_gold(human_gold_path, recording_id)
    score_path = resolve_repo_path(str(row["scorePath"]))
    audio_path = resolve_repo_path(str(row["audioPath"]))
    score_notes = parse_score_notes(score_path)
    score, stored_notes = collect_score_notes(load_score_store(REPO), str(row["scoreId"]))
    if score is None or len(score_notes) != len(stored_notes):
        raise ValueError(f"score-note-count-mismatch:{len(score_notes)}:{len(stored_notes)}")
    cache_path = cache_dir / f"{recording_id}.json"
    events = json.loads(cache_path.read_text(encoding="utf-8"))
    matched = align_score_to_events_dtw(score_notes, events)
    windows, span = derive_activity_anchored_windows(score_notes, events)

    y, sample_rate = librosa.load(str(audio_path), sr=22050, mono=True)
    hop_length = 256
    onset_envelope = librosa.onset.onset_strength(y=y, sr=sample_rate, hop_length=hop_length)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sample_rate, hop_length=hop_length)
    frame_times = librosa.frames_to_time(np.arange(onset_envelope.size), sr=sample_rate, hop_length=hop_length)

    feature_rows = []
    for index, (score_note, stored_note, window) in enumerate(zip(score_notes, stored_notes, windows)):
        human_label = "trill" if "trill-mark" in set(stored_note.get("techniques") or []) else "vibrato"
        features = event_feature_row(
            events,
            onset_envelope,
            chroma,
            frame_times,
            float(window["start"]),
            float(window["end"]),
        )
        feature_rows.append({
            "noteIndex": index,
            "measureIndex": int(stored_note["measureIndex"]),
            "midi": int(stored_note["midi"]),
            "humanLabel": human_label,
            "windowStartSeconds": round(float(window["start"]), 6),
            "windowEndSeconds": round(float(window["end"]), 6),
            **features,
        })

    trill_count = sum(row["humanLabel"] == "trill" for row in feature_rows)
    vibrato_count = sum(row["humanLabel"] == "vibrato" for row in feature_rows)
    gold_count_consistent = (
        trill_count == int(human_gold.get("trillExpectedNoteCount") or -1)
        and vibrato_count == int(human_gold.get("vibratoExpectedLongNoteCount") or -1)
    )
    report = {
        "ok": True,
        "recordingId": recording_id,
        "evaluationLevel": "single-recording-training-only-feature-diagnostic",
        "releaseEvidence": False,
        "studentGateReady": False,
        "scoreNoteCount": len(score_notes),
        "goldCounts": {"trill": trill_count, "vibrato": vibrato_count},
        "goldCountConsistent": gold_count_consistent,
        "activityAnchoredWindowMethod": span,
        "dtwWindowDiagnostics": dtw_window_diagnostics(
            score_notes,
            matched,
            float(span["secondsPerScoreBeat"]),
        ),
        "featureRows": feature_rows,
        "featureDiagnostics": summarize_features(feature_rows),
        "blockingReasons": [
            "m3plus-trill-vibrato-independent-recording-missing",
            "m3plus-trill-vibrato-plain-negative-controls-missing",
            "m3plus-trill-vibrato-feature-thresholds-training-only",
        ],
    }
    if not gold_count_consistent:
        report["ok"] = False
        report["blockingReasons"].append("m3plus-trill-vibrato-gold-count-mismatch")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out_path.with_suffix(".md").write_text(render_markdown(report), encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose round-2 r2-06 trill/vibrato windows and candidate features.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--human-gold", type=Path, default=DEFAULT_HUMAN_GOLD)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--recording-id", default=DEFAULT_RECORDING_ID)
    args = parser.parse_args()
    report = run(
        args.manifest.resolve(),
        args.human_gold.resolve(),
        args.cache_dir.resolve(),
        args.out.resolve(),
        args.recording_id,
    )
    print(json.dumps({
        "ok": report["ok"],
        "recordingId": report["recordingId"],
        "goldCounts": report["goldCounts"],
        "goldCountConsistent": report["goldCountConsistent"],
        "dtwWindowDiagnostics": {
            key: report["dtwWindowDiagnostics"][key]
            for key in ["matchedNoteCount", "unmatchedNoteCount", "implausibleWindowCount", "implausibleWindowRate"]
        },
        "bestTrainingOnlyFeatures": report["featureDiagnostics"]["trainingOnlySingleFeatureThresholds"][:3],
        "out": str(args.out.resolve()),
    }, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
