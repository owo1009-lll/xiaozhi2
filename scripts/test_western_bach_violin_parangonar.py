from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_parangonar.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_parangonar", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinParangonarTest(unittest.TestCase):
    def test_build_notes_preserves_score_axis_gold_and_double_stop(self) -> None:
        notes = MODULE.build_notes(
            "piece",
            [
                {
                    "referenceNoteIndex": 3,
                    "globalQuarterOffset": 1.5,
                    "referenceTime": 2.25,
                    "midi": 69,
                    "doubleStop": True,
                }
            ],
        )
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0].idx, 3)
        self.assertEqual(notes[0].score_time, 1.5)
        self.assertEqual(notes[0].gold_time, 2.25)
        self.assertTrue(notes[0].double_stop)

    def test_summary_counts_missing_predictions_against_total_gold(self) -> None:
        summary = MODULE.summarize_rows(
            [
                {"absError": 0.05, "doubleStop": False, "midi": 69, "predictedMidi": 69},
                {"absError": 0.25, "doubleStop": True, "midi": 71, "predictedMidi": 72},
                {"absError": "", "doubleStop": True, "midi": 74, "predictedMidi": ""},
            ]
        )
        self.assertAlmostEqual(summary["coverage"], 2 / 3)
        self.assertAlmostEqual(summary["hitAt300ms"], 2 / 3)
        self.assertEqual(summary["grade"], "red")
        agreement = summary["scoreMatchedEventPitchAgreement"]
        self.assertAlmostEqual(agreement["exactSemitoneAccuracyAmongMatched"], 0.5)
        self.assertAlmostEqual(agreement["withinOneSemitoneAccuracyOverGold"], 2 / 3)
        self.assertTrue(agreement["notIndependentRecognitionMetric"])


if __name__ == "__main__":
    unittest.main()
