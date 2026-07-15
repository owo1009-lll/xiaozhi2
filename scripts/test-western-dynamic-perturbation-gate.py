from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_dynamic_perturbation_gate import (  # noqa: E402
    evaluate_scenario,
    feature_gate_metrics,
    select_development_threshold,
    select_joint_safety_point,
)


def events(target_time: float = 2.0, target_midi: int = 62, target_confidence: float = 0.9, missing: bool = False):
    output = []
    for index, midi in enumerate((60, 61, 62, 63, 64)):
        if index == 2 and missing:
            continue
        output.append(
            {
                "start": target_time if index == 2 else float(index),
                "end": (target_time if index == 2 else float(index)) + 0.5,
                "midi": target_midi if index == 2 else midi,
                "confidence": target_confidence if index == 2 else 0.9,
            }
        )
    return output


def main() -> int:
    rows = [
        {
            "unit": "u1",
            "noteIndex": index,
            "midi": 60 + index,
            "scoreTime": float(index),
            "goldTime": float(index),
        }
        for index in range(5)
    ]
    grouped = {"u1": rows}
    targets = [{"unit": "u1", "noteIndex": 2}]
    clean = evaluate_scenario(grouped, targets, {"u1": events()}, deviation_limit=0.2, min_event_confidence=0.4)
    assert clean["selectedCount"] == 3
    assert clean["precisionWithin300ms"] == 1.0
    assert clean["targetSelectedCount"] == 1
    assert clean["rows"][2]["eventDurationSeconds"] == 0.5
    late = evaluate_scenario(grouped, targets, {"u1": events(target_time=2.8)}, deviation_limit=0.2, min_event_confidence=0.4)
    assert late["targetSelectedCount"] == 0
    wrong = evaluate_scenario(grouped, targets, {"u1": events(target_midi=70)}, deviation_limit=0.2, min_event_confidence=0.4)
    assert wrong["targetSelectedCount"] == 0
    missing = evaluate_scenario(grouped, targets, {"u1": events(missing=True)}, deviation_limit=0.2, min_event_confidence=0.4)
    assert missing["targetSelectedCount"] == 0
    weak = evaluate_scenario(
        grouped,
        targets,
        {"u1": events(target_confidence=0.2)},
        deviation_limit=0.2,
        min_event_confidence=0.4,
    )
    assert weak["targetSelectedCount"] == 0
    feature_rows = [
        {
            "target": False,
            "pitchDistanceSemitones": 0,
            "eventConfidence": 0.8,
            "eventDurationSeconds": 0.5,
            "relativeEventConfidence": 1.2,
            "relativeIoiDeviationRatio": 0.05,
            "onsetErrorSeconds": 0.02,
        },
        {
            "target": True,
            "pitchDistanceSemitones": 0,
            "eventConfidence": 0.6,
            "eventDurationSeconds": 0.5,
            "relativeEventConfidence": 0.8,
            "relativeIoiDeviationRatio": 0.05,
            "onsetErrorSeconds": 0.02,
        },
    ]
    feature_metrics = feature_gate_metrics(
        feature_rows,
        deviation_limit=0.1,
        min_event_confidence=0.5,
        min_relative_event_confidence=1.1,
        min_event_duration=0.08,
    )
    assert feature_metrics["selectedCount"] == 1
    assert feature_metrics["unsafeTargetAutoPassCount"] == 0
    selected = select_development_threshold(
        [
            {
                "deviationLimit": 0.1,
                "clean": {"selectedCount": 35, "precisionWithin300ms": 0.95, "coverage": 0.25},
                "coreUnsafeTargetAutoPassCount": 0,
            },
            {
                "deviationLimit": 0.2,
                "clean": {"selectedCount": 45, "precisionWithin300ms": 0.95, "coverage": 0.35},
                "coreUnsafeTargetAutoPassCount": 1,
            },
        ]
    )
    assert selected and selected["deviationLimit"] == 0.1
    joint = select_joint_safety_point(
        [
            {
                "clean": {"selectedCount": 35, "precisionWithin300ms": 0.95, "coverage": 0.15},
                "allErrorUnsafeTargetAutoPassCount": 0,
            },
            {
                "clean": {"selectedCount": 45, "precisionWithin300ms": 0.95, "coverage": 0.25},
                "allErrorUnsafeTargetAutoPassCount": 1,
            },
        ]
    )
    assert joint and joint["clean"]["coverage"] == 0.15
    print("western dynamic perturbation gate tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
