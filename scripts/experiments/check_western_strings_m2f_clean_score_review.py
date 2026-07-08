from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from apply_western_strings_m2f_clean_scores import APPROVED_REVIEW_STATUS
from eval_western_strings_m2f_real_recordings import CLEAN_SCORE_EXTENSIONS
from eval_western_strings_m2f_real_recordings import DEFAULT_MANIFEST
from eval_western_strings_m2f_real_recordings import REPO
from eval_western_strings_m2f_real_recordings import load_score_ids
from eval_western_strings_m2f_real_recordings import read_csv
from eval_western_strings_m2f_real_recordings import repo_path


DEFAULT_INTAKE = REPO / "data" / "experiments" / "western-strings-m2" / "clean-score-intake.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "clean-score-review-status.json"


def is_approved(value: str) -> bool:
    return value.strip().lower() == APPROVED_REVIEW_STATUS


def has_reviewer(value: str) -> bool:
    return bool(value.strip())


def validate_target(row: dict[str, str], known_score_ids: set[str]) -> list[str]:
    errors: list[str] = []
    score_id = row.get("scoreId", "").strip()
    target_path = row.get("requiredCleanScorePath", "").strip()
    if score_id:
        if score_id not in known_score_ids:
            errors.append("scoreId-not-found")
        return errors
    if not target_path:
        return ["target-clean-score-missing"]
    resolved = repo_path(target_path)
    if not resolved.exists():
        errors.append("target-clean-score-not-found")
    elif not resolved.is_file():
        errors.append("target-clean-score-not-file")
    elif resolved.suffix.lower() not in CLEAN_SCORE_EXTENSIONS:
        errors.append("target-clean-score-extension-invalid")
    return errors


def check_review_status(intake_path: Path) -> dict[str, Any]:
    if not intake_path.exists():
        return {
            "reviewReady": False,
            "blockingReasons": ["clean-score-intake-missing"],
            "rows": 0,
            "approved": 0,
            "pending": 0,
            "invalidRows": [],
        }
    rows, columns = read_csv(intake_path)
    required_columns = {
        "recordingId",
        "requiredCleanScorePath",
        "scoreId",
        "cleanScoreReviewStatus",
        "cleanScoreReviewedBy",
    }
    missing_columns = sorted(required_columns.difference(columns))
    if missing_columns:
        return {
            "reviewReady": False,
            "blockingReasons": ["intake-missing-columns:" + "|".join(missing_columns)],
            "rows": len(rows),
            "approved": 0,
            "pending": len(rows),
            "invalidRows": [],
        }

    known_score_ids = load_score_ids()
    approved = 0
    pending = 0
    invalid_rows: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=2):
        recording_id = row.get("recordingId", "").strip()
        errors = validate_target(row, known_score_ids)
        if is_approved(row.get("cleanScoreReviewStatus", "")):
            approved += 1
            if not has_reviewer(row.get("cleanScoreReviewedBy", "")):
                errors.append("clean-score-reviewer-missing")
        else:
            pending += 1
            errors.append("clean-score-not-reviewed")
        if errors:
            invalid_rows.append({"line": index, "recordingId": recording_id, "errors": errors})

    blockers: list[str] = []
    if invalid_rows:
        blockers.append("clean-score-review-invalid-rows")
    if not rows:
        blockers.append("clean-score-intake-empty")
    return {
        "reviewReady": not blockers,
        "blockingReasons": blockers,
        "rows": len(rows),
        "approved": approved,
        "pending": pending,
        "invalidRows": invalid_rows[:50],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check M2f clean-score review approval status.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="reserved for command symmetry; not read")
    parser.add_argument("--intake", default=str(DEFAULT_INTAKE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--fail-on-not-ready", action="store_true")
    parser.add_argument("--expect-ready", action="store_true")
    parser.add_argument("--expect-not-ready", action="store_true")
    args = parser.parse_args()

    summary = check_review_status(Path(args.intake))
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    if args.expect_ready and not summary["reviewReady"]:
        raise SystemExit("Expected clean-score review to be ready, but it was not.")
    if args.expect_not_ready and summary["reviewReady"]:
        raise SystemExit("Expected clean-score review to be not ready, but it was ready.")
    if args.fail_on_not_ready and not summary["reviewReady"]:
        raise SystemExit("Clean-score review is not ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
