from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/calibrate_western_bach_violin_musc_postprocessing.py"
SPEC = importlib.util.spec_from_file_location("western_bach_violin_musc_calibration", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class WesternBachViolinMuscCalibrationTest(unittest.TestCase):
    def test_grid_is_fixed_and_unique(self) -> None:
        grid = MODULE.candidate_grid()
        tags = [MODULE.postprocessing_tag(item) for item in grid]
        self.assertEqual(len(grid), 48)
        self.assertEqual(len(set(tags)), 48)

    def test_v2_and_v3_qualification_are_distinct(self) -> None:
        passing = {
            "50ms": {"precision": 0.90, "recall": 0.80},
            "100ms": {"precision": 0.90, "recall": 0.85},
        }
        self.assertTrue(MODULE.qualifies_v2(passing))
        self.assertTrue(MODULE.qualifies_v3(passing))
        failing = {
            "50ms": {"precision": 0.90, "recall": 0.79},
            "100ms": {"precision": 0.90, "recall": 0.85},
        }
        self.assertTrue(MODULE.qualifies_v2(failing))
        self.assertFalse(MODULE.qualifies_v3(failing))

    def test_rank_prefers_qualified_recall_then_conservative_duration(self) -> None:
        base = {
            "aggregate": {
                "50ms": {"recall": 0.80, "f1": 0.85},
                "100ms": {"recall": 0.90},
            },
            "v2Qualified": True,
            "v3Qualified": False,
        }
        short = {
            **base,
            "postprocessing": {
                "minimumNoteLengthMs": 60,
                "onsetThreshold": 0.5,
                "frameThreshold": 0.3,
            },
        }
        long = {
            **base,
            "postprocessing": {
                "minimumNoteLengthMs": 90,
                "onsetThreshold": 0.5,
                "frameThreshold": 0.3,
            },
        }
        self.assertGreater(MODULE.candidate_rank(long), MODULE.candidate_rank(short))


if __name__ == "__main__":
    unittest.main()
