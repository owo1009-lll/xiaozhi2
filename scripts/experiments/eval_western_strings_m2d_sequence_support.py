from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
DEFAULT_FEATURES = REPO / "data" / "experiments" / "western-strings-m2" / "alignment-candidate-feature-table.csv"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m2" / "m2d-sequence-support-summary.json"
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


class BasicPitchCache:
    def __init__(self) -> None:
        self._events: dict[tuple[str, str], list[dict[str, Any]]] = {}

    def events(self, dataset: str, piece: str) -> list[dict[str, Any]]:
        key = (dataset, piece)
        if key not in self._events:
            path = cache_path(dataset, piece)
            self._events[key] = json.loads(path.read_text(encoding="utf-8")) if path and path.exists() else []
        return self._events[key]


def nearest_support_seconds(cache: BasicPitchCache, row: dict[str, str], *, shift_seconds: float, pitch_tolerance: int) -> float | None:
    predicted = safe_float(row.get("predTime"))
    midi = safe_float(row.get("midi"))
    if predicted is None or midi is None:
        return None
    predicted += shift_seconds
    target_midi = round(midi)
    distances = [
        abs(float(event.get("start", 0.0)) - predicted)
        for event in cache.events(row.get("dataset", ""), row.get("piece", ""))
        if abs(round(float(event.get("midi", -999))) - target_midi) <= pitch_tolerance
    ]
    return min(distances) if distances else None


def rows_by_piece(rows: list[dict[str, str]]) -> dict[tuple[str, str], list[dict[str, str]]]:
    grouped: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        grouped[(row.get("dataset", ""), row.get("piece", ""))].append(row)
    for key in list(grouped):
        grouped[key] = sorted(grouped[key], key=lambda row: safe_int(row.get("noteIndex"), 0))
    return grouped


def has_sequence_support(
    cache: BasicPitchCache,
    piece_rows: list[dict[str, str]],
    index: int,
    *,
    shift_seconds: float,
    support_threshold_seconds: float,
    pitch_tolerance: int,
    neighbor_radius: int,
) -> bool:
    start = max(0, index - neighbor_radius)
    stop = min(len(piece_rows), index + neighbor_radius + 1)
    for row in piece_rows[start:stop]:
        support = nearest_support_seconds(cache, row, shift_seconds=shift_seconds, pitch_tolerance=pitch_tolerance)
        if support is None or support > support_threshold_seconds:
            return False
    return True


def evaluate(
    rows: list[dict[str, str]],
    *,
    shift_seconds: float,
    support_threshold_seconds: float,
    pitch_tolerance: int,
    neighbor_radius: int,
) -> dict[str, Any]:
    cache = BasicPitchCache()
    selected = selected_rows(rows)
    accepted: list[dict[str, str]] = []
    for piece_rows in rows_by_piece(selected).values():
        for index, row in enumerate(piece_rows):
            if has_sequence_support(
                cache,
                piece_rows,
                index,
                shift_seconds=shift_seconds,
                support_threshold_seconds=support_threshold_seconds,
                pitch_tolerance=pitch_tolerance,
                neighbor_radius=neighbor_radius,
            ):
                accepted.append(row)
    correct = 0
    for row in accepted:
        gold = safe_float(row.get("goldTime"))
        pred = safe_float(row.get("predTime"))
        if gold is not None and pred is not None and abs((pred + shift_seconds) - gold) <= 0.3:
            correct += 1
    return {
        "noteCount": len(selected),
        "autoPassCount": len(accepted),
        "correctWithin300ms": correct,
        "precisionWithin300ms": round(correct / len(accepted), 4) if accepted else 0.0,
        "coverage": round(len(accepted) / len(selected), 4) if selected else 0.0,
    }


def run(features_path: Path, support_threshold_seconds: float, pitch_tolerance: int, neighbor_radius: int) -> dict[str, Any]:
    rows = read_rows(features_path)
    baseline = evaluate(
        rows,
        shift_seconds=0.0,
        support_threshold_seconds=support_threshold_seconds,
        pitch_tolerance=pitch_tolerance,
        neighbor_radius=neighbor_radius,
    )
    shifted = evaluate(
        rows,
        shift_seconds=0.8,
        support_threshold_seconds=support_threshold_seconds,
        pitch_tolerance=pitch_tolerance,
        neighbor_radius=neighbor_radius,
    )
    ready = (
        baseline["precisionWithin300ms"] >= 0.9
        and baseline["coverage"] >= 0.2
        and shifted["autoPassCount"] == 0
    )
    return {
        "ok": True,
        "studentGateReady": ready,
        "supportFeature": {
            "source": "basic-pitch-event-start-sequence",
            "thresholdSeconds": support_threshold_seconds,
            "pitchToleranceSemitones": pitch_tolerance,
            "neighborRadius": neighbor_radius,
        },
        "scenarios": {
            "baseline_with_sequence_basic_pitch_support": baseline,
            "student_like_correlated_late_800ms_with_sequence_basic_pitch_support": shifted,
        },
        "warning": "Sequence-level Basic Pitch support blocks repeated same-pitch correlated drift in this eval-only pilot. Production student release still requires decision-level wiring and real student-like audio validation.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate sequence-level Basic Pitch support as a western strings student-release gate candidate.")
    parser.add_argument("--features", default=str(DEFAULT_FEATURES))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--support-threshold-seconds", type=float, default=0.05)
    parser.add_argument("--pitch-tolerance", type=int, default=0)
    parser.add_argument("--neighbor-radius", type=int, default=2)
    parser.add_argument("--expect-positive", action="store_true")
    parser.add_argument("--expect-negative", action="store_true")
    args = parser.parse_args()

    summary = run(
        Path(args.features),
        float(args.support_threshold_seconds),
        int(args.pitch_tolerance),
        int(args.neighbor_radius),
    )
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if args.expect_positive and not summary["studentGateReady"]:
        raise SystemExit("Expected sequence-level Basic Pitch support to pass the student gate pilot, but it failed.")
    if args.expect_negative and summary["studentGateReady"]:
        raise SystemExit("Expected sequence-level Basic Pitch support to fail the student gate pilot, but it passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
