# -*- coding: utf-8 -*-
"""Evaluate pymatchmaker offline audio score following on the note-position gold.

This creates a temporary MIDI score from the rebuilt store and lets Matchmaker
follow the real audio file. It is an online score-following baseline, not a
production dependency.
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pretty_midi
from matchmaker.matchmaker import Matchmaker

REPO_ROOT = Path(__file__).resolve().parents[2]


def load_score_notes(score_id: str) -> list[dict]:
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((item for item in store.get("scores", []) if item.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")
    notes = []
    abs_beat = 0.0
    last_key = None
    for section in sorted(score.get("sections", []) or [], key=lambda s: s.get("sequenceIndex", 0)):
        section_notes = []
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
            section_notes.append({
                "measure": measure,
                "page": int(pos.get("pageNumber") or 0),
                "midi": int(round(float(midi))),
                "beatStartLocal": float(note.get("beatStart", 0.0)),
                "beatDuration": max(0.05, float(note.get("beatDuration", 1.0))),
                "sort": (
                    float(pos.get("globalMeasureIndex") or note.get("measureIndex") or measure),
                    float(note.get("beatStart", 0.0)),
                    float(note.get("beatDuration", 0.0)),
                    int(round(float(midi))),
                ),
            })
        section_notes.sort(key=lambda item: item["sort"])
        if not section_notes:
            continue
        key = tuple((n["measure"], n["beatStartLocal"], n["midi"]) for n in section_notes[:4])
        if key == last_key:
            continue
        last_key = key
        section_base = abs_beat
        max_end = 0.0
        for note in section_notes:
            note["onsetBeat"] = section_base + note["beatStartLocal"]
            note["endBeat"] = note["onsetBeat"] + note["beatDuration"]
            max_end = max(max_end, note["beatStartLocal"] + note["beatDuration"])
            notes.append(note)
        abs_beat += max(max_end, 0.25)
    notes.sort(key=lambda item: (item["onsetBeat"], item["midi"]))
    by_measure: dict[int, list[dict]] = defaultdict(list)
    for note in notes:
        by_measure[note["measure"]].append(note)
    for measure_notes in by_measure.values():
        ordered = sorted(measure_notes, key=lambda item: (item["onsetBeat"], item["midi"]))
        for idx, note in enumerate(ordered):
            if len(ordered) == 1:
                note["position"] = "single"
            elif idx == 0:
                note["position"] = "start"
            elif idx == len(ordered) - 1:
                note["position"] = "end"
            else:
                note["position"] = "middle"
    return notes


def write_score_midi(notes: list[dict], out_path: Path, tempo: float = 72.0):
    midi = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    inst = pretty_midi.Instrument(program=40, name="erhu-score")
    seconds_per_beat = 60.0 / tempo
    for note in notes:
        start = note["onsetBeat"] * seconds_per_beat
        end = max(start + 0.05, note["endBeat"] * seconds_per_beat)
        inst.notes.append(pretty_midi.Note(velocity=96, pitch=int(note["midi"]), start=start, end=end))
    midi.instruments.append(inst)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    midi.write(str(out_path))


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


def beat_to_note(notes: list[dict], beat: float):
    if not notes:
        return None
    return min(notes, key=lambda item: (
        0 if item["onsetBeat"] <= beat <= item["endBeat"] else 1,
        min(abs(beat - item["onsetBeat"]), abs(beat - item["endBeat"])),
    ))


def eval_positions(notes: list[dict], positions: list[float], gold: list[dict], *, frame_rate: int, window_seconds: float):
    rows = []
    exact = within1 = position = 0
    for row in gold:
        f0 = max(0, int(np.floor(row["timeSeconds"] * frame_rate)))
        f1 = min(len(positions), int(np.ceil((row["timeSeconds"] + window_seconds) * frame_rate)) + 1)
        candidates = []
        for idx in range(f0, max(f0 + 1, f1)):
            if idx >= len(positions):
                continue
            note = beat_to_note(notes, float(positions[idx]))
            if note is None:
                continue
            m_err = int(note["measure"]) - int(row["measure"])
            pos_hit = m_err == 0 and position_matches(row["position"], note["position"])
            candidates.append({
                "frame": idx,
                "time": round(idx / frame_rate, 3),
                "beat": float(positions[idx]),
                "predMeasure": int(note["measure"]),
                "predPosition": str(note["position"]),
                "measureError": m_err,
                "measureExact": m_err == 0,
                "measureWithin1": abs(m_err) <= 1,
                "positionHit": pos_hit,
                "_rank": (int(not pos_hit), int(m_err != 0), int(abs(m_err) > 1), abs(m_err)),
            })
        best = min(candidates, key=lambda item: item["_rank"]) if candidates else None
        if best is None:
            best = {"predMeasure": None, "predPosition": "", "measureError": None, "measureExact": False, "measureWithin1": False, "positionHit": False}
        exact += int(best["measureExact"])
        within1 += int(best["measureWithin1"])
        position += int(best["positionHit"])
        rows.append({**row, **{k: v for k, v in best.items() if k != "_rank"}})
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
    parser.add_argument("--audio", default="data/real-tests/originals/xuan-dong-full.mp3")
    parser.add_argument("--performance-midi", default="")
    parser.add_argument("--input-type", choices=["audio", "midi"], default="audio")
    parser.add_argument("--gold", default="data/experiments/note-alignment/xuandong-m1-note-position-gold.csv")
    parser.add_argument("--frame-rate", type=int, default=30)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    notes = load_score_notes(args.score_id)
    midi_path = REPO_ROOT / "data" / "experiments" / "model-bakeoff" / f"{args.score_id}-score.mid"
    write_score_midi(notes, midi_path)
    performance_file = args.performance_midi if args.input_type == "midi" else args.audio
    follower = Matchmaker(
        score_file=str(midi_path),
        performance_file=str((REPO_ROOT / performance_file).resolve()),
        wait=False,
        input_type=args.input_type,
        feature_type="pitchclass" if args.input_type == "midi" else "chroma",
        method="hmm" if args.input_type == "midi" else "arzt",
        frame_rate=args.frame_rate,
    )
    positions = list(follower.run(verbose=False))
    gold = load_gold(REPO_ROOT / args.gold)
    results = [eval_positions(notes, positions, gold, frame_rate=args.frame_rate, window_seconds=w) for w in (1.0, 2.0, 5.0)]

    print(f"[Matchmaker {args.input_type} | {args.score_id} | scoreNotes={len(notes)} frames={len(positions)}]")
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
            f"exact={row['measureExact']} pos={row['positionHit']}"
        )

    out = {
        "scoreId": args.score_id,
        "midiPath": str(midi_path),
        "inputType": args.input_type,
        "performanceFile": performance_file,
        "frameRate": args.frame_rate,
        "results": results,
    }
    out_dir = REPO_ROOT / "data" / "experiments" / "model-bakeoff"
    out_path = Path(args.out) if args.out else out_dir / f"matchmaker-{args.input_type}-{args.score_id}.json"
    if not out_path.is_absolute():
        out_path = REPO_ROOT / out_path
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
