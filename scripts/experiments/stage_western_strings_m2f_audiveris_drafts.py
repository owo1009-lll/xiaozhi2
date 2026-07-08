from __future__ import annotations

import argparse
import csv
import json
import shutil
from pathlib import Path
from typing import Any

from eval_western_strings_m2f_real_recordings import REPO
from eval_western_strings_m2f_real_recordings import read_csv
from eval_western_strings_m2f_real_recordings import repo_path


DEFAULT_INTAKE = REPO / "data" / "experiments" / "western-strings-m2" / "clean-score-intake.csv"
DEFAULT_AUDIVERIS_SUMMARY = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m2"
    / "audiveris-draft"
    / "audiveris-draft-musicxml-summary.json"
)
DEFAULT_TARGET_DIR = REPO / "data" / "private" / "western-strings-m2"


def load_audiveris_summary(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"Audiveris summary not found: {path}")
    items = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(items, list):
        raise SystemExit(f"Audiveris summary must be a JSON array: {path}")
    by_key: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        for key_name in ("recordingId", "pieceId"):
            key = str(item.get(key_name) or "").strip()
            if key:
                by_key[key] = item
    return by_key


def ensure_columns(columns: list[str], rows: list[dict[str, str]], required: list[str]) -> list[str]:
    updated = list(columns)
    for column in required:
        if column not in updated:
            updated.append(column)
            for row in rows:
                row[column] = ""
    return updated


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def portable_path(path: Path) -> str:
    try:
        return str(path.resolve(strict=False).relative_to(REPO.resolve(strict=False))).replace("\\", "/")
    except ValueError:
        return str(path.resolve(strict=False))


def stage_drafts(
    intake_path: Path,
    summary_path: Path,
    target_dir: Path,
    *,
    write_files: bool,
    overwrite: bool,
) -> dict[str, Any]:
    rows, columns = read_csv(intake_path)
    columns = ensure_columns(
        columns,
        rows,
        ["requiredCleanScorePath", "cleanScoreReviewStatus", "cleanScoreReviewedBy", "cleanScoreReviewNotes"],
    )
    audiveris_by_key = load_audiveris_summary(summary_path)
    target_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, str]] = []
    for row in rows:
        recording_id = row.get("recordingId", "").strip()
        piece_id = row.get("pieceId", "").strip() or recording_id
        item = audiveris_by_key.get(recording_id) or audiveris_by_key.get(piece_id)
        result = {
            "recordingId": recording_id,
            "pieceId": piece_id,
            "targetPath": "",
            "status": "",
            "reason": "",
        }
        if not item:
            result.update({"status": "skipped", "reason": "no-audiveris-summary-row"})
            results.append(result)
            continue
        if not item.get("parseOk") or not item.get("mxl"):
            result.update({"status": "skipped", "reason": str(item.get("error") or item.get("parseError") or "draft-not-parseable")})
            results.append(result)
            continue
        source = repo_path(str(item.get("mxl") or ""))
        if not source.exists() or not source.is_file():
            result.update({"status": "skipped", "reason": "draft-mxl-missing"})
            results.append(result)
            continue
        target = target_dir / f"{piece_id}.mxl"
        result["targetPath"] = str(target)
        if target.exists() and not overwrite:
            result.update({"status": "target-exists", "reason": "not-overwritten"})
        elif write_files:
            shutil.copy2(source, target)
            result.update({"status": "staged", "reason": ""})
        else:
            result.update({"status": "would-stage", "reason": "dry-run"})
        row["requiredCleanScorePath"] = portable_path(target)
        note = "Audiveris draft staged; verify against the original score image before setting cleanScoreReviewStatus=approved."
        existing_notes = row.get("cleanScoreReviewNotes", "").strip()
        if note not in existing_notes:
            row["cleanScoreReviewNotes"] = f"{existing_notes} {note}".strip()
        results.append(result)

    return {
        "rows": len(rows),
        "staged": sum(1 for item in results if item["status"] == "staged"),
        "wouldStage": sum(1 for item in results if item["status"] == "would-stage"),
        "targetExists": sum(1 for item in results if item["status"] == "target-exists"),
        "skipped": sum(1 for item in results if item["status"] == "skipped"),
        "results": results,
        "updatedRows": rows,
        "columns": columns,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage Audiveris MXL drafts as pending M2f clean-score files.")
    parser.add_argument("--intake", default=str(DEFAULT_INTAKE))
    parser.add_argument("--audiveris-summary", default=str(DEFAULT_AUDIVERIS_SUMMARY))
    parser.add_argument("--target-dir", default=str(DEFAULT_TARGET_DIR))
    parser.add_argument("--out", default="", help="optional output intake path; defaults to --intake with --apply")
    parser.add_argument("--apply", action="store_true", help="write the updated intake CSV; dry-run by default")
    parser.add_argument("--overwrite", action="store_true", help="overwrite staged target MXL files")
    parser.add_argument("--expect-staged", action="store_true")
    args = parser.parse_args()

    intake_path = Path(args.intake)
    if not intake_path.exists():
        raise SystemExit(f"Clean-score intake not found: {intake_path}")
    summary = stage_drafts(
        intake_path,
        Path(args.audiveris_summary),
        Path(args.target_dir),
        write_files=bool(args.apply),
        overwrite=bool(args.overwrite),
    )
    rows = summary.pop("updatedRows")
    columns = summary.pop("columns")
    if args.apply:
        out_path = Path(args.out) if args.out else intake_path
        write_csv(out_path, columns, rows)
        summary["written"] = str(out_path)
    else:
        summary["dryRun"] = True
        summary["written"] = ""
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    if args.expect_staged and (summary.get("staged", 0) + summary.get("wouldStage", 0) + summary.get("targetExists", 0)) == 0:
        raise SystemExit("Expected at least one staged Audiveris draft target, but none were staged or present.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
