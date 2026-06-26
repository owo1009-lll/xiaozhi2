from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any


METHOD_PREFERENCE = [
    "parangonar-basic-pitch",
    "basic-pitch-dtw",
    "crepe-dtw",
    "pyin-dtw",
    "linear-scoretime",
]
METHOD_SETS = [
    ("all", tuple(METHOD_PREFERENCE)),
    ("no-linear", tuple(method for method in METHOD_PREFERENCE if method != "linear-scoretime")),
    ("basic-pitch", ("basic-pitch-dtw",)),
    ("parangonar", ("parangonar-basic-pitch",)),
    ("crepe", ("crepe-dtw",)),
    ("pyin", ("pyin-dtw",)),
]
SPAN_THRESHOLDS = [None, 0.1, 0.2, 0.5]
DISTANCE_THRESHOLDS = [None, 0.05, 0.1, 0.2, 0.5]
AGREEMENT_100_THRESHOLDS = [0, 2, 3]
AGREEMENT_300_THRESHOLDS = [0, 2, 3]


def safe_float(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def safe_int(value: Any, fallback: int = 0) -> int:
    numeric = safe_float(value)
    return int(round(numeric)) if numeric is not None else fallback


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


@dataclass(frozen=True)
class Rule:
    method_set_name: str
    methods: tuple[str, ...]
    max_prediction_span: float | None
    max_candidate_to_median: float | None
    min_agreement_100: int
    min_agreement_300: int
    exclude_double_stop: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "methodSet": self.method_set_name,
            "methods": list(self.methods),
            "maxPredictionSpanSeconds": self.max_prediction_span,
            "maxCandidateToMedianAbsSeconds": self.max_candidate_to_median,
            "minAgreementWithin100ms": self.min_agreement_100,
            "minAgreementWithin300ms": self.min_agreement_300,
            "excludeDoubleStop": self.exclude_double_stop,
        }


def iter_rules() -> list[Rule]:
    rules: list[Rule] = []
    for method_set_name, methods in METHOD_SETS:
        for max_span in SPAN_THRESHOLDS:
            for max_distance in DISTANCE_THRESHOLDS:
                for min_100 in AGREEMENT_100_THRESHOLDS:
                    for min_300 in AGREEMENT_300_THRESHOLDS:
                        for exclude_double_stop in (False, True):
                            rules.append(Rule(
                                method_set_name=method_set_name,
                                methods=methods,
                                max_prediction_span=max_span,
                                max_candidate_to_median=max_distance,
                                min_agreement_100=min_100,
                                min_agreement_300=min_300,
                                exclude_double_stop=exclude_double_stop,
                            ))
    return rules


def candidate_passes(row: dict[str, str], rule: Rule) -> bool:
    if row.get("method") not in rule.methods:
        return False
    if rule.exclude_double_stop and row.get("doubleStop") == "1":
        return False
    span = safe_float(row.get("predictionSpanSeconds"))
    if rule.max_prediction_span is not None and (span is None or span > rule.max_prediction_span):
        return False
    distance = safe_float(row.get("candidateToMedianAbsSeconds"))
    if rule.max_candidate_to_median is not None and (distance is None or distance > rule.max_candidate_to_median):
        return False
    if safe_int(row.get("agreementWithin100ms"), 0) < rule.min_agreement_100:
        return False
    if safe_int(row.get("agreementWithin300ms"), 0) < rule.min_agreement_300:
        return False
    return True


def note_key(row: dict[str, str]) -> tuple[str, str, str]:
    return (row.get("dataset", ""), row.get("piece", ""), row.get("noteIndex", ""))


def method_rank(method: str) -> int:
    try:
        return METHOD_PREFERENCE.index(method)
    except ValueError:
        return len(METHOD_PREFERENCE)


def choose_candidate(candidates: list[dict[str, str]]) -> dict[str, str]:
    return sorted(
        candidates,
        key=lambda row: (
            safe_float(row.get("candidateToMedianAbsSeconds")) if safe_float(row.get("candidateToMedianAbsSeconds")) is not None else 999.0,
            method_rank(row.get("method", "")),
        ),
    )[0]


def group_candidate_rows(rows: list[dict[str, str]]) -> list[list[dict[str, str]]]:
    notes: dict[tuple[str, str, str], list[dict[str, str]]] = {}
    for row in rows:
        notes.setdefault(note_key(row), []).append(row)
    return list(notes.values())


def evaluate_rule_groups(candidate_groups: list[list[dict[str, str]]], rule: Rule, target_column: str = "labelCandidateWithin300ms") -> dict[str, Any]:
    selected: list[dict[str, str]] = []
    for candidates in candidate_groups:
        passed = [row for row in candidates if candidate_passes(row, rule)]
        if passed:
            selected.append(choose_candidate(passed))

    correct = sum(1 for row in selected if row.get(target_column) == "1")
    selected_count = len(selected)
    note_count = len(candidate_groups)
    precision = correct / selected_count if selected_count else 0.0
    coverage = selected_count / note_count if note_count else 0.0
    return {
        "noteCount": note_count,
        "autoPassCount": selected_count,
        "correctCount": correct,
        "precision": precision,
        "coverage": coverage,
    }


def evaluate_rule(rows: list[dict[str, str]], rule: Rule, target_column: str = "labelCandidateWithin300ms") -> dict[str, Any]:
    return evaluate_rule_groups(group_candidate_rows(rows), rule, target_column)


def score_rule(metrics: dict[str, Any], min_precision: float) -> tuple[int, float, float, int]:
    precision = float(metrics.get("precision", 0.0))
    coverage = float(metrics.get("coverage", 0.0))
    auto_count = int(metrics.get("autoPassCount", 0))
    meets = 1 if precision >= min_precision and auto_count > 0 else 0
    return (meets, coverage if meets else precision, precision, auto_count)


def fit_rule(rows: list[dict[str, str]], min_precision: float) -> tuple[Rule, dict[str, Any]]:
    best_rule: Rule | None = None
    best_metrics: dict[str, Any] | None = None
    best_score: tuple[int, float, float, int] | None = None
    candidate_groups = group_candidate_rows(rows)
    for rule in iter_rules():
        metrics = evaluate_rule_groups(candidate_groups, rule)
        current_score = score_rule(metrics, min_precision)
        if best_score is None or current_score > best_score:
            best_score = current_score
            best_rule = rule
            best_metrics = metrics
    if best_rule is None or best_metrics is None:
        raise RuntimeError("No confidence gate rules were generated.")
    return best_rule, best_metrics


def by_dataset(rows: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        grouped.setdefault(row.get("dataset", ""), []).append(row)
    return grouped


def run_lodo(rows: list[dict[str, str]], min_precision: float) -> dict[str, Any]:
    grouped = by_dataset(rows)
    folds = []
    for held_out in sorted(grouped):
        train_rows = [row for dataset, dataset_rows in grouped.items() if dataset != held_out for row in dataset_rows]
        test_rows = grouped[held_out]
        rule, train_metrics = fit_rule(train_rows, min_precision)
        test_metrics = evaluate_rule(test_rows, rule)
        folds.append({
            "heldOutDataset": held_out,
            "rule": rule.to_dict(),
            "train": rounded_metrics(train_metrics),
            "test": rounded_metrics(test_metrics),
        })
    return {"folds": folds}


def rounded_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    return {
        "noteCount": int(metrics.get("noteCount", 0)),
        "autoPassCount": int(metrics.get("autoPassCount", 0)),
        "correctCount": int(metrics.get("correctCount", 0)),
        "precision": round(float(metrics.get("precision", 0.0)), 4),
        "coverage": round(float(metrics.get("coverage", 0.0)), 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate a simple fail-closed confidence gate for western string note alignment candidates.")
    parser.add_argument("--features", default="data/experiments/western-strings-m2/alignment-candidate-feature-table.csv")
    parser.add_argument("--out", default="data/experiments/western-strings-m2/confidence-gate-summary.json")
    parser.add_argument("--min-precision", type=float, default=0.9)
    args = parser.parse_args()

    rows = read_rows(Path(args.features))
    if not rows:
        raise SystemExit(f"No candidate rows found: {args.features}")
    rule, all_metrics = fit_rule(rows, float(args.min_precision))
    summary = {
        "ok": True,
        "minPrecision": float(args.min_precision),
        "allDataBestRule": rule.to_dict(),
        "allData": rounded_metrics(all_metrics),
        "leaveOneDatasetOut": run_lodo(rows, float(args.min_precision)),
        "warning": "This is an eval-only threshold gate. It proves whether a high-precision subset exists; it is not production wiring.",
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
