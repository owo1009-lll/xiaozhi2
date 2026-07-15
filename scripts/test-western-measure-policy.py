from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_bach_violin_measure_policy import measure_policy_metrics  # noqa: E402


def test_eighty_percent_can_hide_one_bad_note() -> None:
    rows = [
        {"unit": "u", "measureIndex": 1, "noteIndex": index}
        for index in range(5)
    ]
    accepted = {("u", index) for index in range(4)}
    targets = {("u", 4)}
    loose = measure_policy_metrics(rows, accepted, targets, 0.80)
    assert loose["autoPassMeasureCount"] == 1
    assert loose["unsafeTargetMeasureCount"] == 1
    strict = measure_policy_metrics(rows, accepted, targets, 1.00)
    assert strict["autoPassMeasureCount"] == 0
    assert strict["unsafeTargetMeasureCount"] == 0


def test_event_confidence_floor_is_runtime_visible_and_fail_closed() -> None:
    rows = [
        {"unit": "u", "measureIndex": 1, "noteIndex": index}
        for index in range(4)
    ]
    accepted = {("u", index) for index in range(4)}
    evidence = {
        ("u", index): {"eventConfidence": confidence}
        for index, confidence in enumerate((0.90, 0.85, 0.80, 0.55))
    }
    target = {("u", 3)}
    baseline = measure_policy_metrics(rows, accepted, target, 1.00)
    assert baseline["unsafeTargetMeasureCount"] == 1
    guarded = measure_policy_metrics(
        rows,
        accepted,
        target,
        1.00,
        evidence,
        0.65,
    )
    assert guarded["autoPassMeasureCount"] == 0
    assert guarded["unsafeTargetMeasureCount"] == 0
    assert guarded["minEventConfidence"] == 0.65


if __name__ == "__main__":
    test_eighty_percent_can_hide_one_bad_note()
    test_event_confidence_floor_is_runtime_visible_and_fail_closed()
    print("western measure-policy tests passed")
