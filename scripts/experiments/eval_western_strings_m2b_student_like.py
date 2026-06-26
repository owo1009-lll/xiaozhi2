from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from statistics import median
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_FEATURES = REPO / "data" / "experiments" / "western-strings-m2" / "alignment-candidate-feature-table.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "m2b-student-like-summary.json"
METHOD_PREFERENCE = [
    "parangonar-basic-pitch",
    "basic-pitch-dtw",
    "crepe-dtw",
    "pyin-dtw",
    "linear-scoretime",
]


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


def note_key(row: dict[str, str]) -> tuple[str, str, str]:
    return (row.get("dataset", ""), row.get("piece", ""), row.get("noteIndex", ""))


def method_rank(method: str) -> int:
    try:
        return METHOD_PREFERENCE.index(method)
    except ValueError:
        return len(METHOD_PREFERENCE)


def group_rows(rows: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(note_key(row), []).append(row)
    return list(grouped.values())


def recompute_note_features(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    next_rows = [dict(row) for row in rows]
    predictions = [safe_float(row.get("predTime")) for row in next_rows]
    valid = [value for value in predictions if value is not None]
    med = median(valid) if valid else None
    span = (max(valid) - min(valid)) if valid else None
    for row in next_rows:
      pred = safe_float(row.get("predTime"))
      gold = safe_float(row.get("goldTime"))
      distance = abs(pred - med) if pred is not None and med is not None else None
      agreements_100 = 0
      agreements_300 = 0
      if pred is not None:
          for other in valid:
              if abs(other - pred) <= 0.1:
                  agreements_100 += 1
              if abs(other - pred) <= 0.3:
                  agreements_300 += 1
      error = abs(pred - gold) if pred is not None and gold is not None else None
      row["methodCount"] = len(next_rows)
      row["validPredictionCount"] = len(valid)
      row["predictionSpanSeconds"] = span
      row["candidateToMedianAbsSeconds"] = distance
      row["agreementWithin100ms"] = agreements_100
      row["agreementWithin300ms"] = agreements_300
      row["labelCandidateAbsError"] = error
      row["labelCandidateWithin300ms"] = 1 if error is not None and error <= 0.3 else 0
    return next_rows


def choose_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not candidates:
        return None
    return sorted(
        candidates,
        key=lambda row: (
            safe_float(row.get("candidateToMedianAbsSeconds")) if safe_float(row.get("candidateToMedianAbsSeconds")) is not None else 999.0,
            method_rank(str(row.get("method", ""))),
        ),
    )[0]


def evaluate(rows: list[dict[str, Any]]) -> dict[str, Any]:
    groups = group_rows(rows)
    selected = [candidate for group in groups if (candidate := choose_candidate(group))]
    correct = sum(1 for row in selected if safe_int(row.get("labelCandidateWithin300ms"), 0) == 1)
    selected_count = len(selected)
    note_count = len(groups)
    return {
        "noteCount": note_count,
        "autoPassCount": selected_count,
        "correctWithin300ms": correct,
        "precisionWithin300ms": round(correct / selected_count, 4) if selected_count else 0.0,
        "coverage": round(selected_count / note_count, 4) if note_count else 0.0,
    }


def scenario_baseline(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def scenario_correlated_late(rows: list[dict[str, str]], seconds: float) -> list[dict[str, Any]]:
    shifted = []
    for row in rows:
        next_row: dict[str, Any] = dict(row)
        pred = safe_float(row.get("predTime"))
        if pred is not None:
            next_row["predTime"] = pred + seconds
        shifted.append(next_row)
    return [row for group in group_rows(shifted) for row in recompute_note_features(group)]


def scenario_single_method(rows: list[dict[str, str]], method: str) -> list[dict[str, Any]]:
    filtered = [dict(row) for row in rows if row.get("method") == method]
    return [row for group in group_rows(filtered) for row in recompute_note_features(group)]


def run(features_path: Path) -> dict[str, Any]:
    rows = read_rows(features_path)
    if not rows:
        raise RuntimeError(f"No feature rows found: {features_path}")
    scenarios = {
        "baseline_current_dataset": scenario_baseline(rows),
        "student_like_correlated_late_800ms": scenario_correlated_late(rows, 0.8),
        "single_source_parangonar": scenario_single_method(rows, "parangonar-basic-pitch"),
    }
    results = {name: evaluate(scenario_rows) for name, scenario_rows in scenarios.items()}
    unsafe = [
        name
        for name, metrics in results.items()
        if name != "baseline_current_dataset"
        and metrics["autoPassCount"] > 0
        and metrics["precisionWithin300ms"] < 0.9
    ]
    return {
        "ok": True,
        "studentGateReady": not unsafe,
        "unsafeScenarios": unsafe,
        "scenarios": results,
        "warning": "M2b is a student-like safety pilot at feature level. If studentGateReady=false, keep western strings auto feedback teacher-only.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate M2b student-like perturbation safety for western strings alignment preview.")
    parser.add_argument("--features", default=str(DEFAULT_FEATURES))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--expect-negative", action="store_true")
    args = parser.parse_args()

    summary = run(Path(args.features))
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.expect_negative and summary["studentGateReady"]:
        raise SystemExit("Expected the synthetic student-like perturbation to block student release, but it passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
