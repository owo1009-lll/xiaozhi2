from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_raw_audio_perturbations.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_raw_audio_perturbations", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinRawAudioPerturbationTest(unittest.TestCase):
    def test_missing_note_keeps_length_and_reduces_target_energy(self) -> None:
        sr = 1000
        waveform = np.ones(3000, dtype=np.float32) * 0.5
        target = {"goldTime": 1.0, "goldOffset": 1.4}
        mutated = MODULE.mutate_waveform(waveform, sr, [target], "missing-note")
        self.assertEqual(len(mutated), len(waveform))
        self.assertLess(float(np.mean(np.abs(mutated[1050:1350]))), 0.01)
        self.assertAlmostEqual(float(mutated[100]), 0.5, places=5)

    def test_wrong_pitch_mutation_keeps_shape_and_finite_values(self) -> None:
        sr = 4000
        time = np.arange(sr * 2) / sr
        waveform = (0.2 * np.sin(2 * np.pi * 440.0 * time)).astype(np.float32)
        target = {"goldTime": 0.5, "goldOffset": 1.0}
        mutated = MODULE.mutate_waveform(waveform, sr, [target], "wrong-pitch-plus2")
        self.assertEqual(mutated.shape, waveform.shape)
        self.assertTrue(np.isfinite(mutated).all())
        self.assertGreater(float(np.max(np.abs(mutated - waveform))), 0.01)

    def test_mutation_window_covers_early_observed_attack(self) -> None:
        targets = [
            {
                "unit": "unit",
                "midi": 72,
                "predictedTime": 0.9,
                "goldTime": 1.0,
                "goldOffset": 1.2,
            }
        ]
        events = {
            "unit": [
                {"start": 0.9, "end": 1.1, "midi": 72, "confidence": 0.8}
            ]
        }
        MODULE.attach_mutation_windows(targets, events, support_threshold=0.30)
        self.assertEqual(targets[0]["mutationStart"], 0.9)
        self.assertEqual(targets[0]["mutationEnd"], 1.2)
        self.assertTrue(targets[0]["mutationEventFound"])

    def test_strict_policy_rejects_low_confidence_target_event(self) -> None:
        rows = {
            "unit": [
                {
                    "unit": "unit",
                    "benchmarkSplit": "holdout-unseen-performer",
                    "noteIndex": 0,
                    "midi": 69,
                    "predictedTime": 1.0,
                    "goldTime": 1.0,
                }
            ]
        }
        events = {
            "unit": [
                {"start": 1.0, "end": 1.2, "midi": 69, "confidence": 0.39}
            ]
        }
        accepted = MODULE.strict_accepted_rows(
            "holdout-unseen-performer",
            rows,
            events,
            center_threshold=0.01,
            neighbor_threshold=0.30,
            neighbor_radius=0,
            min_target_confidence=0.40,
            score_isolation_seconds=0.30,
        )
        self.assertEqual(accepted, [])

    def test_strict_policy_rejects_event_shared_by_repeated_score_pitch(self) -> None:
        rows = {
            "unit": [
                {
                    "unit": "unit",
                    "benchmarkSplit": "holdout-unseen-performer",
                    "noteIndex": 0,
                    "midi": 69,
                    "predictedTime": 1.0,
                    "goldTime": 1.0,
                },
                {
                    "unit": "unit",
                    "benchmarkSplit": "holdout-unseen-performer",
                    "noteIndex": 1,
                    "midi": 69,
                    "predictedTime": 1.2,
                    "goldTime": 1.2,
                },
            ]
        }
        events = {
            "unit": [
                {"start": 1.0, "end": 1.3, "midi": 69, "confidence": 0.8}
            ]
        }
        accepted = MODULE.strict_accepted_rows(
            "holdout-unseen-performer",
            rows,
            events,
            center_threshold=0.01,
            neighbor_threshold=0.30,
            neighbor_radius=0,
            min_target_confidence=0.40,
            score_isolation_seconds=0.30,
        )
        self.assertEqual(accepted, [])


if __name__ == "__main__":
    unittest.main()
