#!/usr/bin/env python3
"""Evaluate an explicit temporal operation-path candidate.

This is architecture-smoke evidence only.  A dynamic-programming path aligns
score notes to Basic Pitch events with explicit match, insert, delete, merge,
and split transitions.  It is calibrated only on the r2-01 waveform-injection
sets, frozen before r2-08 piece holdout and inspected Round 4 are evaluated.
No result from this script may authorize student-facing feedback.
"""
from __future__ import annotations

import csv
import hashlib
import itertools
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import librosa
import numpy as np
from music21 import converter

from eval_western_strings_duration_extra_quantization import (
    EVENT_FILTER,
    INJECT_DIR,
    NATURAL_TAKES,
    PRIVATE,
    V2_SETS,
    analyze_take,
    assign_basic_pitch_events,
    build_rows,
    filter_events,
    score_notes,
    shadow_selected,
)
from eval_western_bach_violin_basic_pitch_transcription import load_events
from train_western_round5_segment_edit_path import (
    GATES,
    binary_metrics,
    score_positions,
    truth_note_index,
)


REPO = Path(__file__).resolve().parents[2]
CONTRACT = "western-round5-temporal-operation-path-smoke-v1"
ROUND4_MANIFEST = REPO / "data/private/western-strings-round4/manifest.csv"
ROUND4_TRUTH = REPO / "data/private/western-strings-round4/error-positions.json"
ROUND4_REPORT = REPO / "data/experiments/western-strings-round4/ordinary-fresh-blind/report.json"
BACH_AUDIT = REPO / "data/experiments/western-strings-bach-violin-dataset-audit.json"
BACH_BASIC_PITCH_CACHE = REPO / "data/experiments/western-strings-bach-violin-basic-pitch-cache"
BACH_PUBLIC_STRESS_UNITS = {
    "oliver-colbentson_bwv1006_mov1",
    "oliver-colbentson_bwv1006_mov7",
}
OUT = REPO / "data/experiments/western-strings-round5-temporal-operation-path/report.json"
EVIDENCE = REPO / "docs/evidence/western-strings-round5-temporal-operation-path-20260722.json"
PROMOTION = {"minPrecision": 0.90, "minRecall": 0.50, "maxStrictFalseAccusations": 0}
KIND_GATE = {
    "wrong": "merged_substitution",
    "missing": "missing",
    "extra": "extra",
    "drag": "drag",
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def binding_hash(path: Path) -> tuple[str, str]:
    data = path.read_bytes()
    if path.suffix.lower() in {".py", ".json", ".csv", ".musicxml", ".xml"}:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        return "lf-normalized-sha256", hashlib.sha256(data).hexdigest()
    return "raw-sha256", hashlib.sha256(data).hexdigest()


def note_durations(score_path: Path) -> list[float]:
    return [max(0.125, float(note.quarterLength)) for note in converter.parse(str(score_path)).flatten().notes]


def robust_seconds_per_quarter(take: dict[str, Any], durations: list[float]) -> float:
    candidates = [
        float(row["expectedDurationSeconds"]) / durations[index]
        for index, row in enumerate(take["rows"])
        if row.get("expectedDurationSeconds") is not None and durations[index] > 0
    ]
    return float(np.median(candidates)) if candidates else 0.5


def prune_events(take: dict[str, Any], min_confidence: float) -> list[dict[str, float]]:
    score_midis = [int(note["midi"]) for note in take["notes"]]
    low, high = min(score_midis) - 3, max(score_midis) + 3
    raw = [
        {
            "start": float(event["start"]),
            "end": float(event["end"]),
            "midi": int(event["midi"]),
            "confidence": float(event["confidence"]),
        }
        for event in take["events"]
        if float(event["confidence"]) >= min_confidence
        and float(event["end"]) - float(event["start"]) >= 0.06
        and low <= int(event["midi"]) <= high
    ]
    raw.sort(key=lambda event: (event["start"], event["end"], -event["confidence"]))
    kept: list[dict[str, float]] = []
    for event in raw:
        replaced = False
        for index in range(len(kept) - 1, -1, -1):
            previous = kept[index]
            if previous["end"] <= event["start"]:
                break
            overlap = max(0.0, min(previous["end"], event["end"]) - max(previous["start"], event["start"]))
            shorter = min(previous["end"] - previous["start"], event["end"] - event["start"])
            if shorter > 0 and overlap / shorter >= 0.80:
                previous_quality = previous["confidence"] * math.sqrt(previous["end"] - previous["start"])
                event_quality = event["confidence"] * math.sqrt(event["end"] - event["start"])
                if event_quality > previous_quality:
                    kept[index] = event
                replaced = True
                break
        if not replaced:
            kept.append(event)
    return sorted(kept, key=lambda event: (event["start"], event["end"]))


@dataclass(frozen=True)
class Params:
    min_confidence: float
    pitch_weight: float
    delete_penalty: float
    insert_penalty: float
    merge_penalty: float
    duration_weight: float
    reattack_ratio: float
    drag_duration_ratio: float
    drag_ioi_ratio: float

    def as_dict(self) -> dict[str, float]:
        return {
            "minConfidence": self.min_confidence,
            "pitchWeight": self.pitch_weight,
            "deletePenalty": self.delete_penalty,
            "insertPenalty": self.insert_penalty,
            "mergePenalty": self.merge_penalty,
            "durationWeight": self.duration_weight,
            "reattackRatio": self.reattack_ratio,
            "dragDurationRatio": self.drag_duration_ratio,
            "dragIoiRatio": self.drag_ioi_ratio,
        }


FROZEN_PARAMS_BY_GATE = {
    "merged_substitution": Params(0.45, 0.50, 0.80, 1.10, 0.20, 0.30, 0.70, 1.30, 0.15),
    "missing": Params(0.45, 0.50, 0.80, 0.80, 0.45, 0.15, 0.70, 1.30, 0.15),
    "extra": Params(0.55, 0.50, 0.80, 1.10, 0.20, 0.30, 0.85, 1.30, 0.15),
    "drag": Params(0.45, 0.50, 0.80, 0.80, 0.20, 0.15, 0.70, 1.30, 0.15),
}


def duration_cost(observed: float, expected: float) -> float:
    return min(2.5, abs(math.log(max(observed, 1e-4) / max(expected, 1e-4))))


def align_operation_path(
    take: dict[str, Any],
    durations: list[float],
    params: Params,
) -> tuple[list[dict[str, Any]], list[dict[str, float]], float]:
    notes = take["notes"]
    events = prune_events(take, params.min_confidence)
    seconds_per_quarter = robust_seconds_per_quarter(take, durations)
    n, m = len(notes), len(events)
    costs = np.full((n + 1, m + 1), np.inf)
    previous: list[list[tuple[int, int, dict[str, Any]] | None]] = [
        [None] * (m + 1) for _ in range(n + 1)
    ]
    costs[0, 0] = 0.0

    def relax(i2: int, j2: int, value: float, i: int, j: int, operation: dict[str, Any]) -> None:
        if value + 1e-10 < costs[i2, j2]:
            costs[i2, j2] = value
            previous[i2][j2] = (i, j, operation)

    for i in range(n + 1):
        for j in range(m + 1):
            base = float(costs[i, j])
            if not math.isfinite(base):
                continue
            if i < n and j < m:
                event = events[j]
                expected = durations[i] * seconds_per_quarter
                pitch_distance = abs(int(notes[i]["midi"]) - int(event["midi"]))
                cost = (
                    params.pitch_weight * min(6.0, pitch_distance)
                    + params.duration_weight * duration_cost(event["end"] - event["start"], expected)
                    + 0.15 * (1.0 - event["confidence"])
                )
                relax(i + 1, j + 1, base + cost, i, j, {
                    "kind": "match", "score": [i], "events": [j], "pitchDistance": pitch_distance,
                })
            if i < n:
                relax(i + 1, j, base + params.delete_penalty, i, j, {
                    "kind": "delete", "score": [i], "events": [],
                })
            if j < m:
                event = events[j]
                cost = params.insert_penalty + 0.25 * (1.0 - event["confidence"])
                relax(i, j + 1, base + cost, i, j, {
                    "kind": "insert", "score": [], "events": [j], "scoreCursor": i,
                })
            if i + 1 < n and j < m:
                event = events[j]
                first = abs(int(notes[i]["midi"]) - int(event["midi"]))
                second = abs(int(notes[i + 1]["midi"]) - int(event["midi"]))
                expected = (durations[i] + durations[i + 1]) * seconds_per_quarter
                cost = (
                    params.merge_penalty
                    + params.pitch_weight * min(4.0, min(first, second))
                    + params.duration_weight * duration_cost(event["end"] - event["start"], expected)
                    + 0.15 * (1.0 - event["confidence"])
                )
                relax(i + 2, j + 1, base + cost, i, j, {
                    "kind": "merge", "score": [i, i + 1], "events": [j],
                    "pitchDistances": [first, second],
                })
            if i < n and j + 1 < m:
                first_event, second_event = events[j], events[j + 1]
                target = int(notes[i]["midi"])
                first = abs(target - int(first_event["midi"]))
                second = abs(target - int(second_event["midi"]))
                expected = durations[i] * seconds_per_quarter
                observed = (first_event["end"] - first_event["start"]) + (second_event["end"] - second_event["start"])
                cost = (
                    params.merge_penalty
                    + params.pitch_weight * min(6.0, first + second)
                    + params.duration_weight * duration_cost(observed, expected)
                    + 0.15 * (2.0 - first_event["confidence"] - second_event["confidence"])
                )
                relax(i + 1, j + 2, base + cost, i, j, {
                    "kind": "split", "score": [i], "events": [j, j + 1],
                    "pitchDistances": [first, second],
                })
    operations = []
    i, j = n, m
    while i or j:
        link = previous[i][j]
        if link is None:
            raise RuntimeError(f"operation-path-backtrace-missing:{i}:{j}")
        old_i, old_j, operation = link
        operations.append(operation)
        i, j = old_i, old_j
    operations.reverse()
    return operations, events, seconds_per_quarter


def onset_context(audio_path: Path) -> dict[str, np.ndarray | float]:
    waveform, sample_rate = librosa.load(audio_path, sr=22050, mono=True)
    envelope = librosa.onset.onset_strength(y=waveform, sr=sample_rate, hop_length=512)
    return {
        "envelope": envelope,
        "times": librosa.frames_to_time(np.arange(len(envelope)), sr=sample_rate, hop_length=512),
    }


def interior_attack_ratio(context: dict[str, Any], start: float, end: float) -> float:
    duration = end - start
    if duration <= 0.20:
        return 0.0
    times = context["times"]
    envelope = context["envelope"]
    full = envelope[(times >= start) & (times < end)]
    interior = envelope[
        (times >= start + max(0.12, duration * 0.20))
        & (times < end - max(0.06, duration * 0.08))
    ]
    if not full.size or not interior.size:
        return 0.0
    return float(np.max(interior) / max(float(np.max(full)), 1e-9))


def predict_operations(
    prepared: dict[str, Any],
    params: Params,
) -> dict[str, set[int]]:
    take = prepared["take"]
    durations = prepared["durations"]
    operations, events, seconds_per_quarter = align_operation_path(take, durations, params)
    predicted = {gate: set() for gate in GATES}
    operation_by_score: dict[int, str] = {}
    for operation in operations:
        kind = operation["kind"]
        for index in operation.get("score", []):
            operation_by_score[index] = kind
        if kind == "match" and operation["pitchDistance"] >= 1:
            predicted["merged_substitution"].add(operation["score"][0])
        elif kind == "delete":
            predicted["missing"].add(operation["score"][0])
        elif kind == "insert":
            event = events[operation["events"][0]]
            cursor = int(operation["scoreCursor"])
            candidates = [index for index in (cursor - 1, cursor) if 0 <= index < len(take["notes"])]
            if candidates:
                localized = min(candidates, key=lambda index: abs(int(take["notes"][index]["midi"]) - int(event["midi"])))
                if abs(int(take["notes"][localized]["midi"]) - int(event["midi"])) <= 1 and event["confidence"] >= 0.65:
                    predicted["extra"].add(localized)
        elif kind == "merge":
            first, second = operation["score"]
            first_distance, second_distance = operation["pitchDistances"]
            if second_distance == 0 and first_distance > 0:
                predicted["merged_substitution"].add(first)
            elif first_distance == 0 and second_distance > 0:
                predicted["missing"].add(second)
        elif kind == "split" and max(operation["pitchDistances"]) <= 1:
            predicted["extra"].add(operation["score"][0])

    for operation in operations:
        if operation["kind"] != "match" or operation["pitchDistance"] != 0:
            continue
        note_index = operation["score"][0]
        event = events[operation["events"][0]]
        ratio = interior_attack_ratio(prepared["onset"], event["start"], event["end"])
        observed_duration = event["end"] - event["start"]
        expected_duration = durations[note_index] * seconds_per_quarter
        duration_ratio = observed_duration / max(expected_duration, 1e-6)
        row = take["rows"][note_index]
        ioi_ratio = float(row.get("relativeIoiDeviationRatio") or 0.0)
        if ratio >= params.reattack_ratio:
            predicted["extra"].add(note_index)
        if (
            note_index not in predicted["extra"]
            and duration_ratio >= params.drag_duration_ratio
            and ioi_ratio >= params.drag_ioi_ratio
            and operation_by_score.get(note_index - 1) != "merge"
        ):
            predicted["drag"].add(note_index)
    return predicted


def prepare_take(recording_id: str, piece_id: str, score_path: Path, audio_path: Path) -> dict[str, Any]:
    return {
        "recordingId": recording_id,
        "pieceId": piece_id,
        "scorePath": score_path,
        "audioPath": audio_path,
        "take": analyze_take(score_path, audio_path),
        "durations": note_durations(score_path),
        "onset": onset_context(audio_path),
    }


def injection_truth(name: str) -> dict[str, set[int]]:
    truth = {gate: set() for gate in GATES}
    for item in read_json(INJECT_DIR / f"{name}.labels.json")["injections"]:
        truth[KIND_GATE[item["type"]]].add(int(item["scoreEventIndex"]))
    return truth


def prepared_injections(names: list[str]) -> list[dict[str, Any]]:
    output = []
    for name in names:
        piece = name.split("-injected")[0]
        item = prepare_take(name, piece, PRIVATE / f"{piece}.musicxml", INJECT_DIR / f"{name}.wav")
        item["truth"] = injection_truth(name)
        output.append(item)
    return output


def prepared_round4() -> list[dict[str, Any]]:
    with ROUND4_MANIFEST.open(encoding="utf-8-sig", newline="") as handle:
        manifest = list(csv.DictReader(handle))
    truth = read_json(ROUND4_TRUTH).get("recordings", {})
    report_recordings = {
        row["recordingId"]: row for row in read_json(ROUND4_REPORT)["recordings"]
    }
    output = []
    for metadata in manifest:
        recording_id = metadata["recordingId"]
        score_path = REPO / metadata["scorePath"]
        audio_path = REPO / metadata["audioPath"]
        item = prepare_take(recording_id, metadata["pieceId"], score_path, audio_path)
        candidate_artifact = read_json(REPO / report_recordings[recording_id]["candidateRowsPath"])
        item["policyCGapIndices"] = {
            int(row["noteIndex"])
            for row in candidate_artifact["candidateRows"]
            if row.get("m3plusTimingAssignmentAvailable") is False
        }
        positions = score_positions(score_path)
        item["truth"] = {gate: set() for gate in GATES}
        for event in truth.get(recording_id, {}).get("errors", []):
            item["truth"][KIND_GATE[event["kind"]]].add(truth_note_index(positions, event))
        output.append(item)
    return output


def prepared_natural_clean() -> list[dict[str, Any]]:
    output = []
    for recording_id, score_path, audio_path in NATURAL_TAKES:
        item = prepare_take(recording_id, recording_id, score_path, audio_path)
        item["truth"] = {gate: set() for gate in GATES}
        output.append(item)
    return output


def prepared_public_professional_stress() -> list[dict[str, Any]]:
    """Prepare frozen public Bach pairs without treating them as error gold.

    These two Oliver Colbentson movements are the audit rows with at most 5%
    double-stop reference notes.  Their existing Basic Pitch cache is reused;
    no parameter selection or model fitting happens on these recordings.
    """
    rows = {
        row["unit"]: row
        for row in read_json(BACH_AUDIT)["rows"]
        if row.get("unit") in BACH_PUBLIC_STRESS_UNITS
    }
    if set(rows) != BACH_PUBLIC_STRESS_UNITS:
        missing = sorted(BACH_PUBLIC_STRESS_UNITS - set(rows))
        raise RuntimeError(f"public-professional-stress-unit-missing:{','.join(missing)}")
    output = []
    for unit in sorted(BACH_PUBLIC_STRESS_UNITS):
        metadata = rows[unit]
        score_path = REPO / metadata["scorePath"]
        audio_path = REPO / metadata["audioPath"]
        # The student injection helper additionally enforces index isomorphism
        # against its own MXL parser.  Public .mxl files need only the same
        # flattened note representation; they have no injection-label index.
        expanded_score = converter.parse(str(score_path)).expandRepeats()
        notes = []
        durations = []
        for note in expanded_score.flatten().notes:
            midis = sorted(int(pitch.midi) for pitch in note.pitches)
            notes.append({
                "midi": midis[0],
                "midis": midis,
                "scoreUnit": float(note.offset),
                "scoreOnsetUnit": float(note.offset),
            })
            durations.append(max(0.125, float(note.quarterLength)))
        events = filter_events(
            load_events(BACH_BASIC_PITCH_CACHE, audio_path),
            EVENT_FILTER["minConfidence"],
            EVENT_FILTER["minDurationSeconds"],
        )
        take_rows = build_rows(notes, events)
        for row in take_rows:
            row["selected"] = shadow_selected(row)
        assignments = assign_basic_pitch_events(notes, events)
        matched = {assignment["eventIndex"] for assignment in assignments if assignment}
        take = {
            "notes": notes,
            "rows": take_rows,
            "events": events,
            "unassigned": [event for index, event in enumerate(events) if index not in matched],
        }
        item = {
            "recordingId": unit,
            "pieceId": metadata["pieceId"],
            "scorePath": score_path,
            "audioPath": audio_path,
            "cachePath": BACH_BASIC_PITCH_CACHE / f"{audio_path.stem}.basic-pitch.json",
            "take": take,
            "durations": durations,
            "onset": onset_context(audio_path),
            "truth": {gate: set() for gate in GATES},
        }
        output.append(item)
    return output


def summarize_unadjudicated_burden(result: dict[str, Any]) -> dict[str, Any]:
    score_positions = sum(
        sum(row["refined"][key] for key in (
            "truePositive", "falsePositive", "falseNegative", "trueNegative"
        ))
        for row in result["recordings"]
    )
    assignment_gaps = sum(len(row["assignmentGaps"]) for row in result["recordings"])
    refined_flags = sum(len(row["refinedSelfCheckHints"]) for row in result["recordings"])
    return {
        "evidenceRole": "public-professional-unadjudicated-negative-burden-proxy",
        "inputContract": "whole-performance score with repeats expanded before alignment",
        "recordingCount": len(result["recordings"]),
        "scorePositionCount": score_positions,
        "assignmentGapCount": assignment_gaps,
        "refinedFlagCount": refined_flags,
        "refinedFlagsPer1000Positions": round(1000.0 * refined_flags / max(1, score_positions), 6),
        "humanErrorGoldAvailable": False,
        "falsePositiveCountAuthoritative": False,
        "promotionEvidenceEligible": False,
        "generalPurposeBurdenReady": False,
        "recordings": [
            {
                "recordingId": row["recordingId"],
                "scorePositionCount": sum(row["refined"][key] for key in (
                    "truePositive", "falsePositive", "falseNegative", "trueNegative"
                )),
                "assignmentGapCount": len(row["assignmentGaps"]),
                "refinedFlagCount": len(row["refinedSelfCheckHints"]),
            }
            for row in result["recordings"]
        ],
        "interpretation": (
            "Every emitted hint is observable review burden, but cannot be labeled a false "
            "accusation without note-level human adjudication of performance/edition deviations. "
            "The observed burden is too large for general-purpose use; the candidate remains "
            "eligible only for the already-scoped short student fresh-blind test."
        ),
    }


def evaluate(dataset: list[dict[str, Any]], params: Params) -> dict[str, Any]:
    pooled = {gate: {"truth": [], "predicted": []} for gate in GATES}
    union_truth: list[int] = []
    union_predicted: list[int] = []
    per_recording = []
    for item in dataset:
        predictions = predict_operations(item, params)
        count = len(item["take"]["notes"])
        local_truth_union = set().union(*item["truth"].values())
        local_prediction_union = set().union(*predictions.values())
        for gate in GATES:
            pooled[gate]["truth"].extend(int(index in item["truth"][gate]) for index in range(count))
            pooled[gate]["predicted"].extend(int(index in predictions[gate]) for index in range(count))
        union_truth.extend(int(index in local_truth_union) for index in range(count))
        union_predicted.extend(int(index in local_prediction_union) for index in range(count))
        local = binary_metrics(np.asarray(union_truth[-count:]), np.asarray(union_predicted[-count:]))
        per_recording.append({
            "recordingId": item["recordingId"],
            "truth": {gate: sorted(item["truth"][gate]) for gate in GATES},
            "predicted": {gate: sorted(predictions[gate]) for gate in GATES},
            "union": local,
        })
    gate_metrics = {}
    for gate in GATES:
        metrics = binary_metrics(np.asarray(pooled[gate]["truth"]), np.asarray(pooled[gate]["predicted"]))
        metrics["jointFloorReady"] = (
            metrics["precision"] >= PROMOTION["minPrecision"]
            and metrics["recall"] >= PROMOTION["minRecall"]
            and metrics["falsePositive"] <= PROMOTION["maxStrictFalseAccusations"]
        )
        gate_metrics[gate] = metrics
    union = binary_metrics(np.asarray(union_truth), np.asarray(union_predicted))
    union["jointFloorReady"] = (
        union["precision"] >= PROMOTION["minPrecision"]
        and union["recall"] >= PROMOTION["minRecall"]
        and union["falsePositive"] <= PROMOTION["maxStrictFalseAccusations"]
    )
    return {"gates": gate_metrics, "union": union, "recordings": per_recording}


def evaluate_gate_specific(
    dataset: list[dict[str, Any]],
    params_by_gate: dict[str, Params],
) -> dict[str, Any]:
    pooled = {gate: {"truth": [], "predicted": []} for gate in GATES}
    union_truth: list[int] = []
    union_predicted: list[int] = []
    per_recording = []
    for item in dataset:
        cache: dict[Params, dict[str, set[int]]] = {}
        predictions: dict[str, set[int]] = {}
        for gate in GATES:
            params = params_by_gate[gate]
            if params not in cache:
                cache[params] = predict_operations(item, params)
            predictions[gate] = cache[params][gate]
        count = len(item["take"]["notes"])
        local_truth_union = set().union(*item["truth"].values())
        local_prediction_union = set().union(*predictions.values())
        local_truth = np.asarray([int(index in local_truth_union) for index in range(count)])
        local_predicted = np.asarray([int(index in local_prediction_union) for index in range(count)])
        for gate in GATES:
            pooled[gate]["truth"].extend(int(index in item["truth"][gate]) for index in range(count))
            pooled[gate]["predicted"].extend(int(index in predictions[gate]) for index in range(count))
        union_truth.extend(local_truth.tolist())
        union_predicted.extend(local_predicted.tolist())
        per_recording.append({
            "recordingId": item["recordingId"],
            "truth": {gate: sorted(item["truth"][gate]) for gate in GATES},
            "predicted": {gate: sorted(predictions[gate]) for gate in GATES},
            "union": binary_metrics(local_truth, local_predicted),
        })
    gate_metrics = {}
    for gate in GATES:
        metrics = binary_metrics(np.asarray(pooled[gate]["truth"]), np.asarray(pooled[gate]["predicted"]))
        metrics["jointFloorReady"] = (
            metrics["precision"] >= PROMOTION["minPrecision"]
            and metrics["recall"] >= PROMOTION["minRecall"]
            and metrics["falsePositive"] <= PROMOTION["maxStrictFalseAccusations"]
        )
        gate_metrics[gate] = metrics
    union = binary_metrics(np.asarray(union_truth), np.asarray(union_predicted))
    union["jointFloorReady"] = (
        union["precision"] >= PROMOTION["minPrecision"]
        and union["recall"] >= PROMOTION["minRecall"]
        and union["falsePositive"] <= PROMOTION["maxStrictFalseAccusations"]
    )
    return {"gates": gate_metrics, "union": union, "recordings": per_recording}


def evaluate_policy_c_gap_refinement(
    dataset: list[dict[str, Any]],
    params_by_gate: dict[str, Params],
) -> dict[str, Any]:
    """Retrospective two-evidence refinement; never a promotion result.

    A Policy-C assignment gap remains a self-check hint only when the explicit
    path independently calls a substitution at that position, or calls a
    deletion inside a run of at least two adjacent assignment gaps.  The
    second clause lets the path choose one position from an ambiguous local
    deletion run instead of hinting every row in that run.
    """
    all_truth: list[int] = []
    base_flags: list[int] = []
    refined_flags: list[int] = []
    per_recording = []
    for item in dataset:
        cache: dict[Params, dict[str, set[int]]] = {}
        predictions: dict[str, set[int]] = {}
        for gate in GATES:
            params = params_by_gate[gate]
            if params not in cache:
                cache[params] = predict_operations(item, params)
            predictions[gate] = cache[params][gate]
        count = len(item["take"]["notes"])
        truth = set().union(*item["truth"].values())
        explicit_gaps = item.get("policyCGapIndices")
        gaps, refined = policy_c_gap_refinement_indices(
            item["take"], predictions, explicit_gaps
        )
        truth_vector = np.asarray([int(index in truth) for index in range(count)])
        base_vector = np.asarray([int(index in gaps) for index in range(count)])
        refined_vector = np.asarray([int(index in refined) for index in range(count)])
        all_truth.extend(truth_vector.tolist())
        base_flags.extend(base_vector.tolist())
        refined_flags.extend(refined_vector.tolist())
        per_recording.append({
            "recordingId": item["recordingId"],
            "assignmentGaps": sorted(gaps),
            "refinedSelfCheckHints": sorted(refined),
            "base": binary_metrics(truth_vector, base_vector),
            "refined": binary_metrics(truth_vector, refined_vector),
        })
    truth_array = np.asarray(all_truth)
    base_array = np.asarray(base_flags)
    refined_array = np.asarray(refined_flags)
    return {
        "rule": (
            "assignment-gap AND (operation-path merged_substitution at same position "
            "OR operation-path missing inside adjacent assignment-gap run)"
        ),
        "outputSemantic": "self_check_hint",
        "automaticAccusationAuthorized": False,
        "base": binary_metrics(truth_array, base_array),
        "refined": binary_metrics(truth_array, refined_array),
        "recordings": per_recording,
    }


def policy_c_gap_refinement_indices(
    take: dict[str, Any],
    predictions: dict[str, set[int]],
    explicit_gaps: set[int] | None = None,
) -> tuple[set[int], set[int]]:
    gaps = set(explicit_gaps) if explicit_gaps is not None else {
        index for index, row in enumerate(take["rows"])
        if row.get("predictedTime") is None
    }
    gap_run_member = {
        index for index in gaps if index - 1 in gaps or index + 1 in gaps
    }
    refined = {
        index for index in gaps
        if index in predictions["merged_substitution"]
        or (index in predictions["missing"] and index in gap_run_member)
    }
    return gaps, refined


def calibration_grid() -> list[Params]:
    return [
        Params(*values)
        for values in itertools.product(
            (0.45, 0.55),
            (0.50, 0.75),
            (0.80, 1.10),
            (0.80, 1.10),
            (0.20, 0.45),
            (0.15, 0.30),
            (0.70, 0.85),
            (1.30, 1.55),
            (0.15, 0.30),
        )
    ]


def select_on_calibration(
    dataset: list[dict[str, Any]],
) -> tuple[dict[str, Params], dict[str, Any], int]:
    best_by_gate: dict[str, tuple[tuple[Any, ...], Params]] = {}
    configuration_count = 0
    for params in calibration_grid():
        configuration_count += 1
        result = evaluate(dataset, params)
        for gate in GATES:
            metrics = result["gates"][gate]
            key = (
                metrics["jointFloorReady"],
                metrics["falsePositive"] == 0,
                metrics["precision"],
                metrics["recall"],
                -metrics["falsePositive"],
            )
            if gate not in best_by_gate or key > best_by_gate[gate][0]:
                best_by_gate[gate] = (key, params)
    selected = {gate: best_by_gate[gate][1] for gate in GATES}
    return selected, evaluate_gate_specific(dataset, selected), configuration_count


def source_binding() -> dict[str, Any]:
    files = {
        ROUND4_MANIFEST,
        ROUND4_TRUTH,
        ROUND4_REPORT,
        BACH_AUDIT,
        Path(__file__).resolve(),
    }
    for name in V2_SETS:
        piece = name.split("-injected")[0]
        files.update({
            PRIVATE / f"{piece}.musicxml",
            INJECT_DIR / f"{name}.wav",
            INJECT_DIR / f"{name}.labels.json",
        })
    with ROUND4_MANIFEST.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            files.add(REPO / row["scorePath"])
            files.add(REPO / row["audioPath"])
    for _, score_path, audio_path in NATURAL_TAKES:
        files.add(score_path)
        files.add(audio_path)
    bach_rows = {
        row["unit"]: row
        for row in read_json(BACH_AUDIT)["rows"]
        if row.get("unit") in BACH_PUBLIC_STRESS_UNITS
    }
    for unit in sorted(BACH_PUBLIC_STRESS_UNITS):
        metadata = bach_rows[unit]
        audio_path = REPO / metadata["audioPath"]
        files.add(audio_path)
        files.add(REPO / metadata["scorePath"])
        files.add(BACH_BASIC_PITCH_CACHE / f"{audio_path.stem}.basic-pitch.json")
    for recording in read_json(ROUND4_REPORT)["recordings"]:
        files.add(REPO / recording["candidateRowsPath"])
    ledger = []
    for file in sorted(files):
        hash_mode, digest = binding_hash(file)
        ledger.append({
            "path": str(file.relative_to(REPO)).replace("\\", "/"),
            "hashMode": hash_mode,
            "sha256": digest,
        })
    canonical = json.dumps(ledger, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {
        "fileCount": len(ledger),
        "aggregateSha256": hashlib.sha256(canonical.encode()).hexdigest(),
        "files": ledger,
    }


def main() -> int:
    dev_names = [name for name in V2_SETS if name.startswith("r2-01-")]
    holdout_names = [name for name in V2_SETS if name.startswith("r2-08-")]
    development = prepared_injections(dev_names)
    holdout = prepared_injections(holdout_names)
    round4 = prepared_round4()
    natural_clean = prepared_natural_clean()
    public_professional = prepared_public_professional_stress()
    selected, development_result, configurations = select_on_calibration(development)
    if selected != FROZEN_PARAMS_BY_GATE:
        raise RuntimeError("frozen-temporal-operation-parameters-drift")
    selected = FROZEN_PARAMS_BY_GATE
    holdout_result = evaluate_gate_specific(holdout, selected)
    round4_result = evaluate_gate_specific(round4, selected)
    calibration_gap_refinement = evaluate_policy_c_gap_refinement(development, selected)
    holdout_gap_refinement = evaluate_policy_c_gap_refinement(holdout, selected)
    round4_gap_refinement = evaluate_policy_c_gap_refinement(round4, selected)
    natural_clean_gap_refinement = evaluate_policy_c_gap_refinement(natural_clean, selected)
    public_professional_gap_refinement = evaluate_policy_c_gap_refinement(public_professional, selected)
    public_professional_burden = summarize_unadjudicated_burden(
        public_professional_gap_refinement
    )
    policy_c = read_json(ROUND4_REPORT)["policyCReviewAssist"]
    strict_true_positive = int(policy_c["planted"]["strictConfirmed"])
    strict_false_positive = int(policy_c["nonPlanted"]["strictFalseAccusations"])
    refined_true_positive = int(round4_gap_refinement["refined"]["truePositive"])
    refined_false_positive = int(round4_gap_refinement["refined"]["falsePositive"])
    combined_true_positive = strict_true_positive + refined_true_positive
    combined_false_positive = strict_false_positive + refined_false_positive
    combined_precision = combined_true_positive / max(1, combined_true_positive + combined_false_positive)
    combined_recall = combined_true_positive / int(policy_c["planted"]["total"])
    gap_refinement_candidate_retained = bool(
        holdout_gap_refinement["refined"]["falsePositive"] == 0
        and holdout_gap_refinement["refined"]["truePositive"] > 0
        and round4_gap_refinement["refined"]["falsePositive"] == 0
        and natural_clean_gap_refinement["refined"]["falsePositive"] == 0
        and refined_true_positive >= 4
    )
    retained = holdout_result["union"]["jointFloorReady"] and round4_result["union"]["jointFloorReady"]
    report = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "scope": "architecture-smoke-preGateOnly",
        "studentFacing": False,
        "automaticAccusationReady": False,
        "reviewAssistPromotionReady": False,
        "productionAdoptionReady": False,
        "promotionEvidenceEligible": False,
        "architecture": {
            "kind": "explicit-dynamic-programming-temporal-operation-path",
            "operations": ["match", "insert", "delete", "merge", "split"],
            "calibrationConfigurationCount": configurations,
            "selectedParametersByGate": {gate: selected[gate].as_dict() for gate in GATES},
        },
        "splitDiscipline": {
            "calibration": "r2-01 waveform-injection-v2, three correlated seeds",
            "syntheticHoldout": "r2-08 waveform-injection-v2, three correlated seeds",
            "realDiagnostic": "inspected Round 4; never fresh-blind",
            "naturalCleanStress": "r2-01, r2-08, r3-01, r3-02, r3-03; negative burden only",
            "publicProfessionalStress": (
                "two frozen Oliver Colbentson BWV1006 movements with <=5% double stops; "
                "unadjudicated burden proxy only"
            ),
        },
        "promotionThresholds": PROMOTION,
        "sourceBinding": source_binding(),
        "calibration": development_result,
        "syntheticHoldout": holdout_result,
        "round4InspectedReal": round4_result,
        "policyCGapRefinement": {
            "evidenceRole": "round4-informed-retrospective-diagnostic-only",
            "calibration": calibration_gap_refinement,
            "syntheticHoldout": holdout_gap_refinement,
            "round4InspectedReal": round4_gap_refinement,
            "naturalCleanStress": natural_clean_gap_refinement,
            "publicProfessionalStress": public_professional_burden,
            "round4TwoLayerCombined": {
                "strictConfirmed": strict_true_positive,
                "refinedSelfCheckHints": refined_true_positive,
                "truePositive": combined_true_positive,
                "falsePositive": combined_false_positive,
                "precision": round(combined_precision, 6),
                "recall": round(combined_recall, 6),
                "strictConfirmedRecallUnchanged": True,
                "automaticAccusationReady": False,
                "reviewAssistPromotionReady": False,
            },
            "candidateRetainedForFreshBlind": gap_refinement_candidate_retained,
            "generalPurposeCandidateRetained": False,
            "promotionBlockingReasons": [
                "gap-refinement-rule-round4-informed",
                "gap-refinement-fresh-blind-not-run",
                "round5-independent-real-confusion-pairs-missing",
                "public-professional-negative-burden-not-cleared",
            ],
            "contaminationBoundary": (
                "The refinement rule was formulated after inspecting Round 4. "
                "Its 6/12 result is a diagnostic ceiling, not fresh-blind evidence."
            ),
        },
        "architectureCandidateRetained": retained,
        "blockingReasons": [
            *([] if holdout_result["union"]["jointFloorReady"] else ["temporal-operation-path-synthetic-piece-holdout-failed"]),
            *([] if round4_result["union"]["jointFloorReady"] else ["temporal-operation-path-synthetic-to-real-transfer-failed"]),
            "round5-independent-real-confusion-pairs-missing",
            "round4-inspected-not-promotion-eligible",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "selectedParametersByGate": {gate: selected[gate].as_dict() for gate in GATES},
        "calibrationUnion": development_result["union"],
        "syntheticHoldoutUnion": holdout_result["union"],
        "round4Union": round4_result["union"],
        "round4Gates": round4_result["gates"],
        "round4PolicyCGapRefinement": report["policyCGapRefinement"]["round4TwoLayerCombined"],
        "naturalCleanRefinedFalsePositive": natural_clean_gap_refinement["refined"]["falsePositive"],
        "publicProfessionalRefinedFlagCount": public_professional_burden["refinedFlagCount"],
        "publicProfessionalScorePositionCount": public_professional_burden["scorePositionCount"],
        "gapRefinementCandidateRetainedForFreshBlind": gap_refinement_candidate_retained,
        "architectureCandidateRetained": retained,
        "report": str(OUT.relative_to(REPO)).replace("\\", "/"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
