from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_basic_pitch_transcription.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_basic_pitch_transcription", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinBasicPitchTranscriptionTest(unittest.TestCase):
    def test_count_metrics_include_precision_recall_and_f1(self) -> None:
        metrics = MODULE.metrics_from_counts(10, 8, 6)
        self.assertAlmostEqual(metrics["precision"], 0.75)
        self.assertAlmostEqual(metrics["recall"], 0.6)
        self.assertAlmostEqual(metrics["f1"], 2 * 0.75 * 0.6 / 1.35)

    def test_direct_match_uses_pitch_and_onset_without_parangonar(self) -> None:
        reference = [
            {"goldTime": "1.0", "goldOffset": "1.5", "midi": "69", "doubleStop": "False"},
            {"goldTime": "2.0", "goldOffset": "2.5", "midi": "71", "doubleStop": "False"},
        ]
        events = [
            {"start": 1.03, "end": 1.4, "midi": 69},
            {"start": 2.02, "end": 2.4, "midi": 72},
        ]
        result = MODULE.evaluate_unit(reference, events)
        self.assertEqual(result["byOnsetTolerance"]["50ms"]["matchedNotes"], 1)
        self.assertAlmostEqual(result["byOnsetTolerance"]["50ms"]["precision"], 0.5)

    def test_empty_event_list_is_a_valid_zero_prediction_case(self) -> None:
        reference = [
            {"goldTime": "1.0", "goldOffset": "1.5", "midi": "69", "doubleStop": "False"},
        ]
        result = MODULE.evaluate_unit(reference, [])
        self.assertEqual(result["byOnsetTolerance"]["300ms"]["matchedNotes"], 0)
        self.assertEqual(result["byOnsetTolerance"]["300ms"]["recall"], 0.0)

    def test_overlapping_same_pitch_events_are_merged(self) -> None:
        events = [
            {"start": 1.0, "end": 1.2, "midi": 69, "confidence": 0.5},
            {"start": 1.15, "end": 1.4, "midi": 69, "confidence": 0.8},
            {"start": 1.1, "end": 1.3, "midi": 71, "confidence": 0.7},
        ]
        merged = MODULE.merge_overlapping_same_pitch(events)
        self.assertEqual(len(merged), 2)
        a4 = next(event for event in merged if event["midi"] == 69)
        self.assertEqual(a4["end"], 1.4)
        self.assertEqual(a4["confidence"], 0.8)


if __name__ == "__main__":
    unittest.main()
