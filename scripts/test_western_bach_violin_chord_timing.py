from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_chord_timing.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_chord_timing", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinChordTimingTest(unittest.TestCase):
    def test_closest_pair_ignores_a_far_outlier(self) -> None:
        self.assertAlmostEqual(MODULE.shared_onset([1.0, 1.04, 4.0], "closest-pair"), 1.02)

    def test_chord_rule_propagates_one_onset_to_missing_chord_member(self) -> None:
        rows = [
            {"unit": "u", "scoreTime": "1", "goldTime": "2.0", "predTime": "2.1", "doubleStop": "True"},
            {"unit": "u", "scoreTime": "1", "goldTime": "2.0", "predTime": "", "doubleStop": "True"},
        ]
        adjusted = MODULE.apply_rule(rows, "closest-pair")
        self.assertEqual([row["adjustedPredTime"] for row in adjusted], [2.1, 2.1])
        self.assertTrue(all(row["chordTimingApplied"] for row in adjusted))

    def test_green_requires_precision_coverage_hit_median_and_p90(self) -> None:
        good = [
            {"adjustedAbsError": 0.05}
            for _ in range(9)
        ] + [{"adjustedAbsError": ""}]
        self.assertTrue(MODULE.summarize(good)["green"])
        bad = [{"adjustedAbsError": 0.4} for _ in range(10)]
        self.assertFalse(MODULE.summarize(bad)["green"])


if __name__ == "__main__":
    unittest.main()
