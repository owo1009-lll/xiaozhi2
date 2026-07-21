#!/usr/bin/env python3
"""Evaluate simple segment/onset candidates for duration and extra-note recall.

This is a development diagnostic only. It answers two narrow questions:

1. Does a conjunction of the existing relative-IOI and event-duration
   features generalize from waveform injections to the real Round-4 takes?
2. Can generic waveform onset peaks inside an aligned score-note window
   identify re-articulated extra notes at an acceptable joint precision/recall
   floor?

Neither candidate may open a student-facing diagnosis. Round 4 is inspected
development evidence, and the onset sweep is selected on synthetic data.
"""
from __future__ import annotations

import json
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


CONTRACT = "western-segment-onset-candidate-pre-gate-v1"
TIMING_DEVIATION_LIMIT = 0.15
DURATION_RATIO_FLOOR = 1.20
PRECISION_FLOOR = 0.90
RECALL_FLOOR = 0.50
ROUND4_REPORT = REPO / "data/experiments/western-strings-round4/ordinary-fresh-blind/report.json"
ROUND4_TRUTH = REPO / "data/private/western-strings-round4/error-positions.json"
OUT_DIR = REPO / "data/experiments/western-strings-round4/segment-onset-candidate"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def metrics(flags: set[int], positives: set[int], total: int) -> dict[str, Any]:
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


def timing_duration_flags(rows: list[dict[str, Any]]) -> set[int]:
    return {
        index
        for index, row in enumerate(rows)
        if row.get("relativeIoiDeviationRatio") is not None
        and float(row["relativeIoiDeviationRatio"]) > TIMING_DEVIATION_LIMIT
        and row.get("eventDurationRatio") is not None
        and float(row["eventDurationRatio"]) >= DURATION_RATIO_FLOOR
    }


def injected_truth(name: str) -> tuple[set[int], set[int]]:
    labels = read_json(INJECT_DIR / f"{name}.labels.json")
    duration_or_extra = {
        int(item["scoreEventIndex"])
        for item in labels["injections"]
        if item["type"] in {"drag", "extra"}
    }
    extra = {
        int(item["scoreEventIndex"])
        for item in labels["injections"]
        if item["type"] == "extra"
    }
    return duration_or_extra, extra


def evaluate_timing_duration_injected(names: list[str]) -> dict[str, Any]:
    total = 0
    offset = 0
    positives: set[int] = set()
    flags: set[int] = set()
    per_set = []
    for name in names:
        piece = name.split("-injected")[0]
        take = analyze_take(PRIVATE / f"{piece}.musicxml", INJECT_DIR / f"{name}.wav")
        local_positive, _ = injected_truth(name)
        local_flags = timing_duration_flags(take["rows"])
        result = metrics(local_flags, local_positive, len(take["rows"]))
        per_set.append({"set": name, **result})
        positives.update(index + offset for index in local_positive)
        flags.update(index + offset for index in local_flags)
        total += len(take["rows"])
        offset += len(take["rows"])
    return {"pooled": metrics(flags, positives, total), "sets": per_set}


def normalized_round4_rows(candidate_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "relativeIoiDeviationRatio": (
                row.get("dynamicShadowEvidence") or {}
            ).get("relativeIoiDeviationRatio"),
            "eventDurationRatio": (
                row.get("dynamicShadowEvidence") or {}
            ).get("eventDurationRatio"),
            "measureIndex": int(row.get("measureIndex") or 0),
            "beatStart": float(row.get("beatStart") or 0.0),
        }
        for row in candidate_rows
    ]


def evaluate_timing_duration_round4() -> dict[str, Any]:
    report = read_json(ROUND4_REPORT)
    truth = read_json(ROUND4_TRUTH)["recordings"]
    total = 0
    offset = 0
    positives: set[int] = set()
    flags: set[int] = set()
    per_take = []
    for recording in report["recordings"]:
        recording_id = recording["recordingId"]
        artifact = read_json(REPO / recording["candidateRowsPath"])
        rows = normalized_round4_rows(artifact["candidateRows"])
        position_to_index = {
            (row["measureIndex"], row["beatStart"]): index
            for index, row in enumerate(rows)
        }
        local_positive = {
            position_to_index[(int(item["measure"]), float(item["beat"]) - 1.0)]
            for item in truth.get(recording_id, {}).get("errors", [])
            if item["kind"] in {"drag", "extra"}
        }
        local_flags = timing_duration_flags(rows)
        result = metrics(local_flags, local_positive, len(rows))
        per_take.append({"recordingId": recording_id, **result})
        positives.update(index + offset for index in local_positive)
        flags.update(index + offset for index in local_flags)
        total += len(rows)
        offset += len(rows)
    return {"pooled": metrics(flags, positives, total), "takes": per_take}


def estimate_note_windows(take: dict[str, Any], audio_duration: float) -> list[tuple[float, float]]:
    notes = take["notes"]
    rows = take["rows"]
    anchor_score = []
    anchor_time = []
    for note, row in zip(notes, rows):
        if row.get("predictedTime") is not None:
            anchor_score.append(float(note["scoreUnit"]))
            anchor_time.append(float(row["predictedTime"]))
    if len(anchor_score) < 2:
        return [(0.0, audio_duration) for _ in notes]
    score_units = np.asarray([float(note["scoreUnit"]) for note in notes])
    estimated = np.interp(score_units, np.asarray(anchor_score), np.asarray(anchor_time))
    gaps = np.diff(estimated)
    fallback = float(np.median(gaps[gaps > 0])) if np.any(gaps > 0) else 0.5
    windows = []
    for index, onset in enumerate(estimated):
        next_onset = estimated[index + 1] if index + 1 < len(estimated) else onset + fallback
        start = max(0.0, float(onset) - min(0.08, fallback * 0.1))
        end = min(audio_duration, float(next_onset) - min(0.08, fallback * 0.1))
        windows.append((start, max(start, end)))
    return windows


def onset_peak_counts(
    item: dict[str, Any],
    delta: float,
    wait: int,
    pitch_conditioned: bool = False,
) -> list[int]:
    envelope = item["onsetEnvelope"]
    sample_rate = item["sampleRate"]
    peak_frames = librosa.util.peak_pick(
        envelope,
        pre_max=3,
        post_max=3,
        pre_avg=3,
        post_avg=5,
        delta=delta,
        wait=wait,
    )
    peak_times = librosa.frames_to_time(peak_frames, sr=sample_rate)
    counts = []
    for index, (start, end) in enumerate(item["windows"]):
        local_peaks = peak_times[(peak_times >= start) & (peak_times < end)]
        if pitch_conditioned:
            target_midi = item["targetMidis"][index]
            supporting_events = [
                event
                for event in item["events"]
                if int(event["midi"]) == target_midi
                and float(event["start"]) < end
                and float(event["end"]) > start
            ]
            local_peaks = np.asarray([
                peak
                for peak in local_peaks
                if any(
                    float(event["start"]) <= peak + 0.12
                    and float(event["end"]) >= peak - 0.04
                    for event in supporting_events
                )
            ])
        counts.append(len(local_peaks))
    return counts


def prepare_onset_sets(names: list[str]) -> list[dict[str, Any]]:
    prepared = []
    for name in names:
        piece = name.split("-injected")[0]
        audio = INJECT_DIR / f"{name}.wav"
        take = analyze_take(PRIVATE / f"{piece}.musicxml", audio)
        _, extra = injected_truth(name)
        waveform, sample_rate = librosa.load(audio, sr=22050, mono=True)
        onset_envelope = librosa.onset.onset_strength(y=waveform, sr=sample_rate)
        prepared.append({
            "name": name,
            "extra": extra,
            "targetMidis": [int(note["midi"]) for note in take["notes"]],
            "events": take["events"],
            "unassigned": take["unassigned"],
            "sampleRate": sample_rate,
            "onsetEnvelope": onset_envelope,
            "onsetFrameTimes": librosa.frames_to_time(
                np.arange(len(onset_envelope)),
                sr=sample_rate,
            ),
            "windows": estimate_note_windows(take, len(waveform) / sample_rate),
        })
    return prepared


def interior_attack_scores(item: dict[str, Any]) -> list[float]:
    envelope = np.asarray(item["onsetEnvelope"])
    frame_times = np.asarray(item["onsetFrameTimes"])
    scores = []
    for start, end in item["windows"]:
        duration = end - start
        all_values = envelope[(frame_times >= start) & (frame_times < end)]
        interior_values = envelope[
            (frame_times >= start + max(0.12, duration * 0.20))
            & (frame_times < end - max(0.06, duration * 0.08))
        ]
        if all_values.size == 0 or interior_values.size == 0:
            scores.append(0.0)
            continue
        scores.append(float(np.max(interior_values) / max(float(np.max(all_values)), 1e-9)))
    return scores


def evaluate_interior_attack(
    prepared: list[dict[str, Any]],
    ratio_floor: float,
) -> dict[str, Any]:
    total = 0
    offset = 0
    positives: set[int] = set()
    flags: set[int] = set()
    for item in prepared:
        local_flags = {
            index
            for index, score in enumerate(interior_attack_scores(item))
            if score >= ratio_floor
        }
        flags.update(index + offset for index in local_flags)
        positives.update(index + offset for index in item["extra"])
        total += len(item["windows"])
        offset += len(item["windows"])
    return {"ratioFloor": ratio_floor, **metrics(flags, positives, total)}


def sweep_interior_attack(
    dev_names: list[str],
    holdout_names: list[str],
) -> dict[str, Any]:
    dev = prepare_onset_sets(dev_names)
    holdout = prepare_onset_sets(holdout_names)
    results = [
        evaluate_interior_attack(dev, round(value, 2))
        for value in np.arange(0.30, 1.0, 0.05)
    ]
    selected = max(
        results,
        key=lambda row: (
            row["jointFloorReady"],
            row["precision"],
            row["recall"],
            -row["falsePositive"],
        ),
    )
    return {
        "candidateDefinition": (
            "maximum interior onset-strength divided by maximum onset-strength "
            "inside the aligned score-note window"
        ),
        "configurationCount": len(results),
        "jointFloorConfigurationCount": sum(row["jointFloorReady"] for row in results),
        "selectedDevelopmentConfiguration": selected,
        "syntheticHoldout": evaluate_interior_attack(holdout, selected["ratioFloor"]),
    }


def evaluate_unassigned_edit_path(prepared: list[dict[str, Any]]) -> dict[str, Any]:
    total = 0
    offset = 0
    positives: set[int] = set()
    flags: set[int] = set()
    per_set = []
    for item in prepared:
        local_flags = set()
        for index, ((start, end), target_midi) in enumerate(
            zip(item["windows"], item["targetMidis"])
        ):
            if any(
                int(event["midi"]) == target_midi
                and start <= float(event["start"]) < end
                for event in item["unassigned"]
            ):
                local_flags.add(index)
        local_metrics = metrics(local_flags, item["extra"], len(item["windows"]))
        per_set.append({"set": item["name"], **local_metrics})
        flags.update(index + offset for index in local_flags)
        positives.update(index + offset for index in item["extra"])
        total += len(item["windows"])
        offset += len(item["windows"])
    return {"pooled": metrics(flags, positives, total), "sets": per_set}


def evaluate_onset_configuration(
    prepared: list[dict[str, Any]],
    delta: float,
    wait: int,
    pitch_conditioned: bool = False,
) -> dict[str, Any]:
    total = 0
    offset = 0
    positives: set[int] = set()
    flags: set[int] = set()
    for item in prepared:
        counts = onset_peak_counts(item, delta, wait, pitch_conditioned)
        local_flags = {index for index, count in enumerate(counts) if count >= 2}
        flags.update(index + offset for index in local_flags)
        positives.update(index + offset for index in item["extra"])
        total += len(counts)
        offset += len(counts)
    return {"delta": delta, "wait": wait, **metrics(flags, positives, total)}


def sweep_onset_count(
    dev_names: list[str],
    holdout_names: list[str],
    pitch_conditioned: bool = False,
) -> dict[str, Any]:
    dev = prepare_onset_sets(dev_names)
    holdout = prepare_onset_sets(holdout_names)
    results = [
        evaluate_onset_configuration(dev, round(delta, 2), wait, pitch_conditioned)
        for delta in np.arange(0.05, 1.51, 0.05)
        for wait in (1, 2, 4, 6, 8)
    ]
    qualifying = [row for row in results if row["jointFloorReady"]]
    selected = max(
        results,
        key=lambda row: (row["jointFloorReady"], row["precision"], row["recall"], -row["falsePositive"]),
    )
    holdout_result = evaluate_onset_configuration(
        holdout,
        selected["delta"],
        selected["wait"],
        pitch_conditioned,
    )
    return {
        "selectionDomain": "r2-01 waveform-injection-v2 (3 seeds)",
        "positiveClass": "extra-note only",
        "candidateDefinition": (
            "two or more onset peaks supported by an overlapping exact-pitch event "
            "inside an aligned score-note window"
            if pitch_conditioned
            else "two or more generic onset peaks inside an aligned score-note window"
        ),
        "configurationCount": len(results),
        "jointFloorConfigurationCount": len(qualifying),
        "selectedDevelopmentConfiguration": selected,
        "holdout": holdout_result,
    }


def evaluate_unassigned_edit_path_split(
    dev_names: list[str],
    holdout_names: list[str],
) -> dict[str, Any]:
    return {
        "candidateDefinition": (
            "an unassigned exact-pitch Basic Pitch event starts inside the aligned "
            "score-note window"
        ),
        "positiveClass": "extra-note only",
        "syntheticDevelopment": evaluate_unassigned_edit_path(prepare_onset_sets(dev_names)),
        "syntheticHoldout": evaluate_unassigned_edit_path(prepare_onset_sets(holdout_names)),
    }


def main() -> int:
    dev_names = [name for name in V2_SETS if name.startswith("r2-01-")]
    holdout_names = [name for name in V2_SETS if name.startswith("r2-08-")]
    timing_duration = {
        "rule": {
            "relativeIoiDeviationRatioGreaterThan": TIMING_DEVIATION_LIMIT,
            "eventDurationRatioAtLeast": DURATION_RATIO_FLOOR,
            "positiveClass": ["drag", "extra"],
        },
        "syntheticDevelopment": evaluate_timing_duration_injected(dev_names),
        "syntheticHoldout": evaluate_timing_duration_injected(holdout_names),
        "round4InspectedReal": evaluate_timing_duration_round4(),
    }
    onset_count = sweep_onset_count(dev_names, holdout_names)
    pitch_conditioned_onset = sweep_onset_count(
        dev_names,
        holdout_names,
        pitch_conditioned=True,
    )
    unassigned_edit_path = evaluate_unassigned_edit_path_split(dev_names, holdout_names)
    interior_attack = sweep_interior_attack(dev_names, holdout_names)
    synthetic_ready = timing_duration["syntheticDevelopment"]["pooled"]["jointFloorReady"]
    holdout_ready = timing_duration["syntheticHoldout"]["pooled"]["jointFloorReady"]
    round4_ready = timing_duration["round4InspectedReal"]["pooled"]["jointFloorReady"]
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "scope": "development-preGateOnly",
        "studentFacing": False,
        "automaticAccusationReady": False,
        "reviewAssistPromotionReady": False,
        "jointFloor": {"precision": PRECISION_FLOOR, "recall": RECALL_FLOOR},
        "timingDurationConjunction": timing_duration,
        "genericOnsetCount": onset_count,
        "pitchConditionedOnsetCount": pitch_conditioned_onset,
        "unassignedEventEditPath": unassigned_edit_path,
        "interiorAttackRatio": interior_attack,
        "findings": {
            "timingDurationSyntheticReady": synthetic_ready and holdout_ready,
            "timingDurationRound4Ready": round4_ready,
            "syntheticToRealGeneralizationReady": synthetic_ready and holdout_ready and round4_ready,
            "genericOnsetCountReady": onset_count["jointFloorConfigurationCount"] > 0,
            "pitchConditionedOnsetCountSyntheticReady": (
                pitch_conditioned_onset["jointFloorConfigurationCount"] > 0
                and pitch_conditioned_onset["holdout"]["jointFloorReady"]
            ),
            "unassignedEventEditPathSyntheticReady": (
                unassigned_edit_path["syntheticDevelopment"]["pooled"]["jointFloorReady"]
                and unassigned_edit_path["syntheticHoldout"]["pooled"]["jointFloorReady"]
            ),
            "interiorAttackRatioSyntheticReady": (
                interior_attack["jointFloorConfigurationCount"] > 0
                and interior_attack["syntheticHoldout"]["jointFloorReady"]
            ),
        },
        "blockingReasons": [
            "timing-duration-synthetic-to-real-generalization-failed",
            "generic-onset-count-no-joint-floor",
            "pitch-conditioned-onset-count-no-joint-floor",
            "unassigned-event-edit-path-no-joint-floor",
            "interior-attack-ratio-no-joint-floor",
            "fresh-blind-independent-positive-evidence-missing",
        ],
        "nextCandidate": (
            "targeted real re-articulation labels plus a learned segment/edit-path model; "
            "stop adding single handcrafted onset features"
        ),
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    round4 = timing_duration["round4InspectedReal"]["pooled"]
    onset_dev = onset_count["selectedDevelopmentConfiguration"]
    pitch_onset_dev = pitch_conditioned_onset["selectedDevelopmentConfiguration"]
    edit_dev = unassigned_edit_path["syntheticDevelopment"]["pooled"]
    interior_dev = interior_attack["selectedDevelopmentConfiguration"]
    lines = [
        "# Segment/onset candidate diagnostic",
        "",
        "Development pre-gate only; no student-facing authorization.",
        "",
        "## Timing + duration conjunction",
        "",
        f"- synthetic development: {timing_duration['syntheticDevelopment']['pooled']['precision']:.2%} precision / {timing_duration['syntheticDevelopment']['pooled']['recall']:.2%} recall",
        f"- synthetic holdout: {timing_duration['syntheticHoldout']['pooled']['precision']:.2%} precision / {timing_duration['syntheticHoldout']['pooled']['recall']:.2%} recall",
        f"- inspected Round 4: {round4['precision']:.2%} precision / {round4['recall']:.2%} recall",
        "- conclusion: synthetic-to-real generalization failed",
        "",
        "## Generic onset-count sweep",
        "",
        f"- configurations: {onset_count['configurationCount']}",
        f"- configurations meeting the joint floor: {onset_count['jointFloorConfigurationCount']}",
        f"- best development result: {onset_dev['precision']:.2%} precision / {onset_dev['recall']:.2%} recall",
        "- conclusion: generic onset peaks alone are not a safe extra-note detector",
        "",
        "## Additional handcrafted extra-note candidates",
        "",
        f"- pitch-conditioned onset count: development P/R {pitch_onset_dev['precision']:.2%}/{pitch_onset_dev['recall']:.2%}; no joint-floor configuration",
        f"- unassigned-event edit path: development P/R {edit_dev['precision']:.2%}/{edit_dev['recall']:.2%}",
        f"- interior attack ratio: development P/R {interior_dev['precision']:.2%}/{interior_dev['recall']:.2%}; no joint-floor configuration",
        "- conclusion: stop stacking single handcrafted attack features; require targeted real labels and a learned segment/edit-path model",
        "",
    ]
    (OUT_DIR / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"ok": True, "report": report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
