from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import librosa
import mir_eval.transcription
import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_AUDIT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-dataset-audit.json"
DEFAULT_CACHE = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-cache"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-transcription.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-transcription.md"
ONSET_TOLERANCES = (0.05, 0.10, 0.30)
FILTER_CONFIDENCE_GRID = tuple(value / 100.0 for value in range(32, 43))
FILTER_MIN_DURATION_GRID = (0.05, 0.06, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12)


def load_reference_rows(dataset_root: Path) -> dict[str, list[dict[str, str]]]:
    import csv

    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    with (dataset_root / "bach-violin-gold-notes.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            grouped[str(row.get("pieceId") or "")].append(dict(row))
    return grouped


def load_events(cache_dir: Path, audio_path: Path) -> list[dict[str, Any]]:
    cache_path = cache_dir / f"{audio_path.stem}.basic-pitch.json"
    if not cache_path.is_file():
        raise FileNotFoundError(f"basic-pitch-cache-missing:{cache_path}")
    return json.loads(cache_path.read_text(encoding="utf-8"))


def arrays_from_reference(rows: list[dict[str, str]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    intervals = []
    pitches = []
    double_stop = []
    for row in rows:
        start = float(row["goldTime"])
        end = max(start + 0.01, float(row["goldOffset"]))
        intervals.append((start, end))
        pitches.append(float(librosa.midi_to_hz(int(row["midi"]))))
        double_stop.append(str(row.get("doubleStop") or "").strip().lower() == "true")
    return np.asarray(intervals, dtype=np.float64), np.asarray(pitches, dtype=np.float64), np.asarray(double_stop, dtype=bool)


def arrays_from_events(events: list[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray]:
    intervals = []
    pitches = []
    for event in events:
        start = float(event["start"])
        end = max(start + 0.01, float(event["end"]))
        intervals.append((start, end))
        pitches.append(float(librosa.midi_to_hz(int(event["midi"]))))
    return np.asarray(intervals, dtype=np.float64).reshape((-1, 2)), np.asarray(pitches, dtype=np.float64)


def f1(precision: float | None, recall: float | None) -> float | None:
    if precision is None or recall is None or precision + recall <= 0:
        return None
    return 2.0 * precision * recall / (precision + recall)


def metrics_from_counts(reference_notes: int, estimated_notes: int, matched_notes: int) -> dict[str, Any]:
    precision = matched_notes / estimated_notes if estimated_notes else None
    recall = matched_notes / reference_notes if reference_notes else None
    return {
        "referenceNotes": reference_notes,
        "estimatedNotes": estimated_notes,
        "matchedNotes": matched_notes,
        "precision": precision,
        "recall": recall,
        "f1": f1(precision, recall),
    }


def evaluate_tolerance(
    reference_rows: list[dict[str, str]],
    events: list[dict[str, Any]],
    onset_tolerance: float,
) -> dict[str, Any]:
    reference_intervals, reference_pitches, double_stop = arrays_from_reference(reference_rows)
    estimated_intervals, estimated_pitches = arrays_from_events(events)
    matches = mir_eval.transcription.match_notes(
        reference_intervals,
        reference_pitches,
        estimated_intervals,
        estimated_pitches,
        onset_tolerance=onset_tolerance,
        pitch_tolerance=50.0,
        offset_ratio=None,
        strict=False,
    )
    matched_reference = {int(reference_index) for reference_index, _ in matches}
    single_reference = int((~double_stop).sum())
    double_reference = int(double_stop.sum())
    single_matched = sum(not bool(double_stop[index]) for index in matched_reference)
    double_matched = sum(bool(double_stop[index]) for index in matched_reference)
    metrics = metrics_from_counts(len(reference_rows), len(events), len(matches))
    metrics["singleNoteRecall"] = single_matched / single_reference if single_reference else None
    metrics["doubleStopRecall"] = double_matched / double_reference if double_reference else None
    return metrics


def evaluate_unit(reference_rows: list[dict[str, str]], events: list[dict[str, Any]]) -> dict[str, Any]:
    double_stop_count = sum(str(row.get("doubleStop") or "").strip().lower() == "true" for row in reference_rows)
    by_tolerance = {
        f"{int(round(tolerance * 1000))}ms": evaluate_tolerance(reference_rows, events, tolerance)
        for tolerance in ONSET_TOLERANCES
    }
    return {
        "referenceNotes": len(reference_rows),
        "estimatedNotes": len(events),
        "doubleStopReferenceNotes": double_stop_count,
        "byOnsetTolerance": by_tolerance,
    }


def merge_overlapping_same_pitch(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_pitch: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for source in sorted(events, key=lambda event: (int(event["midi"]), float(event["start"]))):
        midi = int(source["midi"])
        event = dict(source)
        if by_pitch[midi] and float(event["start"]) <= float(by_pitch[midi][-1]["end"]):
            previous = by_pitch[midi][-1]
            previous["end"] = max(float(previous["end"]), float(event["end"]))
            previous["confidence"] = max(
                float(previous.get("confidence", 0.0)),
                float(event.get("confidence", 0.0)),
            )
        else:
            by_pitch[midi].append(event)
    return sorted(
        [event for events_for_pitch in by_pitch.values() for event in events_for_pitch],
        key=lambda event: (float(event["start"]), float(event["end"]), int(event["midi"])),
    )


def filter_events(events: list[dict[str, Any]], min_confidence: float, min_duration: float) -> list[dict[str, Any]]:
    filtered = [
        event for event in events
        if float(event.get("confidence", 0.0)) >= min_confidence
        and float(event["end"]) - float(event["start"]) >= min_duration
    ]
    return merge_overlapping_same_pitch(filtered)


def aggregate_filtered_corpus(
    corpus: list[dict[str, Any]],
    split: str,
    min_confidence: float,
    min_duration: float,
) -> dict[str, Any]:
    metrics = []
    for item in corpus:
        if item["benchmarkSplit"] != split:
            continue
        events = filter_events(item["events"], min_confidence, min_duration)
        metrics.append(evaluate_tolerance(item["referenceRows"], events, 0.30))
    reference = sum(int(item["referenceNotes"]) for item in metrics)
    estimated = sum(int(item["estimatedNotes"]) for item in metrics)
    matched = sum(int(item["matchedNotes"]) for item in metrics)
    output = metrics_from_counts(reference, estimated, matched)
    output["singleNoteRecall"] = None
    output["doubleStopRecall"] = None
    return output


def calibrate_event_filter(corpus: list[dict[str, Any]]) -> dict[str, Any]:
    candidates = []
    for min_confidence in FILTER_CONFIDENCE_GRID:
        for min_duration in FILTER_MIN_DURATION_GRID:
            metrics = aggregate_filtered_corpus(
                corpus,
                "development-reference-performer",
                min_confidence,
                min_duration,
            )
            candidates.append(
                {
                    "minConfidence": min_confidence,
                    "minDurationSeconds": min_duration,
                    **metrics,
                }
            )
    qualified = [candidate for candidate in candidates if (candidate.get("precision") or 0.0) >= 0.90]
    selected = max(
        qualified,
        key=lambda candidate: (
            candidate.get("recall") or 0.0,
            candidate.get("f1") or 0.0,
            candidate["minDurationSeconds"],
            candidate["minConfidence"],
        ),
    ) if qualified else None
    holdout = None
    if selected:
        holdout = aggregate_filtered_corpus(
            corpus,
            "holdout-unseen-performer",
            float(selected["minConfidence"]),
            float(selected["minDurationSeconds"]),
        )
    return {
        "selectionDiscipline": "select threshold only on reference-performer development data; evaluate frozen threshold on unseen performers",
        "candidateCount": len(candidates),
        "qualifiedCandidateCount": len(qualified),
        "selected": selected,
        "holdout": holdout,
        "topDevelopmentCandidates": sorted(
            qualified,
            key=lambda candidate: (candidate.get("recall") or 0.0, candidate.get("f1") or 0.0),
            reverse=True,
        )[:10],
    }


def aggregate_units(units: list[dict[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for tolerance in ONSET_TOLERANCES:
        key = f"{int(round(tolerance * 1000))}ms"
        reference = sum(int(unit["byOnsetTolerance"][key]["referenceNotes"]) for unit in units)
        estimated = sum(int(unit["byOnsetTolerance"][key]["estimatedNotes"]) for unit in units)
        matched = sum(int(unit["byOnsetTolerance"][key]["matchedNotes"]) for unit in units)
        metrics = metrics_from_counts(reference, estimated, matched)
        single_numer = 0.0
        single_denom = 0
        double_numer = 0.0
        double_denom = 0
        for unit in units:
            item = unit["byOnsetTolerance"][key]
            double_reference = int(unit["doubleStopReferenceNotes"])
            single_reference = int(unit["referenceNotes"]) - double_reference
            if item.get("singleNoteRecall") is not None:
                single_numer += float(item["singleNoteRecall"]) * single_reference
                single_denom += single_reference
            if item.get("doubleStopRecall") is not None:
                double_numer += float(item["doubleStopRecall"]) * double_reference
                double_denom += double_reference
        metrics["singleNoteRecall"] = single_numer / single_denom if single_denom else None
        metrics["doubleStopRecall"] = double_numer / double_denom if double_denom else None
        output[key] = metrics
    return output


def grouped(units: list[dict[str, Any]], field: str) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for unit in units:
        groups[str(unit.get(field) or "unknown")].append(unit)
    return {key: aggregate_units(value) for key, value in sorted(groups.items())}


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Bach Violin Basic Pitch Transcription Benchmark",
            "",
            "Independent transcription scoring: Basic Pitch events are matched directly to reference notes. Parangonar assignments are not used.",
            "Reference note times are estimated CQT-DTW alignments, not human onset gold.",
            "",
            f"- all: {report['all']}",
            f"- development: {report['bySplit'].get('development-reference-performer')}",
            f"- unseen-performer holdout: {report['bySplit'].get('holdout-unseen-performer')}",
            f"- recognitionGateReady: {str(report['recognitionGateReady']).lower()}",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate cached Basic Pitch note transcription on the Bach violin corpus.")
    parser.add_argument("--audit", default=str(DEFAULT_AUDIT))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
    dataset_root = REPO_ROOT / str(audit["datasetRoot"])
    reference = load_reference_rows(dataset_root)
    cache_dir = Path(args.cache_dir).resolve()
    units: list[dict[str, Any]] = []
    corpus: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for source in audit["rows"]:
        if source.get("readyForEvalBenchmark") is not True:
            continue
        try:
            events = load_events(cache_dir, REPO_ROOT / source["audioPath"])
            reference_rows = reference.get(source["pieceId"], [])
            result = evaluate_unit(reference_rows, events)
            result.update(
                {
                    "unit": source["unit"],
                    "violinist": source["violinist"],
                    "work": source["work"],
                    "movement": source["movement"],
                    "benchmarkSplit": source["benchmarkSplit"],
                }
            )
            units.append(result)
            corpus.append(
                {
                    "benchmarkSplit": source["benchmarkSplit"],
                    "referenceRows": reference_rows,
                    "events": events,
                }
            )
        except Exception as exc:
            failures.append({"unit": source["unit"], "reason": f"{type(exc).__name__}:{exc}"})
    all_metrics = aggregate_units(units)
    by_split = grouped(units, "benchmarkSplit")
    holdout_300 = (by_split.get("holdout-unseen-performer") or {}).get("300ms") or {}
    recognition_ready = bool(
        not failures
        and holdout_300.get("precision") is not None
        and holdout_300["precision"] >= 0.90
        and holdout_300.get("recall") is not None
        and holdout_300["recall"] >= 0.80
    )
    filter_calibration = calibrate_event_filter(corpus)
    filtered_holdout = filter_calibration.get("holdout") or {}
    v2_alpha_ready = bool(
        filtered_holdout.get("precision") is not None
        and filtered_holdout["precision"] >= 0.90
        and filtered_holdout.get("recall") is not None
        and filtered_holdout["recall"] >= 0.20
    )
    report = {
        "ok": bool(units) and not failures,
        "evidenceType": "external-professional-recording-estimated-alignment",
        "method": "basic-pitch-independent-note-transcription",
        "pitchToleranceCents": 50.0,
        "offsetConstraint": None,
        "all": all_metrics,
        "bySplit": by_split,
        "byWork": grouped(units, "work"),
        "byPerformer": grouped(units, "violinist"),
        "units": units,
        "failures": failures,
        "recognitionGateReady": recognition_ready,
        "eventFilterCalibration": filter_calibration,
        "recognitionV2AlphaReady": v2_alpha_ready,
        "defaultStudentReleaseEligible": False,
        "releaseBlockers": [
            "reference-alignments-are-estimated-not-human-gold",
            "professional-clean-performance-domain-does-not-test-student-error-detection",
        ],
    }
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("ok", "method", "all", "bySplit", "failures", "recognitionGateReady", "eventFilterCalibration", "recognitionV2AlphaReady")}, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
