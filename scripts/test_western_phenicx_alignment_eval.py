from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_phenicx_alignment.py"
SPEC = importlib.util.spec_from_file_location("western_phenicx_alignment_eval", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def result_row(error: float | None, *, polyphonic: bool = False) -> dict:
    return {
        "absError": "" if error is None else error,
        "polyphonic": polyphonic,
    }


class WesternPhenicxAlignmentEvalTest(unittest.TestCase):
    def test_summary_counts_missing_predictions_in_coverage_and_hit_rate(self) -> None:
        summary = MODULE.summarize_rows(
            [result_row(0.05), result_row(0.20), result_row(0.60), result_row(None)]
        )
        self.assertEqual(summary["goldNotes"], 4)
        self.assertEqual(summary["validPredictions"], 3)
        self.assertEqual(summary["coverage"], 0.75)
        self.assertEqual(summary["precisionWithin300msAmongPredictions"], 2 / 3)
        self.assertEqual(summary["hitAt300ms"], 0.5)

    def test_gate_requires_all_four_metrics(self) -> None:
        passing = {
            "medianOnsetError": 0.10,
            "p90OnsetError": 0.40,
            "hitAt300ms": 0.85,
            "coverage": 0.80,
        }
        self.assertTrue(MODULE.evaluate_gate(passing)["passed"])
        for key in passing:
            failing = dict(passing)
            if key in ("medianOnsetError", "p90OnsetError"):
                failing[key] = MODULE.GATE[
                    "medianOnsetErrorMaxExclusive"
                    if key == "medianOnsetError"
                    else "p90OnsetErrorMaxExclusive"
                ]
            else:
                failing[key] = passing[key] - 0.01
            self.assertFalse(MODULE.evaluate_gate(failing)["passed"], key)

    def test_selection_uses_development_metrics(self) -> None:
        reports = {
            "dev-winner": {
                "development": {
                    "medianOnsetError": 0.05,
                    "p90OnsetError": 0.20,
                    "hitAt300ms": 0.90,
                    "coverage": 0.90,
                },
                "holdout": {
                    "medianOnsetError": 10.0,
                    "p90OnsetError": 10.0,
                    "hitAt300ms": 0.0,
                    "coverage": 0.0,
                },
            },
            "holdout-winner": {
                "development": {
                    "medianOnsetError": 0.20,
                    "p90OnsetError": 0.60,
                    "hitAt300ms": 0.70,
                    "coverage": 0.90,
                },
                "holdout": {
                    "medianOnsetError": 0.01,
                    "p90OnsetError": 0.02,
                    "hitAt300ms": 1.0,
                    "coverage": 1.0,
                },
            },
        }
        self.assertEqual(MODULE.select_method(reports), "dev-winner")

    def test_selection_preserves_zero_error_as_best_value(self) -> None:
        reports = {
            "zero-error": {
                "development": {
                    "medianOnsetError": 0.0,
                    "p90OnsetError": 0.0,
                    "hitAt300ms": 1.0,
                    "coverage": 1.0,
                }
            },
            "nonzero-error": {
                "development": {
                    "medianOnsetError": 0.01,
                    "p90OnsetError": 0.02,
                    "hitAt300ms": 1.0,
                    "coverage": 1.0,
                }
            },
        }
        self.assertEqual(MODULE.select_method(reports), "zero-error")

    def test_parangonar_score_array_uses_adapter_durations(self) -> None:
        rows = [
            {
                "normalizedScoreOnset": 1.0,
                "normalizedScoreOffset": 1.75,
                "midi": 69,
            }
        ]
        score = MODULE.score_array_for_parangonar(rows)
        self.assertAlmostEqual(float(score[0]["onset_beat"]), 1.0)
        self.assertAlmostEqual(float(score[0]["duration_beat"]), 0.75)
        self.assertFalse(bool(score[0]["is_grace"]))

    def test_fallback_only_fills_missing_primary_predictions(self) -> None:
        self.assertEqual(
            MODULE.fill_missing_predictions([1.0, None, 3.0], [9.0, 2.0, 9.0]),
            [1.0, 2.0, 3.0],
        )

    def test_chord_consensus_uses_earliest_available_onset(self) -> None:
        rows = [
            {"normalizedScoreOnset": 1.0},
            {"normalizedScoreOnset": 1.0},
            {"normalizedScoreOnset": 1.0},
            {"normalizedScoreOnset": 2.0},
        ]
        self.assertEqual(
            MODULE.apply_earliest_chord_onset_consensus(
                rows, [None, 1.25, 9.0, 4.0]
            ),
            [1.25, 1.25, 1.25, 4.0],
        )

    def test_chord_consensus_rejects_prediction_count_mismatch(self) -> None:
        with self.assertRaisesRegex(ValueError, "chord-consensus-prediction-count-mismatch"):
            MODULE.apply_earliest_chord_onset_consensus(
                [{"normalizedScoreOnset": 1.0}], []
            )


if __name__ == "__main__":
    unittest.main()
