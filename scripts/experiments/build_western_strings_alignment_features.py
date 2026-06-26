from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from pathlib import Path
from typing import Any


DEFAULT_METHOD = "parangonar-basic-pitch"
METHOD_PREFERENCE = [
    DEFAULT_METHOD,
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


def bool_token(value: Any) -> str:
    text = str(value or "").strip().lower()
    if text in {"true", "1", "yes", "y"}:
        return "1"
    if text in {"false", "0", "no", "n"}:
        return "0"
    return "unknown"


def format_float(value: float | None, digits: int = 6) -> str:
    if value is None or not math.isfinite(value):
        return ""
    return f"{value:.{digits}f}".rstrip("0").rstrip(".")


def max_cluster_count(values: list[float], radius: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    best = 1
    left = 0
    for right, value in enumerate(ordered):
        while value - ordered[left] > radius:
            left += 1
        best = max(best, right - left + 1)
    return best


def choose_selected_method(method_rows: dict[str, dict[str, str]], default_method: str) -> str:
    if default_method in method_rows:
        return default_method
    for method in METHOD_PREFERENCE:
        if method in method_rows:
            return method
    return sorted(method_rows.keys())[0]


def find_per_note_files(input_root: Path) -> list[Path]:
    return sorted(input_root.glob("m0*/m0*-per-note.csv"))


def read_grouped_rows(input_root: Path) -> dict[tuple[str, str, str], dict[str, dict[str, str]]]:
    grouped: dict[tuple[str, str, str], dict[str, dict[str, str]]] = {}
    for csv_path in find_per_note_files(input_root):
        dataset = csv_path.parent.name
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                piece = str(row.get("piece") or "").strip()
                note_index = str(row.get("noteIndex") or "").strip()
                method = str(row.get("method") or "").strip()
                if not piece or not note_index or not method:
                    continue
                grouped.setdefault((dataset, piece, note_index), {})[method] = row
    return grouped


def build_feature_rows(input_root: Path, default_method: str = DEFAULT_METHOD) -> list[dict[str, str]]:
    grouped = read_grouped_rows(input_root)
    feature_rows: list[dict[str, str]] = []
    for (dataset, piece, note_index), method_rows in sorted(grouped.items()):
        selected_method = choose_selected_method(method_rows, default_method)
        selected_row = method_rows[selected_method]
        gold_time = safe_float(selected_row.get("goldTime"))
        score_time = safe_float(selected_row.get("scoreTime"))
        pred_by_method = {
            method: safe_float(row.get("predTime"))
            for method, row in sorted(method_rows.items())
        }
        valid_preds = [value for value in pred_by_method.values() if value is not None]
        selected_pred = pred_by_method.get(selected_method)
        selected_abs_error = (
            abs(float(selected_pred) - float(gold_time))
            if selected_pred is not None and gold_time is not None
            else None
        )
        errors_by_method = {
            method: abs(float(pred) - float(gold_time))
            for method, pred in pred_by_method.items()
            if pred is not None and gold_time is not None
        }
        oracle_method = min(errors_by_method, key=errors_by_method.get) if errors_by_method else ""
        oracle_error = errors_by_method.get(oracle_method) if oracle_method else None
        median_pred = statistics.median(valid_preds) if valid_preds else None
        pred_span = (max(valid_preds) - min(valid_preds)) if len(valid_preds) >= 2 else 0.0 if valid_preds else None
        pred_std = statistics.pstdev(valid_preds) if len(valid_preds) >= 2 else 0.0 if valid_preds else None
        selected_to_median = (
            abs(float(selected_pred) - float(median_pred))
            if selected_pred is not None and median_pred is not None
            else None
        )
        row: dict[str, str] = {
            "dataset": dataset,
            "piece": piece,
            "noteIndex": str(note_index),
            "midi": str(safe_int(selected_row.get("midi"), 0)),
            "scoreTime": format_float(score_time),
            "goldTime": format_float(gold_time),
            "doubleStop": bool_token(selected_row.get("doubleStop")),
            "legato": str(selected_row.get("legato") or "unknown"),
            "selectedMethod": selected_method,
            "selectedPredTime": format_float(selected_pred),
            "methodCount": str(len(method_rows)),
            "validPredictionCount": str(len(valid_preds)),
            "predictionMedianTime": format_float(median_pred),
            "predictionSpanSeconds": format_float(pred_span),
            "predictionStdSeconds": format_float(pred_std),
            "selectedToMedianAbsSeconds": format_float(selected_to_median),
            "agreementWithin100ms": str(max_cluster_count(valid_preds, 0.1)),
            "agreementWithin300ms": str(max_cluster_count(valid_preds, 0.3)),
            "labelSelectedAbsError": format_float(selected_abs_error),
            "labelSelectedWithin100ms": "1" if selected_abs_error is not None and selected_abs_error <= 0.1 else "0",
            "labelSelectedWithin150ms": "1" if selected_abs_error is not None and selected_abs_error <= 0.15 else "0",
            "labelSelectedWithin300ms": "1" if selected_abs_error is not None and selected_abs_error <= 0.3 else "0",
            "labelOracleBestMethod": oracle_method,
            "labelOracleBestAbsError": format_float(oracle_error),
            "labelOracleWithin300ms": "1" if oracle_error is not None and oracle_error <= 0.3 else "0",
        }
        for method in METHOD_PREFERENCE:
            row[f"pred_{method}_time"] = format_float(pred_by_method.get(method))
        feature_rows.append(row)
    return feature_rows


def summarize(rows: list[dict[str, str]]) -> dict[str, Any]:
    by_dataset: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        by_dataset.setdefault(row["dataset"], []).append(row)

    def median_label(rows_for_dataset: list[dict[str, str]], key: str) -> float | None:
        values = [safe_float(row.get(key)) for row in rows_for_dataset]
        cleaned = [value for value in values if value is not None]
        return statistics.median(cleaned) if cleaned else None

    def ratio(rows_for_dataset: list[dict[str, str]], key: str) -> float:
        if not rows_for_dataset:
            return 0.0
        return sum(1 for row in rows_for_dataset if row.get(key) == "1") / len(rows_for_dataset)

    return {
        "rowCount": len(rows),
        "datasets": {
            dataset: {
                "rowCount": len(dataset_rows),
                "selectedMedianErrorMs": round(float(median_label(dataset_rows, "labelSelectedAbsError") or 0.0) * 1000, 3),
                "selectedHit100": round(ratio(dataset_rows, "labelSelectedWithin100ms"), 4),
                "selectedHit150": round(ratio(dataset_rows, "labelSelectedWithin150ms"), 4),
                "selectedHit300": round(ratio(dataset_rows, "labelSelectedWithin300ms"), 4),
                "oracleMedianErrorMs": round(float(median_label(dataset_rows, "labelOracleBestAbsError") or 0.0) * 1000, 3),
                "oracleHit300": round(ratio(dataset_rows, "labelOracleWithin300ms"), 4),
            }
            for dataset, dataset_rows in sorted(by_dataset.items())
        },
        "leakageWarning": "Columns prefixed with label are gold-derived and must not be used as model features.",
    }


def build_candidate_rows(note_rows: list[dict[str, str]]) -> list[dict[str, str]]:
    candidate_rows: list[dict[str, str]] = []
    for note_row in note_rows:
        gold_time = safe_float(note_row.get("goldTime"))
        median_time = safe_float(note_row.get("predictionMedianTime"))
        for method in METHOD_PREFERENCE:
            pred_time = safe_float(note_row.get(f"pred_{method}_time"))
            if pred_time is None:
                continue
            abs_error = abs(pred_time - gold_time) if gold_time is not None else None
            distance_to_median = abs(pred_time - median_time) if median_time is not None else None
            candidate_rows.append({
                "dataset": note_row["dataset"],
                "piece": note_row["piece"],
                "noteIndex": note_row["noteIndex"],
                "method": method,
                "midi": note_row["midi"],
                "scoreTime": note_row["scoreTime"],
                "goldTime": note_row["goldTime"],
                "predTime": format_float(pred_time),
                "doubleStop": note_row["doubleStop"],
                "legato": note_row["legato"],
                "methodCount": note_row["methodCount"],
                "validPredictionCount": note_row["validPredictionCount"],
                "predictionSpanSeconds": note_row["predictionSpanSeconds"],
                "predictionStdSeconds": note_row["predictionStdSeconds"],
                "candidateToMedianAbsSeconds": format_float(distance_to_median),
                "agreementWithin100ms": note_row["agreementWithin100ms"],
                "agreementWithin300ms": note_row["agreementWithin300ms"],
                "isDefaultSelectedMethod": "1" if method == note_row["selectedMethod"] else "0",
                "isOracleBestMethod": "1" if method == note_row["labelOracleBestMethod"] else "0",
                "labelCandidateAbsError": format_float(abs_error),
                "labelCandidateWithin100ms": "1" if abs_error is not None and abs_error <= 0.1 else "0",
                "labelCandidateWithin150ms": "1" if abs_error is not None and abs_error <= 0.15 else "0",
                "labelCandidateWithin300ms": "1" if abs_error is not None and abs_error <= 0.3 else "0",
            })
    return candidate_rows


def summarize_candidates(rows: list[dict[str, str]]) -> dict[str, Any]:
    by_method: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        by_method.setdefault(row["method"], []).append(row)

    def ratio(method_rows: list[dict[str, str]], key: str) -> float:
        if not method_rows:
            return 0.0
        return sum(1 for row in method_rows if row.get(key) == "1") / len(method_rows)

    def median_error_ms(method_rows: list[dict[str, str]]) -> float:
        values = [
            safe_float(row.get("labelCandidateAbsError"))
            for row in method_rows
        ]
        cleaned = [value for value in values if value is not None]
        return round(float(statistics.median(cleaned) if cleaned else 0.0) * 1000, 3)

    return {
        "rowCount": len(rows),
        "methods": {
            method: {
                "rowCount": len(method_rows),
                "medianErrorMs": median_error_ms(method_rows),
                "hit100": round(ratio(method_rows, "labelCandidateWithin100ms"), 4),
                "hit150": round(ratio(method_rows, "labelCandidateWithin150ms"), 4),
                "hit300": round(ratio(method_rows, "labelCandidateWithin300ms"), 4),
            }
            for method, method_rows in sorted(by_method.items())
        },
    }


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build M2 note-alignment confidence feature rows from M0 per-note CSV artifacts.")
    parser.add_argument("--input-root", default="data/experiments/western-strings-m0")
    parser.add_argument("--out-dir", default="data/experiments/western-strings-m2")
    parser.add_argument("--default-method", default=DEFAULT_METHOD)
    args = parser.parse_args()

    input_root = Path(args.input_root)
    out_dir = Path(args.out_dir)
    rows = build_feature_rows(input_root, default_method=str(args.default_method))
    if not rows:
        raise SystemExit(f"No M0 per-note rows found under {input_root}")
    candidate_rows = build_candidate_rows(rows)
    summary = summarize(rows)
    summary["candidateFeatures"] = summarize_candidates(candidate_rows)
    write_csv(out_dir / "alignment-feature-table.csv", rows)
    write_csv(out_dir / "alignment-candidate-feature-table.csv", candidate_rows)
    (out_dir / "alignment-feature-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"ok": True, "outDir": str(out_dir), **summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
