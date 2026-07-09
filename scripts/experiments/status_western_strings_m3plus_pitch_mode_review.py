from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_PACK_DIR = REPO / "data" / "experiments" / "western-strings-m3plus" / "pitch-mode-review-pack"
DEFAULT_SOURCE = DEFAULT_PACK_DIR / "m3plus-pitch-mode-review.csv"
DEFAULT_LABELS = DEFAULT_PACK_DIR / "m3plus-pitch-mode-review-labels.csv"
DEFAULT_COMPLETED = DEFAULT_PACK_DIR / "m3plus-pitch-mode-review.completed.csv"
DEFAULT_OUT = DEFAULT_PACK_DIR / "m3plus-pitch-mode-review-status.json"

MATCH_VALUES = {"match", "mismatch", "uncertain"}
JUDGEABLE_VALUES = {"yes", "no", "uncertain"}
PITCH_LABEL_VALUES = {"in-tune", "sharp", "flat", "wrong-note", "not-judgeable", "uncertain"}


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def is_reviewed(row: dict[str, str]) -> bool:
    fields = [
        "audioScoreMatch",
        "observedPitchBehavior",
        "pitchJudgementMode",
        "pitchJudgeable",
        "pitchAccuracyLabel",
        "reviewConfidence",
        "reviewComments",
    ]
    return any(str(row.get(field, "")).strip() for field in fields)


def is_scored(row: dict[str, str]) -> bool:
    return (
        str(row.get("audioScoreMatch", "")).strip() == "match"
        and str(row.get("pitchJudgeable", "")).strip() == "yes"
        and str(row.get("pitchAccuracyLabel", "")).strip() in {"in-tune", "sharp", "flat", "wrong-note"}
    )


def build_status(
    source_path: Path,
    labels_path: Path,
    completed_path: Path,
    out_path: Path,
    min_reviewed_per_mode: int,
    min_scored_per_mode: int,
) -> dict[str, Any]:
    source_rows = read_csv(source_path)
    label_rows = read_csv(labels_path)
    source_ids = {row.get("rowId", "") for row in source_rows}
    for row in label_rows:
        row_id = row.get("rowId", "")
        if row_id and row_id not in source_ids:
            source_rows.append(row)
            source_ids.add(row_id)
    labels_by_id = {row.get("rowId", ""): row for row in label_rows if row.get("rowId", "")}

    reviewed_rows = [row for row in label_rows if row.get("rowId", "") in source_ids and is_reviewed(row)]
    scored_rows = [row for row in reviewed_rows if is_scored(row)]

    mode_totals = Counter(row.get("candidateMode", "") for row in source_rows)
    mode_reviewed = Counter(row.get("candidateMode", "") for row in reviewed_rows)
    mode_scored = Counter(row.get("candidateMode", "") for row in scored_rows)
    match_counts = Counter(str(row.get("audioScoreMatch", "")).strip() or "blank" for row in reviewed_rows)
    label_counts = Counter(str(row.get("pitchAccuracyLabel", "")).strip() or "blank" for row in reviewed_rows)
    behavior_counts = Counter(str(row.get("observedPitchBehavior", "")).strip() or "blank" for row in reviewed_rows)

    per_mode: dict[str, dict[str, int]] = {}
    for mode in sorted(mode_totals):
        per_mode[mode] = {
            "total": int(mode_totals[mode]),
            "reviewed": int(mode_reviewed[mode]),
            "scored": int(mode_scored[mode]),
            "reviewedDeficit": max(0, int(min_reviewed_per_mode) - int(mode_reviewed[mode])),
            "scoredDeficit": max(0, int(min_scored_per_mode) - int(mode_scored[mode])),
        }

    blocking_reasons: list[str] = []
    if not source_path.exists():
        blocking_reasons.append("m3plus-review-source-missing")
    if not labels_path.exists():
        blocking_reasons.append("m3plus-review-labels-missing")
    if not completed_path.exists():
        blocking_reasons.append("m3plus-review-completed-csv-missing")
    if any(item["reviewedDeficit"] > 0 for item in per_mode.values()):
        blocking_reasons.append("m3plus-review-reviewed-per-mode-too-low")
    if any(item["scoredDeficit"] > 0 for item in per_mode.values()):
        blocking_reasons.append("m3plus-review-scored-per-mode-too-low")

    gate_ready = not blocking_reasons
    status = {
        "ok": True,
        "m3plusModeEvalReady": gate_ready,
        "gate": {
            "name": "western-strings-m3plus-pitch-mode-review-status",
            "studentGateReady": False,
            "reason": "human-label-status-only",
            "runtimeEffect": "none",
        },
        "paths": {
            "source": str(source_path.relative_to(REPO) if source_path.is_relative_to(REPO) else source_path),
            "labels": str(labels_path.relative_to(REPO) if labels_path.is_relative_to(REPO) else labels_path),
            "completedCsv": str(completed_path.relative_to(REPO) if completed_path.is_relative_to(REPO) else completed_path),
            "out": str(out_path.relative_to(REPO) if out_path.is_relative_to(REPO) else out_path),
        },
        "counts": {
            "rowCount": len(source_rows),
            "labelRows": len(label_rows),
            "reviewedRows": len(reviewed_rows),
            "scoredRows": len(scored_rows),
            "missingLabelRows": max(0, len(source_rows) - len(labels_by_id)),
        },
        "perMode": per_mode,
        "matchCounts": dict(sorted(match_counts.items())),
        "pitchAccuracyLabelCounts": dict(sorted(label_counts.items())),
        "observedPitchBehaviorCounts": dict(sorted(behavior_counts.items())),
        "blockingReasons": blocking_reasons,
        "nextActions": (
            ["M3+ review labels are sufficient for offline mode evaluation."]
            if gate_ready
            else [
                "Open the M3+ review pack HTML, finish labels, download m3plus-pitch-mode-review.completed.csv, then run western:m3plus-review-import.",
                "Keep runtime/student gate review-only until per-mode precision is evaluated separately.",
            ]
        ),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    return status


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Report M3+ pitch-mode review label status.")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--completed", default=str(DEFAULT_COMPLETED))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-reviewed-per-mode", type=int, default=5)
    parser.add_argument("--min-scored-per-mode", type=int, default=3)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    status = build_status(
        repo_path(args.source),
        repo_path(args.labels),
        repo_path(args.completed),
        repo_path(args.out),
        int(args.min_reviewed_per_mode),
        int(args.min_scored_per_mode),
    )
    print(json.dumps(status, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
