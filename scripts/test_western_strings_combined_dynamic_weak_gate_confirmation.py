from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments/eval_western_strings_combined_dynamic_weak_gate_confirmation.py"
)
SPEC = importlib.util.spec_from_file_location("combined_dynamic_weak_confirmation", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def metrics(coverage: float, *, unsafe: int = 0, precision: float = 0.98) -> dict:
    return {
        "clean": {
            "selectedCount": 100,
            "precisionWithin300ms": precision,
            "coverage": coverage,
            "targetCount": 32,
        },
        "allErrorUnsafeTargetAutoPassCount": unsafe,
    }


class CombinedDynamicWeakConfirmationTest(unittest.TestCase):
    def test_joint_selection_maximizes_worst_fold_coverage(self) -> None:
        selected = MODULE.choose_joint_policy(
            [
                {
                    "point": {"id": "a"},
                    "development": metrics(0.50),
                    "selection": metrics(0.25),
                },
                {
                    "point": {"id": "b"},
                    "development": metrics(0.40),
                    "selection": metrics(0.35),
                },
                {
                    "point": {"id": "unsafe"},
                    "development": metrics(0.80, unsafe=1),
                    "selection": metrics(0.80),
                },
            ]
        )
        self.assertEqual(selected["point"]["id"], "b")

    def test_filter_fold_removes_overlap_units(self) -> None:
        fold = {
            "keys": [("fresh", 1), ("overlap", 2)],
            "cleanFeatures": np.asarray([[1.0], [2.0]]),
            "weakFeatures": np.asarray([[3.0], [4.0]]),
            "dynamicRows": {
                "clean": [{"unit": "fresh"}, {"unit": "overlap"}],
            },
        }
        filtered = MODULE.filter_fold_units(fold, {"fresh"})
        self.assertEqual(filtered["keys"], [("fresh", 1)])
        self.assertEqual(filtered["cleanFeatures"].tolist(), [[1.0]])
        self.assertEqual(filtered["dynamicRows"]["clean"], [{"unit": "fresh"}])

    def test_confirmation_requires_coverage_and_zero_unsafe(self) -> None:
        self.assertTrue(MODULE.confirmation_passed(metrics(0.36), 4))
        self.assertFalse(MODULE.confirmation_passed(metrics(0.19), 4))
        self.assertFalse(MODULE.confirmation_passed(metrics(0.36, unsafe=1), 4))


if __name__ == "__main__":
    unittest.main()
