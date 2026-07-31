#!/usr/bin/env python3
"""Put LilyPond SVG noteheads into score order and prove the order is right.

LilyPond emits noteheads in internal drawing order, not reading order, so the
positions have to be regrouped into systems (by y) and sorted left to right.
That regrouping is the only inferred step in an otherwise exact pipeline, so it
is not trusted blindly: the resulting order is checked against the pitch
sequence that came from the MIDI, which is exact.

On a staff, higher pitch sits higher on the page, so within one system the
correlation between pitch and -y must be strongly positive. A shuffled order
destroys that correlation, which is what makes this a real check rather than a
formality.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_lilypond_notehead_coords import extract  # noqa: E402


def group_systems(positions: list[dict[str, float]], gap_ratio: float = 0.4) -> list[list[int]]:
    """Split noteheads into systems using the vertical gaps between staff bands."""
    if not positions:
        return []
    order = sorted(range(len(positions)), key=lambda i: positions[i]["y"])
    ys = [positions[i]["y"] for i in order]
    deltas = [ys[i + 1] - ys[i] for i in range(len(ys) - 1)]
    if not deltas:
        return [order]
    # A system spans a few staff steps; the jump to the next system is far
    # larger. Anything above this threshold is treated as a system break.
    typical = statistics.median([d for d in deltas if d > 0] or [0.0])
    threshold = max(typical * 4.0, (max(ys) - min(ys)) * gap_ratio / max(1, len(ys) ** 0.5))

    systems: list[list[int]] = [[order[0]]]
    for index in range(1, len(order)):
        if ys[index] - ys[index - 1] > threshold:
            systems.append([])
        systems[-1].append(order[index])
    return systems


def score_order(positions: list[dict[str, float]]) -> list[int]:
    systems = group_systems(positions)
    ordered: list[int] = []
    for system in systems:
        ordered.extend(sorted(system, key=lambda i: positions[i]["x"]))
    return ordered


def pearson(a: list[float], b: list[float]) -> float:
    if len(a) < 3:
        return 1.0
    mean_a, mean_b = statistics.fmean(a), statistics.fmean(b)
    num = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
    den_a = sum((x - mean_a) ** 2 for x in a) ** 0.5
    den_b = sum((y - mean_b) ** 2 for y in b) ** 0.5
    return num / (den_a * den_b) if den_a and den_b else 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--svg", required=True)
    parser.add_argument("--midi", required=True)
    parser.add_argument("--min-correlation", type=float, default=0.9)
    args = parser.parse_args()

    import mido

    page = extract(Path(args.svg))
    positions = page["positions"]

    pitches: list[int] = []
    events: list[tuple[int, int]] = []
    midi = mido.MidiFile(args.midi)
    for track in midi.tracks:
        tick = 0
        for message in track:
            tick += message.time
            if message.type == "note_on" and message.velocity > 0:
                events.append((tick, message.note))
    events.sort()
    pitches = [note for _, note in events]

    ordered = score_order(positions)
    systems = group_systems(positions)

    correlations = []
    cursor = 0
    for system in systems:
        size = len(system)
        window = ordered[cursor:cursor + size]
        window_pitches = pitches[cursor:cursor + size]
        cursor += size
        if len(window) != len(window_pitches) or len(window) < 3:
            continue
        correlations.append(pearson(
            [-positions[i]["y"] for i in window],
            [float(p) for p in window_pitches],
        ))

    worst = min(correlations) if correlations else 1.0
    mean_correlation = statistics.fmean(correlations) if correlations else 1.0
    ok = len(positions) == len(pitches) and worst >= args.min_correlation

    print(json.dumps({
        "ok": ok,
        "noteheads": len(positions),
        "midiNotes": len(pitches),
        "systems": len(systems),
        "systemSizes": [len(s) for s in systems],
        "pitchYCorrelation": {
            "worstSystem": round(worst, 4),
            "meanSystem": round(mean_correlation, 4),
            "threshold": args.min_correlation,
        },
    }, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
