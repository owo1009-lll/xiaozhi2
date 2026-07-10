from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_gate_pilot import (  # noqa: E402
    build_runtime_notes,
    load_reference_by_piece,
    select_all_eval_units,
    select_pilot_units,
)
from eval_western_strings_m0_bach10 import (  # noqa: E402
    Note,
    _performance_array_for_parangonar,
    _score_array_for_parangonar,
    basic_pitch_events,
    evaluate_predictions,
    grade,
)
from parangonar.match import AutomaticNoteMatcher  # noqa: E402


DEFAULT_AUDIT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
DEFAULT_CACHE = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-cache"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-parangonar-pilot.json"
DEFAULT_CSV = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-parangonar-pilot.csv"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-parangonar-pilot.md"


def build_notes(unit: str, runtime_notes: list[dict[str, Any]]) -> list[Note]:
    return [
        Note(
            piece=unit,
            idx=int(item["referenceNoteIndex"]),
            score_time=float(item["globalQuarterOffset"]),
            gold_time=float(item["referenceTime"]),
            midi=int(item["midi"]),
            double_stop=bool(item.get("doubleStop")),
            legato="unknown",
        )
        for item in runtime_notes
    ]


def safe_rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator > 0 else None


def predict_parangonar_details(notes: list[Note], events: list[dict[str, Any]]) -> list[dict[str, Any] | None]:
    if not events:
        return [None for _ in notes]
    np.random.seed(7)
    matcher = AutomaticNoteMatcher()
    alignments = matcher(_score_array_for_parangonar(notes), _performance_array_for_parangonar(events))
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
        if 0 <= score_index < len(notes) and 0 <= event_index < len(events):
            matched.setdefault(score_index, []).append((event_index, events[event_index]))

    details: list[dict[str, Any] | None] = []
    for score_index, note_item in enumerate(notes):
        candidates = matched.get(score_index, [])
        if not candidates:
            details.append(None)
            continue
        event_index, event = min(
            candidates,
            key=lambda pair: (
                abs(float(pair[1]["midi"]) - float(note_item.midi)),
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
    return details


def summarize_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    errors = [float(row["absError"]) for row in rows if row.get("absError") not in ("", None)]
    total = len(rows)
    valid = len(errors)
    double_rows = [row for row in rows if bool(row.get("doubleStop"))]
    double_errors = [float(row["absError"]) for row in double_rows if row.get("absError") not in ("", None)]
    single_rows = [row for row in rows if not bool(row.get("doubleStop"))]
    single_errors = [float(row["absError"]) for row in single_rows if row.get("absError") not in ("", None)]
    summary = {
        "goldNotes": total,
        "validPredictions": valid,
        "missingPredictions": total - valid,
        "coverage": safe_rate(valid, total),
        "medianOnsetError": float(np.median(errors)) if errors else None,
        "p90OnsetError": float(np.percentile(errors, 90)) if errors else None,
        "hitAt100ms": safe_rate(sum(error <= 0.1 for error in errors), total),
        "hitAt300ms": safe_rate(sum(error <= 0.3 for error in errors), total),
        "singleNote": {
            "goldNotes": len(single_rows),
            "coverage": safe_rate(len(single_errors), len(single_rows)),
            "medianOnsetError": float(np.median(single_errors)) if single_errors else None,
            "hitAt300ms": safe_rate(sum(error <= 0.3 for error in single_errors), len(single_rows)),
        },
        "doubleStop": {
            "goldNotes": len(double_rows),
            "coverage": safe_rate(len(double_errors), len(double_rows)),
            "medianOnsetError": float(np.median(double_errors)) if double_errors else None,
            "hitAt300ms": safe_rate(sum(error <= 0.3 for error in double_errors), len(double_rows)),
        },
    }
    pitch_rows = [row for row in rows if row.get("predictedMidi") not in ("", None)]
    exact_pitch = sum(abs(int(row["predictedMidi"]) - int(row["midi"])) == 0 for row in pitch_rows)
    within_one = sum(abs(int(row["predictedMidi"]) - int(row["midi"])) <= 1 for row in pitch_rows)
    summary["scoreMatchedEventPitchAgreement"] = {
        "goldNotes": total,
        "matchedPitchEvents": len(pitch_rows),
        "eventCoverage": safe_rate(len(pitch_rows), total),
        "exactSemitoneAccuracyOverGold": safe_rate(exact_pitch, total),
        "exactSemitoneAccuracyAmongMatched": safe_rate(exact_pitch, len(pitch_rows)),
        "withinOneSemitoneAccuracyOverGold": safe_rate(within_one, total),
        "withinOneSemitoneAccuracyAmongMatched": safe_rate(within_one, len(pitch_rows)),
        "notIndependentRecognitionMetric": True,
        "caveat": "Parangonar uses pitch during matching; use the independent Basic Pitch transcription benchmark for recognition claims.",
    }
    summary["grade"] = grade(summary)
    return summary


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
    summary = report["summary"]
    return "\n".join(
        [
            "# Bach Violin Parangonar + Basic Pitch Pilot",
            "",
            "Professional public performances evaluated against estimated CQT-DTW timestamps. This is external development evidence, not human onset gold.",
            "",
            f"- units: {report['evaluatedUnitCount']} / {report['selectedUnitCount']}",
            f"- notes: {summary['goldNotes']}",
            f"- coverage: {summary['coverage']}",
            f"- median onset error: {summary['medianOnsetError']}",
            f"- p90 onset error: {summary['p90OnsetError']}",
            f"- hit@100ms: {summary['hitAt100ms']}",
            f"- hit@300ms: {summary['hitAt300ms']}",
            f"- grade: {summary['grade']}",
            f"- single-note: {summary['singleNote']}",
            f"- double-stop: {summary['doubleStop']}",
            "",
            "## Per Movement",
            "",
            "| Unit | Performer | Work | Movement | Notes | Coverage | Median | P90 | Hit@300 | Grade |",
            "|---|---|---|---|---:|---:|---:|---:|---:|---|",
            *[
                "| {unit} | {violinist} | {work} | {movement} | {goldNotes} | {coverage} | {medianOnsetError} | {p90OnsetError} | {hitAt300ms} | {grade} |".format(
                    **item
                )
                for item in report["units"]
            ],
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate Parangonar + Basic Pitch on the local Bach violin corpus.")
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    parser.add_argument("--selection", choices=["pilot", "all-eval-ready"], default="pilot")
    parser.add_argument("--max-units", type=int, default=6)
    parser.add_argument("--unit", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
    dataset_root = REPO_ROOT / str(audit["datasetRoot"])
    references = load_reference_by_piece(dataset_root)
    requested = {str(value).strip() for value in args.unit if str(value).strip()}
    if requested:
        selected = [row for row in audit["rows"] if row.get("unit") in requested]
        selection_policy = "explicit unit list"
    elif args.selection == "all-eval-ready":
        selected = select_all_eval_units(audit["rows"], max(0, args.max_units))
        selection_policy = "all eval-ready movements"
    else:
        selected = select_pilot_units(audit["rows"], max(1, args.max_units))
        selection_policy = "one public-domain movement per BWV work"
    if not selected:
        raise SystemExit("No eval-ready Bach violin units selected.")

    cache_dir = Path(args.cache_dir).resolve()
    all_rows: list[dict[str, Any]] = []
    unit_reports: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for index, source in enumerate(selected, start=1):
        print(f"[{index}/{len(selected)}] {source['unit']}", file=sys.stderr, flush=True)
        try:
            runtime_notes, missing = build_runtime_notes(
                REPO_ROOT / source["scorePath"],
                references.get(source["pieceId"], []),
            )
            mapping_rate = len(runtime_notes) / max(1, int(source.get("referenceNoteCount") or 0))
            if mapping_rate < 0.98:
                raise ValueError(f"score-reference-note-mapping-below-98pct:{mapping_rate:.6f}")
            notes = build_notes(source["unit"], runtime_notes)
            events = basic_pitch_events(REPO_ROOT / source["audioPath"], cache_dir)
            match_details = predict_parangonar_details(notes, events)
            predictions = [None if detail is None else float(detail["start"]) for detail in match_details]
            unit_summary, rows = evaluate_predictions(notes, predictions, "parangonar-basic-pitch")
            unit_summary["grade"] = grade(unit_summary)
            for row, detail in zip(rows, match_details):
                predicted_midi = None if detail is None else int(detail["midi"])
                row.update(
                    {
                        "unit": source["unit"],
                        "violinist": source["violinist"],
                        "work": source["work"],
                        "movement": source["movement"],
                        "benchmarkSplit": source.get("benchmarkSplit", ""),
                        "predictedMidi": "" if predicted_midi is None else predicted_midi,
                        "pitchSemitoneError": "" if predicted_midi is None else predicted_midi - int(row["midi"]),
                        "eventConfidence": "" if detail is None else round(float(detail["confidence"]), 6),
                        "eventDuration": "" if detail is None else round(float(detail["end"]) - float(detail["start"]), 6),
                        "eventIndex": "" if detail is None else int(detail["eventIndex"]),
                    }
                )
            unit_summary["scoreMatchedEventPitchAgreement"] = summarize_rows(rows)["scoreMatchedEventPitchAgreement"]
            all_rows.extend(rows)
            unit_reports.append(
                {
                    "unit": source["unit"],
                    "violinist": source["violinist"],
                    "work": source["work"],
                    "movement": source["movement"],
                    "benchmarkSplit": source.get("benchmarkSplit"),
                    "basicPitchEventCount": len(events),
                    "missingScoreMappings": missing,
                    **unit_summary,
                }
            )
        except Exception as exc:
            failures.append({"unit": source["unit"], "reason": f"{type(exc).__name__}:{exc}"})

    report = {
        "ok": bool(unit_reports),
        "evidenceType": "external-professional-recording-estimated-alignment",
        "referenceAlignmentType": "estimated-cqt-dtw-not-human-gold",
        "method": "parangonar-basic-pitch",
        "selectionPolicy": selection_policy,
        "selectedUnitCount": len(selected),
        "evaluatedUnitCount": len(unit_reports),
        "failedUnitCount": len(failures),
        "summary": summarize_rows(all_rows),
        "units": unit_reports,
        "failures": failures,
        "releaseEligible": False,
        "releaseBlocker": "estimated-reference-alignments-and-professional-domain-only",
    }
    out_path = Path(args.out).resolve()
    csv_path = Path(args.csv).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_csv(csv_path, all_rows)
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("ok", "method", "selectionPolicy", "selectedUnitCount", "evaluatedUnitCount", "failedUnitCount", "summary", "failures")}, ensure_ascii=False, indent=2))
    return 0 if report["ok"] and not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
