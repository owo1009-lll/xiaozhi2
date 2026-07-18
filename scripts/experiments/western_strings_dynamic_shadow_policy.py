#!/usr/bin/env python3
"""Gold-free candidate policy for the ordinary-upload dynamic shadow.

This module deliberately contains no labels, target flags, or onset-error
truth.  It turns features available from the uploaded score and recording
into a shadow decision.  The caller must keep the production auto-decision
fail closed until a later release gate explicitly promotes this policy.

The causal-energy model is intentionally absent.  Its public evaluation
trained fold-local models and did not produce a frozen deployment artifact,
so energy remains review-only rather than silently changing this policy.
"""
from __future__ import annotations

import math
import statistics
from typing import Any


DYNAMIC_SHADOW_CONTRACT_VERSION = "western-ordinary-dynamic-shadow-candidate-v1"
DYNAMIC_SHADOW_POLICY_VERSION = "western-ordinary-dynamic-shadow-policy-v1"
DYNAMIC_SHADOW_TIMING_MODE = "basic-pitch-dtw"

# The first five thresholds are the frozen three-stage public confirmation
# point.  minEventDurationRatio is the development-selected guard that kept
# hard wrong/missing injections at 0/30 on both development and holdout.
DYNAMIC_SHADOW_POLICY: dict[str, float] = {
    "deviationLimit": 0.15,
    "minEventConfidence": 0.4,
    "minRelativeEventConfidence": 0.8,
    "minEventDurationSeconds": 0.08,
    "minSamePitchScoreDistanceQuarters": 0.5,
    "minEventDurationRatio": 0.15,
}

DYNAMIC_FEATURE_FIELDS = (
    "pitchDistanceSemitones",
    "eventConfidence",
    "relativeIoiDeviationRatio",
    "relativeEventConfidence",
    "eventDurationSeconds",
    "nearestSamePitchScoreDistanceQuarters",
    "expectedDurationSeconds",
    "eventDurationRatio",
)


def finite_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def empty_dynamic_features() -> dict[str, float | int | None]:
    return {field: None for field in DYNAMIC_FEATURE_FIELDS}


def _score_unit(note: dict[str, Any]) -> float | None:
    return finite_float(note.get("scoreUnit", note.get("scoreOnsetUnit")))


def _same_pitch_distances(notes: list[dict[str, Any]]) -> list[float | None]:
    by_pitch: dict[int, list[tuple[float, int]]] = {}
    for index, note in enumerate(notes):
        midi = finite_float(note.get("midi"))
        score_unit = _score_unit(note)
        if midi is None or score_unit is None:
            continue
        by_pitch.setdefault(int(round(midi)), []).append((score_unit, index))
    distances: list[float | None] = [None] * len(notes)
    for positions in by_pitch.values():
        positions.sort()
        for position_index, (score_unit, note_index) in enumerate(positions):
            candidates: list[float] = []
            if position_index > 0:
                candidates.append(max(0.0, score_unit - positions[position_index - 1][0]))
            if position_index + 1 < len(positions):
                candidates.append(max(0.0, positions[position_index + 1][0] - score_unit))
            distances[note_index] = min(candidates) if candidates else None
    return distances


def build_dynamic_candidate_features(
    notes: list[dict[str, Any]],
    assignments: list[dict[str, Any] | None],
    relative_ioi_features: list[dict[str, Any]],
) -> list[dict[str, float | int | None]]:
    """Build runtime-visible features without consulting any evaluation gold.

    Expected duration follows the already-evaluated injection protocol: the
    adjacent score-onset span is scaled by the frozen evaluator's sorted
    upper-middle seconds-per-quarter from adjacent aligned event pairs.  This
    preserves the meaning of the selected 0.15 duration-ratio guard.
    """

    if not (len(notes) == len(assignments) == len(relative_ioi_features)):
        raise ValueError("dynamic-shadow-feature-input-length-mismatch")

    tempo_samples: list[float] = []
    for index in range(len(notes) - 1):
        left, right = assignments[index], assignments[index + 1]
        left_score, right_score = _score_unit(notes[index]), _score_unit(notes[index + 1])
        if left is None or right is None or left_score is None or right_score is None:
            continue
        score_delta = right_score - left_score
        event_delta = finite_float(right.get("time"))
        left_time = finite_float(left.get("time"))
        if event_delta is None or left_time is None:
            continue
        event_delta -= left_time
        if score_delta > 1e-6 and event_delta > 0:
            tempo_samples.append(event_delta / score_delta)
    # Preserve the frozen injection evaluator exactly: for an even number of
    # samples it selected the upper middle value, not the arithmetic median.
    tempo_samples.sort()
    seconds_per_quarter = (
        tempo_samples[len(tempo_samples) // 2] if tempo_samples else None
    )
    same_pitch_distances = _same_pitch_distances(notes)

    rows: list[dict[str, float | int | None]] = []
    for index, (note, assignment, ioi) in enumerate(
        zip(notes, assignments, relative_ioi_features)
    ):
        row = empty_dynamic_features()
        row["nearestSamePitchScoreDistanceQuarters"] = same_pitch_distances[index]
        if assignment is None:
            rows.append(row)
            continue

        confidence = finite_float(assignment.get("confidence"))
        neighbor_confidences = [
            value
            for candidate_index in range(max(0, index - 2), min(len(assignments), index + 3))
            if candidate_index != index
            and assignments[candidate_index] is not None
            and (value := finite_float(assignments[candidate_index].get("confidence"))) is not None
        ]
        relative_confidence = (
            confidence / max(0.01, statistics.fmean(neighbor_confidences))
            if confidence is not None and neighbor_confidences
            else None
        )
        start = finite_float(assignment.get("time"))
        end = finite_float(assignment.get("end"))
        duration = max(0.0, end - start) if start is not None and end is not None else None

        current_score = _score_unit(note)
        adjacent_score = None
        if current_score is not None and index + 1 < len(notes):
            next_score = _score_unit(notes[index + 1])
            if next_score is not None:
                adjacent_score = next_score - current_score
        elif current_score is not None and index > 0:
            previous_score = _score_unit(notes[index - 1])
            if previous_score is not None:
                adjacent_score = current_score - previous_score
        expected_duration = (
            adjacent_score * seconds_per_quarter
            if adjacent_score and seconds_per_quarter is not None
            else None
        )
        duration_ratio = (
            duration / max(0.15, expected_duration)
            if duration is not None and expected_duration is not None and expected_duration > 0
            else None
        )

        row.update(
            {
                "pitchDistanceSemitones": (
                    int(round(value))
                    if (value := finite_float(assignment.get("pitchDistanceSemitones"))) is not None
                    else None
                ),
                "eventConfidence": round(confidence, 6) if confidence is not None else None,
                "relativeIoiDeviationRatio": (
                    round(value, 6)
                    if (value := finite_float(ioi.get("relativeIoiDeviationRatio"))) is not None
                    else None
                ),
                "relativeEventConfidence": (
                    round(relative_confidence, 6) if relative_confidence is not None else None
                ),
                "eventDurationSeconds": round(duration, 6) if duration is not None else None,
                "expectedDurationSeconds": (
                    round(expected_duration, 6) if expected_duration is not None else None
                ),
                "eventDurationRatio": round(duration_ratio, 6) if duration_ratio is not None else None,
            }
        )
        rows.append(row)
    return rows


def evaluate_dynamic_shadow(
    features: dict[str, Any],
    *,
    timing_mode: str = DYNAMIC_SHADOW_TIMING_MODE,
    policy: dict[str, float] = DYNAMIC_SHADOW_POLICY,
) -> dict[str, Any]:
    """Evaluate a shadow candidate and return a fail-closed audit decision."""

    blockers: list[str] = []
    if timing_mode != DYNAMIC_SHADOW_TIMING_MODE:
        blockers.append("timing-mode-not-basic-pitch-dtw")

    pitch_distance = finite_float(features.get("pitchDistanceSemitones"))
    if pitch_distance is None:
        blockers.append("pitch-distance-missing")
    elif pitch_distance != 0:
        blockers.append("pitch-distance-not-zero")

    checks = (
        ("eventConfidence", "minEventConfidence", "event-confidence"),
        ("relativeEventConfidence", "minRelativeEventConfidence", "relative-event-confidence"),
        ("eventDurationSeconds", "minEventDurationSeconds", "event-duration"),
        ("eventDurationRatio", "minEventDurationRatio", "event-duration-ratio"),
    )
    for field, threshold, reason in checks:
        value = finite_float(features.get(field))
        if value is None:
            blockers.append(f"{reason}-missing")
        elif value < policy[threshold]:
            blockers.append(f"{reason}-below-minimum")

    deviation = finite_float(features.get("relativeIoiDeviationRatio"))
    if deviation is None:
        blockers.append("relative-ioi-deviation-missing")
    elif deviation > policy["deviationLimit"]:
        blockers.append("relative-ioi-deviation-above-maximum")

    if "nearestSamePitchScoreDistanceQuarters" not in features:
        blockers.append("same-pitch-distance-missing")
    else:
        same_pitch = features.get("nearestSamePitchScoreDistanceQuarters")
        if same_pitch is not None:
            same_pitch_value = finite_float(same_pitch)
            if same_pitch_value is None:
                blockers.append("same-pitch-distance-invalid")
            elif same_pitch_value < policy["minSamePitchScoreDistanceQuarters"]:
                blockers.append("same-pitch-distance-below-minimum")

    return {"selected": not blockers, "blockingReasons": blockers}


def build_dynamic_shadow_evidence(
    features: dict[str, Any],
    *,
    timing_mode: str,
) -> dict[str, Any]:
    normalized = {field: features.get(field) for field in DYNAMIC_FEATURE_FIELDS}
    decision = evaluate_dynamic_shadow(features, timing_mode=timing_mode)
    return {
        "contractVersion": DYNAMIC_SHADOW_CONTRACT_VERSION,
        "policyVersion": DYNAMIC_SHADOW_POLICY_VERSION,
        "timingMode": timing_mode,
        "energyVetoIncluded": False,
        "causalEnergyStatus": "excluded-review-only",
        "selected": decision["selected"],
        "blockingReasons": decision["blockingReasons"],
        **normalized,
    }
