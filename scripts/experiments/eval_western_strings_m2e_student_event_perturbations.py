from __future__ import annotations

import argparse
import csv
import copy
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_FEATURES = REPO / "data" / "experiments" / "western-strings-m2" / "alignment-candidate-feature-table.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "m2e-student-event-perturbation-summary.json"
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


def choose_candidate(candidates: list[dict[str, str]]) -> dict[str, str]:
    def distance(row: dict[str, str]) -> float:
        value = safe_float(row.get("candidateToMedianAbsSeconds"))
        return value if value is not None else 999.0

    return sorted(candidates, key=lambda row: (distance(row), method_rank(row.get("method", ""))))[0]


def selected_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    groups: dict[tuple[str, str, str], list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        groups[note_key(row)].append(row)
    return [choose_candidate(group) for group in groups.values()]


def rows_by_piece(rows: list[dict[str, str]]) -> dict[tuple[str, str], list[dict[str, str]]]:
    grouped: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[(row.get("dataset", ""), row.get("piece", ""))].append(row)
    for key in list(grouped):
        grouped[key] = sorted(grouped[key], key=lambda row: safe_int(row.get("noteIndex"), 0))
    return grouped


def cache_path(dataset: str, piece: str) -> Path | None:
    if dataset == "m0a-bach10":
        return REPO / "data" / "experiments" / "western-strings-m0" / "m0a-bach10" / "cache" / "basic-pitch" / f"{piece}-violin.basic-pitch.json"
    if dataset == "m0b-urmp":
        track = piece.split(":")[-1]
        filename = {
            "vn": "AuSep_1_vn_01_Jupiter.basic-pitch.json",
            "vc": "AuSep_2_vc_01_Jupiter.basic-pitch.json",
        }.get(track)
        return REPO / "data" / "experiments" / "western-strings-m0" / "m0b-urmp" / "cache" / "basic-pitch" / filename if filename else None
    if dataset == "m0c-musicnet":
        sample_id = piece.split(":")[0].replace("MusicNet-", "")
        return REPO / "data" / "experiments" / "western-strings-m0" / "m0c-musicnet" / "cache" / "basic-pitch" / f"{sample_id}.basic-pitch.json"
    return None


def load_events(selected: list[dict[str, str]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    events: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for dataset, piece in rows_by_piece(selected):
        path = cache_path(dataset, piece)
        events[(dataset, piece)] = json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else []
    return events


def event_distance(event: dict[str, Any], row: dict[str, str]) -> float | None:
    predicted = safe_float(row.get("predTime"))
    midi = safe_float(row.get("midi"))
    event_start = safe_float(event.get("start"))
    event_midi = safe_float(event.get("midi"))
    if predicted is None or midi is None or event_start is None or event_midi is None:
        return None
    if round(event_midi) != round(midi):
        return None
    return abs(event_start - predicted)


def nearest_event_index(events: list[dict[str, Any]], row: dict[str, str], threshold_seconds: float) -> int | None:
    best_index = None
    best_distance = None
    for index, event in enumerate(events):
        distance = event_distance(event, row)
        if distance is None:
            continue
        if best_distance is None or distance < best_distance:
            best_distance = distance
            best_index = index
    return best_index if best_distance is not None and best_distance <= threshold_seconds else None


def nearest_support_seconds(events: list[dict[str, Any]], row: dict[str, str], pitch_tolerance: int) -> float | None:
    predicted = safe_float(row.get("predTime"))
    midi = safe_float(row.get("midi"))
    if predicted is None or midi is None:
        return None
    target_midi = round(midi)
    distances = []
    for event in events:
        event_start = safe_float(event.get("start"))
        event_midi = safe_float(event.get("midi"))
        if event_start is None or event_midi is None:
            continue
        if abs(round(event_midi) - target_midi) <= pitch_tolerance:
            distances.append(abs(event_start - predicted))
    return min(distances) if distances else None


def has_sequence_support(
    events_by_piece: dict[tuple[str, str], list[dict[str, Any]]],
    piece_rows: list[dict[str, str]],
    index: int,
    *,
    support_threshold_seconds: float,
    pitch_tolerance: int,
    neighbor_radius: int,
) -> bool:
    start = max(0, index - neighbor_radius)
    stop = min(len(piece_rows), index + neighbor_radius + 1)
    for row in piece_rows[start:stop]:
        events = events_by_piece[(row.get("dataset", ""), row.get("piece", ""))]
        support = nearest_support_seconds(events, row, pitch_tolerance)
        if support is None or support > support_threshold_seconds:
            return False
    return True


def baseline_auto_pass_rows(
    selected: list[dict[str, str]],
    events_by_piece: dict[tuple[str, str], list[dict[str, Any]]],
    *,
    support_threshold_seconds: float,
    pitch_tolerance: int,
    neighbor_radius: int,
) -> set[tuple[str, str, str]]:
    accepted = set()
    for piece_rows in rows_by_piece(selected).values():
        for index, row in enumerate(piece_rows):
            if has_sequence_support(
                events_by_piece,
                piece_rows,
                index,
                support_threshold_seconds=support_threshold_seconds,
                pitch_tolerance=pitch_tolerance,
                neighbor_radius=neighbor_radius,
            ):
                accepted.add(note_key(row))
    return accepted


def choose_targets(selected: list[dict[str, str]], accepted: set[tuple[str, str, str]], target_stride: int) -> set[tuple[str, str, str]]:
    targets = set()
    for piece_rows in rows_by_piece(selected).values():
        eligible = [row for row in piece_rows if note_key(row) in accepted]
        for offset, row in enumerate(eligible):
            if offset % target_stride == 0:
                targets.add(note_key(row))
    return targets


def mutate_events(
    selected: list[dict[str, str]],
    base_events: dict[tuple[str, str], list[dict[str, Any]]],
    targets: set[tuple[str, str, str]],
    scenario: str,
    *,
    support_threshold_seconds: float,
) -> dict[tuple[str, str], list[dict[str, Any]]]:
    events_by_piece = copy.deepcopy(base_events)
    if scenario == "extra_spurious_events":
        for piece_key, events in events_by_piece.items():
            for event in list(events[: max(1, len(events) // 20)]):
                extra = dict(event)
                start = safe_float(extra.get("start")) or 0.0
                midi = safe_float(extra.get("midi")) or 60.0
                extra["start"] = start + 0.12
                extra["midi"] = midi + 7
                events.append(extra)
            events.sort(key=lambda event: safe_float(event.get("start")) or 0.0)
        return events_by_piece

    rows = {note_key(row): row for row in selected}
    touched_indices: dict[tuple[str, str], set[int]] = defaultdict(set)
    for key in sorted(targets):
        row = rows[key]
        piece_key = (row.get("dataset", ""), row.get("piece", ""))
        events = events_by_piece[piece_key]
        index = nearest_event_index(events, row, support_threshold_seconds)
        if index is None or index in touched_indices[piece_key]:
            continue
        touched_indices[piece_key].add(index)
        if scenario in {"omit_target_notes", "weak_onset_dropouts"}:
            events[index]["_drop"] = True
        elif scenario == "wrong_pitch_target_notes":
            midi = safe_float(events[index].get("midi"))
            if midi is not None:
                events[index]["midi"] = midi + 2
        elif scenario == "late_target_notes_800ms":
            start = safe_float(events[index].get("start"))
            if start is not None:
                events[index]["start"] = start + 0.8
    for piece_key, events in list(events_by_piece.items()):
        events_by_piece[piece_key] = [event for event in events if not event.get("_drop")]
    return events_by_piece


def evaluate(
    selected: list[dict[str, str]],
    events_by_piece: dict[tuple[str, str], list[dict[str, Any]]],
    targets: set[tuple[str, str, str]],
    *,
    support_threshold_seconds: float,
    pitch_tolerance: int,
    neighbor_radius: int,
) -> dict[str, Any]:
    accepted: list[dict[str, str]] = []
    for piece_rows in rows_by_piece(selected).values():
        for index, row in enumerate(piece_rows):
            if has_sequence_support(
                events_by_piece,
                piece_rows,
                index,
                support_threshold_seconds=support_threshold_seconds,
                pitch_tolerance=pitch_tolerance,
                neighbor_radius=neighbor_radius,
            ):
                accepted.append(row)
    correct = 0
    unsafe_target = 0
    for row in accepted:
        key = note_key(row)
        gold = safe_float(row.get("goldTime"))
        pred = safe_float(row.get("predTime"))
        if gold is not None and pred is not None and abs(pred - gold) <= 0.3:
            correct += 1
        if key in targets:
            unsafe_target += 1
    return {
        "noteCount": len(selected),
        "targetCount": len(targets),
        "autoPassCount": len(accepted),
        "correctWithin300msAgainstCleanGold": correct,
        "precisionWithin300msAgainstCleanGold": round(correct / len(accepted), 4) if accepted else 0.0,
        "coverage": round(len(accepted) / len(selected), 4) if selected else 0.0,
        "targetAutoPassCount": unsafe_target,
        "targetAutoPassRate": round(unsafe_target / len(targets), 4) if targets else 0.0,
    }


def run(
    features_path: Path,
    support_threshold_seconds: float,
    pitch_tolerance: int,
    neighbor_radius: int,
    target_stride: int,
) -> dict[str, Any]:
    selected = selected_rows(read_rows(features_path))
    base_events = load_events(selected)
    clean_accept = baseline_auto_pass_rows(
        selected,
        base_events,
        support_threshold_seconds=support_threshold_seconds,
        pitch_tolerance=pitch_tolerance,
        neighbor_radius=neighbor_radius,
    )
    targets = choose_targets(selected, clean_accept, target_stride)
    scenarios = {}
    target_scenarios = [
        "omit_target_notes",
        "wrong_pitch_target_notes",
        "late_target_notes_800ms",
        "weak_onset_dropouts",
    ]
    scenarios["clean_reference"] = evaluate(
        selected,
        base_events,
        set(),
        support_threshold_seconds=support_threshold_seconds,
        pitch_tolerance=pitch_tolerance,
        neighbor_radius=neighbor_radius,
    )
    for scenario in target_scenarios + ["extra_spurious_events"]:
        scenario_targets = targets if scenario in target_scenarios else set()
        mutated = mutate_events(
            selected,
            base_events,
            scenario_targets,
            scenario,
            support_threshold_seconds=support_threshold_seconds,
        )
        scenarios[scenario] = evaluate(
            selected,
            mutated,
            scenario_targets,
            support_threshold_seconds=support_threshold_seconds,
            pitch_tolerance=pitch_tolerance,
            neighbor_radius=neighbor_radius,
        )
    unsafe = {
        name: metrics
        for name, metrics in scenarios.items()
        if name in target_scenarios and metrics["targetAutoPassCount"] > 0
    }
    clean = scenarios["clean_reference"]
    ready = (
        clean["precisionWithin300msAgainstCleanGold"] >= 0.9
        and clean["coverage"] >= 0.2
        and not unsafe
    )
    return {
        "ok": True,
        "studentGateReady": ready,
        "supportFeature": {
            "source": "basic-pitch-event-start-sequence",
            "thresholdSeconds": support_threshold_seconds,
            "pitchToleranceSemitones": pitch_tolerance,
            "neighborRadius": neighbor_radius,
            "targetStride": target_stride,
        },
        "unsafeScenarios": sorted(unsafe),
        "scenarios": scenarios,
        "warning": "M2e mutates cached Basic Pitch events to simulate student-like errors. This is stronger than feature-only perturbation, but still not a substitute for real student recordings.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate M2d sequence support on student-like Basic Pitch event perturbations.")
    parser.add_argument("--features", default=str(DEFAULT_FEATURES))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--support-threshold-seconds", type=float, default=0.03)
    parser.add_argument("--pitch-tolerance", type=int, default=0)
    parser.add_argument("--neighbor-radius", type=int, default=2)
    parser.add_argument("--target-stride", type=int, default=5)
    parser.add_argument("--expect-positive", action="store_true")
    parser.add_argument("--expect-negative", action="store_true")
    args = parser.parse_args()

    summary = run(
        Path(args.features),
        float(args.support_threshold_seconds),
        int(args.pitch_tolerance),
        int(args.neighbor_radius),
        max(1, int(args.target_stride)),
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.expect_positive and not summary["studentGateReady"]:
        raise SystemExit("Expected student-like event perturbations to pass the M2d gate, but they exposed unsafe auto-pass.")
    if args.expect_negative and summary["studentGateReady"]:
        raise SystemExit("Expected student-like event perturbations to fail the M2d gate, but they passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
