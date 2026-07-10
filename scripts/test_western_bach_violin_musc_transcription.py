from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_musc_transcription.py"
SPEC = importlib.util.spec_from_file_location("western_bach_violin_musc", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class WesternBachViolinMuscTranscriptionTest(unittest.TestCase):
    def test_holdout_pilot_selects_one_unit_per_work(self) -> None:
        rows = [
            {
                "unit": "dev",
                "work": "A",
                "readyForEvalBenchmark": True,
                "benchmarkSplit": "development-reference-performer",
                "referenceNoteCount": 10,
                "referenceDoubleStopNoteCount": 0,
                "audio": {"durationSeconds": 1},
            },
            {
                "unit": "high-poly",
                "work": "A",
                "readyForEvalBenchmark": True,
                "benchmarkSplit": "holdout-unseen-performer",
                "referenceNoteCount": 10,
                "referenceDoubleStopNoteCount": 5,
                "audio": {"durationSeconds": 1},
            },
            {
                "unit": "low-poly",
                "work": "A",
                "readyForEvalBenchmark": True,
                "benchmarkSplit": "holdout-unseen-performer",
                "referenceNoteCount": 10,
                "referenceDoubleStopNoteCount": 0,
                "audio": {"durationSeconds": 2},
            },
            {
                "unit": "work-b",
                "work": "B",
                "readyForEvalBenchmark": True,
                "benchmarkSplit": "holdout-unseen-performer",
                "referenceNoteCount": 10,
                "referenceDoubleStopNoteCount": 0,
                "audio": {"durationSeconds": 3},
            },
        ]
        selected = MODULE.select_holdout_pilot(rows)
        self.assertEqual([row["unit"] for row in selected], ["low-poly", "work-b"])

    def test_musc_events_are_validated_and_sorted(self) -> None:
        raw = [
            (2.0, 2.5, 71, 0.8, np.asarray([0, 10])),
            (1.0, 1.2, 69, 0.7, np.asarray([-5, 5])),
        ]
        events = MODULE.normalize_musc_events(raw)
        self.assertEqual([event["midi"] for event in events], [69, 71])
        self.assertEqual(events[0]["pitchBendFrameCount"], 2)
        self.assertEqual(events[0]["maxAbsPitchBend"], 5.0)

    def test_invalid_musc_event_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "nonpositive-duration"):
            MODULE.normalize_musc_events([(1.0, 1.0, 69, 0.7, None)])

    def test_postprocessing_config_is_validated_and_tagged(self) -> None:
        config = MODULE.normalize_postprocessing(
            {"onsetThreshold": 0.5, "frameThreshold": 0.3, "minimumNoteLengthMs": 90}
        )
        self.assertEqual(MODULE.postprocessing_tag(config), "o050-f030-m0090")
        with self.assertRaisesRegex(ValueError, "invalid-onset"):
            MODULE.normalize_postprocessing(
                {"onsetThreshold": 0, "frameThreshold": 0.3, "minimumNoteLengthMs": 90}
            )

    def test_v2_and_v3_gates_are_distinct(self) -> None:
        passing = {
            "50ms": {"precision": 0.90, "recall": 0.80},
            "100ms": {"precision": 0.90, "recall": 0.85},
        }
        self.assertTrue(MODULE.v2_core_gate(passing)["passed"])
        self.assertTrue(MODULE.v3_core_gate(passing)["passed"])
        failing = {
            "50ms": {"precision": 0.89, "recall": 0.80},
            "100ms": {"precision": 0.90, "recall": 0.85},
        }
        self.assertTrue(MODULE.v2_core_gate(failing)["passed"])
        self.assertFalse(MODULE.v3_core_gate(failing)["passed"])

    def test_fresh_confirmation_performers_are_frozen(self) -> None:
        self.assertEqual(MODULE.FRESH_CORE_PERFORMERS, ("Oliver Colbentson",))
        rows = [
            {
                "unit": "oliver",
                "violinist": "Oliver Colbentson",
                "work": "A",
                "movement": "1",
                "readyForEvalBenchmark": True,
                "benchmarkSplit": "holdout-unseen-performer",
            },
            {
                "unit": "seen",
                "violinist": "John Garner",
                "work": "A",
                "movement": "2",
                "readyForEvalBenchmark": True,
                "benchmarkSplit": "holdout-unseen-performer",
            },
            {
                "unit": "silei",
                "violinist": "Silei Li",
                "work": "B",
                "movement": "1",
                "readyForEvalBenchmark": True,
                "benchmarkSplit": "holdout-unseen-performer",
            },
        ]
        self.assertEqual(
            [row["unit"] for row in MODULE.select_fresh_confirmation(rows)],
            ["oliver", "silei"],
        )


if __name__ == "__main__":
    unittest.main()
