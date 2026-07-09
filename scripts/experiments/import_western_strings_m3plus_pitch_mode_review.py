from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any

from status_western_strings_m3plus_pitch_mode_review import (
    DEFAULT_COMPLETED,
    DEFAULT_LABELS,
    DEFAULT_OUT,
    DEFAULT_SOURCE,
    REPO,
    build_status,
    repo_path,
)


REVIEW_COLUMNS = [
    "rowId",
    "recordingId",
    "scenario",
    "noteIndex",
    "noteId",
    "measureIndex",
    "pageNumber",
    "midi",
    "predictedOnsetSeconds",
    "predictedDurationSeconds",
    "candidateMode",
    "flags",
    "audioClip",
    "audioScoreMatch",
    "observedPitchBehavior",
    "pitchJudgementMode",
    "pitchJudgeable",
    "pitchAccuracyLabel",
    "reviewConfidence",
    "reviewComments",
]

AUDIO_MATCH = {"", "match", "mismatch", "uncertain"}
PITCH_BEHAVIOR = {
    "",
    "stable",
    "vibrato",
    "slide",
    "trill",
    "ornament",
    "double-stop",
    "harmonic",
    "variable-f0",
    "other",
    "uncertain",
}
JUDGEMENT_MODE = {
    "",
    "normal-center",
    "vibrato-center",
    "slide-start-end",
    "trill-two-targets",
    "ornament-main-note",
    "multi-f0",
    "sounding-pitch",
    "not-judgeable",
    "uncertain",
}
PITCH_JUDGEABLE = {"", "yes", "no", "uncertain"}
PITCH_LABEL = {"", "in-tune", "sharp", "flat", "wrong-note", "not-judgeable", "uncertain"}


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=REVIEW_COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in REVIEW_COLUMNS})


def clean_enum(value: Any, allowed: set[str]) -> str:
    text = str(value if value is not None else "").strip()
    return text if text in allowed else ""


def clean_confidence(value: Any) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        return ""
    try:
        number = int(float(text))
    except ValueError:
        return ""
    if number < 1 or number > 5:
        return ""
    return str(number)


def normalize_row(row: dict[str, Any], source_row: dict[str, str]) -> dict[str, str]:
    merged = {column: str(source_row.get(column, "") or "") for column in REVIEW_COLUMNS}
    for column in REVIEW_COLUMNS:
        if column in row and str(row.get(column, "")).strip() != "":
            merged[column] = str(row.get(column, "")).strip()
    merged["audioScoreMatch"] = clean_enum(merged.get("audioScoreMatch"), AUDIO_MATCH)
    merged["observedPitchBehavior"] = clean_enum(merged.get("observedPitchBehavior"), PITCH_BEHAVIOR)
    merged["pitchJudgementMode"] = clean_enum(merged.get("pitchJudgementMode"), JUDGEMENT_MODE)
    merged["pitchJudgeable"] = clean_enum(merged.get("pitchJudgeable"), PITCH_JUDGEABLE)
    merged["pitchAccuracyLabel"] = clean_enum(merged.get("pitchAccuracyLabel"), PITCH_LABEL)
    merged["reviewConfidence"] = clean_confidence(merged.get("reviewConfidence"))
    return merged


def merge_labels(source_path: Path, completed_path: Path, labels_path: Path) -> dict[str, Any]:
    if not source_path.exists():
        raise SystemExit(f"Missing source review CSV: {source_path}")
    if not completed_path.exists():
        raise SystemExit(f"Missing completed review CSV: {completed_path}")
    source_rows = read_csv(source_path)
    completed_rows = read_csv(completed_path)
    existing_rows = read_csv(labels_path)
    source_by_id = {row.get("rowId", ""): row for row in source_rows if row.get("rowId", "")}
    merged_by_id = {row.get("rowId", ""): row for row in existing_rows if row.get("rowId", "")}
    imported = 0
    skipped_unknown = 0
    for row in completed_rows:
        row_id = str(row.get("rowId", "")).strip()
        if not row_id or row_id not in source_by_id:
            skipped_unknown += 1
            continue
        merged_by_id[row_id] = normalize_row(row, source_by_id[row_id])
        imported += 1
    ordered_rows = [merged_by_id[row.get("rowId", "")] for row in source_rows if row.get("rowId", "") in merged_by_id]
    source_ids = {row.get("rowId", "") for row in source_rows if row.get("rowId", "")}
    for row in existing_rows:
        row_id = row.get("rowId", "")
        if row_id and row_id not in source_ids and row_id in merged_by_id:
            ordered_rows.append(merged_by_id[row_id])
    write_csv(labels_path, ordered_rows)
    return {
        "importedRows": imported,
        "skippedUnknownRows": skipped_unknown,
        "labelRows": len(ordered_rows),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import completed M3+ pitch-mode review labels.")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--reviews", default=str(DEFAULT_COMPLETED))
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--status-out", default=str(DEFAULT_OUT))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_path = repo_path(args.source)
    reviews_path = repo_path(args.reviews)
    labels_path = repo_path(args.labels)
    status_out = repo_path(args.status_out)
    import_summary = merge_labels(source_path, reviews_path, labels_path)
    status = build_status(source_path, labels_path, reviews_path, status_out, 5, 3)
    print(json.dumps({
        "ok": True,
        **import_summary,
        "status": {
            "m3plusModeEvalReady": status.get("m3plusModeEvalReady"),
            "blockingReasons": status.get("blockingReasons", []),
            "counts": status.get("counts", {}),
            "perMode": status.get("perMode", {}),
        },
        "paths": {
            "labels": str(labels_path.relative_to(REPO) if labels_path.is_relative_to(REPO) else labels_path),
            "status": str(status_out.relative_to(REPO) if status_out.is_relative_to(REPO) else status_out),
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
