from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_bach_violin_gate_pilot.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_gate_pilot", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class BachViolinGatePilotTest(unittest.TestCase):
    def test_selection_uses_one_public_domain_row_per_work(self) -> None:
        rows = [
            {"unit": "a-hard", "work": "BWV1001", "license": "PD", "readyForEvalBenchmark": True, "referenceDoubleStopNoteCount": 10, "referenceNoteCount": 20, "audio": {"durationSeconds": 10}},
            {"unit": "a-easy", "work": "BWV1001", "license": "PD", "readyForEvalBenchmark": True, "referenceDoubleStopNoteCount": 1, "referenceNoteCount": 20, "audio": {"durationSeconds": 20}},
            {"unit": "b", "work": "BWV1002", "license": "PD", "readyForEvalBenchmark": True, "referenceDoubleStopNoteCount": 0, "referenceNoteCount": 20, "audio": {"durationSeconds": 30}},
            {"unit": "cc", "work": "BWV1003", "license": "CC BY", "readyForEvalBenchmark": True, "referenceDoubleStopNoteCount": 0, "referenceNoteCount": 20, "audio": {"durationSeconds": 5}},
        ]
        selected = MODULE.select_pilot_units(rows, 6)
        self.assertEqual([row["unit"] for row in selected], ["a-easy", "b"])

    def test_all_eval_selection_keeps_non_pd_rows_and_respects_limit(self) -> None:
        rows = [
            {"unit": "b", "work": "BWV1002", "movement": "2", "violinist": "B", "license": "CC BY", "readyForEvalBenchmark": True},
            {"unit": "a", "work": "BWV1001", "movement": "1", "violinist": "A", "license": "PD", "readyForEvalBenchmark": True},
            {"unit": "bad", "work": "BWV1000", "license": "PD", "readyForEvalBenchmark": False},
        ]
        self.assertEqual(
            [row["unit"] for row in MODULE.select_all_eval_units(rows)],
            ["a", "b"],
        )
        self.assertEqual(
            [row["unit"] for row in MODULE.select_all_eval_units(rows, 1)],
            ["a"],
        )

    def test_summary_requires_precision_coverage_and_minimum_selected(self) -> None:
        unit = {
            "ok": True,
            "work": "BWV1001",
            "confidenceMetricsEvaluable": True,
            "rows": [
                {"selected": True, "correctWithin300ms": True, "absoluteOnsetErrorSeconds": 0.1}
                for _ in range(10)
            ] + [
                {"selected": False, "correctWithin300ms": False, "absoluteOnsetErrorSeconds": 1.0}
                for _ in range(30)
            ],
        }
        second = {**unit, "work": "BWV1002"}
        metrics = MODULE.summarize_units([unit, second])
        self.assertTrue(metrics["readyToExpandExternalEval"])
        self.assertFalse(metrics["releaseEligible"])
        self.assertEqual(metrics["allCandidateCorrectWithin300msCount"], 20)
        self.assertEqual(metrics["allCandidateCorrectWithin300msRate"], 0.25)

    def test_score_pitch_start_uses_first_score_onset_without_reference_time(self) -> None:
        times = np.arange(0.0, 3.0, 0.1)
        midi = np.full(times.shape, np.nan)
        midi[12:15] = [69.1, 69.0, 69.2]
        notes = [
            {"scoreOnsetTick": 0, "midi": 69},
            {"scoreOnsetTick": 24, "midi": 71},
        ]
        detected = MODULE.detect_score_pitch_start(times, midi, notes)
        self.assertAlmostEqual(detected, 1.2)

    def test_score_pitch_start_accepts_octave_equivalence_only_for_anchor_search(self) -> None:
        times = np.arange(0.0, 2.0, 0.1)
        midi = np.full(times.shape, np.nan)
        midi[9:12] = [55.1, 55.0, 55.2]
        detected = MODULE.detect_score_pitch_start(times, midi, [{"scoreOnsetTick": 0, "midi": 79}])
        self.assertAlmostEqual(detected, 0.9)

    def test_violin_activity_start_rejects_low_frequency_noise(self) -> None:
        times = np.arange(0.0, 2.0, 0.1)
        midi = np.full(times.shape, np.nan)
        midi[1:5] = 36.0
        midi[9:13] = 55.0
        detected = MODULE.detect_violin_activity_start(times, midi)
        self.assertAlmostEqual(detected, 0.9)

    def test_shifted_decision_preserves_default_and_supports_audio_start(self) -> None:
        notes = [{"noteId": "n1", "sectionId": "s", "sectionTitle": "", "midi": 69, "scoreUnit": 0.0, "position": {"measureIndex": 1}}]
        times = np.asarray([0.0, 1.0, 1.1])
        midi = np.asarray([np.nan, 69.0, 69.0])
        baseline = MODULE.build_decisions(notes, times, midi, 2.0, 0)
        shifted = MODULE.build_decisions(notes, times, midi, 2.0, 0, audio_start_seconds=1.0)
        self.assertEqual(baseline[0]["predictedOnsetSeconds"], 0.0)
        self.assertEqual(shifted[0]["predictedOnsetSeconds"], 1.0)

    def test_score_parser_expands_repeats_and_assigns_global_measure_indices(self) -> None:
        xml = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <barline location="left"><repeat direction="forward"/></barline>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
  </part>
</score-partwise>
"""
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "repeat.musicxml"
            path.write_text(xml, encoding="utf-8")
            positions = MODULE.parse_score_positions(path)
        self.assertEqual(positions[(0, 60)][0]["measureIndex"], 1)
        self.assertEqual(positions[(96, 62)][0]["measureIndex"], 2)
        self.assertEqual(positions[(192, 60)][0]["measureIndex"], 3)
        self.assertEqual(positions[(288, 62)][0]["measureIndex"], 4)


if __name__ == "__main__":
    unittest.main()
