from __future__ import annotations

import hashlib
import importlib.util
import tempfile
import unittest
import wave
from pathlib import Path

import pretty_midi


SCRIPT = Path(__file__).resolve().parent / "experiments/audit_western_hf2_hardanger_dataset.py"
SPEC = importlib.util.spec_from_file_location("western_hf2_hardanger_audit", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class WesternHf2HardangerDatasetAuditTest(unittest.TestCase):
    def test_provenance_only_promotes_hf1_emotional_rows(self) -> None:
        self.assertIn(
            "human-verified",
            MODULE.provenance_for_row({"has_emotional_variations": "True"}),
        )
        self.assertIn(
            "not-independently-reverified",
            MODULE.provenance_for_row(
                {"has_emotional_variations": "False", "notes": "processed"}
            ),
        )

    def test_onset_polyphony_groups_near_simultaneous_notes(self) -> None:
        notes = [
            pretty_midi.Note(90, 60, 0.0, 1.0),
            pretty_midi.Note(90, 67, 0.008, 1.0),
            pretty_midi.Note(90, 69, 1.1, 1.5),
        ]
        result = MODULE.onset_polyphony(notes)
        self.assertEqual(result["polyphonicOnsetGroupCount"], 1)
        self.assertEqual(result["polyphonicNoteCount"], 2)
        self.assertEqual(result["maxOnsetPolyphony"], 2)

    def test_pair_hashes_and_media_are_checked(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            audio = root / "audio.wav"
            midi_path = root / "notes.mid"
            with wave.open(str(audio), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(44_100)
                handle.writeframes(b"\0\0" * 44_100)
            midi = pretty_midi.PrettyMIDI(initial_tempo=120)
            instrument = pretty_midi.Instrument(program=40)
            instrument.notes.append(pretty_midi.Note(90, 69, 0.1, 0.5))
            midi.instruments.append(instrument)
            midi.write(str(midi_path))
            row = {
                "id": "row-1",
                "song_name": "test",
                "audio_relpath": "audio.wav",
                "midi_relpath": "notes.mid",
                "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                "midi_sha256": hashlib.sha256(midi_path.read_bytes()).hexdigest(),
                "has_emotional_variations": "True",
                "emotion": "original",
                "notes": "",
            }
            inspected = MODULE.inspect_pair(root, row)
            self.assertTrue(inspected["ready"])
            self.assertEqual(inspected["midi"]["noteCount"], 1)
            row["audio_sha256"] = "0" * 64
            inspected = MODULE.inspect_pair(root, row)
            self.assertFalse(inspected["ready"])
            self.assertIn("audio-sha256-mismatch", inspected["issues"])


if __name__ == "__main__":
    unittest.main()
