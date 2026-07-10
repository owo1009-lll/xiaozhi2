from __future__ import annotations

import importlib.util
import tempfile
import unittest
import wave
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/audit_western_phenicx_dataset.py"
SPEC = importlib.util.spec_from_file_location("western_phenicx_dataset_audit", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def write_wav(path: Path, duration_seconds: float = 2.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = 8000
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * int(sample_rate * duration_seconds))


def write_fixture(root: Path, mismatch: bool = False) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "Readme.txt").write_text(
        "non-commercial use only\nYou can not redistribute them nor modify them\n",
        encoding="utf-8",
    )
    aligned = "0.100000,0.500000,G4\n0.600000,1.000000,A4\n"
    score = "0.000000,0.400000,G4\n0.500000,0.900000,B4\n" if mismatch else aligned
    for piece in MODULE.EXPECTED_PIECES:
        annotation_dir = root / "annotations" / piece
        annotation_dir.mkdir(parents=True, exist_ok=True)
        (annotation_dir / "violin.txt").write_text(aligned, encoding="utf-8")
        (annotation_dir / "violin_o.txt").write_text(score, encoding="utf-8")
        write_wav(root / "audio" / piece / "violin1.wav")


class WesternPhenicxDatasetAuditTest(unittest.TestCase):
    def test_ready_fixture_has_one_to_one_score_gold_pitch_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "PHENICX-Anechoic"
            write_fixture(root)
            report = MODULE.build_audit(root)
        self.assertTrue(report["readyForAlignmentBenchmark"])
        self.assertEqual(report["counts"]["readyPieceCount"], 4)
        self.assertEqual(report["counts"]["goldNoteCount"], 8)
        self.assertEqual(report["adapterRequirement"], "mix-all-synchronized-violin-tracks-per-piece-before-evaluation")

    def test_pitch_sequence_mismatch_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "PHENICX-Anechoic"
            write_fixture(root, mismatch=True)
            report = MODULE.build_audit(root)
        self.assertFalse(report["readyForAlignmentBenchmark"])
        self.assertTrue(
            any(issue.endswith("score-gold-pitch-sequence-mismatch") for issue in report["issues"])
        )

    def test_note_name_parser_handles_sharps_and_flats(self) -> None:
        self.assertEqual(MODULE.note_name_to_midi("G4"), 67)
        self.assertEqual(MODULE.note_name_to_midi("D#4"), 63)
        self.assertEqual(MODULE.note_name_to_midi("Eb4"), 63)

    def test_unaligned_score_can_keep_zero_duration_onset_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "score.txt"
            path.write_text("1.000000,1.000000,G4\n", encoding="utf-8")
            rows = MODULE.parse_annotation(path, allow_zero_duration=True)
            self.assertEqual(rows[0]["onset"], rows[0]["offset"])
            with self.assertRaises(ValueError):
                MODULE.parse_annotation(path)

    def test_unaligned_score_can_preserve_authoritative_row_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "score.txt"
            path.write_text(
                "1.000000,1.500000,G4\n0.900000,0.900000,A4\n",
                encoding="utf-8",
            )
            rows = MODULE.parse_annotation(
                path,
                allow_zero_duration=True,
                require_monotonic=False,
            )
            self.assertEqual([row["midi"] for row in rows], [67, 69])
            with self.assertRaises(ValueError):
                MODULE.parse_annotation(path, allow_zero_duration=True)


if __name__ == "__main__":
    unittest.main()
