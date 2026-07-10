from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

import pretty_midi


SCRIPT = Path(__file__).resolve().parent / "experiments/audit_western_violin_midi_dataset.py"
SPEC = importlib.util.spec_from_file_location("western_violin_midi_dataset_audit", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class WesternViolinMidiDatasetAuditTest(unittest.TestCase):
    def test_weak_label_subset_requires_at_least_98_percent_ready(self) -> None:
        self.assertEqual(MODULE.MIN_WEAK_LABEL_READY_RATE, 0.98)

    def test_filename_parser_uses_last_time_suffix(self) -> None:
        row = MODULE.parse_filename(
            Path("Kayser_Op20-01_BochanKang_JRYZZ-WXwtI-0004-0064.mid")
        )
        self.assertEqual(row["book"], "Kayser")
        self.assertEqual(row["performer"], "BochanKang")
        self.assertEqual(row["youtubeId"], "JRYZZ-WXwtI")
        self.assertEqual(row["linkedSegmentDurationSeconds"], 60)

    def test_invalid_filename_duration_fails(self) -> None:
        with self.assertRaisesRegex(ValueError, "segment-duration"):
            MODULE.parse_filename(Path("Kayser_Op20-01_Player_video-0064-0004.mid"))

    def test_midi_inspection_counts_notes_and_pitch_bends(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "Kayser_Op20-01_Player_video-0000-0001.mid"
            midi = pretty_midi.PrettyMIDI(initial_tempo=120)
            instrument = pretty_midi.Instrument(program=40)
            instrument.notes.append(pretty_midi.Note(velocity=100, pitch=69, start=0, end=1))
            instrument.pitch_bends.append(pretty_midi.PitchBend(100, 0.5))
            midi.instruments.append(instrument)
            midi.write(str(path))
            row = MODULE.inspect_midi(path)
        self.assertTrue(row["ready"])
        self.assertEqual(row["noteCount"], 1)
        self.assertEqual(row["pitchBendCount"], 1)


if __name__ == "__main__":
    unittest.main()
