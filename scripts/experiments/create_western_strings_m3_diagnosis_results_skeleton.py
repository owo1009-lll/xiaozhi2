from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recordings-manifest.csv"
DEFAULT_M2F_RESULTS = REPO / "data" / "experiments" / "western-strings-m2" / "real-student-recording-results.csv"
DEFAULT_PREVIEWS = REPO / "data" / "experiments" / "western-strings-m2" / "results-review-pack" / "recording-previews.json"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m3" / "real-student-diagnosis-results.csv"

DIAGNOSIS_CATEGORIES = ["pitch", "onset", "duration", "missing", "extra"]
BASE_COLUMNS = ["recordingId", "scenario", "autoPassEvaluatedCount"]
DIAGNOSIS_COLUMNS = [
    f"{category}{suffix}"
    for category in DIAGNOSIS_CATEGORIES
    for suffix in ["AutoIssueCount", "CorrectIssueCount", "UnsafeIssueCount"]
]
COLUMNS = BASE_COLUMNS + DIAGNOSIS_COLUMNS + ["notes"]


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
      return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def read_preview_auto_pass_counts(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    counts: dict[str, int] = {}
    for recording in data.get("recordings", []):
        recording_id = str(recording.get("recordingId") or "").strip()
        if not recording_id:
            continue
        try:
            counts[recording_id] = int(round(float(recording.get("autoPassCount") or 0)))
        except (TypeError, ValueError):
            counts[recording_id] = 0
    return counts


def read_result_auto_pass_counts(path: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in read_csv(path):
        recording_id = str(row.get("recordingId") or "").strip()
        if not recording_id:
            continue
        try:
            counts[recording_id] = int(round(float(row.get("autoPassCount") or 0)))
        except (TypeError, ValueError):
            counts[recording_id] = 0
    return counts


def build_rows(
    manifest_rows: list[dict[str, str]],
    m2f_counts: dict[str, int],
    preview_counts: dict[str, int],
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for manifest_row in manifest_rows:
        recording_id = str(manifest_row.get("recordingId") or "").strip()
        if not recording_id:
            continue
        row: dict[str, str] = {column: "" for column in COLUMNS}
        row["recordingId"] = recording_id
        row["scenario"] = str(manifest_row.get("scenario") or "").strip()
        row["autoPassEvaluatedCount"] = str(m2f_counts.get(recording_id, preview_counts.get(recording_id, 0)))
        for column in DIAGNOSIS_COLUMNS:
            row[column] = "0"
        row["notes"] = "M3 diagnosis counts must come from teacher/gold review; change zeros only after review."
        rows.append(row)
    return rows


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create the Western Strings M3 diagnosis review skeleton.")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--m2f-results", type=Path, default=DEFAULT_M2F_RESULTS)
    parser.add_argument("--previews", type=Path, default=DEFAULT_PREVIEWS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest_rows = read_csv(args.manifest)
    if not manifest_rows:
        raise SystemExit(f"manifest has no rows: {args.manifest}")
    rows = build_rows(
        manifest_rows=manifest_rows,
        m2f_counts=read_result_auto_pass_counts(args.m2f_results),
        preview_counts=read_preview_auto_pass_counts(args.previews),
    )
    write_csv(args.out, rows)
    print(json.dumps({
        "ok": True,
        "out": str(args.out.relative_to(REPO) if args.out.is_relative_to(REPO) else args.out),
        "rows": len(rows),
        "categories": DIAGNOSIS_CATEGORIES,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
