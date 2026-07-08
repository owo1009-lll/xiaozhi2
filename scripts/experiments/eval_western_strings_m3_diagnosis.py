from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recordings-manifest.csv"
DEFAULT_RESULTS = REPO / "data" / "experiments" / "western-strings-m3" / "real-student-diagnosis-results.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m3" / "m3-diagnosis-summary.json"

DIAGNOSIS_CATEGORIES = ["pitch", "onset", "duration", "missing", "extra"]
DEFAULT_REQUIRED_CATEGORIES = ["pitch", "onset", "missing"]


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def safe_int(value: Any) -> int | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric):
        return None
    return int(round(numeric))


def summarize(
    manifest_path: Path,
    results_path: Path,
    *,
    min_precision: float,
    min_auto_issues_per_category: int,
    required_categories: list[str],
) -> dict[str, Any]:
    manifest_rows = read_csv(manifest_path)
    result_rows = read_csv(results_path)
    manifest_ids = {str(row.get("recordingId") or "").strip() for row in manifest_rows if str(row.get("recordingId") or "").strip()}
    result_ids = {str(row.get("recordingId") or "").strip() for row in result_rows if str(row.get("recordingId") or "").strip()}
    blocking: list[str] = []
    invalid_rows: list[dict[str, Any]] = []

    if not manifest_rows:
        blocking.append("manifest-missing-or-empty")
    if not result_rows:
        blocking.append("results-missing-or-empty")

    missing_ids = sorted(manifest_ids - result_ids)
    unknown_ids = sorted(result_ids - manifest_ids)
    if missing_ids:
        blocking.append("missing-result-recordings")
    if unknown_ids:
        blocking.append("unknown-result-recordings")

    required_set = set(required_categories)
    totals = {
        category: {
            "requiredForRelease": category in required_set,
            "autoIssueCount": 0,
            "correctIssueCount": 0,
            "unsafeIssueCount": 0,
            "precision": None,
            "ready": False,
            "status": "pending",
        }
        for category in DIAGNOSIS_CATEGORIES
    }
    auto_pass_evaluated = 0

    for index, row in enumerate(result_rows, start=2):
        recording_id = str(row.get("recordingId") or "").strip()
        auto_pass = safe_int(row.get("autoPassEvaluatedCount"))
        if auto_pass is None or auto_pass < 0:
            invalid_rows.append({"row": index, "recordingId": recording_id, "reason": "invalid-autoPassEvaluatedCount"})
        else:
            auto_pass_evaluated += auto_pass
        for category in DIAGNOSIS_CATEGORIES:
            values = {}
            for field in ["AutoIssueCount", "CorrectIssueCount", "UnsafeIssueCount"]:
                column = f"{category}{field}"
                value = safe_int(row.get(column))
                if value is None or value < 0:
                    invalid_rows.append({"row": index, "recordingId": recording_id, "reason": f"invalid-{column}"})
                    value = 0
                values[field] = value
            if values["CorrectIssueCount"] > values["AutoIssueCount"]:
                invalid_rows.append({"row": index, "recordingId": recording_id, "reason": f"{category}-correct-exceeds-auto"})
            if values["UnsafeIssueCount"] > values["AutoIssueCount"]:
                invalid_rows.append({"row": index, "recordingId": recording_id, "reason": f"{category}-unsafe-exceeds-auto"})
            totals[category]["autoIssueCount"] += values["AutoIssueCount"]
            totals[category]["correctIssueCount"] += values["CorrectIssueCount"]
            totals[category]["unsafeIssueCount"] += values["UnsafeIssueCount"]

    if invalid_rows:
        blocking.append("invalid-result-rows")

    for category, stats in totals.items():
        auto_issues = int(stats["autoIssueCount"])
        correct = int(stats["correctIssueCount"])
        unsafe = int(stats["unsafeIssueCount"])
        precision = (correct / auto_issues) if auto_issues else None
        stats["precision"] = round(precision, 6) if precision is not None else None
        required = bool(stats["requiredForRelease"])
        stats["ready"] = (
            required
            and auto_issues >= min_auto_issues_per_category
            and precision is not None
            and precision >= min_precision
            and unsafe == 0
        )
        if not required:
            stats["status"] = "review_only"
            continue
        if auto_issues < min_auto_issues_per_category:
            stats["status"] = "insufficient-auto-issues"
            blocking.append(f"{category}-insufficient-auto-issues")
        elif precision is None or precision < min_precision:
            stats["status"] = "precision-below-threshold"
            blocking.append(f"{category}-precision-below-threshold")
        elif unsafe:
            stats["status"] = "unsafe-diagnosis"
            blocking.append(f"{category}-unsafe-diagnosis")
        else:
            stats["status"] = "ready"

    ok = not blocking
    return {
        "ok": ok,
        "diagnosisGateReady": ok,
        "gate": {
            "name": "western-strings-m3-basic-diagnosis",
            "minPrecision": min_precision,
            "minAutoIssuesPerCategory": min_auto_issues_per_category,
            "categories": DIAGNOSIS_CATEGORIES,
            "requiredCategories": required_categories,
            "reviewOnlyCategories": [category for category in DIAGNOSIS_CATEGORIES if category not in required_set],
        },
        "manifestPath": str(manifest_path.relative_to(REPO) if manifest_path.is_relative_to(REPO) else manifest_path),
        "resultsPath": str(results_path.relative_to(REPO) if results_path.is_relative_to(REPO) else results_path),
        "blockingReasons": sorted(set(blocking)),
        "recordings": {
            "manifestRows": len(manifest_rows),
            "resultRows": len(result_rows),
            "missingRecordingIds": missing_ids,
            "unknownRecordingIds": unknown_ids,
        },
        "autoPassEvaluatedCount": auto_pass_evaluated,
        "categories": totals,
        "invalidRows": invalid_rows,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate the Western Strings M3 diagnosis gate.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--min-precision", type=float, default=0.9)
    parser.add_argument("--min-auto-issues-per-category", type=int, default=1)
    parser.add_argument(
        "--required-categories",
        default=",".join(DEFAULT_REQUIRED_CATEGORIES),
        help="Comma-separated categories required for this release gate, or 'all'. Non-required categories remain review-only.",
    )
    parser.add_argument("--fail-on-not-ready", action="store_true")
    return parser.parse_args()


def parse_required_categories(value: str) -> list[str]:
    text = str(value or "").strip().lower()
    if text == "all":
        return list(DIAGNOSIS_CATEGORIES)
    categories = [item.strip() for item in text.split(",") if item.strip()]
    invalid = [item for item in categories if item not in DIAGNOSIS_CATEGORIES]
    if invalid:
        raise SystemExit(f"invalid required categories: {', '.join(invalid)}")
    if not categories:
        raise SystemExit("required categories cannot be empty")
    return categories


def main() -> int:
    args = parse_args()
    summary = summarize(
        manifest_path=args.manifest,
        results_path=args.results,
        min_precision=args.min_precision,
        min_auto_issues_per_category=max(0, args.min_auto_issues_per_category),
        required_categories=parse_required_categories(args.required_categories),
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if args.fail_on_not_ready and not summary["diagnosisGateReady"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
