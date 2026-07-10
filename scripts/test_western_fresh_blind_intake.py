from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/audit_western_fresh_blind_intake.py"
SPEC = importlib.util.spec_from_file_location("fresh_blind_intake", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


MUSIC_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>
</score-partwise>
"""

MULTIPART_WITHOUT_VIOLIN_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
    <score-part id="P2"><part-name>Cello</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>
  <part id="P2"><measure number="1"><note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration></note></measure></part>
</score-partwise>
"""


def write_mxl(path: Path, xml_text: str = MUSIC_XML) -> None:
    container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles>
</container>
"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("score.musicxml", xml_text)


def write_csv(path: Path, headers: list[str], rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [",".join(headers), *[",".join(row) for row in rows]]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


class FreshBlindIntakeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "data/experiments/western-strings-m3").mkdir(parents=True)
        (self.root / "data/experiments/western-strings-controlled-pilot-sessions").mkdir(parents=True)
        (self.root / "data").mkdir(exist_ok=True)
        (self.root / "data/erhu-score-imports.json").write_text('{"scores": []}\n', encoding="utf-8")

        old_audio = self.root / "old.wav"
        old_audio.write_bytes(b"old-audio")
        old_score = self.root / "old.mxl"
        write_mxl(old_score)
        write_csv(
            self.root / "data/experiments/western-strings-m2/real-student-recordings-manifest.csv",
            ["recordingId", "pieceId", "audioPath", "scorePath", "scoreId"],
            [["old-recording", "old-piece", "old.wav", "old.mxl", "old-score-id"]],
        )
        write_csv(
            self.root / "data/experiments/western-strings-m2/clean-score-intake.csv",
            ["recordingId", "pieceId", "requiredCleanScorePath", "scoreId"],
            [["old-recording", "old-piece", "old.mxl", "old-score-id"]],
        )

        self.audio = self.root / "new.wav"
        self.audio.write_bytes(b"new-audio")
        self.score = self.root / "new.mxl"
        write_mxl(self.score, MUSIC_XML.replace("<step>A</step>", "<step>B</step>"))
        self.display = self.root / "new-score.png"
        self.display.write_bytes(b"png")
        self.manifest = self.root / "intake.json"
        self.write_manifest()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_manifest(self, **overrides) -> None:
        payload = {
            "auditId": "blind-001",
            "recordingId": "new-recording",
            "pieceId": "new-piece",
            "audioPath": str(self.audio),
            "scorePath": str(self.score),
            "scoreDisplayPath": str(self.display),
            "cleanScoreReviewStatus": "approved",
            "cleanScoreReviewedBy": "reviewer-1",
            "consent": "yes",
            "licenseStatus": "local-only",
            "requireNewPiece": True,
        }
        payload.update(overrides)
        self.manifest.write_text(json.dumps(payload), encoding="utf-8")

    @staticmethod
    def audio_probe(_: Path) -> dict:
        return {"durationSeconds": 12.0, "codec": "pcm_s16le", "sampleRate": 44100, "channels": 1}

    def audit(self) -> dict:
        return MODULE.audit_intake(self.manifest, repo_root=self.root, audio_probe=self.audio_probe)

    def test_fresh_pair_passes(self) -> None:
        report = self.audit()
        self.assertTrue(report["readyForMachinePrecheck"])
        self.assertEqual(report["blockingReasons"], [])
        self.assertEqual(report["candidate"]["score"]["firstMeasurePitchedNoteCount"], 1)

    def test_seen_recording_is_rejected(self) -> None:
        self.write_manifest(recordingId="old-recording")
        self.assertIn("fresh-blind-recording-id-already-seen", self.audit()["blockingReasons"])

    def test_duplicate_audio_content_is_rejected(self) -> None:
        self.audio.write_bytes((self.root / "old.wav").read_bytes())
        self.assertIn("fresh-blind-audio-content-already-seen", self.audit()["blockingReasons"])

    def test_duplicate_score_content_is_rejected_for_new_piece_audit(self) -> None:
        self.score.write_bytes((self.root / "old.mxl").read_bytes())
        self.assertIn("fresh-blind-score-content-already-seen", self.audit()["blockingReasons"])

    def test_unapproved_score_is_rejected(self) -> None:
        self.write_manifest(cleanScoreReviewStatus="pending")
        self.assertIn("fresh-blind-clean-score-not-approved", self.audit()["blockingReasons"])

    def test_utf8_bom_manifest_is_supported(self) -> None:
        payload = self.manifest.read_text(encoding="utf-8")
        self.manifest.write_text(payload, encoding="utf-8-sig")
        self.assertTrue(self.audit()["readyForMachinePrecheck"])

    def test_first_measure_without_pitch_is_rejected(self) -> None:
        write_mxl(
            self.score,
            MUSIC_XML.replace(
                "<note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note>",
                "<note><rest/><duration>1</duration></note>",
            ),
        )
        self.assertIn("fresh-blind-first-measure-has-no-pitched-notes", self.audit()["blockingReasons"])

    def test_blank_paths_are_reported_once_and_remain_blank(self) -> None:
        self.write_manifest(audioPath="", scorePath="", scoreDisplayPath="")
        report = self.audit()
        self.assertEqual(report["candidate"]["audioPath"], "")
        self.assertEqual(report["candidate"]["scorePath"], "")
        self.assertEqual(report["candidate"]["scoreDisplayPath"], "")
        self.assertIn("fresh-blind-audio-path-missing", report["blockingReasons"])
        self.assertNotIn("fresh-blind-audio-file-missing", report["blockingReasons"])

    def test_multipart_score_without_violin_part_is_rejected(self) -> None:
        write_mxl(self.score, MULTIPART_WITHOUT_VIOLIN_XML)
        self.assertIn("fresh-blind-violin-part-not-resolved", self.audit()["blockingReasons"])

    def test_stage_replaces_manifest_only_after_full_audit_passes(self) -> None:
        original = {"auditId": "keep-this"}
        self.manifest.write_text(json.dumps(original), encoding="utf-8")
        payload = MODULE.build_stage_payload(
            repo_root=self.root,
            audit_id="blind-stage-001",
            recording_id="new-recording",
            piece_id="new-piece",
            audio_path=str(self.audio),
            score_path=str(self.score),
            score_display_path=str(self.display),
            reviewed_by="reviewer-1",
        )
        report = MODULE.stage_intake(
            self.manifest,
            payload,
            repo_root=self.root,
            audio_probe=self.audio_probe,
        )
        self.assertTrue(report["staged"])
        self.assertEqual(json.loads(self.manifest.read_text(encoding="utf-8"))["recordingId"], "new-recording")
        self.assertFalse(self.manifest.with_name(f".{self.manifest.name}.candidate").exists())

    def test_rejected_stage_preserves_existing_manifest(self) -> None:
        original = {"auditId": "keep-this"}
        self.manifest.write_text(json.dumps(original), encoding="utf-8")
        payload = MODULE.build_stage_payload(
            repo_root=self.root,
            audit_id="blind-stage-002",
            recording_id="old-recording",
            piece_id="new-piece",
            audio_path=str(self.audio),
            score_path=str(self.score),
            score_display_path=str(self.display),
            reviewed_by="reviewer-1",
        )
        report = MODULE.stage_intake(
            self.manifest,
            payload,
            repo_root=self.root,
            audio_probe=self.audio_probe,
        )
        self.assertFalse(report["staged"])
        self.assertIn("fresh-blind-recording-id-already-seen", report["blockingReasons"])
        self.assertEqual(json.loads(self.manifest.read_text(encoding="utf-8")), original)
        self.assertFalse(self.manifest.with_name(f".{self.manifest.name}.candidate").exists())


if __name__ == "__main__":
    unittest.main()
