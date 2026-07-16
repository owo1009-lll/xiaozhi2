from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.experiments.eval_western_strings_m4_omr_benchmark import (
    evaluate_pair,
    movement_siblings,
    parse_notes_many,
    verify_source_derived_gold,
)


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_single_note_score(path: Path, step: str, octave: int) -> None:
    path.write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>{step}</step><octave>{octave}</octave></pitch><duration>1</duration></note>
    </measure>
  </part>
</score-partwise>
""",
        encoding="utf-8",
    )


with tempfile.TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    gold_path = root / "violin-ex05.musicxml"
    manifest_path = root / "manifest.json"
    gold_path.write_text("<score-partwise version=\"4.0\"/>", encoding="utf-8")
    manifest = {
        "license": "CC-BY-SA-4.0",
        "sourceCommit": "0123456789abcdef",
        "photoGold": [
            {
                "pieceId": "violin-ex05",
                "path": gold_path.name,
                "sha256": file_sha256(gold_path),
            }
        ],
    }
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    row = {
        "pieceId": "violin-ex05",
        "goldProvenance": "independent-source-derived-gold",
        "goldSourceManifest": str(manifest_path),
    }

    assert verify_source_derived_gold(row, gold_path) == (True, "")

    gold_path.write_text("<score-partwise version=\"3.1\"/>", encoding="utf-8")
    assert verify_source_derived_gold(row, gold_path) == (False, "source-gold-hash-mismatch")

    manifest["license"] = "unknown"
    manifest["photoGold"][0]["sha256"] = file_sha256(gold_path)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    assert verify_source_derived_gold(row, gold_path) == (False, "source-license-not-allowed")

    movement_one = root / "draft.mvt1.mxl"
    movement_two = root / "draft.mvt2.mxl"
    write_single_note_score(movement_one, "C", 4)
    write_single_note_score(movement_two, "D", 4)
    assert movement_siblings(movement_two) == [movement_one, movement_two]
    notes = parse_notes_many([movement_one, movement_two])
    assert [note.midi for note in notes] == [60, 62]
    assert [note.onset_quarters for note in notes] == [0.0, 1.0]
    assert [note.measure_index for note in notes] == [1, 2]

    unreviewed_gold = root / "unreviewed-gold.musicxml"
    unreviewed_draft = root / "unreviewed-draft.musicxml"
    write_single_note_score(unreviewed_gold, "C", 4)
    write_single_note_score(unreviewed_draft, "D", 4)
    pending_row = {
        "pieceId": "pending-piece",
        "recordingId": "pending-recording",
        "requiredCleanScorePath": str(unreviewed_gold),
        "cleanScoreReviewStatus": "pending",
        "cleanScoreReviewedBy": "",
    }
    pending_result = evaluate_pair(
        pending_row,
        {"pending-piece": {"mxl": str(unreviewed_draft)}},
        root,
        onset_tolerance_quarters=0.25,
    )
    assert pending_result["parseOk"] is True
    assert pending_result["benchmarkUsable"] is False
    assert pending_result["goldProvenance"] == "different-draft-unverified"
    assert pending_result["blockingReason"] == "gold-clean-score-not-human-approved"

    approved_result = evaluate_pair(
        {**pending_row, "cleanScoreReviewStatus": "approved", "cleanScoreReviewedBy": "teacher-a"},
        {"pending-piece": {"mxl": str(unreviewed_draft)}},
        root,
        onset_tolerance_quarters=0.25,
    )
    assert approved_result["benchmarkUsable"] is True
    assert approved_result["goldProvenance"] == "independent-edited-gold"

print(
    json.dumps(
        {
            "ok": True,
            "checks": [
                "valid-manifest",
                "hash-mismatch",
                "license-fail-closed",
                "movement-order-and-concatenation",
                "unreviewed-different-gold-rejected",
                "approved-different-gold-accepted",
            ],
        }
    )
)
