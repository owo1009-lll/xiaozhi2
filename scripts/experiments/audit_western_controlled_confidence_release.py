from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_PILOT_PREDICTIONS = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "candidate-confidence-pilot-predictions.csv"
)
DEFAULT_VALIDATION_SELECTION = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "offline-feature-candidate-review"
    / "candidate-confidence-validation-selection.json"
)
DEFAULT_VALIDATION_EVAL = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-validation-review"
    / "confidence-validation-eval.json"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m3"
    / "confidence-validation-review"
    / "ordinary-confidence-release-audit.json"
)


def repo_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else REPO / path


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def status_value(row: dict[str, Any]) -> str:
    return str(row.get("teacherCandidateStatus") or "").strip().lower()


def probability_value(row: dict[str, Any]) -> float:
    for key in ("probabilityUsable", "predictedUsableProbability", "confidenceProbability"):
        try:
            value = float(row.get(key))
            if value == value:
                return value
        except (TypeError, ValueError):
            pass
    return 0.0


def summarize_reviewed_predictions(rows: list[dict[str, str]], threshold: float) -> dict[str, Any]:
    selected = [row for row in rows if probability_value(row) >= threshold]
    selected_usable = sum(1 for row in selected if status_value(row) == "usable")
    selected_wrong = sum(1 for row in selected if status_value(row) == "wrong")
    reviewed = [row for row in rows if status_value(row) in {"usable", "wrong", "uncertain"}]
    scored = [row for row in rows if status_value(row) in {"usable", "wrong"}]
    return {
        "rowCount": len(rows),
        "reviewedRows": len(reviewed),
        "scoredRows": len(scored),
        "selectedRows": len(selected),
        "selectedUsableRows": selected_usable,
        "selectedWrongRows": selected_wrong,
        "precision": round(selected_usable / len(selected), 6) if selected else None,
        "coverageWithinRows": round(len(selected) / len(rows), 6) if rows else 0.0,
    }


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    threshold = float(args.threshold)
    pilot_rows = read_csv(repo_path(args.pilot_predictions))
    selection = read_json(repo_path(args.validation_selection))
    validation = read_json(repo_path(args.validation_eval))
    validation_eval_rows = read_csv(
        repo_path(validation.get("rowsOut") or DEFAULT_VALIDATION_EVAL.with_name("confidence-validation-eval-rows.csv"))
    )
    candidate_count = int(selection.get("candidateCount") or 0)
    selected_above_threshold = int(selection.get("selectedAboveThresholdCount") or 0)
    sampled_row_count = int(selection.get("rowCount") or 0)
    threshold_pool_coverage = selected_above_threshold / candidate_count if candidate_count else 0.0
    pilot = summarize_reviewed_predictions(pilot_rows, threshold)
    validation_rows = summarize_reviewed_predictions(validation_eval_rows, threshold)
    validation_counts = validation.get("counts") or {}
    validation_metrics = validation.get("metrics") or {}
    report = {
        "ok": True,
        "threshold": threshold,
        "sources": {
            "pilotPredictions": repo_relative(repo_path(args.pilot_predictions)),
            "validationSelection": repo_relative(repo_path(args.validation_selection)),
            "validationEval": repo_relative(repo_path(args.validation_eval)),
        },
        "pilotOutOfFold": pilot,
        "validationExport": {
            "candidateCount": candidate_count,
            "selectedAboveThresholdCount": selected_above_threshold,
            "sampledReviewRows": sampled_row_count,
            "thresholdPoolCoverage": round(threshold_pool_coverage, 6),
            "importantCaveat": (
                "The fresh validation review batch is prefiltered to candidates above the threshold; "
                "its coverage is not comparable to the out-of-fold pilot coverage."
            ),
        },
        "validationReviewedSample": {
            "rowCount": validation_rows["rowCount"],
            "selectedRows": int(validation_counts.get("selectedRows") or validation_rows["selectedRows"]),
            "selectedUsableRows": int(validation_counts.get("selectedUsableRows") or validation_rows["selectedUsableRows"]),
            "selectedWrongRows": int(validation_counts.get("selectedWrongRows") or validation_rows["selectedWrongRows"]),
            "precision": validation_metrics.get("precision"),
            "coverageWithinReviewedSample": validation_metrics.get("coverage"),
        },
        "releaseReadiness": {
            "runtimeScorerWired": True,
            "defaultEnabled": False,
            "readyForDefaultEnable": False,
            "blockingReasons": [
                "ordinary-auto-gate-disabled-by-default",
                "ordinary-confidence-full-threshold-pool-precision-unmeasured",
            ],
        },
        "recommendedNextStep": (
            "Keep the default fail-closed. For a monitored pilot, review a stratified sample from the full "
            "threshold pool (including around-threshold and below-threshold rows) before enabling the gate for students."
        ),
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit ordinary-upload confidence release evidence and coverage semantics.")
    parser.add_argument("--pilot-predictions", default=str(DEFAULT_PILOT_PREDICTIONS))
    parser.add_argument("--validation-selection", default=str(DEFAULT_VALIDATION_SELECTION))
    parser.add_argument("--validation-eval", default=str(DEFAULT_VALIDATION_EVAL))
    parser.add_argument("--threshold", type=float, default=0.7)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
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
        "pilotPrecision": report["pilotOutOfFold"]["precision"],
        "pilotCoverage": report["pilotOutOfFold"]["coverageWithinRows"],
        "thresholdPoolCoverage": report["validationExport"]["thresholdPoolCoverage"],
        "validationPrecision": report["validationReviewedSample"]["precision"],
        "readyForDefaultEnable": report["releaseReadiness"]["readyForDefaultEnable"],
        "blockingReasons": report["releaseReadiness"]["blockingReasons"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
