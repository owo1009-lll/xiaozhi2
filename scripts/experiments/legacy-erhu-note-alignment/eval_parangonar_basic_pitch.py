# -*- coding: utf-8 -*-
"""Evaluate Parangonar AutomaticNoteMatcher on Basic Pitch note events.

This is an external note-alignment baseline:
  score note array (rebuilt store) <-> performance note array (Basic Pitch)
  Parangonar AutomaticNoteMatcher -> matched note ids
  human second-level gold -> measure/position hit rates

Run with the isolated model-bakeoff venv because Parangonar is not a production
dependency.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from parangonar.match import AutomaticNoteMatcher, TheGlueNoteMatcher
import parangonar.match.pretrained_models as parangonar_pretrained

REPO_ROOT = Path(__file__).resolve().parents[2]


def score_note_rows(score_id: str) -> list[dict]:
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((item for item in store.get("scores", []) if item.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")
    rows = []
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
            rows.append({
                "sort": (
                    float(pos.get("globalMeasureIndex") or note.get("measureIndex") or measure),
                    float(note.get("beatStart", 0.0)),
                    float(note.get("beatDuration", 0.0)),
                    int(round(float(midi))),
                ),
                "measure": measure,
                "page": int(pos.get("pageNumber") or 0),
                "midi": int(round(float(midi))),
                "onsetBeat": float(note.get("beatStart", 0.0)) + float(measure - 1) * 4.0,
                "durationBeat": max(0.05, float(note.get("beatDuration", 1.0))),
            })
    rows.sort(key=lambda item: item["sort"])
    by_measure: dict[int, list[dict]] = defaultdict(list)
    for row in rows:
        by_measure[row["measure"]].append(row)
    for idx, row in enumerate(rows):
        row["id"] = f"s{idx}"
    for measure_rows in by_measure.values():
        ordered = sorted(measure_rows, key=lambda item: item["sort"])
        for idx, row in enumerate(ordered):
            if len(ordered) == 1:
                row["position"] = "single"
            elif idx == 0:
                row["position"] = "start"
            elif idx == len(ordered) - 1:
                row["position"] = "end"
            else:
                row["position"] = "middle"
            row["ordinal"] = idx
            row["countInMeasure"] = len(ordered)
    return rows


def score_array(rows: list[dict]) -> np.ndarray:
    dtype = [
        ("id", "U32"),
        ("pitch", "i4"),
        ("onset_beat", "f4"),
        ("duration_beat", "f4"),
        ("onset_quarter", "f4"),
        ("duration_quarter", "f4"),
        ("is_grace", "bool"),
    ]
    arr = np.zeros(len(rows), dtype=dtype)
    for i, row in enumerate(rows):
        arr[i]["id"] = row["id"]
        arr[i]["pitch"] = row["midi"]
        arr[i]["onset_beat"] = row["onsetBeat"]
        arr[i]["duration_beat"] = row["durationBeat"]
        arr[i]["onset_quarter"] = row["onsetBeat"]
        arr[i]["duration_quarter"] = row["durationBeat"]
        arr[i]["is_grace"] = False
    return arr


def load_basic_pitch_csv(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        next(reader)
        for row in reader:
            if len(row) < 4:
                continue
            try:
                start = float(row[0])
                end = float(row[1])
                midi = int(round(float(row[2])))
                velocity = int(round(float(row[3])))
            except ValueError:
                continue
            rows.append({
                "start": start,
                "end": end,
                "duration": max(0.02, end - start),
                "midi": midi,
                "velocity": velocity,
            })
    rows.sort(key=lambda item: (item["start"], item["end"], item["midi"]))
    for idx, row in enumerate(rows):
        row["id"] = f"p{idx}"
    return rows


def performance_array(rows: list[dict]) -> np.ndarray:
    dtype = [
        ("id", "U32"),
        ("pitch", "i4"),
        ("onset_sec", "f4"),
        ("duration_sec", "f4"),
        ("velocity", "i4"),
    ]
    arr = np.zeros(len(rows), dtype=dtype)
    for i, row in enumerate(rows):
        arr[i]["id"] = row["id"]
        arr[i]["pitch"] = row["midi"]
        arr[i]["onset_sec"] = row["start"]
        arr[i]["duration_sec"] = row["duration"]
        arr[i]["velocity"] = row["velocity"]
    return arr


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


def position_matches(expected: str, predicted: str) -> bool:
    return expected == predicted or (predicted == "single" and expected in {"start", "middle", "end"})


def eval_gold(score_rows: list[dict], perf_rows: list[dict], alignments: list[dict], gold: list[dict], *, window_seconds: float):
    score_by_id = {row["id"]: row for row in score_rows}
    perf_to_score: dict[str, list[dict]] = defaultdict(list)
    for item in alignments:
        if item.get("label") == "match":
            score = score_by_id.get(str(item.get("score_id")))
            if score is not None:
                perf_to_score[str(item.get("performance_id"))].append(score)
    rows = []
    exact = within1 = position = 0
    for gold_row in gold:
        t0 = gold_row["timeSeconds"]
        t1 = t0 + window_seconds
        candidates = [
            perf for perf in perf_rows
            if perf["start"] <= t1 and perf["end"] >= t0
        ]
        aligned = []
        for perf in candidates:
            for score in perf_to_score.get(perf["id"], []):
                aligned.append((perf, score))
        if aligned:
            def rank(item):
                perf, score = item
                measure_error = abs(int(score["measure"]) - int(gold_row["measure"]))
                pos_bad = not (
                    int(score["measure"]) == int(gold_row["measure"])
                    and position_matches(gold_row["position"], score["position"])
                )
                time_distance = abs(float(perf["start"]) - float(gold_row["timeSeconds"]))
                return (int(pos_bad), measure_error, time_distance)
            perf, score = min(aligned, key=rank)
            pred_measure = int(score["measure"])
            pred_position = str(score["position"])
            pred_perf_start = float(perf["start"])
        else:
            pred_measure = None
            pred_position = ""
            pred_perf_start = None
        is_exact = pred_measure == gold_row["measure"]
        is_within1 = pred_measure is not None and abs(pred_measure - gold_row["measure"]) <= 1
        is_position = is_exact and position_matches(gold_row["position"], pred_position)
        exact += int(is_exact)
        within1 += int(is_within1)
        position += int(is_position)
        rows.append({
            **gold_row,
            "predMeasure": pred_measure,
            "predPosition": pred_position,
            "predPerfStart": pred_perf_start,
            "measureExact": is_exact,
            "measureWithin1": is_within1,
            "positionHit": is_position,
            "candidatePerfCount": len(candidates),
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
    parser.add_argument("--matcher", choices=["automatic", "thegluenote"], default="automatic")
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    scores = score_note_rows(args.score_id)
    perfs = load_basic_pitch_csv(REPO_ROOT / args.basic_pitch_csv)
    gold = load_gold(REPO_ROOT / args.gold)
    if args.matcher == "thegluenote":
        # Parangonar 3.3.2 imports torch but forgets this guard in pretrained_models.
        # Keep the workaround local to the isolated bake-off venv.
        parangonar_pretrained.TORCH_AVAILABLE = True
        matcher = TheGlueNoteMatcher()
    else:
        matcher = AutomaticNoteMatcher()
    alignments = matcher(score_array(scores), performance_array(perfs))
    results = [eval_gold(scores, perfs, alignments, gold, window_seconds=w) for w in (1.0, 2.0, 5.0)]

    print(f"[Parangonar {args.matcher} + Basic Pitch | {args.score_id} | scoreNotes={len(scores)} perfEvents={len(perfs)} alignments={len(alignments)}]")
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
        "scoreNoteCount": len(scores),
        "performanceEventCount": len(perfs),
        "alignmentCount": len(alignments),
        "matcher": args.matcher,
        "results": results,
    }
    out_dir = REPO_ROOT / "data" / "experiments" / "model-bakeoff"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else out_dir / f"parangonar-{args.matcher}-basic-pitch-{args.score_id}.json"
    if not out_path.is_absolute():
        out_path = REPO_ROOT / out_path
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
