#!/usr/bin/env python3
"""Evaluate direct waveform absence evidence for Policy C assignment gaps.

Threshold selection uses only r2-01 waveform injections. r2-08 is the
synthetic holdout; Round 4 is inspected diagnostic evidence and cannot promote
the candidate. The evaluator never changes runtime policy.
"""
from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path
from typing import Any

import librosa
import numpy as np


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_duration_extra_quantization import (  # noqa: E402
    INJECT_DIR,
    PRIVATE,
    V2_SETS,
    analyze_take,
)
from eval_western_strings_segment_onset_candidate import estimate_note_windows  # noqa: E402


CONTRACT = "western-policy-c-waveform-absence-pre-gate-v1"
PRECISION_FLOOR = 0.90
RECALL_FLOOR = 0.50
ROUND4_DIR = REPO / "data/private/western-strings-round4"
ROUND4_MANIFEST = ROUND4_DIR / "manifest.csv"
ROUND4_REPORT = REPO / "data/experiments/western-strings-round4/ordinary-fresh-blind/report.json"
ROUND4_TRUTH = ROUND4_DIR / "error-positions.json"
OUT_DIR = REPO / "data/experiments/western-strings-round4/policy-c-waveform-absence"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def classification_metrics(flags: set[int], positives: set[int], total: int) -> dict[str, Any]:
    true_positive = len(flags & positives)
    false_positive = len(flags - positives)
    false_negative = len(positives - flags)
    precision = true_positive / len(flags) if flags else 0.0
    recall = true_positive / len(positives) if positives else 0.0
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "trueNegative": total - true_positive - false_positive - false_negative,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "jointFloorReady": precision >= PRECISION_FLOOR and recall >= RECALL_FLOOR,
    }


def centered_rms(waveform: np.ndarray, sample_rate: int, window: tuple[float, float]) -> float:
    start, end = window
    duration = max(0.0, end - start)
    left = start + duration * 0.20
    right = end - duration * 0.20
    samples = waveform[int(left * sample_rate):int(right * sample_rate)]
    return float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0


def waveform_absence_rows(audio: Path, take: dict[str, Any]) -> list[dict[str, Any]]:
    waveform, sample_rate = librosa.load(audio, sr=22050, mono=True)
    windows = estimate_note_windows(take, len(waveform) / sample_rate)
    rms_values = [centered_rms(waveform, sample_rate, window) for window in windows]
    hop_length = 512
    f0, voiced, _ = librosa.pyin(
        waveform,
        fmin=float(librosa.note_to_hz("C3")),
        fmax=float(librosa.note_to_hz("A7")),
        sr=sample_rate,
        hop_length=hop_length,
        frame_length=2048,
    )
    frame_times = librosa.frames_to_time(
        np.arange(len(f0)),
        sr=sample_rate,
        hop_length=hop_length,
    )
    observed_midi = np.full(len(f0), np.nan)
    valid = np.asarray(voiced, dtype=bool) & np.isfinite(f0)
    observed_midi[valid] = librosa.hz_to_midi(f0[valid])
    output = []
    for index, (row, note, rms, window) in enumerate(
        zip(take["rows"], take["notes"], rms_values, windows)
    ):
        neighbors = [
            rms_values[neighbor]
            for neighbor in range(max(0, index - 2), min(len(rms_values), index + 3))
            if neighbor != index and rms_values[neighbor] > 1e-9
        ]
        reference = float(np.median(neighbors)) if neighbors else 0.0
        relative_db = 20.0 * math.log10(max(rms, 1e-9) / max(reference, 1e-9))
        start, end = window
        duration = max(0.0, end - start)
        local = (frame_times >= start + duration * 0.20) & (frame_times < end - duration * 0.20)
        local_total = int(np.sum(local))
        local_voiced = local & valid
        target_frames = local_voiced & (np.abs(observed_midi - int(note["midi"])) <= 0.50)
        output.append({
            "noteIndex": index,
            "assignmentGap": row.get("predictedTime") is None,
            "centeredRms": round(rms, 8),
            "neighborMedianRms": round(reference, 8),
            "relativeEnergyDb": round(relative_db, 6),
            "voicedFrameRatio": round(float(np.sum(local_voiced)) / local_total, 6) if local_total else 0.0,
            "targetPitchFrameRatio": round(float(np.sum(target_frames)) / local_total, 6) if local_total else 0.0,
        })
    return output


def evaluate_rows(
    rows_by_take: list[tuple[str, list[dict[str, Any]], set[int]]],
    threshold: float,
    feature: str = "relativeEnergyDb",
) -> dict[str, Any]:
    total = 0
    offset = 0
    flags: set[int] = set()
    positives: set[int] = set()
    per_take = []
    for name, rows, local_positives in rows_by_take:
        local_flags = {
            int(row["noteIndex"])
            for row in rows
            if row["assignmentGap"] and float(row[feature]) <= threshold
        }
        per_take.append({
            "take": name,
            "assignmentGapCount": sum(row["assignmentGap"] for row in rows),
            **classification_metrics(local_flags, local_positives, len(rows)),
        })
        flags.update(index + offset for index in local_flags)
        positives.update(index + offset for index in local_positives)
        total += len(rows)
        offset += len(rows)
    return {"threshold": threshold, "feature": feature, "pooled": classification_metrics(flags, positives, total), "takes": per_take}


def prepare_injected(names: list[str]) -> list[tuple[str, list[dict[str, Any]], set[int]]]:
    prepared = []
    for name in names:
        piece = name.split("-injected")[0]
        labels = read_json(INJECT_DIR / f"{name}.labels.json")
        missing = {
            int(item["scoreEventIndex"])
            for item in labels["injections"]
            if item["type"] == "missing"
        }
        audio = INJECT_DIR / f"{name}.wav"
        take = analyze_take(PRIVATE / f"{piece}.musicxml", audio)
        prepared.append((name, waveform_absence_rows(audio, take), missing))
    return prepared


def select_threshold(
    dev: list[tuple[str, list[dict[str, Any]], set[int]]],
    feature: str,
) -> tuple[dict[str, Any], int]:
    values = sorted({
        float(row[feature])
        for _, rows, _ in dev
        for row in rows
        if row["assignmentGap"]
    })
    candidates = [evaluate_rows(dev, value, feature) for value in values]
    selected = max(
        candidates,
        key=lambda result: (
            result["pooled"]["jointFloorReady"],
            result["pooled"]["precision"],
            result["pooled"]["recall"],
            -result["pooled"]["falsePositive"],
        ),
    )
    return selected, sum(result["pooled"]["jointFloorReady"] for result in candidates)


def prepare_round4() -> tuple[list[tuple[str, list[dict[str, Any]], set[int]]], list[dict[str, Any]]]:
    report = read_json(ROUND4_REPORT)
    truth = read_json(ROUND4_TRUTH)["recordings"]
    report_by_id = {row["recordingId"]: row for row in report["recordings"]}
    prepared = []
    hint_details = []
    with ROUND4_MANIFEST.open(encoding="utf-8-sig", newline="") as handle:
        for manifest in csv.DictReader(handle):
            recording_id = manifest["recordingId"]
            report_row = report_by_id[recording_id]
            artifact = read_json(REPO / report_row["candidateRowsPath"])
            candidate_rows = artifact["candidateRows"]
            position_to_index = {
                (int(row["measureIndex"]), float(row["beatStart"])): int(row["noteIndex"])
                for row in candidate_rows
            }
            missing = {
                position_to_index[(int(item["measure"]), float(item["beat"]) - 1.0)]
                for item in truth.get(recording_id, {}).get("errors", [])
                if item["kind"] == "missing"
            }
            score = REPO / manifest["scorePath"]
            audio = REPO / manifest["audioPath"]
            take = analyze_take(score, audio)
            rows = waveform_absence_rows(audio, take)
            artifact_gap_by_index = {
                int(row["noteIndex"]): row.get("m3plusTimingAssignmentAvailable") is not True
                for row in candidate_rows
            }
            for row in rows:
                row["assignmentGap"] = artifact_gap_by_index[int(row["noteIndex"])]
            prepared.append((recording_id, rows, missing))
            truth_by_index = {
                position_to_index[(int(item["measure"]), float(item["beat"]) - 1.0)]: item["kind"]
                for item in truth.get(recording_id, {}).get("errors", [])
            }
            for row in rows:
                if row["assignmentGap"]:
                    hint_details.append({
                        "recordingId": recording_id,
                        **row,
                        "truthKind": truth_by_index.get(row["noteIndex"], "non_planted"),
                    })
    return prepared, hint_details


def main() -> int:
    dev_names = [name for name in V2_SETS if name.startswith("r2-01-")]
    holdout_names = [name for name in V2_SETS if name.startswith("r2-08-")]
    dev = prepare_injected(dev_names)
    holdout = prepare_injected(holdout_names)
    energy_selected, energy_qualifying_count = select_threshold(dev, "relativeEnergyDb")
    energy_threshold = float(energy_selected["threshold"])
    energy_holdout = evaluate_rows(holdout, energy_threshold, "relativeEnergyDb")
    pitch_selected, pitch_qualifying_count = select_threshold(dev, "targetPitchFrameRatio")
    pitch_threshold = float(pitch_selected["threshold"])
    pitch_holdout = evaluate_rows(holdout, pitch_threshold, "targetPitchFrameRatio")
    round4_rows, hint_details = prepare_round4()
    energy_round4 = evaluate_rows(round4_rows, energy_threshold, "relativeEnergyDb")
    pitch_round4 = evaluate_rows(round4_rows, pitch_threshold, "targetPitchFrameRatio")
    energy_synthetic_ready = (
        energy_selected["pooled"]["jointFloorReady"]
        and energy_holdout["pooled"]["jointFloorReady"]
    )
    pitch_synthetic_ready = (
        pitch_selected["pooled"]["jointFloorReady"]
        and pitch_holdout["pooled"]["jointFloorReady"]
    )
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "scope": "development-preGateOnly",
        "studentFacing": False,
        "automaticAccusationReady": False,
        "thresholds": {"minPrecision": PRECISION_FLOOR, "minRecall": RECALL_FLOOR},
        "selectionDomain": "r2-01 waveform-injection-v2 (3 seeds)",
        "energyAbsence": {
            "featureDefinition": "center 60% RMS relative to median RMS of two adjacent windows on each side",
            "qualifyingDevelopmentThresholdCount": energy_qualifying_count,
            "syntheticDevelopment": energy_selected,
            "syntheticHoldout": energy_holdout,
            "round4InspectedDiagnostic": energy_round4,
            "syntheticGeneralizationReady": energy_synthetic_ready,
            "syntheticToRealGeneralizationReady": (
                energy_synthetic_ready and energy_round4["pooled"]["jointFloorReady"]
            ),
        },
        "targetPitchAbsence": {
            "featureDefinition": "pYIN frames within +/-50 cents of target pitch divided by all center-window frames",
            "qualifyingDevelopmentThresholdCount": pitch_qualifying_count,
            "syntheticDevelopment": pitch_selected,
            "syntheticHoldout": pitch_holdout,
            "round4InspectedDiagnostic": pitch_round4,
            "syntheticGeneralizationReady": pitch_synthetic_ready,
            "syntheticToRealGeneralizationReady": (
                pitch_synthetic_ready and pitch_round4["pooled"]["jointFloorReady"]
            ),
        },
        "round4AssignmentGapRows": hint_details,
        "reviewAssistPromotionReady": False,
        "blockingReasons": [
            *([] if energy_synthetic_ready else ["waveform-energy-absence-synthetic-joint-floor-failed"]),
            *([] if pitch_synthetic_ready else ["target-pitch-absence-synthetic-joint-floor-failed"]),
            "waveform-absence-synthetic-to-real-generalization-failed",
            "cross-device-room-performer-energy-robustness-missing",
            "position-labelled-fresh-blind-evidence-missing",
        ],
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    energy_dev = energy_selected["pooled"]
    energy_real = energy_round4["pooled"]
    pitch_dev = pitch_selected["pooled"]
    pitch_real = pitch_round4["pooled"]
    lines = [
        "# Policy C waveform-absence diagnostic",
        "",
        "Development pre-gate only; no runtime promotion.",
        "",
        f"- RMS synthetic development P/R: {energy_dev['precision']:.2%}/{energy_dev['recall']:.2%}",
        f"- RMS Round-4 P/R: {energy_real['precision']:.2%}/{energy_real['recall']:.2%}",
        f"- target-pitch synthetic development P/R: {pitch_dev['precision']:.2%}/{pitch_dev['recall']:.2%}",
        f"- target-pitch Round-4 P/R: {pitch_real['precision']:.2%}/{pitch_real['recall']:.2%}",
        "- conclusion: both handcrafted absence features fail synthetic-to-real transfer",
        "",
    ]
    (OUT_DIR / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"ok": True, "report": report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
