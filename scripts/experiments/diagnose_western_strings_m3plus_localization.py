from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_PACK_DIR = REPO / "data" / "experiments" / "western-strings-m3plus" / "pitch-mode-review-pack"
DEFAULT_LABELS = DEFAULT_PACK_DIR / "m3plus-pitch-mode-review-labels.csv"
DEFAULT_JSON = DEFAULT_PACK_DIR / "m3plus-localization-diagnosis.json"
DEFAULT_GROUP_CSV = DEFAULT_PACK_DIR / "m3plus-localization-diagnosis-groups.csv"
DEFAULT_ROWS_CSV = DEFAULT_PACK_DIR / "m3plus-localization-diagnosis-rows.csv"

MATCH_VALUES = {"match", "mismatch", "uncertain"}


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fieldnames})


def clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def match_status(row: dict[str, str]) -> str:
    value = clean(row.get("audioScoreMatch"))
    return value if value in MATCH_VALUES else "blank"


def summarize_rows(rows: list[dict[str, str]]) -> dict[str, Any]:
    counts = Counter(match_status(row) for row in rows)
    total = len(rows)
    match = counts.get("match", 0)
    mismatch = counts.get("mismatch", 0)
    uncertain = counts.get("uncertain", 0)
    blank = counts.get("blank", 0)
    non_match = mismatch + uncertain + blank
    return {
        "total": total,
        "match": match,
        "mismatch": mismatch,
        "uncertain": uncertain,
        "blank": blank,
        "nonMatch": non_match,
        "matchRate": round(match / total, 6) if total else None,
        "nonMatchRate": round(non_match / total, 6) if total else None,
    }


def group_summary(rows: list[dict[str, str]], fields: tuple[str, ...], group_name: str) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, ...], list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        key = tuple(clean(row.get(field)) or "blank" for field in fields)
        buckets[key].append(row)

    out: list[dict[str, Any]] = []
    for key, group_rows in buckets.items():
        summary = summarize_rows(group_rows)
        out.append({
            "group": group_name,
            **{field: value for field, value in zip(fields, key)},
            **summary,
            "exampleRows": "|".join(clean(row.get("rowId")) for row in group_rows[:5] if clean(row.get("rowId"))),
        })
    out.sort(key=lambda item: (-float(item.get("nonMatchRate") or 0), -int(item.get("nonMatch") or 0), str(item)))
    return out


def row_diagnostics(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        status = match_status(row)
        out.append({
            "rowId": clean(row.get("rowId")),
            "recordingId": clean(row.get("recordingId")),
            "scenario": clean(row.get("scenario")),
            "candidateMode": clean(row.get("candidateMode")),
            "flags": clean(row.get("flags")),
            "noteIndex": clean(row.get("noteIndex")),
            "noteId": clean(row.get("noteId")),
            "measureIndex": clean(row.get("measureIndex")),
            "pageNumber": clean(row.get("pageNumber")),
            "midi": clean(row.get("midi")),
            "predictedOnsetSeconds": clean(row.get("predictedOnsetSeconds")),
            "audioScoreMatch": status,
            "observedPitchBehavior": clean(row.get("observedPitchBehavior")),
            "pitchJudgeable": clean(row.get("pitchJudgeable")),
            "pitchAccuracyLabel": clean(row.get("pitchAccuracyLabel")),
            "reviewConfidence": clean(row.get("reviewConfidence")),
            "reviewComments": clean(row.get("reviewComments")),
        })
    out.sort(key=lambda item: (
        0 if item["audioScoreMatch"] in {"mismatch", "uncertain", "blank"} else 1,
        item["recordingId"],
        safe_float(item["predictedOnsetSeconds"]) if safe_float(item["predictedOnsetSeconds"]) is not None else 1e9,
    ))
    return out


def diagnose(rows: list[dict[str, str]], min_group_total: int, high_risk_rate: float) -> dict[str, Any]:
    group_rows: list[dict[str, Any]] = []
    for fields, group_name in [
        (("recordingId",), "recording"),
        (("scenario",), "scenario"),
        (("candidateMode",), "candidateMode"),
        (("recordingId", "candidateMode"), "recording-candidateMode"),
        (("scenario", "candidateMode"), "scenario-candidateMode"),
    ]:
        group_rows.extend(group_summary(rows, fields, group_name))

    high_risk_groups = [
        row for row in group_rows
        if int(row.get("total") or 0) >= min_group_total
        and float(row.get("nonMatchRate") or 0) >= high_risk_rate
    ]
    high_risk_groups.sort(key=lambda item: (-float(item.get("nonMatchRate") or 0), -int(item.get("nonMatch") or 0), str(item)))

    summary = summarize_rows(rows)
    summary["highRiskGroupCount"] = len(high_risk_groups)
    summary["minGroupTotal"] = min_group_total
    summary["highRiskRate"] = high_risk_rate
    summary["status"] = (
        "localization-needs-candidate-quality-work"
        if summary["nonMatch"] else "localization-review-all-match"
    )

    return {
        "ok": True,
        "summary": summary,
        "highRiskGroups": high_risk_groups[:30],
        "groupRows": group_rows,
        "rowDiagnostics": row_diagnostics(rows),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Diagnose M3+ score-audio localization quality from review labels.")
    parser.add_argument("--labels", default=str(DEFAULT_LABELS))
    parser.add_argument("--out-json", default=str(DEFAULT_JSON))
    parser.add_argument("--out-groups-csv", default=str(DEFAULT_GROUP_CSV))
    parser.add_argument("--out-rows-csv", default=str(DEFAULT_ROWS_CSV))
    parser.add_argument("--min-group-total", type=int, default=3)
    parser.add_argument("--high-risk-rate", type=float, default=0.25)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = read_csv(repo_path(args.labels))
    report = diagnose(rows, int(args.min_group_total), float(args.high_risk_rate))

    out_json = repo_path(args.out_json)
    out_groups_csv = repo_path(args.out_groups_csv)
    out_rows_csv = repo_path(args.out_rows_csv)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps({
        "ok": report["ok"],
        "summary": report["summary"],
        "highRiskGroups": report["highRiskGroups"],
        "artifacts": {
            "groupsCsv": str(out_groups_csv.relative_to(REPO) if out_groups_csv.is_relative_to(REPO) else out_groups_csv),
            "rowsCsv": str(out_rows_csv.relative_to(REPO) if out_rows_csv.is_relative_to(REPO) else out_rows_csv),
        },
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(out_groups_csv, report["groupRows"], [
        "group",
        "recordingId",
        "scenario",
        "candidateMode",
        "total",
        "match",
        "mismatch",
        "uncertain",
        "blank",
        "nonMatch",
        "matchRate",
        "nonMatchRate",
        "exampleRows",
    ])
    write_csv(out_rows_csv, report["rowDiagnostics"], [
        "rowId",
        "recordingId",
        "scenario",
        "candidateMode",
        "flags",
        "noteIndex",
        "noteId",
        "measureIndex",
        "pageNumber",
        "midi",
        "predictedOnsetSeconds",
        "audioScoreMatch",
        "observedPitchBehavior",
        "pitchJudgeable",
        "pitchAccuracyLabel",
        "reviewConfidence",
        "reviewComments",
    ])
    print(json.dumps({
        "ok": True,
        "summary": report["summary"],
        "topHighRiskGroups": report["highRiskGroups"][:10],
        "artifacts": {
            "json": str(out_json.relative_to(REPO) if out_json.is_relative_to(REPO) else out_json),
            "groupsCsv": str(out_groups_csv.relative_to(REPO) if out_groups_csv.is_relative_to(REPO) else out_groups_csv),
            "rowsCsv": str(out_rows_csv.relative_to(REPO) if out_rows_csv.is_relative_to(REPO) else out_rows_csv),
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
