# -*- coding: utf-8 -*-
"""Diagnose the failed ordinary-upload confidence recalibration validation pack.

This script is eval-only. It does not retrain models, merge labels, or enable any
runtime gate. It explains why the current recalibration blind-validation pack
failed and writes small artifacts for the next feature/model iteration.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from eval_western_controlled_candidate_confidence import (
    build_feature_row,
    enrich_from_candidate_artifact,
    safe_string,
)


REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROWS = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-recalibration-validation-review"
    / "confidence-recalibration-validation-eval-rows.csv"
)
DEFAULT_JSON = DEFAULT_ROWS.with_name("confidence-recalibration-failure-diagnosis.json")
DEFAULT_ROWS_CSV = DEFAULT_ROWS.with_name("confidence-recalibration-failure-diagnosis-rows.csv")
DEFAULT_GROUPS_CSV = DEFAULT_ROWS.with_name("confidence-recalibration-failure-diagnosis-groups.csv")


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


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


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def status(row: dict[str, Any]) -> str:
    return safe_string(row.get("teacherCandidateStatus")).strip().lower()


def scenario_from_recording(recording_id: str) -> str:
    bits = [part for part in recording_id.split("-") if part]
    return bits[-1] if bits else "unknown"


def boolish(value: Any) -> bool:
    return str(value).strip().lower() in {"true", "yes", "1"}


def enriched_eval_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        enriched = enrich_from_candidate_artifact(row)
        features = build_feature_row(enriched)
        probability = safe_float(row.get("predictedUsableProbability"))
        abs_cents = features.get("absCentsError")
        pitch_support = boolish(enriched.get("pitchSupportWithin80Cents"))
        item = {
            "reviewRowNumber": row.get("reviewRowNumber", ""),
            "piece": row.get("piece", ""),
            "recordingId": row.get("recordingId", ""),
            "recordingScenario": scenario_from_recording(row.get("recordingId", "")),
            "candidateId": row.get("candidateId", ""),
            "teacherCandidateStatus": status(row),
            "predictedUsableProbability": "" if probability is None else round(probability, 6),
            "threshold": row.get("threshold", ""),
            "selectedByThreshold": row.get("selectedByThreshold", ""),
            "measureIndex": row.get("measureIndex", enriched.get("measureIndex", "")),
            "pageNumber": row.get("pageNumber", enriched.get("pageNumber", "")),
            "midi": enriched.get("midi", row.get("midi", "")),
            "medianObservedMidi": enriched.get("medianObservedMidi", ""),
            "centsError": enriched.get("centsError", ""),
            "absCentsError": "" if abs_cents is None else round(float(abs_cents), 3),
            "pitchSupportWithin80Cents": "true" if pitch_support else "false",
            "voicedFrameCount": enriched.get("voicedFrameCount", ""),
            "predictedOnsetSeconds": row.get("predictedOnsetSeconds", enriched.get("predictedOnsetSeconds", "")),
            "candidateRowsPath": row.get("candidateRowsPath", ""),
        }
        flags = []
        if item["teacherCandidateStatus"] == "wrong" and item["selectedByThreshold"] == "yes":
            flags.append("false-positive-selected")
        if not pitch_support:
            flags.append("no-pitch-support")
        if abs_cents is not None and float(abs_cents) > 1200:
            flags.append("octave-or-localization-scale-pitch-error")
        if item["recordingScenario"] == "weak_onset":
            flags.append("weak-onset-recording")
        item["riskFlags"] = "|".join(flags)
        out.append(item)
    return out


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    selected = [row for row in rows if row.get("selectedByThreshold") == "yes"]
    scored = [row for row in selected if row.get("teacherCandidateStatus") in {"usable", "wrong"}]
    usable = [row for row in scored if row.get("teacherCandidateStatus") == "usable"]
    wrong = [row for row in scored if row.get("teacherCandidateStatus") == "wrong"]
    pitch_support_selected = [row for row in scored if row.get("pitchSupportWithin80Cents") == "true"]
    abs_cents_values = [
        float(row["absCentsError"])
        for row in scored
        if row.get("absCentsError") not in {"", None}
    ]
    return {
        "rowCount": len(rows),
        "selectedRows": len(selected),
        "selectedScoredRows": len(scored),
        "selectedUsableRows": len(usable),
        "selectedWrongRows": len(wrong),
        "selectedPrecision": round(len(usable) / len(scored), 6) if scored else None,
        "pitchSupportSelectedRows": len(pitch_support_selected),
        "pitchSupportSelectedPrecision": (
            round(sum(1 for row in pitch_support_selected if row.get("teacherCandidateStatus") == "usable") / len(pitch_support_selected), 6)
            if pitch_support_selected else None
        ),
        "allSelectedRowsLackPitchSupport": bool(scored) and not pitch_support_selected,
        "minSelectedAbsCentsError": round(min(abs_cents_values), 3) if abs_cents_values else None,
        "maxSelectedAbsCentsError": round(max(abs_cents_values), 3) if abs_cents_values else None,
        "dominantFailureRecording": Counter(row.get("recordingId") for row in wrong).most_common(1)[0][0] if wrong else "",
        "diagnosis": (
            "false-positives-are-recording-specific-and-not-separated-by-current-deployable-pitch-support-features"
            if wrong else "no-selected-false-positives"
        ),
    }


def group_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[("recordingId", row.get("recordingId") or "blank")].append(row)
        groups[("recordingScenario", row.get("recordingScenario") or "blank")].append(row)
    out = []
    for (group, value), group_items in groups.items():
        selected = [row for row in group_items if row.get("selectedByThreshold") == "yes"]
        scored = [row for row in selected if row.get("teacherCandidateStatus") in {"usable", "wrong"}]
        usable = sum(1 for row in scored if row.get("teacherCandidateStatus") == "usable")
        wrong = sum(1 for row in scored if row.get("teacherCandidateStatus") == "wrong")
        out.append({
            "group": group,
            "value": value,
            "selectedRows": len(selected),
            "selectedUsableRows": usable,
            "selectedWrongRows": wrong,
            "selectedPrecision": round(usable / len(scored), 6) if scored else "",
            "exampleRows": "|".join(str(row.get("reviewRowNumber")) for row in selected[:5]),
        })
    out.sort(key=lambda row: (-int(row["selectedWrongRows"]), str(row["group"]), str(row["value"])))
    return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Diagnose failed P1 confidence recalibration validation rows.")
    parser.add_argument("--rows", default=str(DEFAULT_ROWS))
    parser.add_argument("--out-json", default=str(DEFAULT_JSON))
    parser.add_argument("--out-rows-csv", default=str(DEFAULT_ROWS_CSV))
    parser.add_argument("--out-groups-csv", default=str(DEFAULT_GROUPS_CSV))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows_path = repo_path(args.rows)
    out_json = repo_path(args.out_json)
    out_rows = repo_path(args.out_rows_csv)
    out_groups = repo_path(args.out_groups_csv)
    rows = enriched_eval_rows(read_csv(rows_path))
    groups = group_rows(rows)
    summary = summarize(rows)
    payload = {
        "ok": True,
        "source": repo_relative(rows_path),
        "summary": summary,
        "topFalsePositiveRows": [row for row in rows if row.get("teacherCandidateStatus") == "wrong"][:10],
        "artifacts": {
            "rowsCsv": repo_relative(out_rows),
            "groupsCsv": repo_relative(out_groups),
        },
        "nextRecommendation": (
            "Do not re-review the same 10-row pack or only raise threshold. "
            "The current selected rows all lack pitch support and the false positives cluster in a weak_onset recording; "
            "add deployable candidate/localization quality features or collect stronger calibration evidence before another blind pack."
        ),
    }
    write_json(out_json, payload)
    write_csv(out_rows, rows, [
        "reviewRowNumber",
        "piece",
        "recordingId",
        "recordingScenario",
        "candidateId",
        "teacherCandidateStatus",
        "predictedUsableProbability",
        "threshold",
        "selectedByThreshold",
        "measureIndex",
        "pageNumber",
        "midi",
        "medianObservedMidi",
        "centsError",
        "absCentsError",
        "pitchSupportWithin80Cents",
        "voicedFrameCount",
        "predictedOnsetSeconds",
        "riskFlags",
        "candidateRowsPath",
    ])
    write_csv(out_groups, groups, [
        "group",
        "value",
        "selectedRows",
        "selectedUsableRows",
        "selectedWrongRows",
        "selectedPrecision",
        "exampleRows",
    ])
    print(json.dumps({
        "ok": True,
        "summary": summary,
        "artifacts": {
            "json": repo_relative(out_json),
            "rowsCsv": repo_relative(out_rows),
            "groupsCsv": repo_relative(out_groups),
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
