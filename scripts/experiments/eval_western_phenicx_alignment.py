from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_strings_m0_bach10 import (  # noqa: E402
    Note,
    _performance_array_for_parangonar,
    basic_pitch_events,
    predict_basic_pitch_assignment,
)


DEFAULT_ADAPTER = (
    REPO_ROOT
    / "data"
    / "experiments"
    / "western-strings-phenicx-adapter"
    / "manifest.json"
)
DEFAULT_OUTPUT_DIR = (
    REPO_ROOT / "data" / "experiments" / "western-strings-phenicx-alignment"
)
METHODS = (
    "linear-duration",
    "basic-pitch-dtw",
    "parangonar-basic-pitch",
    "parangonar-with-basic-fallback",
    "parangonar-fallback-chord-onset-consensus",
)
GATE = {
    "medianOnsetErrorMaxExclusive": 0.150,
    "p90OnsetErrorMaxExclusive": 0.500,
    "hitAt300msMin": 0.850,
    "coverageMin": 0.800,
}


def safe_rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator > 0 else None


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def load_notes(path: Path, piece: str) -> tuple[list[dict[str, Any]], list[Note]]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    notes = [
        Note(
            piece=piece,
            idx=int(row["rowIndex"]),
            score_time=float(row["normalizedScoreOnset"]),
            gold_time=float(row["goldOnset"]),
            midi=int(row["midi"]),
            double_stop=int(row.get("goldChordSize") or 1) >= 2,
            legato="unknown",
        )
        for row in rows
    ]
    if [note.idx for note in notes] != list(range(len(notes))):
        raise ValueError(f"noncontiguous-row-index:{piece}")
    return rows, notes


def predict_linear_duration(
    rows: list[dict[str, Any]], audio_duration_seconds: float
) -> list[float | None]:
    if not rows or audio_duration_seconds <= 0.0:
        return [None for _ in rows]
    score_start = min(float(row["normalizedScoreOnset"]) for row in rows)
    score_end = max(float(row["normalizedScoreOffset"]) for row in rows)
    score_span = score_end - score_start
    if score_span <= 0.0:
        return [None for _ in rows]
    return [
        (float(row["normalizedScoreOnset"]) - score_start)
        * audio_duration_seconds
        / score_span
        for row in rows
    ]


def score_array_for_parangonar(rows: list[dict[str, Any]]) -> np.ndarray:
    dtype = [
        ("id", "U32"),
        ("pitch", "i4"),
        ("onset_beat", "f4"),
        ("duration_beat", "f4"),
        ("onset_quarter", "f4"),
        ("duration_quarter", "f4"),
        ("is_grace", "bool"),
    ]
    output = np.zeros(len(rows), dtype=dtype)
    for index, row in enumerate(rows):
        onset = float(row["normalizedScoreOnset"])
        duration = max(0.001, float(row["normalizedScoreOffset"]) - onset)
        output[index]["id"] = f"s{index}"
        output[index]["pitch"] = int(row["midi"])
        output[index]["onset_beat"] = onset
        output[index]["duration_beat"] = duration
        output[index]["onset_quarter"] = onset
        output[index]["duration_quarter"] = duration
        output[index]["is_grace"] = duration <= 0.05
    return output


def predict_parangonar(
    rows: list[dict[str, Any]], events: list[dict[str, Any]]
) -> tuple[list[float | None], list[dict[str, Any] | None]]:
    if not events:
        return [None for _ in rows], [None for _ in rows]
    try:
        from parangonar.match import AutomaticNoteMatcher
    except Exception as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(f"parangonar unavailable: {exc}") from exc

    np.random.seed(7)
    matcher = AutomaticNoteMatcher()
    alignments = matcher(
        score_array_for_parangonar(rows),
        _performance_array_for_parangonar(events),
    )
    matched: dict[int, list[tuple[int, dict[str, Any]]]] = {}
    for item in alignments:
        if item.get("label") != "match":
            continue
        score_id = str(item.get("score_id") or "")
        performance_id = str(item.get("performance_id") or "")
        if not score_id.startswith("s") or not performance_id.startswith("p"):
            continue
        try:
            score_index = int(score_id[1:])
            event_index = int(performance_id[1:])
        except ValueError:
            continue
        if 0 <= score_index < len(rows) and 0 <= event_index < len(events):
            matched.setdefault(score_index, []).append((event_index, events[event_index]))

    details: list[dict[str, Any] | None] = []
    for score_index, score_row in enumerate(rows):
        candidates = matched.get(score_index, [])
        if not candidates:
            details.append(None)
            continue
        event_index, event = min(
            candidates,
            key=lambda pair: (
                abs(int(pair[1]["midi"]) - int(score_row["midi"])),
                -float(pair[1].get("confidence", 0.0)),
                float(pair[1]["start"]),
            ),
        )
        details.append(
            {
                "eventIndex": event_index,
                "start": float(event["start"]),
                "end": float(event["end"]),
                "midi": int(event["midi"]),
                "confidence": float(event.get("confidence", 0.0)),
            }
        )
    return [None if item is None else float(item["start"]) for item in details], details


def fill_missing_predictions(
    primary: list[float | None], fallback: list[float | None]
) -> list[float | None]:
    if len(primary) != len(fallback):
        raise ValueError("fallback-prediction-count-mismatch")
    return [fallback_value if value is None else value for value, fallback_value in zip(primary, fallback)]


def apply_earliest_chord_onset_consensus(
    rows: list[dict[str, Any]], predictions: list[float | None]
) -> list[float | None]:
    if len(rows) != len(predictions):
        raise ValueError("chord-consensus-prediction-count-mismatch")
    output = list(predictions)
    chord_groups: dict[float, list[int]] = {}
    for index, row in enumerate(rows):
        chord_groups.setdefault(float(row["normalizedScoreOnset"]), []).append(index)
    for indices in chord_groups.values():
        if len(indices) < 2:
            continue
        available = [output[index] for index in indices if output[index] is not None]
        if not available:
            continue
        shared_onset = min(float(value) for value in available)
        for index in indices:
            output[index] = shared_onset
    return output


def build_result_rows(
    piece: str,
    split: str,
    method: str,
    source_rows: list[dict[str, Any]],
    predictions: list[float | None],
    details: list[dict[str, Any] | None] | None = None,
) -> list[dict[str, Any]]:
    if len(source_rows) != len(predictions):
        raise ValueError(f"prediction-count-mismatch:{piece}:{method}")
    details = details or [None for _ in source_rows]
    output = []
    for source, predicted, detail in zip(source_rows, predictions, details):
        gold = float(source["goldOnset"])
        error = None if predicted is None else abs(float(predicted) - gold)
        output.append(
            {
                "piece": piece,
                "split": split,
                "method": method,
                "rowIndex": int(source["rowIndex"]),
                "midi": int(source["midi"]),
                "scoreOnset": float(source["normalizedScoreOnset"]),
                "goldOnset": gold,
                "predictedOnset": "" if predicted is None else float(predicted),
                "absError": "" if error is None else error,
                "goldChordSize": int(source.get("goldChordSize") or 1),
                "polyphonic": int(source.get("goldChordSize") or 1) >= 2,
                "scoreTimeAdjusted": bool(source.get("scoreTimeAdjusted")),
                "predictedMidi": "" if detail is None else int(detail["midi"]),
                "eventConfidence": "" if detail is None else float(detail["confidence"]),
                "eventIndex": "" if detail is None else int(detail["eventIndex"]),
            }
        )
    return output


def summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    errors = [
        value
        for row in rows
        if (value := finite_number(row.get("absError"))) is not None
    ]
    total = len(rows)
    valid = len(errors)
    hits_100 = sum(error <= 0.100 for error in errors)
    hits_300 = sum(error <= 0.300 for error in errors)
    return {
        "goldNotes": total,
        "validPredictions": valid,
        "missingPredictions": total - valid,
        "coverage": safe_rate(valid, total),
        "medianOnsetError": float(np.median(errors)) if errors else None,
        "p90OnsetError": float(np.percentile(errors, 90)) if errors else None,
        "precisionWithin100msAmongPredictions": safe_rate(hits_100, valid),
        "precisionWithin300msAmongPredictions": safe_rate(hits_300, valid),
        "hitAt100ms": safe_rate(hits_100, total),
        "hitAt300ms": safe_rate(hits_300, total),
    }


def summarize_with_groups(rows: list[dict[str, Any]]) -> dict[str, Any]:
    summary = summarize_rows(rows)
    summary["singleNote"] = summarize_rows(
        [row for row in rows if not bool(row.get("polyphonic"))]
    )
    summary["polyphonic"] = summarize_rows(
        [row for row in rows if bool(row.get("polyphonic"))]
    )
    return summary


def evaluate_gate(metrics: dict[str, Any]) -> dict[str, Any]:
    checks = {
        "median": (
            finite_number(metrics.get("medianOnsetError")) is not None
            and float(metrics["medianOnsetError"])
            < GATE["medianOnsetErrorMaxExclusive"]
        ),
        "p90": (
            finite_number(metrics.get("p90OnsetError")) is not None
            and float(metrics["p90OnsetError"])
            < GATE["p90OnsetErrorMaxExclusive"]
        ),
        "hitAt300ms": (
            finite_number(metrics.get("hitAt300ms")) is not None
            and float(metrics["hitAt300ms"]) >= GATE["hitAt300msMin"]
        ),
        "coverage": (
            finite_number(metrics.get("coverage")) is not None
            and float(metrics["coverage"]) >= GATE["coverageMin"]
        ),
    }
    return {"passed": all(checks.values()), "checks": checks, "thresholds": GATE}


def selection_key(method_report: dict[str, Any]) -> tuple[float, ...]:
    metrics = method_report["development"]
    gate = evaluate_gate(metrics)
    hit_at_300 = finite_number(metrics.get("hitAt300ms"))
    coverage = finite_number(metrics.get("coverage"))
    median = finite_number(metrics.get("medianOnsetError"))
    p90 = finite_number(metrics.get("p90OnsetError"))
    return (
        float(gate["passed"]),
        -1.0 if hit_at_300 is None else hit_at_300,
        -1.0 if coverage is None else coverage,
        -(1e9 if median is None else median),
        -(1e9 if p90 is None else p90),
    )


def select_method(method_reports: dict[str, dict[str, Any]]) -> str:
    if not method_reports:
        raise ValueError("no-method-reports")
    return max(sorted(method_reports), key=lambda method: selection_key(method_reports[method]))


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
    lines = [
        "# PHENICX Human-Gold Violin Alignment",
        "",
        "PHENICX manual per-instrument note onsets. Public professional ensemble-section evidence only; not student-domain release evidence.",
        "",
        f"- selectedMethod: {report['selectedMethod']}",
        f"- alignmentGatePassed: {str(report['alignmentGatePassed']).lower()}",
        f"- polyphonicSubgroupGatePassed: {str(report['polyphonicSubgroupGate']['passed']).lower()}",
        f"- freshExternalConfirmationRequired: {str(report['freshExternalConfirmationRequired']).lower()}",
        f"- gate: {report['gate']}",
        "",
        "| Method | Split | Notes | Coverage | Median | P90 | Hit@300 | Gate |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for method, method_report in report["methods"].items():
        for split in ("development", "holdout"):
            metrics = method_report[split]
            lines.append(
                f"| {method} | {split} | {metrics['goldNotes']} | {metrics['coverage']} | "
                f"{metrics['medianOnsetError']} | {metrics['p90OnsetError']} | "
                f"{metrics['hitAt300ms']} | {str(evaluate_gate(metrics)['passed']).lower()} |"
            )
    lines.extend(["", "## Selected Method Per Piece", "", "| Piece | Split | Notes | Coverage | Median | P90 | Hit@300 | Gate |", "|---|---|---:|---:|---:|---:|---:|---|"])
    selected = report["methods"][report["selectedMethod"]]
    for piece, metrics in selected["pieces"].items():
        lines.append(
            f"| {piece} | {metrics['split']} | {metrics['goldNotes']} | {metrics['coverage']} | "
            f"{metrics['medianOnsetError']} | {metrics['p90OnsetError']} | "
            f"{metrics['hitAt300ms']} | {str(metrics['gate']['passed']).lower()} |"
        )
    lines.append("")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate fixed alignment baselines on PHENICX manual violin note gold."
    )
    parser.add_argument("--adapter", default=str(DEFAULT_ADAPTER))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    adapter_path = Path(args.adapter).resolve()
    output_dir = Path(args.output_dir).resolve()
    adapter = json.loads(adapter_path.read_text(encoding="utf-8"))
    if adapter.get("adapterReady") is not True:
        raise SystemExit("PHENICX adapter is not ready.")

    all_rows: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    piece_method_rows: dict[str, dict[str, list[dict[str, Any]]]] = {}
    cache_dir = output_dir / "cache" / "basic-pitch"
    for piece_index, piece_manifest in enumerate(adapter["pieces"], start=1):
        piece = str(piece_manifest["piece"])
        split = str(piece_manifest["split"])
        print(f"[{piece_index}/{len(adapter['pieces'])}] {piece}", file=sys.stderr, flush=True)
        try:
            source_rows, notes = load_notes(Path(piece_manifest["notesPath"]), piece)
            audio_path = Path(piece_manifest["audio"]["outputPath"])
            events = basic_pitch_events(audio_path, cache_dir)
            basic_predictions = predict_basic_pitch_assignment(notes, events)
            parangonar_predictions, parangonar_details = predict_parangonar(source_rows, events)
            fallback_predictions = fill_missing_predictions(
                parangonar_predictions, basic_predictions
            )
            predictions: dict[str, tuple[list[float | None], list[dict[str, Any] | None] | None]] = {
                "linear-duration": (
                    predict_linear_duration(source_rows, float(piece_manifest["audio"]["durationSeconds"])),
                    None,
                ),
                "basic-pitch-dtw": (basic_predictions, None),
                "parangonar-basic-pitch": (parangonar_predictions, parangonar_details),
                "parangonar-with-basic-fallback": (
                    fallback_predictions,
                    parangonar_details,
                ),
                "parangonar-fallback-chord-onset-consensus": (
                    apply_earliest_chord_onset_consensus(
                        source_rows, fallback_predictions
                    ),
                    None,
                ),
            }
            piece_method_rows[piece] = {}
            for method in METHODS:
                method_predictions, details = predictions[method]
                rows = build_result_rows(
                    piece,
                    split,
                    method,
                    source_rows,
                    method_predictions,
                    details,
                )
                piece_method_rows[piece][method] = rows
                all_rows.extend(rows)
        except Exception as exc:
            failures.append({"piece": piece, "reason": f"{type(exc).__name__}:{exc}"})

    method_reports: dict[str, dict[str, Any]] = {}
    for method in METHODS:
        method_rows = [row for row in all_rows if row["method"] == method]
        pieces: dict[str, dict[str, Any]] = {}
        for piece, by_method in piece_method_rows.items():
            rows = by_method[method]
            metrics = summarize_with_groups(rows)
            metrics["split"] = rows[0]["split"] if rows else ""
            metrics["gate"] = evaluate_gate(metrics)
            pieces[piece] = metrics
        method_reports[method] = {
            "development": summarize_with_groups(
                [row for row in method_rows if row["split"] == "development"]
            ),
            "holdout": summarize_with_groups(
                [row for row in method_rows if row["split"] == "holdout"]
            ),
            "pieces": pieces,
        }

    selected_method = select_method(method_reports)
    selected = method_reports[selected_method]
    holdout_piece_gates = [
        metrics["gate"]["passed"]
        for metrics in selected["pieces"].values()
        if metrics["split"] == "holdout"
    ]
    holdout_gate = evaluate_gate(selected["holdout"])
    polyphonic_subgroup_gate = evaluate_gate(selected["holdout"]["polyphonic"])
    alignment_gate_passed = (
        not failures
        and holdout_gate["passed"]
        and len(holdout_piece_gates) == 2
        and all(holdout_piece_gates)
    )
    report = {
        "ok": not failures and len(piece_method_rows) == 4,
        "dataset": "PHENICX-Anechoic",
        "evidenceType": "public-professional-ensemble-section-manual-note-onset-gold",
        "referenceAlignmentType": "manually-aligned-per-instrument-note-onset-offset",
        "splitPolicy": adapter["splitPolicy"],
        "selectionPolicy": "select method on development only; holdout untouched; require aggregate and both holdout pieces to pass",
        "methods": method_reports,
        "selectedMethod": selected_method,
        "gate": {
            "holdoutAggregate": holdout_gate,
            "holdoutPieceGatesPassed": sum(holdout_piece_gates),
            "holdoutPieceGateCount": len(holdout_piece_gates),
        },
        "alignmentGatePassed": alignment_gate_passed,
        "polyphonicSubgroupGate": polyphonic_subgroup_gate,
        "firstPassBeforeFallback": {
            "selectedMethod": "parangonar-basic-pitch",
            "holdout": method_reports["parangonar-basic-pitch"]["holdout"],
            "alignmentGate": evaluate_gate(
                method_reports["parangonar-basic-pitch"]["holdout"]
            ),
        },
        "candidateRationale": "For notes sharing normalizedScoreOnset, use the earliest available predicted onset as their shared onset. The transform reads score timing only (never goldOnset or goldChordSize), and candidate selection uses development metrics only.",
        "protocolCaveat": "The holdout result had already been inspected before the missing-only fallback and chord-onset consensus candidates were added. Both transformations use fixed score-side structure and are selected on development data, but this remains sequential engineering evidence rather than an untouched one-shot holdout.",
        "freshExternalConfirmationRequired": True,
        "studentReleaseEligible": False,
        "studentReleaseBlocker": "public-professional-ensemble-section-domain-only",
        "failures": failures,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (output_dir / "report.md").write_text(render_markdown(report), encoding="utf-8")
    write_csv(output_dir / "per-note.csv", all_rows)
    print(
        json.dumps(
            {
                "ok": report["ok"],
                "selectedMethod": selected_method,
                "development": selected["development"],
                "holdout": selected["holdout"],
                "gate": report["gate"],
                "alignmentGatePassed": alignment_gate_passed,
                "failures": failures,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["ok"] and report["alignmentGatePassed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
