from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

from eval_western_strings_m2f_real_recordings import CLEAN_SCORE_EXTENSIONS
from eval_western_strings_m2f_real_recordings import DEFAULT_MANIFEST
from eval_western_strings_m2f_real_recordings import REPO
from eval_western_strings_m2f_real_recordings import read_csv
from eval_western_strings_m2f_real_recordings import repo_path


DEFAULT_INTAKE = REPO / "data" / "experiments" / "western-strings-m2" / "clean-score-intake.csv"
APPROVED_REVIEW_STATUS = "approved"


def is_clean_score_path(value: str) -> bool:
    if not value.strip():
        return False
    path = repo_path(value)
    return path.exists() and path.is_file() and path.suffix.lower() in CLEAN_SCORE_EXTENSIONS


def is_approved_review_status(value: str) -> bool:
    return value.strip().lower() == APPROVED_REVIEW_STATUS


def has_reviewer(value: str) -> bool:
    return bool(value.strip())


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def apply_clean_scores(manifest_path: Path, intake_path: Path) -> dict[str, Any]:
    manifest_rows, manifest_columns = read_csv(manifest_path)
    intake_rows, intake_columns = read_csv(intake_path)

    required_intake_columns = {"recordingId", "requiredCleanScorePath", "scoreId", "cleanScoreReviewStatus"}
    missing_intake_columns = sorted(required_intake_columns.difference(intake_columns))
    if missing_intake_columns:
        return {
            "applyReady": False,
            "blockingReasons": ["intake-missing-columns:" + "|".join(missing_intake_columns)],
            "rows": len(manifest_rows),
            "updates": [],
        }

    intake_by_id: dict[str, dict[str, str]] = {}
    duplicate_intake_ids: list[str] = []
    for row in intake_rows:
        recording_id = row.get("recordingId", "").strip()
        if not recording_id:
            continue
        if recording_id in intake_by_id:
            duplicate_intake_ids.append(recording_id)
            continue
        intake_by_id[recording_id] = row

    blockers: list[str] = []
    if duplicate_intake_ids:
        blockers.append("intake-duplicate-recording-ids:" + "|".join(duplicate_intake_ids[:20]))

    updates: list[dict[str, str]] = []
    updated_rows: list[dict[str, str]] = []
    seen_manifest_ids: set[str] = set()
    for row in manifest_rows:
        updated = dict(row)
        recording_id = row.get("recordingId", "").strip()
        if not recording_id:
            blockers.append("manifest-recordingId-missing")
            updated_rows.append(updated)
            continue
        if recording_id in seen_manifest_ids:
            blockers.append("manifest-duplicate-recording-id:" + recording_id)
            updated_rows.append(updated)
            continue
        seen_manifest_ids.add(recording_id)

        intake = intake_by_id.get(recording_id)
        if intake is None:
            blockers.append("intake-row-missing:" + recording_id)
            updated_rows.append(updated)
            continue

        score_id = intake.get("scoreId", "").strip()
        current_score_path = intake.get("currentScorePath", "").strip()
        clean_score_path = intake.get("requiredCleanScorePath", "").strip()
        review_approved = is_approved_review_status(intake.get("cleanScoreReviewStatus", ""))
        reviewer_present = has_reviewer(intake.get("cleanScoreReviewedBy", ""))
        if score_id:
            if not review_approved:
                blockers.append("clean-score-not-reviewed:" + recording_id)
                updated_rows.append(updated)
                continue
            if not reviewer_present:
                blockers.append("clean-score-reviewer-missing:" + recording_id)
                updated_rows.append(updated)
                continue
            updated["scoreId"] = score_id
            updated["scorePath"] = ""
            updates.append({"recordingId": recording_id, "mode": "scoreId", "value": score_id})
        elif is_clean_score_path(current_score_path):
            updated["scorePath"] = current_score_path
            updated["scoreId"] = ""
            updates.append({"recordingId": recording_id, "mode": "scorePath", "value": current_score_path})
        elif is_clean_score_path(clean_score_path):
            if not review_approved:
                blockers.append("clean-score-not-reviewed:" + recording_id)
                updated_rows.append(updated)
                continue
            if not reviewer_present:
                blockers.append("clean-score-reviewer-missing:" + recording_id)
                updated_rows.append(updated)
                continue
            updated["scorePath"] = clean_score_path
            updated["scoreId"] = ""
            updates.append({"recordingId": recording_id, "mode": "scorePath", "value": clean_score_path})
        else:
            if not review_approved:
                blockers.append("clean-score-not-reviewed:" + recording_id)
            blockers.append("clean-score-missing:" + recording_id)
        updated_rows.append(updated)

    unknown_intake_ids = sorted(set(intake_by_id).difference(seen_manifest_ids))
    if unknown_intake_ids:
        blockers.append("intake-unknown-recording-ids:" + "|".join(unknown_intake_ids[:20]))

    return {
        "applyReady": not blockers,
        "blockingReasons": blockers,
        "rows": len(manifest_rows),
        "updates": updates,
        "updatedRows": updated_rows,
        "manifestColumns": manifest_columns,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Apply M2f clean-score intake rows to the real-student recording manifest."
    )
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--intake", default=str(DEFAULT_INTAKE))
    parser.add_argument("--out", default="", help="optional output manifest path; defaults to --manifest with --apply")
    parser.add_argument("--apply", action="store_true", help="write the updated manifest; dry-run by default")
    parser.add_argument("--expect-ready", action="store_true")
    parser.add_argument("--expect-not-ready", action="store_true")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    intake_path = Path(args.intake)
    if not manifest_path.exists():
        raise SystemExit(f"Manifest not found: {manifest_path}")
    if not intake_path.exists():
        raise SystemExit(f"Clean-score intake not found: {intake_path}")

    summary = apply_clean_scores(manifest_path, intake_path)
    updated_rows = summary.pop("updatedRows", [])
    manifest_columns = summary.pop("manifestColumns", [])

    out_path = Path(args.out) if args.out else manifest_path
    if args.apply:
        if not summary["applyReady"]:
            print(json.dumps(summary, indent=2, ensure_ascii=False))
            raise SystemExit("Clean-score intake is not ready; manifest was not changed.")
        write_csv(out_path, manifest_columns, updated_rows)
        summary["written"] = str(out_path)
    else:
        summary["written"] = ""
        summary["dryRun"] = True

    print(json.dumps(summary, indent=2, ensure_ascii=False))
    if args.expect_ready and not summary["applyReady"]:
        raise SystemExit("Expected clean-score intake to be ready, but it was not.")
    if args.expect_not_ready and summary["applyReady"]:
        raise SystemExit("Expected clean-score intake to be not ready, but it was ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
