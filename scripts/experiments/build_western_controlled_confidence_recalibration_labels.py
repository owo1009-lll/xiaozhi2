# -*- coding: utf-8 -*-
"""Build eval-only labels for the ordinary-upload confidence recalibration pilot.

This combines the original controlled-candidate labels with the later
threshold-pool review labels. It is deliberately conservative:

- only human-reviewed statuses are copied;
- duplicate batch/submission/candidate keys are kept once;
- no runtime gate or model artifact is changed.
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_SOURCES = [
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "controlled-candidate-review-labels.csv",
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-threshold-pool-review"
    / "controlled-candidate-review.completed.csv",
]
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-recalibration"
    / "combined-controlled-candidate-review-labels.csv"
)


VALID_STATUSES = {"usable", "wrong", "uncertain"}


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def candidate_key(row: dict[str, Any]) -> str:
    return "::".join([
        str(row.get("batchRunId") or ""),
        str(row.get("submissionId") or ""),
        str(row.get("candidateId") or ""),
    ])


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_rows(path: Path, headers: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def build(sources: list[Path], out_path: Path) -> dict[str, Any]:
    headers: list[str] = []
    seen_headers: set[str] = set()
    seen_keys: set[str] = set()
    output_rows: list[dict[str, str]] = []
    source_summaries: list[dict[str, Any]] = []

    for source in sources:
        source_headers, rows = read_rows(source)
        for header in source_headers:
            if header not in seen_headers:
                headers.append(header)
                seen_headers.add(header)

        copied = 0
        skipped_duplicate = 0
        skipped_status = 0
        for row in rows:
            status = str(row.get("teacherCandidateStatus") or "").strip().lower()
            if status not in VALID_STATUSES:
                skipped_status += 1
                continue
            key = candidate_key(row)
            if key in seen_keys:
                skipped_duplicate += 1
                continue
            seen_keys.add(key)
            output_rows.append(row)
            copied += 1
        source_summaries.append({
            "source": repo_relative(source),
            "inputRows": len(rows),
            "copiedRows": copied,
            "skippedDuplicateRows": skipped_duplicate,
            "skippedUnreviewedRows": skipped_status,
        })

    write_rows(out_path, headers, output_rows)
    counts = Counter(str(row.get("teacherCandidateStatus") or "").strip().lower() for row in output_rows)
    return {
        "ok": True,
        "out": repo_relative(out_path),
        "rowCount": len(output_rows),
        "statusCounts": dict(sorted(counts.items())),
        "sources": source_summaries,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Combine reviewed confidence labels for eval-only recalibration.")
    parser.add_argument("--source", action="append", default=[], help="Input reviewed CSV. Can be passed multiple times.")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    sources = [repo_path(value) for value in args.source] if args.source else DEFAULT_SOURCES
    report = build(sources, repo_path(args.out))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
