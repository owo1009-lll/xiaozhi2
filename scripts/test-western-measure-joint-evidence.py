from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_measure_joint_evidence import evaluate_measure_rows  # noqa: E402


def rows(*, weak_target: bool = False, pitch_conflict: bool = False) -> list[dict]:
    result = []
    for index in range(5):
        result.append({
            "unit": "u",
            "noteIndex": index,
            "target": weak_target and index == 4,
            "pitchDistanceSemitones": 1 if pitch_conflict and index == 2 else 0,
            "eventConfidence": 0.9,
            "relativeIoiDeviationRatio": 0.0,
            "eventDurationSeconds": 0.5,
            "relativeEventConfidence": 1.2,
            "nearestSamePitchScoreDistanceQuarters": 2.0,
        })
    return result


POINT = {
    "deviationLimit": 0.15,
    "minEventConfidence": 0.4,
    "minRelativeEventConfidence": 0.8,
    "minEventDurationSeconds": 0.08,
    "minSamePitchScoreDistanceQuarters": 0.5,
}
LOOKUP = {("u", index): 1 for index in range(5)}
IOI = {("u", index) for index in range(5)}


def test_weak_energy_blocks_measure_without_using_target_in_decision() -> None:
    probabilities = {("u", index): 1.0 for index in range(5)}
    probabilities[("u", 4)] = 0.0
    strict = evaluate_measure_rows(
        rows=rows(weak_target=True),
        measure_lookup=LOOKUP,
        ioi_opportunities=IOI,
        dynamic_point=POINT,
        energy_probabilities=probabilities,
        note_confirmed_threshold=0.8,
        ioi_consistency_threshold=0.8,
        energy_support_threshold=1.0,
    )
    assert strict["autoPassMeasureCount"] == 0
    assert strict["unsafeTargetMeasureCount"] == 0
    loose = evaluate_measure_rows(
        rows=rows(weak_target=True),
        measure_lookup=LOOKUP,
        ioi_opportunities=IOI,
        dynamic_point=POINT,
        energy_probabilities=probabilities,
        note_confirmed_threshold=0.8,
        ioi_consistency_threshold=0.8,
        energy_support_threshold=0.8,
    )
    assert loose["autoPassMeasureCount"] == 1
    assert loose["unsafeTargetMeasureCount"] == 1


def test_explicit_pitch_conflict_always_vetoes_green_measure() -> None:
    probabilities = {("u", index): 1.0 for index in range(5)}
    result = evaluate_measure_rows(
        rows=rows(pitch_conflict=True),
        measure_lookup=LOOKUP,
        ioi_opportunities=IOI,
        dynamic_point=POINT,
        energy_probabilities=probabilities,
        note_confirmed_threshold=0.3,
        ioi_consistency_threshold=0.5,
        energy_support_threshold=0.7,
    )
    assert result["autoPassMeasureCount"] == 0


if __name__ == "__main__":
    test_weak_energy_blocks_measure_without_using_target_in_decision()
    test_explicit_pitch_conflict_always_vetoes_green_measure()
    print("western measure joint-evidence tests passed")
