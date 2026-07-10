from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import pretty_midi


SCRIPT = Path(__file__).resolve().parent / "experiments/eval_western_hf2_hardanger_musc.py"
SPEC = importlib.util.spec_from_file_location("western_hf2_hardanger_musc", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class WesternHf2HardangerMuscTest(unittest.TestCase):
    def test_direct_core_selection_is_frozen_to_original_hf1_rows(self) -> None:
        audit = {
            "pairs": [
                {"id": "a", "songName": "A", "emotion": "original", "ready": True, "humanVerifiedHf1": True},
                {"id": "b", "songName": "A", "emotion": "happy", "ready": True, "humanVerifiedHf1": True},
                {"id": "c", "songName": "B", "emotion": "original", "ready": True, "humanVerifiedHf1": False},
            ]
        }
        self.assertEqual([row["id"] for row in MODULE.select_pairs(audit, "direct-core")], ["a"])
        self.assertEqual(
            [row["id"] for row in MODULE.select_pairs(audit, "all-human-verified")],
            ["a", "b"],
        )

    def test_reference_rows_mark_near_simultaneous_notes_as_double_stop(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "notes.mid"
            midi = pretty_midi.PrettyMIDI(initial_tempo=120)
            instrument = pretty_midi.Instrument(program=40)
            instrument.notes.extend(
                [
                    pretty_midi.Note(90, 60, 0.0, 0.5),
                    pretty_midi.Note(90, 67, 0.008, 0.5),
                    pretty_midi.Note(90, 69, 1.0, 1.5),
                ]
            )
            midi.instruments.append(instrument)
            midi.write(str(path))
            rows = MODULE.reference_rows_from_midi(path)
        self.assertEqual([row["doubleStop"] for row in rows], ["true", "true", "false"])

    def test_incremental_plan_limits_only_uncached_predictions(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir)
            postprocessing = {"onsetThreshold": 0.5, "frameThreshold": 0.4, "minimumNoteLengthMs": 60}
            selected = [
                {"id": "a", "audioPath": str(cache_dir / "a.wav"), "audio": {"durationSeconds": 30}},
                {"id": "b", "audioPath": str(cache_dir / "b.wav"), "audio": {"durationSeconds": 20}},
                {"id": "c", "audioPath": str(cache_dir / "c.wav"), "audio": {"durationSeconds": 10}},
            ]
            MODULE.musc_cache_path(Path(selected[0]["audioPath"]), cache_dir, postprocessing).write_text(
                "[]\n", encoding="utf-8"
            )
            plan = MODULE.build_incremental_plan(
                selected,
                cache_dir,
                postprocessing,
                force=False,
                max_new_units=1,
                max_new_audio_seconds=100,
            )
        self.assertEqual(
            [(item["source"]["id"], item["action"]) for item in plan],
            [("a", "cache"), ("c", "predict"), ("b", "pending")],
        )

    def test_incremental_plan_supports_status_only_mode(self) -> None:
        selected = [{"id": "a", "audioPath": "a.wav"}]
        with tempfile.TemporaryDirectory() as temp_dir:
            plan = MODULE.build_incremental_plan(
                selected,
                Path(temp_dir),
                {"onsetThreshold": 0.5, "frameThreshold": 0.4, "minimumNoteLengthMs": 60},
                force=False,
                max_new_units=0,
                max_new_audio_seconds=100,
            )
        self.assertEqual(plan[0]["action"], "pending")

    def test_incremental_plan_caps_total_audio_duration_without_blocking_first(self) -> None:
        selected = [
            {"id": "a", "audioPath": "a.wav", "audio": {"durationSeconds": 44}},
            {"id": "b", "audioPath": "b.wav", "audio": {"durationSeconds": 46}},
            {"id": "c", "audioPath": "c.wav", "audio": {"durationSeconds": 60}},
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            plan = MODULE.build_incremental_plan(
                selected,
                Path(temp_dir),
                {"onsetThreshold": 0.5, "frameThreshold": 0.4, "minimumNoteLengthMs": 60},
                force=False,
                max_new_units=3,
                max_new_audio_seconds=100,
            )
        self.assertEqual([item["action"] for item in plan], ["predict", "predict", "pending"])

    def test_sparse_integer_midi_matching_finds_maximum_cardinality(self) -> None:
        reference_rows = [
            {"goldTime": "0.00", "goldOffset": "0.2", "midi": "60", "doubleStop": "false"},
            {"goldTime": "0.09", "goldOffset": "0.3", "midi": "60", "doubleStop": "false"},
            {"goldTime": "1.00", "goldOffset": "1.4", "midi": "64", "doubleStop": "true"},
            {"goldTime": "1.00", "goldOffset": "1.4", "midi": "67", "doubleStop": "true"},
        ]
        events = [
            {"start": 0.05, "end": 0.2, "midi": 60},
            {"start": 0.14, "end": 0.3, "midi": 60},
            {"start": 1.05, "end": 1.4, "midi": 64},
            {"start": 1.05, "end": 1.4, "midi": 67},
        ]
        matches = MODULE.sparse_integer_midi_matches(reference_rows, events, 0.05)
        self.assertEqual(len(matches), 4)
        self.assertEqual(len({row[0] for row in matches}), 4)
        self.assertEqual(len({row[1] for row in matches}), 4)

        metrics = MODULE.evaluate_hf2_tolerance(reference_rows, events, 0.05)
        self.assertEqual(metrics["matchedNotes"], 4)
        self.assertEqual(metrics["singleNoteRecall"], 1.0)
        self.assertEqual(metrics["doubleStopRecall"], 1.0)

    def test_sparse_integer_midi_matching_rejects_wrong_pitch_and_late_onset(self) -> None:
        reference_rows = [
            {"goldTime": "1.0", "goldOffset": "1.2", "midi": "69", "doubleStop": "false"}
        ]
        events = [
            {"start": 1.05, "end": 1.2, "midi": 70},
            {"start": 1.051, "end": 1.2, "midi": 69},
        ]
        self.assertEqual(MODULE.sparse_integer_midi_matches(reference_rows, events, 0.05), [])


if __name__ == "__main__":
    unittest.main()
