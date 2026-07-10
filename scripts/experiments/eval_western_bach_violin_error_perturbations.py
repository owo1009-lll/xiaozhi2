from __future__ import annotations

import argparse
import bisect
import copy
import csv
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
import sys

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from eval_western_bach_violin_basic_pitch_transcription import filter_events  # noqa: E402


DEFAULT_ROWS = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-chord-timing.csv"
DEFAULT_CACHE = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-cache"
DEFAULT_RECOGNITION = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-basic-pitch-transcription.json"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-error-perturbations.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-bach-violin-error-perturbations.md"
THRESHOLD_GRID = (0.03, 0.05, 0.08, 0.10, 0.15, 0.20, 0.25, 0.30)
SCENARIOS = ("missing-note", "weak-onset", "wrong-pitch", "late-onset-800ms")
DEVELOPMENT_SPLIT = "development-reference-performer"
HOLDOUT_SPLIT = "holdout-unseen-performer"


def read_rows(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = [dict(row) for row in csv.DictReader(handle)]
    for row in rows:
        row["predictedTime"] = (
            None if row.get("adjustedPredTime") in ("", None)
            else float(row["adjustedPredTime"])
        )
        row["midi"] = int(row["midi"])
        row["noteIndex"] = int(row["noteIndex"])
        row["goldTime"] = float(row["goldTime"])
        row["doubleStop"] = str(row.get("doubleStop") or "").strip().lower() == "true"
    return rows


def load_base_events(
    rows: list[dict[str, Any]],
    cache_dir: Path,
    min_confidence: float,
    min_duration: float,
) -> dict[str, list[dict[str, Any]]]:
    events_by_unit = {}
    for unit in sorted({str(row["unit"]) for row in rows}):
        cache_path = cache_dir / f"{unit}.basic-pitch.json"
        events = json.loads(cache_path.read_text(encoding="utf-8"))
        events_by_unit[unit] = filter_events(events, min_confidence, min_duration)
    return events_by_unit


def rows_by_unit(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row["unit"])].append(row)
    for unit in grouped:
        grouped[unit].sort(key=lambda row: int(row["noteIndex"]))
    return grouped


def build_event_index(events: list[dict[str, Any]]) -> dict[int, tuple[list[float], list[int]]]:
    grouped: dict[int, list[tuple[float, int]]] = defaultdict(list)
    for index, event in enumerate(events):
        grouped[int(event["midi"])].append((float(event["start"]), index))
    output = {}
    for midi, pairs in grouped.items():
        pairs.sort()
        output[midi] = ([pair[0] for pair in pairs], [pair[1] for pair in pairs])
    return output


def nearby_event_indices(
    index: dict[int, tuple[list[float], list[int]]],
    midi: int,
    predicted_time: float | None,
    threshold: float,
) -> list[int]:
    if predicted_time is None or midi not in index:
        return []
    times, event_indices = index[midi]
    left = bisect.bisect_left(times, predicted_time - threshold)
    right = bisect.bisect_right(times, predicted_time + threshold)
    return event_indices[left:right]


def has_support(
    index: dict[int, tuple[list[float], list[int]]],
    row: dict[str, Any],
    threshold: float,
) -> bool:
    return bool(nearby_event_indices(index, int(row["midi"]), row.get("predictedTime"), threshold))


def accepted_rows(
    split: str,
    grouped_rows: dict[str, list[dict[str, Any]]],
    events_by_unit: dict[str, list[dict[str, Any]]],
    threshold: float,
    neighbor_radius: int,
) -> list[dict[str, Any]]:
    accepted = []
    for unit, unit_rows in grouped_rows.items():
        if not unit_rows or unit_rows[0].get("benchmarkSplit") != split:
            continue
        index = build_event_index(events_by_unit[unit])
        for row_index, row in enumerate(unit_rows):
            start = max(0, row_index - neighbor_radius)
            stop = min(len(unit_rows), row_index + neighbor_radius + 1)
            if all(has_support(index, neighbor, threshold) for neighbor in unit_rows[start:stop]):
                accepted.append(row)
    return accepted


def metrics(
    split: str,
    grouped_rows: dict[str, list[dict[str, Any]]],
    events_by_unit: dict[str, list[dict[str, Any]]],
    threshold: float,
    neighbor_radius: int,
    targets: set[tuple[str, int]] | None = None,
) -> dict[str, Any]:
    accepted = accepted_rows(split, grouped_rows, events_by_unit, threshold, neighbor_radius)
    total = sum(
        len(unit_rows)
        for unit_rows in grouped_rows.values()
        if unit_rows and unit_rows[0].get("benchmarkSplit") == split
    )
    correct = sum(
        row.get("predictedTime") is not None
        and abs(float(row["predictedTime"]) - float(row["goldTime"])) <= 0.30
        for row in accepted
    )
    target_set = targets or set()
    unsafe = sum((str(row["unit"]), int(row["noteIndex"])) in target_set for row in accepted)
    return {
        "goldNotes": total,
        "autoPassCount": len(accepted),
        "correctWithin300ms": correct,
        "precisionWithin300ms": correct / len(accepted) if accepted else None,
        "coverage": len(accepted) / total if total else None,
        "targetCount": len(target_set),
        "unsafeTargetAutoPassCount": unsafe,
        "unsafeTargetAutoPassRate": unsafe / len(target_set) if target_set else 0.0,
    }


def choose_targets(
    split: str,
    grouped_rows: dict[str, list[dict[str, Any]]],
    events_by_unit: dict[str, list[dict[str, Any]]],
    threshold: float,
    neighbor_radius: int,
    stride: int,
) -> set[tuple[str, int]]:
    eligible = [
        row for row in accepted_rows(split, grouped_rows, events_by_unit, threshold, neighbor_radius)
        if not bool(row.get("doubleStop"))
    ]
    return {
        (str(row["unit"]), int(row["noteIndex"]))
        for index, row in enumerate(eligible)
        if index % max(1, stride) == 0
    }


def mutate_events(
    grouped_rows: dict[str, list[dict[str, Any]]],
    base_events: dict[str, list[dict[str, Any]]],
    targets: set[tuple[str, int]],
    scenario: str,
    threshold: float,
) -> dict[str, list[dict[str, Any]]]:
    events_by_unit = copy.deepcopy(base_events)
    row_lookup = {
        (str(row["unit"]), int(row["noteIndex"])): row
        for unit_rows in grouped_rows.values()
        for row in unit_rows
    }
    touched: dict[str, set[int]] = defaultdict(set)
    for target in sorted(targets):
        row = row_lookup[target]
        unit = str(row["unit"])
        index = build_event_index(events_by_unit[unit])
        candidates = nearby_event_indices(index, int(row["midi"]), row.get("predictedTime"), threshold)
        for event_index in candidates:
            if event_index in touched[unit]:
                continue
            touched[unit].add(event_index)
            event = events_by_unit[unit][event_index]
            if scenario in {"missing-note", "weak-onset"}:
                event["_drop"] = True
            elif scenario == "wrong-pitch":
                event["midi"] = int(event["midi"]) + 2
            elif scenario == "late-onset-800ms":
                event["start"] = float(event["start"]) + 0.8
                event["end"] = float(event["end"]) + 0.8
            else:
                raise ValueError(f"unknown-perturbation-scenario:{scenario}")
    for unit in events_by_unit:
        events_by_unit[unit] = [event for event in events_by_unit[unit] if not event.get("_drop")]
    return events_by_unit


def evaluate_threshold(
    split: str,
    grouped_rows: dict[str, list[dict[str, Any]]],
    base_events: dict[str, list[dict[str, Any]]],
    threshold: float,
    neighbor_radius: int,
    target_stride: int,
) -> dict[str, Any]:
    clean = metrics(split, grouped_rows, base_events, threshold, neighbor_radius)
    targets = choose_targets(
        split,
        grouped_rows,
        base_events,
        threshold,
        neighbor_radius,
        target_stride,
    )
    scenarios = {}
    for scenario in SCENARIOS:
        mutated = mutate_events(grouped_rows, base_events, targets, scenario, threshold)
        scenarios[scenario] = metrics(
            split,
            grouped_rows,
            mutated,
            threshold,
            neighbor_radius,
            targets,
        )
    unsafe = sum(item["unsafeTargetAutoPassCount"] for item in scenarios.values())
    return {
        "supportThresholdSeconds": threshold,
        "clean": clean,
        "targetCount": len(targets),
        "scenarios": scenarios,
        "unsafeTargetAutoPassCount": unsafe,
        "gateReady": bool(
            clean.get("precisionWithin300ms") is not None
            and clean["precisionWithin300ms"] >= 0.90
            and clean.get("coverage") is not None
            and clean["coverage"] >= 0.20
            and len(targets) >= 100
            and unsafe == 0
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Bach Violin Public-Event Error Perturbation Gate",
            "",
            "Basic Pitch events from real professional recordings are perturbed after extraction. This is stronger than feature-only perturbation but is not raw-audio student-error evidence.",
            "",
            f"- selected threshold: {report.get('selectedThresholdSeconds')}",
            f"- development: {report.get('development')}",
            f"- unseen-performer holdout: {report.get('holdout')}",
            f"- publicEventPerturbationGateReady: {str(report.get('publicEventPerturbationGateReady', False)).lower()}",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Calibrate and evaluate score-aware error rejection on perturbed public Bach Basic Pitch events.")
    parser.add_argument("--rows", default=str(DEFAULT_ROWS))
    parser.add_argument("--cache-dir", default=str(DEFAULT_CACHE))
    parser.add_argument("--recognition", default=str(DEFAULT_RECOGNITION))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    parser.add_argument("--neighbor-radius", type=int, default=2)
    parser.add_argument("--target-stride", type=int, default=20)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rows = read_rows(Path(args.rows).resolve())
    grouped_rows = rows_by_unit(rows)
    recognition = json.loads(Path(args.recognition).read_text(encoding="utf-8"))
    selected_filter = ((recognition.get("eventFilterCalibration") or {}).get("selected") or {})
    min_confidence = float(selected_filter.get("minConfidence", 0.38))
    min_duration = float(selected_filter.get("minDurationSeconds", 0.08))
    base_events = load_base_events(
        rows,
        Path(args.cache_dir).resolve(),
        min_confidence,
        min_duration,
    )
    development_sweep = [
        evaluate_threshold(
            DEVELOPMENT_SPLIT,
            grouped_rows,
            base_events,
            threshold,
            max(0, int(args.neighbor_radius)),
            max(1, int(args.target_stride)),
        )
        for threshold in THRESHOLD_GRID
    ]
    qualified = [item for item in development_sweep if item["gateReady"]]
    selected = max(
        qualified,
        key=lambda item: (
            item["clean"].get("coverage") or 0.0,
            item["clean"].get("precisionWithin300ms") or 0.0,
            -item["supportThresholdSeconds"],
        ),
    ) if qualified else None
    holdout = None
    if selected:
        holdout = evaluate_threshold(
            HOLDOUT_SPLIT,
            grouped_rows,
            base_events,
            float(selected["supportThresholdSeconds"]),
            max(0, int(args.neighbor_radius)),
            max(1, int(args.target_stride)),
        )
    report = {
        "ok": True,
        "evidenceType": "real-public-audio-derived-event-perturbation",
        "eventFilter": {
            "minConfidence": min_confidence,
            "minDurationSeconds": min_duration,
            "mergeOverlappingSamePitch": True,
        },
        "neighborRadius": max(0, int(args.neighbor_radius)),
        "selectionDiscipline": "select support threshold on reference-performer development data; evaluate frozen threshold on unseen performers",
        "developmentSweep": development_sweep,
        "selectedThresholdSeconds": None if selected is None else selected["supportThresholdSeconds"],
        "development": selected,
        "holdout": holdout,
        "publicEventPerturbationGateReady": bool(holdout and holdout["gateReady"]),
        "rawAudioStudentErrorGateReady": False,
        "extraNoteDiagnosisReady": False,
        "limitations": [
            "perturbations-are-applied-to-basic-pitch-events-not-waveform",
            "professional-recordings-do-not-cover-real-student-error-acoustics",
            "extra-note-diagnosis-remains-review-only",
        ],
    }
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["publicEventPerturbationGateReady"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
