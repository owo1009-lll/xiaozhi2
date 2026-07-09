# -*- coding: utf-8 -*-
"""Diagnose why the ordinary-upload confidence gate failed threshold-pool review.

This script is eval-only. It joins the stratified threshold-pool completed
review CSV, the selection JSON, and the frozen-model eval rows, then reports:

- selected usable/wrong counts and precision;
- per-confidence-stratum status counts;
- high-confidence false positives;
- simple threshold/rule sweeps, to check whether an obvious safer operating
  point exists before doing deeper model work.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable


REPO = Path(__file__).resolve().parents[2]
DEFAULT_BASE = REPO / "data" / "experiments" / "western-strings-m3" / "confidence-threshold-pool-review"
DEFAULT_COMPLETED = DEFAULT_BASE / "controlled-candidate-review.completed.csv"
DEFAULT_SELECTION = DEFAULT_BASE / "candidate-confidence-threshold-pool-selection.json"
DEFAULT_EVAL_ROWS = DEFAULT_BASE / "confidence-threshold-pool-eval-rows.csv"
DEFAULT_EVAL_JSON = DEFAULT_BASE / "confidence-threshold-pool-eval.json"
DEFAULT_OUT = DEFAULT_BASE / "confidence-threshold-pool-diagnosis.json"


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
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def status_value(row: dict[str, Any]) -> str:
    return str(row.get("teacherCandidateStatus") or "").strip().lower()


def is_scored(row: dict[str, Any]) -> bool:
    return status_value(row) in {"usable", "wrong"}


def is_selected(row: dict[str, Any]) -> bool:
    return str(row.get("selectedByThreshold") or "").strip().lower() in {"yes", "true", "1"}


def review_row_number(row: dict[str, Any]) -> str:
    return str(row.get("reviewRowNumber") or "").strip()


def summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [row for row in rows if is_scored(row)]
    usable = [row for row in scored if status_value(row) == "usable"]
    wrong = [row for row in scored if status_value(row) == "wrong"]
    return {
        "rowCount": len(rows),
        "scoredRows": len(scored),
        "usableRows": len(usable),
        "wrongRows": len(wrong),
        "uncertainRows": sum(1 for row in rows if status_value(row) == "uncertain"),
        "precision": round(len(usable) / len(scored), 6) if scored else None,
    }


def summarize_rule(name: str, rows: list[dict[str, Any]], predicate: Callable[[dict[str, Any]], bool]) -> dict[str, Any] | None:
    selected = [row for row in rows if is_scored(row) and predicate(row)]
    if not selected:
        return None
    usable = sum(1 for row in selected if status_value(row) == "usable")
    wrong = sum(1 for row in selected if status_value(row) == "wrong")
    scored_total = sum(1 for row in rows if is_scored(row))
    return {
        "name": name,
        "selectedRows": len(selected),
        "usableRows": usable,
        "wrongRows": wrong,
        "precision": round(usable / len(selected), 6),
        "coverageWithinScoredRows": round(len(selected) / scored_total, 6) if scored_total else 0.0,
    }


def compact_candidate(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "reviewRowNumber": row.get("reviewRowNumber", ""),
        "teacherCandidateStatus": status_value(row),
        "confidenceStratum": row.get("confidenceStratum", ""),
        "predictedUsableProbability": safe_float(row.get("predictedUsableProbability")),
        "piece": row.get("piece", ""),
        "recordingId": row.get("recordingId", ""),
        "candidateId": row.get("candidateId", ""),
        "measureIndex": row.get("measureIndex", ""),
        "noteIndex": row.get("noteIndex", ""),
        "midi": row.get("midi", ""),
        "medianObservedMidi": row.get("medianObservedMidi", ""),
        "centsError": row.get("centsError", ""),
        "voicedFrameCount": row.get("voicedFrameCount", ""),
        "pitchSupportWithin80Cents": row.get("pitchSupportWithin80Cents", ""),
        "predictedOnsetSeconds": row.get("predictedOnsetSeconds", ""),
        "candidateRowsPath": row.get("candidateRowsPath", ""),
        "teacherComments": row.get("teacherComments", ""),
    }


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    completed_path = repo_path(args.completed_csv)
    selection_path = repo_path(args.selection_json)
    eval_rows_path = repo_path(args.eval_rows)
    eval_json_path = repo_path(args.eval_json)

    completed_rows = read_csv(completed_path)
    selection_rows = read_json(selection_path).get("rows") or []
    eval_rows = read_csv(eval_rows_path)
    eval_json = read_json(eval_json_path)

    by_number: dict[str, dict[str, Any]] = {}
    for row in selection_rows:
        by_number.setdefault(review_row_number(row), {}).update(row)
    for row in completed_rows:
        by_number.setdefault(review_row_number(row), {}).update(row)

    joined: list[dict[str, Any]] = []
    for row in eval_rows:
        number = review_row_number(row)
        joined.append({**by_number.get(number, {}), **row})

    selected = [row for row in joined if is_selected(row)]
    selected_wrong = [row for row in selected if status_value(row) == "wrong"]
    selected_usable = [row for row in selected if status_value(row) == "usable"]
    status_by_stratum: dict[str, dict[str, int]] = {}
    for row in joined:
        stratum = str(row.get("confidenceStratum") or "blank")
        status_by_stratum.setdefault(stratum, {})
        status = status_value(row) or "blank"
        status_by_stratum[stratum][status] = status_by_stratum[stratum].get(status, 0) + 1

    rules: list[dict[str, Any]] = []
    for threshold in [0.5, 0.6, 0.7, 0.8, 0.85, 0.88, 0.89, 0.9, 0.93, 0.95, 0.98, 0.99, 0.995, 1.0]:
        result = summarize_rule(
            f"predictedUsableProbability>={threshold}",
            joined,
            lambda row, threshold=threshold: safe_float(row.get("predictedUsableProbability")) >= threshold,
        )
        if result:
            rules.append(result)
    for max_measure in [1, 2, 3, 4, 5, 6, 8, 10, 20]:
        result = summarize_rule(
            f"measureIndex<={max_measure}",
            joined,
            lambda row, max_measure=max_measure: safe_float(row.get("measureIndex"), 999999.0) <= max_measure,
        )
        if result:
            rules.append(result)
    for probability in [0.7, 0.8, 0.9, 0.95, 0.98, 0.99]:
        for max_measure in [1, 2, 3, 4, 5, 6]:
            result = summarize_rule(
                f"predictedUsableProbability>={probability} AND measureIndex<={max_measure}",
                joined,
                lambda row, probability=probability, max_measure=max_measure: (
                    safe_float(row.get("predictedUsableProbability")) >= probability
                    and safe_float(row.get("measureIndex"), 999999.0) <= max_measure
                ),
            )
            if result:
                rules.append(result)

    candidate_rules = [rule for rule in rules if rule["selectedRows"] >= int(args.min_selected_rows)]
    candidate_rules.sort(key=lambda rule: (rule["precision"], rule["selectedRows"]), reverse=True)
    release_like = [
        rule for rule in candidate_rules
        if rule["precision"] >= float(args.min_precision)
    ]

    selected_wrong_by_piece = Counter(str(row.get("piece") or "blank") for row in selected_wrong)
    selected_wrong_by_recording = Counter(str(row.get("recordingId") or "blank") for row in selected_wrong)
    selected_wrong_by_stratum = Counter(str(row.get("confidenceStratum") or "blank") for row in selected_wrong)

    return {
        "ok": True,
        "sources": {
            "completedCsv": repo_relative(completed_path),
            "selectionJson": repo_relative(selection_path),
            "evalRows": repo_relative(eval_rows_path),
            "evalJson": repo_relative(eval_json_path),
        },
        "releaseFloor": {
            "minPrecision": float(args.min_precision),
            "minSelectedRows": int(args.min_selected_rows),
        },
        "evalSummary": {
            "blindValidationPassed": eval_json.get("blindValidationPassed"),
            "blockingReasons": eval_json.get("blockingReasons") or [],
            "metrics": eval_json.get("metrics") or {},
            "counts": eval_json.get("counts") or {},
        },
        "reviewSummary": summarize_rows(joined),
        "selectedSummary": summarize_rows(selected),
        "selectedWrongSummary": {
            "count": len(selected_wrong),
            "byStratum": dict(sorted(selected_wrong_by_stratum.items())),
            "byPiece": dict(selected_wrong_by_piece.most_common()),
            "byRecording": dict(selected_wrong_by_recording.most_common()),
            "rows": [compact_candidate(row) for row in selected_wrong],
        },
        "selectedUsableSummary": {
            "count": len(selected_usable),
            "rows": [compact_candidate(row) for row in selected_usable],
        },
        "statusByStratum": dict(sorted(status_by_stratum.items())),
        "ruleSearch": {
            "bestRulesWithMinSelected": candidate_rules[:20],
            "releaseLikeRules": release_like,
            "conclusion": (
                "no-simple-rule-meets-release-floor"
                if not release_like
                else "simple-rule-candidate-found"
            ),
        },
        "recommendedNextStep": (
            "Do not enable the ordinary-upload confidence gate. Inspect the selected wrong rows "
            "and recalibrate features/model; the current frozen RF candidate fails the stratified "
            "threshold-pool release floor."
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze failed threshold-pool confidence review.")
    parser.add_argument("--completed-csv", default=str(DEFAULT_COMPLETED))
    parser.add_argument("--selection-json", default=str(DEFAULT_SELECTION))
    parser.add_argument("--eval-rows", default=str(DEFAULT_EVAL_ROWS))
    parser.add_argument("--eval-json", default=str(DEFAULT_EVAL_JSON))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--min-precision", type=float, default=0.9)
    parser.add_argument("--min-selected-rows", type=int, default=10)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = evaluate(args)
    out_path = repo_path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "out": repo_relative(out_path),
        "selectedPrecision": report["selectedSummary"]["precision"],
        "selectedWrongRows": report["selectedWrongSummary"]["count"],
        "bestRule": (report["ruleSearch"]["bestRulesWithMinSelected"] or [None])[0],
        "releaseLikeRuleCount": len(report["ruleSearch"]["releaseLikeRules"]),
        "conclusion": report["ruleSearch"]["conclusion"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
