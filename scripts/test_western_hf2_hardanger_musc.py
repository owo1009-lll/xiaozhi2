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
                {"id": "a", "audioPath": str(cache_dir / "a.wav")},
                {"id": "b", "audioPath": str(cache_dir / "b.wav")},
                {"id": "c", "audioPath": str(cache_dir / "c.wav")},
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
            )
        self.assertEqual([item["action"] for item in plan], ["cache", "predict", "pending"])

    def test_incremental_plan_supports_status_only_mode(self) -> None:
        selected = [{"id": "a", "audioPath": "a.wav"}]
        with tempfile.TemporaryDirectory() as temp_dir:
            plan = MODULE.build_incremental_plan(
                selected,
                Path(temp_dir),
                {"onsetThreshold": 0.5, "frameThreshold": 0.4, "minimumNoteLengthMs": 60},
                force=False,
                max_new_units=0,
            )
        self.assertEqual(plan[0]["action"], "pending")


if __name__ == "__main__":
    unittest.main()
