from __future__ import annotations

import csv
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent / "experiments/audit_western_bach_violin_dataset.py"
SPEC = importlib.util.spec_from_file_location("bach_violin_audit", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


MUSIC_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration></note></measure></part>
</score-partwise>
"""


def write_csv(path: Path, headers: list[str], rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        writer.writerows(rows)


def write_mxl(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles>
</container>
"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("META-INF/container.xml", container)
        archive.writestr("score.musicxml", MUSIC_XML)


class BachViolinDatasetAuditTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        self.dataset = self.repo / "dataset"
        (self.repo / "data/experiments/western-strings-m3").mkdir(parents=True)
        (self.repo / "data/experiments/western-strings-controlled-pilot-sessions").mkdir(parents=True)
        (self.repo / "data/erhu-score-imports.json").write_text('{"scores": []}\n', encoding="utf-8")
        audio = self.dataset / "audio-by-movement/sample.mp3"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(b"new-audio")
        write_mxl(self.dataset / "bach-violin-dataset/scores/bwv1001/sample.mxl")
        write_csv(
            self.dataset / "bach-violin-index.csv",
            ["unit", "violinist", "work", "mov", "movement", "noteCount", "audioClip", "score", "source", "license", "url"],
            [["sample", "Player", "BWV1001", "1", "Adagio", "1", "audio-by-movement/sample.mp3", "scores/bwv1001/sample.mxl", "musopen", "PD", "https://example.test"]],
        )
        write_csv(
            self.dataset / "bach-violin-gold-notes.csv",
            ["dataset", "pieceId", "piece", "track", "instrument", "noteIndex", "scoreOnsetTick", "goldTime", "goldOffset", "midi", "doubleStop", "legato", "audioPath", "scorePath", "goldPath"],
            [["bach-violin", "bach-violin:sample", "sample", "violin", "violin", "0", "0", "1.0", "1.5", "69", "False", "unknown", "", "", ""]],
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def audio_probe(_: Path) -> dict:
        return {"durationSeconds": 12.0, "codec": "mp3", "sampleRate": 44100, "channels": 2}

    def test_eval_ready_row_uses_nested_score_resolution_and_is_not_student_blind(self) -> None:
        report = MODULE.audit_dataset(self.dataset, repo_root=self.repo, audio_probe=self.audio_probe)
        self.assertTrue(report["readyForEvalBenchmark"])
        self.assertFalse(report["freshStudentBlindEligible"])
        self.assertEqual(report["counts"]["readyForEvalBenchmarkRows"], 1)
        row = report["rows"][0]
        self.assertEqual(row["scorePathResolution"], "bach-violin-dataset-root")
        self.assertEqual(row["referenceAlignmentType"], "estimated-cqt-dtw-not-human-gold")
        self.assertEqual(row["benchmarkSplit"], "holdout-unseen-performer")
        self.assertTrue(report["datasetRoles"]["externalDevelopmentBenchmark"])
        self.assertEqual(
            [protocol["name"] for protocol in report["evaluationProtocols"]],
            ["leave-one-performer-out", "leave-one-work-out"],
        )
        self.assertEqual(row["issues"], [])


if __name__ == "__main__":
    unittest.main()
