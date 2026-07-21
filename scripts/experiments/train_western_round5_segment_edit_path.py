#!/usr/bin/env python3
"""Train/evaluate the Round-5 segment edit-path candidate, fail-closed.

The runner consumes only a validated Round-5 intake.  Calibration rows train
four fixed binary classifiers; fresh-blind rows are evaluation-only.  It does
not tune a threshold on fresh-blind data and never grants student-facing or
automatic-accusation authority.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import joblib
import librosa
import numpy as np
from music21 import converter
from sklearn.ensemble import RandomForestClassifier


REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import status_western_round5_targeted_intake as intake  # noqa: E402
from eval_western_strings_duration_extra_quantization import analyze_take  # noqa: E402


CONTRACT = "western-round5-segment-edit-path-candidate-v1"
FROZEN_GAP_REFINEMENT_CONTRACT = "western-round5-frozen-gap-refinement-v1"
GATES = ("merged_substitution", "missing", "extra", "drag")
GAP_REFINEMENT_TARGET_GATES = ("merged_substitution", "missing")
DEFAULT_CONTRACT = REPO / "config/western-strings-round5-targeted-contract.json"
DEFAULT_MANIFEST = REPO / "data/private/western-strings-round5/manifest.csv"
DEFAULT_TRUTH = REPO / "data/private/western-strings-round5/position-truth.json"
DEFAULT_REPORT = REPO / "data/experiments/western-strings-round5-segment-edit-path/report.json"
DEFAULT_MODEL = REPO / "data/experiments/western-strings-round5-segment-edit-path/model.joblib"
MODEL_PARAMS = {
    "n_estimators": 256,
    "max_depth": 4,
    "min_samples_leaf": 2,
    "class_weight": "balanced_subsample",
    "random_state": 20260722,
    "n_jobs": 1,
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def score_positions(score_path: Path) -> list[dict[str, Any]]:
    stream = converter.parse(str(score_path))
    positions = []
    for index, note in enumerate(stream.flatten().notes):
        midis = sorted(int(pitch.midi) for pitch in note.pitches)
        positions.append({
            "noteIndex": index,
            "measure": int(note.measureNumber or 0),
            "beat": float(note.beat),
            "scoreMidi": midis[0],
        })
    return positions


def truth_note_index(
    positions: list[dict[str, Any]],
    event: dict[str, Any],
) -> int:
    matches = [
        row["noteIndex"]
        for row in positions
        if row["measure"] == int(event["measure"])
        and abs(row["beat"] - float(event["beat"])) <= 1e-4
        and row["scoreMidi"] == int(event["scoreMidi"])
    ]
    if len(matches) != 1:
        raise ValueError(
            "round5-truth-position-not-unique:"
            f"measure={event.get('measure')}:beat={event.get('beat')}:"
            f"midi={event.get('scoreMidi')}:matches={len(matches)}"
        )
    return matches[0]


def estimate_note_windows(take: dict[str, Any]) -> list[tuple[float, float]]:
    notes = take["notes"]
    rows = take["rows"]
    anchors = [
        (float(note["scoreUnit"]), float(row["predictedTime"]))
        for note, row in zip(notes, rows)
        if row.get("predictedTime") is not None
    ]
    if len(anchors) < 2:
        return [(0.0, 0.0) for _ in notes]
    anchor_score = np.asarray([item[0] for item in anchors])
    anchor_time = np.asarray([item[1] for item in anchors])
    score_units = np.asarray([float(note["scoreUnit"]) for note in notes])
    estimated = np.interp(score_units, anchor_score, anchor_time)
    positive_gaps = np.diff(estimated)
    positive_gaps = positive_gaps[positive_gaps > 1e-6]
    fallback = float(np.median(positive_gaps)) if positive_gaps.size else 0.5
    windows = []
    for index, onset in enumerate(estimated):
        previous = estimated[index - 1] if index else onset - fallback
        following = estimated[index + 1] if index + 1 < len(estimated) else onset + fallback
        start = max(0.0, float((previous + onset) / 2.0))
        end = max(start, float((onset + following) / 2.0))
        windows.append((start, end))
    return windows


def _number(value: Any, missing: float = 0.0) -> float:
    return missing if value is None else float(value)


def prepare_acoustic_context(audio_path: Path) -> dict[str, Any]:
    waveform, sample_rate = librosa.load(audio_path, sr=22050, mono=True)
    hop_length = 512
    onset_envelope = librosa.onset.onset_strength(
        y=waveform,
        sr=sample_rate,
        hop_length=hop_length,
    )
    onset_times = librosa.frames_to_time(
        np.arange(len(onset_envelope)),
        sr=sample_rate,
        hop_length=hop_length,
    )
    peak_frames = librosa.util.peak_pick(
        onset_envelope,
        pre_max=3,
        post_max=3,
        pre_avg=3,
        post_avg=5,
        delta=0.20,
        wait=2,
    )
    f0, voiced, voiced_probability = librosa.pyin(
        waveform,
        fmin=librosa.note_to_hz("G3"),
        fmax=librosa.note_to_hz("E7"),
        sr=sample_rate,
        frame_length=2048,
        hop_length=hop_length,
    )
    f0_midi = np.full_like(f0, np.nan, dtype=np.float64)
    finite = np.isfinite(f0)
    f0_midi[finite] = librosa.hz_to_midi(f0[finite])
    return {
        "waveform": waveform,
        "sampleRate": sample_rate,
        "onsetEnvelope": onset_envelope,
        "onsetTimes": onset_times,
        "onsetPeakTimes": librosa.frames_to_time(
            peak_frames,
            sr=sample_rate,
            hop_length=hop_length,
        ),
        "pitchTimes": librosa.frames_to_time(
            np.arange(len(f0_midi)),
            sr=sample_rate,
            hop_length=hop_length,
        ),
        "f0Midi": f0_midi,
        "voiced": voiced,
        "voicedProbability": voiced_probability,
    }


def acoustic_window_features(
    context: dict[str, Any] | None,
    start: float,
    end: float,
    target_midi: int,
) -> dict[str, float]:
    empty = {
        "acousticAvailable": 0.0,
        "targetRmsDb": -120.0,
        "targetPeakDb": -120.0,
        "targetOnsetMean": 0.0,
        "targetOnsetMax": 0.0,
        "targetInteriorAttackRatio": 0.0,
        "targetOnsetPeakCount": 0.0,
        "targetVoicedFrameRatio": 0.0,
        "targetPitchOccupancy": 0.0,
        "targetNearPitchOccupancy": 0.0,
        "targetMeanVoicedProbability": 0.0,
    }
    if not context or end <= start:
        return empty
    waveform = context["waveform"]
    sample_rate = int(context["sampleRate"])
    sample_start = max(0, int(round(start * sample_rate)))
    sample_end = min(len(waveform), int(round(end * sample_rate)))
    segment = waveform[sample_start:sample_end]
    if segment.size == 0:
        return empty
    rms = float(np.sqrt(np.mean(np.square(segment, dtype=np.float64))))
    peak = float(np.max(np.abs(segment)))
    onset_mask = (context["onsetTimes"] >= start) & (context["onsetTimes"] < end)
    onset_values = context["onsetEnvelope"][onset_mask]
    duration = end - start
    interior_mask = (
        (context["onsetTimes"] >= start + max(0.12, duration * 0.20))
        & (context["onsetTimes"] < end - max(0.06, duration * 0.08))
    )
    interior_values = context["onsetEnvelope"][interior_mask]
    onset_max = float(np.max(onset_values)) if onset_values.size else 0.0
    pitch_mask = (context["pitchTimes"] >= start) & (context["pitchTimes"] < end)
    local_f0 = context["f0Midi"][pitch_mask]
    local_voiced = context["voiced"][pitch_mask]
    local_probability = context["voicedProbability"][pitch_mask]
    finite_f0 = local_f0[np.isfinite(local_f0)]
    return {
        "acousticAvailable": 1.0,
        "targetRmsDb": float(20.0 * np.log10(max(rms, 1e-6))),
        "targetPeakDb": float(20.0 * np.log10(max(peak, 1e-6))),
        "targetOnsetMean": float(np.mean(onset_values)) if onset_values.size else 0.0,
        "targetOnsetMax": onset_max,
        "targetInteriorAttackRatio": (
            float(np.max(interior_values)) / max(onset_max, 1e-9)
            if interior_values.size else 0.0
        ),
        "targetOnsetPeakCount": float(np.sum(
            (context["onsetPeakTimes"] >= start) & (context["onsetPeakTimes"] < end)
        )),
        "targetVoicedFrameRatio": float(np.mean(local_voiced)) if local_voiced.size else 0.0,
        "targetPitchOccupancy": float(np.mean(np.abs(finite_f0 - target_midi) <= 0.5))
        if finite_f0.size else 0.0,
        "targetNearPitchOccupancy": float(np.mean(np.abs(finite_f0 - target_midi) <= 2.0))
        if finite_f0.size else 0.0,
        "targetMeanVoicedProbability": float(np.nanmean(local_probability))
        if local_probability.size and np.any(np.isfinite(local_probability)) else 0.0,
    }


def extract_segment_features(
    take: dict[str, Any],
    note_index: int,
    acoustic_context: dict[str, Any] | None = None,
) -> dict[str, float]:
    rows = take["rows"]
    notes = take["notes"]
    windows = estimate_note_windows(take)
    target_midi = int(notes[note_index]["midi"])
    target_start, target_end = windows[note_index]
    left = max(0, note_index - 2)
    right = min(len(rows), note_index + 3)
    segment_start = windows[left][0]
    segment_end = windows[right - 1][1]
    target_events = [
        event for event in take["events"]
        if float(event["start"]) < target_end and float(event["end"]) > target_start
    ]
    target_unassigned = [
        event for event in take["unassigned"]
        if float(event["start"]) < target_end and float(event["end"]) > target_start
    ]
    segment_unassigned = [
        event for event in take["unassigned"]
        if segment_start <= float(event["start"]) < segment_end
    ]
    segment_rows = rows[left:right]
    available_ioi = [
        float(row["relativeIoiDeviationRatio"])
        for row in segment_rows
        if row.get("relativeIoiDeviationRatio") is not None
    ]
    features: dict[str, float] = {
        "targetWindowEventCount": float(len(target_events)),
        "targetWindowPitchDiversity": float(len({int(event["midi"]) for event in target_events})),
        "targetUnassignedCount": float(len(target_unassigned)),
        "targetUnassignedExactPitchCount": float(sum(
            int(event["midi"]) == target_midi for event in target_unassigned
        )),
        "targetUnassignedNearPitchCount": float(sum(
            0 < abs(int(event["midi"]) - target_midi) <= 2 for event in target_unassigned
        )),
        "segmentUnassignedCount": float(len(segment_unassigned)),
        "segmentGapCount": float(sum(row.get("predictedTime") is None for row in segment_rows)),
        "segmentPitchMismatchCount": float(sum(
            row.get("pitchDistanceSemitones") not in (None, 0) for row in segment_rows
        )),
        "segmentMaxIoiDeviation": max(available_ioi, default=0.0),
        "segmentMeanIoiDeviation": float(np.mean(available_ioi)) if available_ioi else 0.0,
        "scorePreviousInterval": float(
            target_midi - int(notes[note_index - 1]["midi"])
        ) if note_index else 0.0,
        "scoreNextInterval": float(
            int(notes[note_index + 1]["midi"]) - target_midi
        ) if note_index + 1 < len(notes) else 0.0,
    }
    if acoustic_context is not None:
        features.update(acoustic_window_features(
            acoustic_context,
            target_start,
            target_end,
            target_midi,
        ))
    for offset in range(-2, 3):
        key = f"n_m{abs(offset)}" if offset < 0 else f"n_p{offset}" if offset > 0 else "n_0"
        index = note_index + offset
        if not 0 <= index < len(rows):
            features.update({
                f"{key}OutOfRange": 1.0,
                f"{key}AssignmentGap": 1.0,
                f"{key}PitchDistance": 12.0,
                f"{key}Confidence": 0.0,
                f"{key}IoiMissing": 1.0,
                f"{key}IoiDeviation": 0.0,
                f"{key}DurationMissing": 1.0,
                f"{key}DurationRatio": 0.0,
            })
            continue
        row = rows[index]
        features.update({
            f"{key}OutOfRange": 0.0,
            f"{key}AssignmentGap": float(row.get("predictedTime") is None),
            f"{key}PitchDistance": _number(row.get("pitchDistanceSemitones"), 12.0),
            f"{key}Confidence": _number(row.get("eventConfidence")),
            f"{key}IoiMissing": float(row.get("relativeIoiDeviationRatio") is None),
            f"{key}IoiDeviation": _number(row.get("relativeIoiDeviationRatio")),
            f"{key}DurationMissing": float(row.get("eventDurationRatio") is None),
            f"{key}DurationRatio": _number(row.get("eventDurationRatio")),
        })
    return features


def build_dataset(
    manifest_path: Path,
    truth_path: Path,
) -> list[dict[str, Any]]:
    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        manifest = {row["recordingId"]: row for row in csv.DictReader(handle)}
    truth = read_json(truth_path)["recordings"]
    dataset = []
    for recording_id, truth_recording in truth.items():
        metadata = manifest[recording_id]
        score_path = REPO / metadata["scorePath"]
        audio_path = REPO / metadata["audioPath"]
        take = analyze_take(score_path, audio_path)
        positions = score_positions(score_path)
        if len(positions) != len(take["notes"]):
            raise ValueError(f"round5-score-position-count-mismatch:{recording_id}")
        for event in truth_recording["events"]:
            note_index = truth_note_index(positions, event)
            dataset.append({
                "recordingId": recording_id,
                "pieceId": metadata["pieceId"],
                "performerId": metadata["performerId"],
                "deviceId": metadata["deviceId"],
                "roomId": metadata["roomId"],
                "split": metadata["split"],
                "gate": event["gate"],
                "label": event["label"],
                "noteIndex": note_index,
                "features": extract_segment_features(take, note_index),
            })
    return dataset


def binary_metrics(truth: np.ndarray, predicted: np.ndarray) -> dict[str, Any]:
    true_positive = int(np.sum((truth == 1) & (predicted == 1)))
    false_positive = int(np.sum((truth == 0) & (predicted == 1)))
    false_negative = int(np.sum((truth == 1) & (predicted == 0)))
    true_negative = int(np.sum((truth == 0) & (predicted == 0)))
    precision = true_positive / max(1, true_positive + false_positive)
    recall = true_positive / max(1, true_positive + false_negative)
    return {
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "trueNegative": true_negative,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
    }


def frozen_gap_refinement_metrics(recordings: list[dict[str, Any]]) -> dict[str, Any]:
    true_positive = false_positive = false_negative = true_negative = 0
    off_scope_true_error_hints = 0
    total_positions = 0
    per_gate = {
        gate: {"positive": 0, "detected": 0}
        for gate in GAP_REFINEMENT_TARGET_GATES
    }
    per_recording = []
    for recording in recordings:
        refined = set(recording["refined"])
        target_positive = set(recording["targetPositive"])
        known_positive = set(recording["knownPositive"])
        position_count = int(recording["positionCount"])
        tp = len(refined & target_positive)
        fp = len(refined - known_positive)
        fn = len(target_positive - refined)
        off_scope = len((refined & known_positive) - target_positive)
        negative_count = position_count - len(known_positive)
        true_positive += tp
        false_positive += fp
        false_negative += fn
        true_negative += max(0, negative_count - fp)
        off_scope_true_error_hints += off_scope
        total_positions += position_count
        for gate in GAP_REFINEMENT_TARGET_GATES:
            positives = set(recording["positiveByGate"].get(gate, set()))
            per_gate[gate]["positive"] += len(positives)
            per_gate[gate]["detected"] += len(refined & positives)
        per_recording.append({
            "recordingId": recording["recordingId"],
            "positionCount": position_count,
            "targetPositiveCount": len(target_positive),
            "knownPositiveCount": len(known_positive),
            "refinedHintCount": len(refined),
            "truePositive": tp,
            "falsePositive": fp,
            "offScopeTrueErrorHints": off_scope,
        })
    precision = true_positive / max(1, true_positive + false_positive)
    recall = true_positive / max(1, true_positive + false_negative)
    return {
        "positionCount": total_positions,
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "falseNegative": false_negative,
        "trueNegative": true_negative,
        "offScopeTrueErrorHints": off_scope_true_error_hints,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "byTargetGate": {
            gate: {
                **counts,
                "recall": round(counts["detected"] / max(1, counts["positive"]), 6),
            }
            for gate, counts in per_gate.items()
        },
        "recordings": per_recording,
    }


def evaluate_frozen_gap_refinement(
    manifest_path: Path,
    truth_path: Path,
    promotion: dict[str, Any],
) -> dict[str, Any]:
    from eval_western_round5_temporal_operation_path import (  # noqa: PLC0415
        FROZEN_PARAMS_BY_GATE,
        note_durations,
        onset_context,
        policy_c_gap_refinement_indices,
        predict_operations,
    )

    with manifest_path.open(encoding="utf-8-sig", newline="") as handle:
        manifest = {row["recordingId"]: row for row in csv.DictReader(handle)}
    truth = read_json(truth_path)["recordings"]
    prepared_by_split = {"calibration": [], "fresh-blind": []}
    for recording_id, truth_recording in truth.items():
        metadata = manifest[recording_id]
        score_path = REPO / metadata["scorePath"]
        audio_path = REPO / metadata["audioPath"]
        take = analyze_take(score_path, audio_path)
        positions = score_positions(score_path)
        if len(positions) != len(take["notes"]):
            raise ValueError(f"round5-score-position-count-mismatch:{recording_id}")
        prepared = {
            "take": take,
            "durations": note_durations(score_path),
            "onset": onset_context(audio_path),
        }
        predictions = {}
        prediction_cache = {}
        for gate in GAP_REFINEMENT_TARGET_GATES:
            params = FROZEN_PARAMS_BY_GATE[gate]
            if params not in prediction_cache:
                prediction_cache[params] = predict_operations(prepared, params)
            predictions[gate] = prediction_cache[params][gate]
        _, refined = policy_c_gap_refinement_indices(take, predictions)
        known_positive = set()
        positive_by_gate = {gate: set() for gate in GATES}
        for event in truth_recording["events"]:
            note_index = truth_note_index(positions, event)
            if event["label"] == "positive":
                known_positive.add(note_index)
                positive_by_gate[event["gate"]].add(note_index)
        target_positive = set().union(*(
            positive_by_gate[gate] for gate in GAP_REFINEMENT_TARGET_GATES
        ))
        prepared_by_split[metadata["split"]].append({
            "recordingId": recording_id,
            "positionCount": len(positions),
            "refined": refined,
            "targetPositive": target_positive,
            "knownPositive": known_positive,
            "positiveByGate": positive_by_gate,
        })
    calibration = frozen_gap_refinement_metrics(prepared_by_split["calibration"])
    fresh_blind = frozen_gap_refinement_metrics(prepared_by_split["fresh-blind"])
    ready = (
        fresh_blind["precision"] >= float(promotion["minPrecision"])
        and fresh_blind["recall"] >= float(promotion["minRecall"])
        and fresh_blind["falsePositive"] <= int(promotion["maxStrictFalseAccusations"])
        and all(
            fresh_blind["byTargetGate"][gate]["positive"] > 0
            for gate in GAP_REFINEMENT_TARGET_GATES
        )
    )
    return {
        "contract": FROZEN_GAP_REFINEMENT_CONTRACT,
        "runnerWired": True,
        "evaluationPerformed": True,
        "truthSemantics": "complete per-recording error inventory; every unlisted score position is ordinary-correct",
        "targetGates": list(GAP_REFINEMENT_TARGET_GATES),
        "outputSemantic": "self_check_hint",
        "strictConfirmedRecallChanged": False,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "promotionEvidenceEligible": True,
        "frozenParametersByGate": {
            gate: FROZEN_PARAMS_BY_GATE[gate].as_dict()
            for gate in GAP_REFINEMENT_TARGET_GATES
        },
        "promotionThresholds": promotion,
        "calibrationDiagnosticOnly": calibration,
        "freshBlind": fresh_blind,
        "reviewAssistPromotionReady": ready,
        "blockingReasons": [] if ready else ["round5-frozen-gap-refinement-gate-failed"],
    }


def train_and_evaluate(
    dataset: list[dict[str, Any]],
    promotion: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, RandomForestClassifier]]:
    feature_names = sorted({
        feature
        for row in dataset
        for feature in row["features"]
    })
    models = {}
    results = {}
    for gate in GATES:
        calibration = [row for row in dataset if row["gate"] == gate and row["split"] == "calibration"]
        fresh = [row for row in dataset if row["gate"] == gate and row["split"] == "fresh-blind"]
        y_calibration = np.asarray([int(row["label"] == "positive") for row in calibration])
        y_fresh = np.asarray([int(row["label"] == "positive") for row in fresh])
        if len(calibration) == 0 or len(fresh) == 0 or len(set(y_calibration.tolist())) != 2:
            results[gate] = {
                "ready": False,
                "calibrationRows": len(calibration),
                "freshBlindRows": len(fresh),
                "blockingReasons": [f"round5-segment-model-class-support-missing:{gate}"],
            }
            continue
        x_calibration = np.asarray([
            [float(row["features"].get(name, 0.0)) for name in feature_names]
            for row in calibration
        ])
        x_fresh = np.asarray([
            [float(row["features"].get(name, 0.0)) for name in feature_names]
            for row in fresh
        ])
        model = RandomForestClassifier(**MODEL_PARAMS)
        model.fit(x_calibration, y_calibration)
        predicted = (model.predict_proba(x_fresh)[:, 1] >= 0.5).astype(int)
        metrics = binary_metrics(y_fresh, predicted)
        ready = (
            metrics["precision"] >= float(promotion["minPrecision"])
            and metrics["recall"] >= float(promotion["minRecall"])
            and metrics["falsePositive"] <= int(promotion["maxStrictFalseAccusations"])
        )
        results[gate] = {
            "ready": ready,
            "calibrationRows": len(calibration),
            "freshBlindRows": len(fresh),
            "decisionThreshold": 0.5,
            **metrics,
            "blockingReasons": [] if ready else [f"round5-segment-model-gate-failed:{gate}"],
        }
        models[gate] = model
    return {
        "featureNames": feature_names,
        "modelType": "fixed-random-forest-binary-per-gate",
        "modelParams": MODEL_PARAMS,
        "gates": results,
        "allGatesReady": all(results.get(gate, {}).get("ready") is True for gate in GATES),
    }, models


def run(
    contract_path: Path,
    manifest_path: Path,
    truth_path: Path,
    report_path: Path,
    model_path: Path,
) -> dict[str, Any]:
    intake.REPO = REPO
    intake_report = intake.validate(contract_path, manifest_path, truth_path)
    source_hashes = intake_report.get("hashes", {})
    base = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "intakeContractVersion": intake_report.get("contractVersion"),
        "sourceHashes": source_hashes,
        "intakeReady": intake_report.get("ready") is True,
        "trainingPerformed": False,
        "reviewAssistPromotionReady": False,
        "automaticAccusationReady": False,
        "studentFacing": False,
        "productionAdoptionReady": False,
        "frozenGapRefinement": {
            "contract": FROZEN_GAP_REFINEMENT_CONTRACT,
            "runnerWired": True,
            "evaluationPerformed": False,
            "outputSemantic": "self_check_hint",
            "strictConfirmedRecallChanged": False,
            "automaticAccusationReady": False,
            "studentFacing": False,
            "promotionEvidenceEligible": False,
            "reviewAssistPromotionReady": False,
            "blockingReasons": ["round5-targeted-intake-not-ready"],
        },
    }
    if intake_report.get("ready") is not True:
        report = {
            **base,
            "blockingReasons": [
                "round5-targeted-intake-not-ready",
                *intake_report.get("blockingReasons", []),
            ],
        }
    else:
        contract = read_json(contract_path)
        dataset = build_dataset(manifest_path, truth_path)
        evaluation, models = train_and_evaluate(dataset, contract["promotion"])
        frozen_gap_refinement = evaluate_frozen_gap_refinement(
            manifest_path, truth_path, contract["promotion"]
        )
        model_path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump({
            "contract": CONTRACT,
            "featureNames": evaluation["featureNames"],
            "models": models,
        }, model_path)
        all_ready = evaluation["allGatesReady"]
        report = {
            **base,
            "trainingPerformed": True,
            "datasetRows": len(dataset),
            "evaluation": evaluation,
            "modelArtifact": {
                "path": str(model_path.resolve().relative_to(REPO.resolve())).replace("\\", "/"),
                "sha256": sha256(model_path),
            },
            "reviewAssistPromotionReady": all_ready,
            "frozenGapRefinement": frozen_gap_refinement,
            "blockingReasons": [] if all_ready else sorted({
                reason
                for gate in evaluation["gates"].values()
                for reason in gate.get("blockingReasons", [])
            }),
        }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--truth", type=Path, default=DEFAULT_TRUTH)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--require-trained", action="store_true")
    args = parser.parse_args()
    report = run(args.contract, args.manifest, args.truth, args.report, args.model)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if args.require_trained and not report["trainingPerformed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
