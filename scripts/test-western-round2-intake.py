from __future__ import annotations

import csv
import importlib.util
import struct
import sys
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts" / "experiments" / "prepare_western_strings_round2.py"
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("prepare_western_strings_round2", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
  <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note>
  </measure></part>
</score-partwise>
"""


def png_header(width: int = 1200, height: int = 1600) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + struct.pack(">II", width, height)


def fake_probe(path: Path) -> dict[str, object]:
    return {"durationSeconds": 45.0 + int(path.stem[-1]), "codec": "aac", "sampleRate": 48000, "channels": 2}


def rows_by_id(path: Path) -> dict[str, dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return {row["recordingId"]: row for row in csv.DictReader(handle)}


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="western-round2-") as temp:
        repo = Path(temp)
        source = repo / "source"
        private = repo / "data" / "private" / "western-strings-round2"
        source.mkdir(parents=True)
        for index in range(1, 9):
            (source / f"{index}.m4a").write_bytes(f"audio-{index}".encode())
            score_text = MUSICXML.replace("G</step>", f"{'CDEFGABC'[index - 1]}</step>")
            score_text = score_text.replace('measure number="1"', f'measure number="{index}"')
            (source / f"r2-{index:02d}.musicxml").write_text(score_text, encoding="utf-8")
            (source / f"r2-{index:02d}.png").write_bytes(png_header() + f"image-{index}".encode())
        (source / "README-怎么用.md").write_text(
            "\n".join([
                "| r2-02 | G大调旋律 | 故意拉错 5 个音 |",
                "| r2-03 | a小调练习 | 故意漏掉 5 个音 |",
                "| r2-04 | C大调练习 | 故意 4 处明显拖拍 |",
            ]),
            encoding="utf-8",
        )

        report = MODULE.prepare_round2(
            repo_root=repo,
            source_root=source,
            private_root=private,
            apply=True,
            audio_probe=fake_probe,
            history=MODULE.empty_history(),
        )
        assert report["ok"] is True, report
        assert report["summary"]["validatedPairCount"] == 8
        assert report["summary"]["readyForMachineAnalysis"] is True
        assert report["summary"]["readyForScenarioCountEvaluation"] is True
        assert report["summary"]["readyForLabeledM3Evaluation"] is False
        assert report["summary"]["scenarioExpectedIssueCounts"] == {"r2-02": 5, "r2-03": 5, "r2-04": 4}
        assert (private / "README-source.md").is_file()
        assert (private / "r2-08.m4a").is_file()
        manifest = rows_by_id(private / "manifest.csv")
        assert len(manifest) == 8
        assert manifest["round2-r2-08-20260715"]["scenario"] == "fresh_blind_correct"
        assert manifest["round2-r2-08-20260715"]["expectedMeasureCount"] == "1"
        assert manifest["round2-r2-08-20260715"]["expectedPitchedNoteCount"] == "1"
        assert manifest["round2-r2-02-20260715"]["expectedIssueCount"] == "5"
        assert manifest["round2-r2-03-20260715"]["expectedIssueCount"] == "5"
        assert manifest["round2-r2-04-20260715"]["expectedIssueCount"] == "4"

        # Rerunning intake must preserve score IDs written by the importer.
        manifest["round2-r2-08-20260715"]["scoreId"] = "score-round2-08"
        MODULE.write_csv(private / "manifest.csv", MODULE.MANIFEST_FIELDS, list(manifest.values()))
        intake = rows_by_id(private / "clean-score-intake.csv")
        intake["round2-r2-08-20260715"]["scoreId"] = "score-round2-08"
        MODULE.write_csv(private / "clean-score-intake.csv", MODULE.INTAKE_FIELDS, list(intake.values()))
        rerun = MODULE.prepare_round2(
            repo_root=repo,
            source_root=source,
            private_root=private,
            apply=True,
            audio_probe=fake_probe,
            history=MODULE.empty_history(),
        )
        assert rerun["ok"] is True
        assert rows_by_id(private / "manifest.csv")["round2-r2-08-20260715"]["scoreId"] == "score-round2-08"

        # Existing private round-2 files may appear in live history after import;
        # an identical rerun must remain idempotent rather than self-blocking.
        live_history = MODULE.empty_history()
        for index, piece_id, _scenario, _title in MODULE.ROUND2_ROWS:
            recording_id = f"round2-r2-{index:02d}-20260715"
            audio_path = source / f"{index}.m4a"
            score_path = source / f"r2-{index:02d}.musicxml"
            live_history["recordingIds"].add(recording_id)
            live_history["pieceIds"].add(piece_id)
            live_history["audioSha1"].add(MODULE.hash_file(audio_path, "sha1"))
            live_history["audioSha256"].add(MODULE.hash_file(audio_path, "sha256"))
            live_history["scoreSha1"].add(MODULE.hash_file(score_path, "sha1"))
            live_history["scoreSha256"].add(MODULE.hash_file(score_path, "sha256"))
            live_history["scoreXmlSha256"].add(str(MODULE.inspect_musicxml(score_path)["normalizedXmlSha256"]))
        history_rerun = MODULE.prepare_round2(
            repo_root=repo,
            source_root=source,
            private_root=private,
            apply=False,
            audio_probe=fake_probe,
            history=live_history,
        )
        assert history_rerun["ok"] is True, history_rerun["blockingReasons"]

        # Intra-round duplicate audio must fail closed.
        (source / "2.m4a").write_bytes((source / "1.m4a").read_bytes())
        duplicate = MODULE.prepare_round2(
            repo_root=repo,
            source_root=source,
            private_root=private,
            apply=False,
            audio_probe=fake_probe,
            history=MODULE.empty_history(),
        )
        assert duplicate["ok"] is False
        assert any("audio-duplicate-within-round" in reason for reason in duplicate["blockingReasons"])

    print("western round2 intake tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
