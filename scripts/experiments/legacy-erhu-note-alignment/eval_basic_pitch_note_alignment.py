# -*- coding: utf-8 -*-
"""Evaluate Basic Pitch note events as a symbolic note-alignment baseline.

Pipeline:
  score notes (from rebuilt store) <-> Basic Pitch note events
  monotone symbolic DTW on pitch class/absolute pitch
  gold seconds -> Basic Pitch notes in that 1s/2s/5s window -> aligned score note

This is eval-only. It reads Basic Pitch CSV output and writes results under
data/experiments/model-bakeoff.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]


def load_score_notes(score_id: str) -> list[dict]:
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((item for item in store.get("scores", []) if item.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")
    notes = []
    for section in score.get("sections", []) or []:
        for note in section.get("notes", []) or []:
            pos = note.get("notePosition") or {}
            if str(pos.get("scoreLineRole", "erhu")) != "erhu":
                continue
            midi = note.get("midiPitch")
            if midi is None:
                continue
            measure = int(note.get("measureIndex") or pos.get("globalMeasureIndex") or 0)
            if measure <= 0:
                continue
            notes.append({
                "sort": (
                    float(pos.get("globalMeasureIndex") or note.get("measureIndex") or measure),
                    float(note.get("beatStart", 0.0)),
                    float(note.get("beatDuration", 0.0)),
                    int(round(float(midi))),
                ),
                "measure": measure,
                "page": int(pos.get("pageNumber") or 0),
                "midi": int(round(float(midi))),
            })
    notes.sort(key=lambda item: item["sort"])
    by_measure: dict[int, list[dict]] = defaultdict(list)
    for note in notes:
        by_measure[note["measure"]].append(note)
    for measure_notes in by_measure.values():
        for idx, note in enumerate(measure_notes):
            if len(measure_notes) == 1:
                note["position"] = "single"
            elif idx == 0:
                note["position"] = "start"
            elif idx == len(measure_notes) - 1:
                note["position"] = "end"
            else:
                note["position"] = "middle"
            note["ordinal"] = idx
            note["countInMeasure"] = len(measure_notes)
    return notes


def load_basic_pitch_csv(path: Path) -> list[dict]:
    events = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        for row in reader:
            if len(row) < 4:
                continue
            try:
                start = float(row[0])
                end = float(row[1])
                midi = int(round(float(row[2])))
                velocity = float(row[3])
            except ValueError:
                continue
            events.append({"start": start, "end": end, "midi": midi, "velocity": velocity})
    return sorted(events, key=lambda item: (item["start"], item["end"], item["midi"]))


def load_gold(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            rows.append({
                "timeLabel": row.get("timeLabel", ""),
                "timeSeconds": float(row["timeSeconds"]),
                "measure": int(row["measure"]),
                "position": str(row.get("positionInMeasure", "")).strip(),
            })
    return rows


def pitch_cost(score_midi: np.ndarray, perf_midi: np.ndarray, mode: str) -> np.ndarray:
    if mode == "absolute":
        return np.abs(score_midi[:, None] - perf_midi[None, :]).astype(np.float32)
    score_pc = score_midi % 12
    perf_pc = perf_midi % 12
    diff = np.abs(score_pc[:, None] - perf_pc[None, :]).astype(np.float32)
    return np.minimum(diff, 12.0 - diff)


def dtw_align_score_to_perf(score_notes: list[dict], perf_events: list[dict], *, mode: str) -> dict[int, list[int]]:
    """Return perf index -> aligned score indices."""
    score_midi = np.array([item["midi"] for item in score_notes], dtype=np.int16)
    perf_midi = np.array([item["midi"] for item in perf_events], dtype=np.int16)
    c = pitch_cost(score_midi, perf_midi, mode=mode)
    n, m = c.shape
    dp = np.full((n + 1, m + 1), np.inf, dtype=np.float32)
    back = np.zeros((n + 1, m + 1), dtype=np.int8)
    dp[0, 0] = 0.0
    gap = 2.0
    for i in range(1, n + 1):
        dp[i, 0] = dp[i - 1, 0] + gap
        back[i, 0] = 1
    for j in range(1, m + 1):
        dp[0, j] = dp[0, j - 1] + gap
        back[0, j] = 2
    for i in range(1, n + 1):
        row = c[i - 1]
        for j in range(1, m + 1):
            choices = (
                dp[i - 1, j - 1] + row[j - 1],
                dp[i - 1, j] + gap,
                dp[i, j - 1] + gap,
            )
            move = int(np.argmin(choices))
            dp[i, j] = choices[move]
            back[i, j] = move

    mapping: dict[int, list[int]] = defaultdict(list)
    i, j = n, m
    while i > 0 or j > 0:
        move = int(back[i, j])
        if i > 0 and j > 0 and move == 0:
            mapping[j - 1].append(i - 1)
            i -= 1
            j -= 1
        elif i > 0 and (j == 0 or move == 1):
            i -= 1
        else:
            j -= 1
    return mapping


def position_matches(expected: str, predicted: str) -> bool:
    if expected == predicted:
        return True
    return predicted == "single" and expected in {"start", "middle", "end"}


def eval_gold(score_notes: list[dict], perf_events: list[dict], perf_to_score: dict[int, list[int]], gold: list[dict], *, window_seconds: float):
    rows = []
    exact = within1 = position = 0
    for row in gold:
        t0 = row["timeSeconds"]
        t1 = t0 + window_seconds
        candidate_perf = [
            idx for idx, event in enumerate(perf_events)
            if event["start"] <= t1 and event["end"] >= t0
        ]
        aligned = []
        for pidx in candidate_perf:
            for sidx in perf_to_score.get(pidx, []):
                note = score_notes[sidx]
                aligned.append((pidx, sidx, note))
        if not aligned:
            best = None
        else:
            def rank(item):
                pidx, _sidx, note = item
                measure_error = abs(int(note["measure"]) - int(row["measure"]))
                pos_bad = not (int(note["measure"]) == int(row["measure"]) and position_matches(row["position"], note["position"]))
                onset_distance = abs(float(perf_events[pidx]["start"]) - float(row["timeSeconds"]))
                return (int(pos_bad), measure_error, onset_distance)
            best = min(aligned, key=rank)
        if best is None:
            pred_measure = None
            pred_position = ""
            perf_start = None
        else:
            pidx, _sidx, note = best
            pred_measure = int(note["measure"])
            pred_position = str(note["position"])
            perf_start = float(perf_events[pidx]["start"])
        is_exact = pred_measure == row["measure"]
        is_within1 = pred_measure is not None and abs(pred_measure - row["measure"]) <= 1
        is_position = is_exact and position_matches(row["position"], pred_position)
        exact += int(is_exact)
        within1 += int(is_within1)
        position += int(is_position)
        rows.append({
            **row,
            "predMeasure": pred_measure,
            "predPosition": pred_position,
            "predPerfStart": perf_start,
            "measureExact": is_exact,
            "measureWithin1": is_within1,
            "positionHit": is_position,
            "candidatePerfCount": len(candidate_perf),
            "alignedCandidateCount": len(aligned),
        })
    n = max(1, len(gold))
    return {
        "pointCount": len(gold),
        "windowSeconds": window_seconds,
        "measureExactRate": round(exact / n, 3),
        "measureWithin1Rate": round(within1 / n, 3),
        "positionHitRate": round(position / n, 3),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--score-id", default="score-mofx8cdb-sbrqgx")
    parser.add_argument("--basic-pitch-csv", default="data/experiments/model-bakeoff/basic-pitch/xuan-dong-full_basic_pitch.csv")
    parser.add_argument("--gold", default="data/experiments/note-alignment/xuandong-m1-note-position-gold.csv")
    parser.add_argument("--pitch-mode", choices=["pitch-class", "absolute"], default="pitch-class")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    score_notes = load_score_notes(args.score_id)
    perf_events = load_basic_pitch_csv(REPO_ROOT / args.basic_pitch_csv)
    gold = load_gold(REPO_ROOT / args.gold)
    mapping = dtw_align_score_to_perf(score_notes, perf_events, mode=args.pitch_mode)
    results = [eval_gold(score_notes, perf_events, mapping, gold, window_seconds=w) for w in (1.0, 2.0, 5.0)]

    print(f"[Basic Pitch symbolic DTW | {args.score_id} | mode={args.pitch_mode} | scoreNotes={len(score_notes)} perfEvents={len(perf_events)}]")
    for result in results:
        print(
            f"  window={result['windowSeconds']:.0f}s "
            f"measureExact={result['measureExactRate']} "
            f"measure±1={result['measureWithin1Rate']} "
            f"positionHit={result['positionHitRate']}"
        )
    print("  per-point (5s window):")
    for row in results[-1]["rows"]:
        print(
            f"    {row['timeLabel']:>4} m{row['measure']:>3} {row['position']:<5} "
            f"-> m{str(row['predMeasure']):>3} {row['predPosition']:<6} "
            f"exact={row['measureExact']} pos={row['positionHit']} events={row['candidatePerfCount']}"
        )

    out = {
        "scoreId": args.score_id,
        "basicPitchCsv": args.basic_pitch_csv,
        "pitchMode": args.pitch_mode,
        "scoreNoteCount": len(score_notes),
        "performanceEventCount": len(perf_events),
        "results": results,
    }
    out_dir = REPO_ROOT / "data" / "experiments" / "model-bakeoff"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else out_dir / f"basic-pitch-note-align-{args.score_id}-{args.pitch_mode}.json"
    if not out_path.is_absolute():
        out_path = REPO_ROOT / out_path
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
