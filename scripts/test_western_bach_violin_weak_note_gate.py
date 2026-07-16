from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_weak_note_gate.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_weak_note_gate", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinWeakNoteGateTest(unittest.TestCase):
    def test_threshold_selection_requires_zero_unsafe_and_minimum_clean(self) -> None:
        examples = [
            *[
                {"label": 1, "strictAccepted": True}
                for _ in range(30)
            ],
            *[
                {"label": 0, "strictAccepted": True}
                for _ in range(5)
            ],
        ]
        probabilities = np.asarray([0.8] * 30 + [0.2] * 5, dtype=np.float64)
        selected = MODULE.choose_zero_unsafe_threshold(examples, probabilities)
        self.assertIsNotNone(selected)
        self.assertEqual(selected["cleanAutoPassCount"], 30)
        self.assertEqual(selected["unsafeWeakAutoPassCount"], 0)

    def test_threshold_selection_fails_when_classes_overlap(self) -> None:
        examples = [
            *[
                {"label": 1, "strictAccepted": True}
                for _ in range(30)
            ],
            {"label": 0, "strictAccepted": True},
        ]
        probabilities = np.asarray([0.8] * 30 + [0.9], dtype=np.float64)
        self.assertIsNone(
            MODULE.choose_zero_unsafe_threshold(examples, probabilities)
        )

    def test_safe_db_ratio_is_finite_at_silence(self) -> None:
        self.assertTrue(np.isfinite(MODULE.safe_db_ratio(0.0, 0.0)))

    def test_bounded_segment_uses_only_post_onset_samples(self) -> None:
        waveform = np.arange(20, dtype=np.float64)
        segment = MODULE.bounded_segment(waveform, 10, 0.3, 0.8)
        np.testing.assert_array_equal(segment, np.arange(3, 8, dtype=np.float64))


if __name__ == "__main__":
    unittest.main()
