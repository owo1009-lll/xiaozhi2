from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from eval_western_strings_m2f_real_recordings import CLEAN_SCORE_EXTENSIONS
from eval_western_strings_m2f_real_recordings import DEFAULT_MANIFEST
from eval_western_strings_m2f_real_recordings import REPO
from eval_western_strings_m2f_real_recordings import read_csv
from eval_western_strings_m2f_real_recordings import repo_path


DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "clean-score-intake.csv"

INTAKE_COLUMNS = [
    "recordingId",
    "pieceId",
    "audioPath",
    "currentScorePath",
    "currentScoreType",
    "requiredCleanScorePath",
    "scoreId",
    "cleanScoreReviewStatus",
    "cleanScoreReviewedBy",
    "cleanScoreReviewNotes",
    "action",
    "status",
    "notes",
]


def score_type(value: str) -> str:
    if not value.strip():
        return "missing"
    path = repo_path(value)
    if not path.exists():
        return "missing-file"
    if not path.is_file():
        return "not-file"
    if path.suffix.lower() in CLEAN_SCORE_EXTENSIONS:
        return "clean-score"
    return "image-or-unsupported"


def build_rows(manifest_path: Path) -> list[dict[str, str]]:
    rows, _columns = read_csv(manifest_path)
    intake_rows: list[dict[str, str]] = []
    for row in rows:
        recording_id = row.get("recordingId", "").strip()
        piece_id = row.get("pieceId", "").strip()
        current_score_path = row.get("scorePath", "").strip() or row.get("scoreSourcePath", "").strip()
        score_id = row.get("scoreId", "").strip()
        required_path = ""
        if piece_id:
            required_path = f"data/private/western-strings-m2/{piece_id}.musicxml"
        status = "ready" if (score_id or score_type(current_score_path) == "clean-score") else "needs-clean-score"
        notes = (
            "Provide a clean MusicXML/MXL/MIDI score here, or fill scoreId with an existing clean score. "
            "Do not use JPG/PNG score images for the V2 M2f release gate. "
            "Set cleanScoreReviewStatus=approved only after human score review."
        )
        intake_rows.append(
            {
                "recordingId": recording_id,
                "pieceId": piece_id,
                "audioPath": row.get("audioPath", "").strip(),
                "currentScorePath": current_score_path,
                "currentScoreType": score_type(current_score_path),
                "requiredCleanScorePath": required_path,
                "scoreId": score_id,
                "cleanScoreReviewStatus": "",
                "cleanScoreReviewedBy": "",
                "cleanScoreReviewNotes": "",
                "action": "replace scorePath with requiredCleanScorePath or fill scoreId",
                "status": status,
                "notes": notes,
            }
        )
    return intake_rows


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=INTAKE_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create the M2f clean-score intake checklist from the real-student recording manifest."
    )
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")

    rows = build_rows(manifest_path)
    out_path = Path(args.out)
    write_csv(out_path, rows)
    summary = {
        "ok": True,
        "manifest": str(manifest_path),
        "out": str(out_path),
        "rows": len(rows),
        "needsCleanScore": sum(1 for row in rows if row["status"] == "needs-clean-score"),
        "ready": sum(1 for row in rows if row["status"] == "ready"),
        "acceptedExtensions": sorted(CLEAN_SCORE_EXTENSIONS),
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
