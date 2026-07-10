from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf


SCRIPT = Path(__file__).resolve().parent / "experiments/prepare_western_phenicx_alignment.py"
SPEC = importlib.util.spec_from_file_location("western_phenicx_alignment_adapter", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class WesternPhenicxAlignmentAdapterTest(unittest.TestCase):
    def test_score_normalization_preserves_row_and_pitch_mapping(self) -> None:
        score = [
            {"onset": 1.0, "offset": 1.4, "midi": 67, "noteName": "G4"},
            {"onset": 0.9, "offset": 0.9, "midi": 69, "noteName": "A4"},
            {"onset": 1.5, "offset": 1.8, "midi": 71, "noteName": "B4"},
        ]
        gold = [
            {"onset": 2.0, "offset": 2.4, "midi": 67, "noteName": "G4"},
            {"onset": 2.1, "offset": 2.2, "midi": 69, "noteName": "A4"},
            {"onset": 2.5, "offset": 2.8, "midi": 71, "noteName": "B4"},
        ]
        rows, stats = MODULE.normalize_score_timeline(score, gold)
        self.assertEqual([row["midi"] for row in rows], [67, 69, 71])
        self.assertEqual([row["rowIndex"] for row in rows], [0, 1, 2])
        self.assertEqual(rows[1]["normalizedScoreOnset"], 1.0)
        self.assertGreater(rows[1]["normalizedScoreOffset"], 1.0)
        self.assertEqual(stats["backwardOnsetAdjustmentCount"], 1)
        self.assertEqual(stats["zeroDurationRepairCount"], 1)

    def test_mixer_is_finite_peak_limited_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            sample_rate = 8000
            time = np.arange(sample_rate, dtype=np.float32) / sample_rate
            first = 0.2 * np.sin(2 * np.pi * 440.0 * time)
            second = 0.1 * np.sin(2 * np.pi * 660.0 * time)
            first_path = root / "violin1.wav"
            second_path = root / "violin2.wav"
            sf.write(first_path, first, sample_rate, subtype="PCM_16")
            sf.write(second_path, second, sample_rate, subtype="PCM_16")
            output_a = root / "mix-a.wav"
            output_b = root / "mix-b.wav"
            report_a = MODULE.mix_violin_tracks([first_path, second_path], output_a)
            report_b = MODULE.mix_violin_tracks([first_path, second_path], output_b)
        self.assertTrue(report_a["finite"])
        self.assertEqual(report_a["clippingSampleCount"], 0)
        self.assertLessEqual(report_a["renderedPeak"], 0.951)
        self.assertGreaterEqual(report_a["renderedPeak"], 0.90)
        self.assertEqual(report_a["outputSha256"], report_b["outputSha256"])

    def test_pitch_mismatch_fails_before_mapping(self) -> None:
        score = [{"onset": 0.0, "offset": 1.0, "midi": 67, "noteName": "G4"}]
        gold = [{"onset": 0.0, "offset": 1.0, "midi": 69, "noteName": "A4"}]
        with self.assertRaisesRegex(ValueError, "pitch-sequence"):
            MODULE.normalize_score_timeline(score, gold)


if __name__ == "__main__":
    unittest.main()
