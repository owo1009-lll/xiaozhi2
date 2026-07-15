from __future__ import annotations

import argparse
import csv
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
PYTHON_SERVICE = REPO / "python-service"
if str(PYTHON_SERVICE) not in sys.path:
    sys.path.insert(0, str(PYTHON_SERVICE))

from analyzer import ErhuAnalyzer  # noqa: E402
from config import settings  # noqa: E402
from schemas import MusicXmlImportRequest  # noqa: E402


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def collect_notes(score: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        note
        for section in score.get("sections", []) or []
        for note in section.get("notes", []) or []
        if int(note.get("midiPitch") or 0) > 0
    ]


def score_structure(score: dict[str, Any]) -> dict[str, int]:
    notes = collect_notes(score)
    return {
        "pitchedNoteCount": len(notes),
        "measureCount": len({int(note.get("measureIndex") or 0) for note in notes if int(note.get("measureIndex") or 0) > 0}),
        "uniqueNoteIdCount": len({str(note.get("noteId") or "").strip() for note in notes if str(note.get("noteId") or "").strip()}),
    }


def structure_matches(structure: dict[str, int], expected_measures: int, expected_notes: int) -> bool:
    return (
        structure["measureCount"] == expected_measures
        and structure["pitchedNoteCount"] == expected_notes
        and structure["uniqueNoteIdCount"] == expected_notes
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair collapsed round-2 MusicXML score structures in place.")
    parser.add_argument("--repo-root", type=Path, default=REPO)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("data/private/western-strings-round2/manifest.csv"),
    )
    parser.add_argument(
        "--sqlite",
        type=Path,
        default=Path("data/erhu-score-imports.sqlite"),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/experiments/western-strings-round2/score-structure-repair.json"),
    )
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    manifest_path = args.manifest if args.manifest.is_absolute() else repo_root / args.manifest
    sqlite_path = args.sqlite if args.sqlite.is_absolute() else repo_root / args.sqlite
    out_path = args.out if args.out.is_absolute() else repo_root / args.out
    rows = read_manifest(manifest_path)
    analyzer = ErhuAnalyzer(settings)
    connection = sqlite3.connect(sqlite_path)
    repairs: list[dict[str, Any]] = []
    try:
        for row in rows:
            score_id = str(row.get("scoreId") or "").strip()
            recording_id = str(row.get("recordingId") or "").strip()
            expected_measures = int(row.get("expectedMeasureCount") or 0)
            expected_notes = int(row.get("expectedPitchedNoteCount") or 0)
            stored = connection.execute(
                "SELECT payload FROM imported_scores WHERE score_id = ? AND archived = 0",
                (score_id,),
            ).fetchone()
            if not stored:
                raise RuntimeError(f"active score not found: {score_id}")
            current_score = json.loads(stored[0])
            before = score_structure(current_score)
            item: dict[str, Any] = {
                "recordingId": recording_id,
                "scoreId": score_id,
                "expectedMeasureCount": expected_measures,
                "expectedPitchedNoteCount": expected_notes,
                "before": before,
                "needsRepair": not structure_matches(before, expected_measures, expected_notes),
            }
            if not item["needsRepair"]:
                item["after"] = before
                item["status"] = "already-valid"
                repairs.append(item)
                continue

            score_path = Path(str(row.get("scorePath") or ""))
            if not score_path.is_absolute():
                score_path = repo_root / score_path
            result = analyzer.import_musicxml_score(
                MusicXmlImportRequest(
                    jobId=f"repair-{score_id}",
                    musicxmlPath=str(score_path),
                    originalFilename=score_path.name,
                    titleHint=str(row.get("title") or row.get("pieceId") or recording_id),
                    selectedPartHint="violin",
                    instrument="violin",
                    scoreSource="musicxml",
                    tempoKnown=False,
                    tempoSource="unknown",
                    outputDir=str(repo_root / "data" / "score-imports" / f"repair-{score_id}"),
                )
            )
            if result.omrStatus != "completed" or not isinstance(result.piecePack, dict):
                raise RuntimeError(f"MusicXML repair failed for {recording_id}: {result.error or result.warnings}")
            piece_pack = result.piecePack
            after = score_structure(piece_pack)
            if not structure_matches(after, expected_measures, expected_notes):
                raise RuntimeError(
                    f"repaired structure mismatch for {recording_id}: expected "
                    f"{expected_measures} measures/{expected_notes} notes, got {after}"
                )
            next_score = dict(current_score)
            next_score.update({
                "sections": piece_pack.get("sections") or [],
                "instrument": piece_pack.get("instrument") or "violin",
                "scoreSource": piece_pack.get("scoreSourceType") or current_score.get("scoreSource") or "musicxml",
                "tempoKnown": piece_pack.get("tempoKnown", False),
                "tempoSource": piece_pack.get("tempoSource") or "unknown",
                "selectedPart": result.selectedPart or current_score.get("selectedPart") or "violin",
                "selectedPartConfidence": result.selectedPartConfidence,
                "partCandidates": result.partCandidates,
                "markingStats": result.markingStats,
                "omrStats": result.omrStats,
                "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            })
            item["after"] = after
            item["status"] = "validated-pending-apply" if not args.apply else "repaired"
            item["nextPayload"] = next_score
            repairs.append(item)

        backup_path = ""
        if args.apply:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = sqlite_path.with_name(f"{sqlite_path.name}.bak-round2-structure-{stamp}")
            connection.commit()
            shutil.copy2(sqlite_path, backup)
            backup_path = str(backup.relative_to(repo_root)).replace("\\", "/")
            connection.execute("BEGIN IMMEDIATE")
            for item in repairs:
                next_score = item.pop("nextPayload", None)
                if not next_score:
                    continue
                connection.execute(
                    """
                    UPDATE imported_scores
                    SET selected_part = ?, updated_at = ?, payload = ?
                    WHERE score_id = ? AND archived = 0
                    """,
                    (
                        str(next_score.get("selectedPart") or "violin"),
                        str(next_score.get("updatedAt") or ""),
                        json.dumps(next_score, ensure_ascii=False),
                        item["scoreId"],
                    ),
                )
            connection.commit()
        else:
            for item in repairs:
                item.pop("nextPayload", None)

        report = {
            "ok": True,
            "applied": args.apply,
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "manifest": str(manifest_path.relative_to(repo_root)).replace("\\", "/"),
            "backup": backup_path,
            "rowCount": len(repairs),
            "repairCount": sum(1 for item in repairs if item["needsRepair"]),
            "rows": repairs,
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
