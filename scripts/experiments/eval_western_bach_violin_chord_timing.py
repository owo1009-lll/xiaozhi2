from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-parangonar-full.csv"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-chord-timing.json"
DEFAULT_CSV = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-chord-timing.csv"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-chord-timing.md"
DEVELOPMENT_SPLIT = "development-reference-performer"
HOLDOUT_SPLIT = "holdout-unseen-performer"
RULES = ("min", "max", "median", "closest-pair")


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def boolish(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def shared_onset(predictions: list[float], rule: str) -> float:
    if not predictions:
        raise ValueError("chord-onset-predictions-empty")
    if len(predictions) == 1:
        return predictions[0]
    if rule == "min":
        return min(predictions)
    if rule == "max":
        return max(predictions)
    if rule == "median":
        return float(statistics.median(predictions))
    if rule == "closest-pair":
        _, midpoint = min(
            (abs(left - right), (left + right) / 2.0)
            for index, left in enumerate(predictions)
            for right in predictions[index + 1:]
        )
        return midpoint
    raise ValueError(f"unknown-chord-rule:{rule}")


def apply_rule(rows: list[dict[str, str]], rule: str) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row.get("unit") or ""), str(row.get("scoreTime") or ""))].append(row)
    adjusted: list[dict[str, Any]] = []
    for group in grouped.values():
        is_chord = len(group) > 1 and any(boolish(row.get("doubleStop")) for row in group)
        predictions = [float(row["predTime"]) for row in group if row.get("predTime") not in ("", None)]
        chord_onset = shared_onset(predictions, rule) if is_chord and predictions else None
        for source in group:
            row = dict(source)
            raw_prediction = None if row.get("predTime") in ("", None) else float(row["predTime"])
            prediction = chord_onset if chord_onset is not None else raw_prediction
            gold = float(row["goldTime"])
            row["chordTimingRule"] = rule
            row["chordTimingApplied"] = bool(chord_onset is not None)
            row["adjustedPredTime"] = "" if prediction is None else round(prediction, 6)
            row["adjustedAbsError"] = "" if prediction is None else round(abs(prediction - gold), 6)
            adjusted.append(row)
    return adjusted


def summarize(rows: list[dict[str, Any]], *, error_field: str = "adjustedAbsError") -> dict[str, Any]:
    errors = [float(row[error_field]) for row in rows if row.get(error_field) not in ("", None)]
    total = len(rows)
    valid = len(errors)
    correct = sum(error <= 0.3 for error in errors)
    coverage = valid / total if total else None
    precision = correct / valid if valid else None
    hit_all = correct / total if total else None
    median = float(np.median(errors)) if errors else None
    p90 = float(np.percentile(errors, 90)) if errors else None
    green = bool(
        coverage is not None
        and precision is not None
        and median is not None
        and coverage >= 0.80
        and precision >= 0.90
        and hit_all is not None
        and hit_all >= 0.85
        and median < 0.150
        and p90 is not None
        and p90 < 0.500
    )
    return {
        "goldNotes": total,
        "validPredictions": valid,
        "coverage": coverage,
        "precisionWithin300msAmongPredictions": precision,
        "hitAt300msOverGold": hit_all,
        "medianOnsetError": median,
        "p90OnsetError": p90,
        "green": green,
    }


def select_rule(development_rows: list[dict[str, str]]) -> tuple[str, dict[str, dict[str, Any]]]:
    double_stop_rows = [row for row in development_rows if boolish(row.get("doubleStop"))]
    evaluations: dict[str, dict[str, Any]] = {}
    for rule in RULES:
        evaluations[rule] = summarize(apply_rule(double_stop_rows, rule))
    selected = max(
        RULES,
        key=lambda rule: (
            evaluations[rule]["precisionWithin300msAmongPredictions"] or 0.0,
            evaluations[rule]["coverage"] or 0.0,
            -(evaluations[rule]["medianOnsetError"] or 10**9),
        ),
    )
    return selected, evaluations


def grouped_summaries(rows: list[dict[str, Any]], field: str) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[str(row.get(field) or "unknown")].append(row)
    return {key: summarize(group) for key, group in sorted(groups.items())}


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Bach Violin Chord-Timing Gate",
            "",
            "The chord rule is selected only on the reference-performer development split, then frozen for unseen-performer holdout evaluation.",
            "Reference timestamps are estimated CQT-DTW alignments, not human onset gold.",
            "",
            f"- selected rule: {report['selectedChordRule']}",
            f"- development: {report['development']}",
            f"- holdout: {report['holdout']}",
            f"- all: {report['all']}",
            f"- externalControlledPilotReady: {str(report['externalControlledPilotReady']).lower()}",
            f"- defaultStudentReleaseEligible: false",
            "",
            "## Development Rule Sweep (Double Stops Only)",
            "",
            *[f"- {rule}: {metrics}" for rule, metrics in report["developmentRuleSweep"].items()],
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Select a chord-onset sharing rule on development data and evaluate it on unseen performers.")
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rows = read_rows(Path(args.input).resolve())
    development = [row for row in rows if row.get("benchmarkSplit") == DEVELOPMENT_SPLIT]
    holdout = [row for row in rows if row.get("benchmarkSplit") == HOLDOUT_SPLIT]
    if not development or not holdout:
        raise SystemExit("Both development and unseen-performer holdout rows are required.")
    selected_rule, sweep = select_rule(development)
    adjusted = apply_rule(rows, selected_rule)
    adjusted_development = [row for row in adjusted if row.get("benchmarkSplit") == DEVELOPMENT_SPLIT]
    adjusted_holdout = [row for row in adjusted if row.get("benchmarkSplit") == HOLDOUT_SPLIT]
    report = {
        "ok": True,
        "evidenceType": "external-professional-recording-estimated-alignment",
        "selectionDiscipline": "select chord rule on reference-performer development split; evaluate once on unseen-performer holdout",
        "selectedChordRule": selected_rule,
        "developmentRuleSweep": sweep,
        "development": summarize(adjusted_development),
        "holdout": summarize(adjusted_holdout),
        "all": summarize(adjusted),
        "byWork": grouped_summaries(adjusted, "work"),
        "byPerformer": grouped_summaries(adjusted, "violinist"),
        "externalControlledPilotReady": summarize(adjusted_holdout)["green"],
        "defaultStudentReleaseEligible": False,
        "releaseBlockers": [
            "reference-alignments-are-estimated-not-human-gold",
            "professional-performance-domain-does-not-validate-student-error-diagnosis",
        ],
    }
    out_path = Path(args.out).resolve()
    csv_path = Path(args.csv).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(csv_path, adjusted)
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["externalControlledPilotReady"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
