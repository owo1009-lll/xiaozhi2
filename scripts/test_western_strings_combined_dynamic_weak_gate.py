from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments/eval_western_strings_combined_dynamic_weak_gate.py"
)
SPEC = importlib.util.spec_from_file_location("combined_dynamic_weak_gate", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class CombinedDynamicWeakGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.point = {
            "deviationLimit": 0.2,
            "minEventConfidence": 0.6,
            "minRelativeEventConfidence": 0.5,
            "minEventDurationSeconds": 0.1,
        }

    def row(self, **overrides: object) -> dict[str, object]:
        row: dict[str, object] = {
            "unit": "unit-a",
            "noteIndex": 1,
            "pitchDistanceSemitones": 0,
            "eventConfidence": 0.8,
            "relativeIoiDeviationRatio": 0.1,
            "relativeEventConfidence": 0.7,
            "eventDurationSeconds": 0.2,
            "onsetErrorSeconds": 0.05,
            "target": False,
        }
        row.update(overrides)
        return row

    def test_dynamic_selection_requires_every_signal(self) -> None:
        self.assertTrue(MODULE.dynamic_selected(self.row(), self.point))
        self.assertFalse(
            MODULE.dynamic_selected(
                self.row(relativeEventConfidence=0.4),
                self.point,
            )
        )

    def test_energy_gate_can_only_veto_dynamic_selection(self) -> None:
        rows = [
            self.row(noteIndex=1),
            self.row(noteIndex=2, relativeIoiDeviationRatio=0.4),
        ]
        metrics = MODULE.combined_metrics(
            rows,
            {("unit-a", 1): 0.9, ("unit-a", 2): 0.9},
            self.point,
            0.8,
        )
        self.assertEqual(metrics["selectedCount"], 1)
        self.assertEqual(metrics["correctWithin300msCount"], 1)

    def test_unmatched_note_remains_in_coverage_denominator(self) -> None:
        rows = [self.row(), self.row(noteIndex=2, eventConfidence=None)]
        metrics = MODULE.combined_metrics(
            rows,
            {("unit-a", 1): 0.9, ("unit-a", 2): 0.9},
            self.point,
            0.8,
        )
        self.assertEqual(metrics["noteCount"], 2)
        self.assertEqual(metrics["selectedCount"], 1)
        self.assertEqual(metrics["coverage"], 0.5)

    def test_weak_target_selected_by_both_gates_is_unsafe(self) -> None:
        rows = [self.row(target=True)]
        metrics = MODULE.combined_metrics(
            rows,
            {("unit-a", 1): 0.9},
            self.point,
            0.8,
        )
        self.assertEqual(metrics["targetCount"], 1)
        self.assertEqual(metrics["unsafeTargetAutoPassCount"], 1)

    def test_energy_intersection_requires_every_model(self) -> None:
        probabilities = MODULE.intersection_probabilities(
            [("unit-a", 1), ("unit-a", 2)],
            {
                "a": {("unit-a", 1): 0.9, ("unit-a", 2): 0.9},
                "b": {("unit-a", 1): 0.8, ("unit-a", 2): 0.4},
            },
            {"a": 0.7, "b": 0.7},
        )
        self.assertEqual(probabilities[("unit-a", 1)], 1.0)
        self.assertEqual(probabilities[("unit-a", 2)], 0.0)


if __name__ == "__main__":
    unittest.main()
