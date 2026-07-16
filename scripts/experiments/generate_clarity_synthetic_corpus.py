#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Route-B synthetic corpus factory for Clarity Stage-B adaptation.

Generates a large, seeded, parameter-varied corpus of solo-violin MusicXML
(keys x meters x rhythm vocabularies x accidentals x rests x ties x slurs x
occasional double stops), then writes a MERGED split manifest that is
schema-compatible with the existing Clarity split
({sample_id, dataset, split, work_id, musicxml_path, sha256}):

  merged manifest = [existing Bach rows, untouched]  +  [synthetic rows]

Synthetic rows go to train/validation ONLY. The existing synthetic-test rows
and the frozen real-photo blind holdout are never touched or duplicated, so
holdout contamination is impossible by construction.

Deterministic: one master seed drives every piece; regenerating with the same
seed reproduces byte-identical musical content.

Eval-only data tooling: no runtime gate, no production policy is affected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from pathlib import Path

from music21 import stream, note, chord, meter, key, tempo, clef, tie, spanner

REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "clarity-synthetic-corpus"
DEFAULT_BASE_SPLIT = (REPO / "data" / "experiments" / "western-strings-m4"
                      / "clarity-adaptation-dataset" / "clarity-adaptation-source-split.jsonl")

# violin-friendly pitch space (first position, mostly)
SCALE_DEGREES = ["C", "D", "E", "F", "G", "A", "B"]
METERS = ["4/4", "3/4", "2/4", "6/8"]
KEY_FIFTHS = [-3, -2, -1, 0, 0, 1, 1, 2, 2, 3, 4]  # weighted toward simple keys
LOW_MIDI, HIGH_MIDI = 55, 88  # G3..E6


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def _clamp_walk(midi: int, step: int) -> int:
    nxt = midi + step
    if nxt < LOW_MIDI:
        nxt = midi + abs(step)
    elif nxt > HIGH_MIDI:
        nxt = midi - abs(step)
    return nxt


def compose_piece(seed: int, dense: bool = False):
    rng = random.Random(seed)
    ks_fifths = rng.choice(KEY_FIFTHS)
    ts = rng.choice(METERS)
    n_measures = rng.randint(14, 22) if dense else rng.randint(8, 14)
    beats_per_measure = {"4/4": 4.0, "3/4": 3.0, "2/4": 2.0, "6/8": 3.0}[ts]

    # per-piece rhythm vocabulary (quarterLength values)
    vocab_pool = [
        [1.0, 0.5],                 # quarters + eighths
        [1.0, 2.0],                 # quarters + halves
        [1.0, 0.5, 1.5],            # with dotted quarter
        [0.5, 0.25],                # eighths + sixteenths
        [1.0, 0.5, 2.0],
    ]
    if dense:
        vocab_pool = [[0.5, 0.25], [0.25, 0.5], [0.5, 0.25, 1.0]]
    vocab = rng.choice(vocab_pool)
    if ts == "6/8":
        vocab = [0.25, 0.5, 1.0] if dense else [0.5, 1.0, 1.5]

    p_rest = rng.uniform(0.01, 0.04) if dense else rng.uniform(0.03, 0.10)
    p_accidental = rng.uniform(0.02, 0.12)
    p_double_stop = rng.choice([0.0, 0.0, 0.0, rng.uniform(0.05, 0.2)])
    p_slur = rng.uniform(0.0, 0.25)
    use_ties = rng.random() < 0.4

    s = stream.Score()
    part = stream.Part()
    part.insert(0, clef.TrebleClef())
    part.insert(0, key.KeySignature(ks_fifths))
    part.insert(0, meter.TimeSignature(ts))
    part.insert(0, tempo.MetronomeMark(number=rng.choice([56, 63, 72, 76, 84, 92])))

    tonic_midi = 62 + ks_fifths  # rough center; walk clamps to range anyway
    cur = max(LOW_MIDI + 5, min(HIGH_MIDI - 10, tonic_midi + rng.choice([0, 12])))
    pending_tie_pitch: int | None = None

    for mi in range(n_measures):
        m = stream.Measure(number=mi + 1)
        remaining = beats_per_measure
        last_note_obj = None
        while remaining > 1e-6:
            choices = [d for d in vocab if d <= remaining + 1e-6]
            if not choices:
                d = remaining
            else:
                d = rng.choice(choices)
            is_last_measure = mi == n_measures - 1 and remaining - d <= 1e-6
            if is_last_measure:
                d = remaining  # final long tonic fills the bar
                n = note.Note(cur)
                n.quarterLength = d
                m.append(n)
                remaining = 0.0
                break
            if rng.random() < p_rest and remaining - d > 1e-6:
                r = note.Rest()
                r.quarterLength = d
                m.append(r)
                remaining -= d
                continue
            step = rng.choice([-2, -1, -1, 1, 1, 2, 2, -3, 3, -4, 4, 5, -5, 7, -7, 12, -12])
            cur = _clamp_walk(cur, step)
            midi_val = cur
            if rng.random() < p_accidental:
                midi_val = _clamp_walk(cur, rng.choice([-1, 1]))
            if rng.random() < p_double_stop:
                lower = midi_val - rng.choice([3, 4, 5, 7, 12])
                if lower >= LOW_MIDI:
                    el = chord.Chord([lower, midi_val])
                else:
                    el = note.Note(midi_val)
            else:
                el = note.Note(midi_val)
            el.quarterLength = d
            if pending_tie_pitch is not None:
                if isinstance(el, note.Note) and el.pitch.midi == pending_tie_pitch:
                    el.tie = tie.Tie("stop")
                pending_tie_pitch = None
            elif (use_ties and isinstance(el, note.Note)
                  and abs(remaining - d) < 1e-6 and rng.random() < 0.25
                  and mi < n_measures - 1):
                el.tie = tie.Tie("start")
                pending_tie_pitch = el.pitch.midi
            m.append(el)
            if (p_slur and last_note_obj is not None and rng.random() < p_slur
                    and isinstance(el, note.Note) and isinstance(last_note_obj, note.Note)):
                sl = spanner.Slur([last_note_obj, el])
                m.insert(0, sl)
            last_note_obj = el
            remaining -= d
        part.append(m)
    s.append(part)
    meta = {"fifths": ks_fifths, "meter": ts, "measures": n_measures, "dense": dense,
            "vocab": vocab, "pDoubleStop": round(p_double_stop, 3)}
    return s, meta


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--count", type=int, default=300)
    ap.add_argument("--dense", action="store_true", help="16th-note-heavy long pieces (sequence-length lever)")
    ap.add_argument("--master-seed", type=int, default=20260717)
    ap.add_argument("--val-ratio", type=float, default=0.1)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--base-split", type=Path, default=DEFAULT_BASE_SPLIT)
    args = ap.parse_args(argv)

    out_root = args.out.resolve()
    corpus_dir = out_root / "corpus"
    corpus_dir.mkdir(parents=True, exist_ok=True)

    base_rows = []
    if args.base_split.is_file():
        for line in args.base_split.read_text(encoding="utf-8").splitlines():
            if line.strip():
                base_rows.append(json.loads(line))
    base_ids = {r["sample_id"] for r in base_rows}

    rng = random.Random(args.master_seed)
    seeds = [rng.randrange(1, 10**9) for _ in range(args.count)]
    rows = []
    stats = {"train": 0, "validation": 0, "pieces": 0, "failed": 0}
    for idx, seed in enumerate(seeds):
        sample_id = f"syn-{args.master_seed}-{idx:04d}"
        if sample_id in base_ids:
            continue
        try:
            score, meta = compose_piece(seed, dense=args.dense)
            xml_path = corpus_dir / f"{sample_id}.musicxml"
            score.write("musicxml", fp=str(xml_path))
        except Exception as exc:  # keep the factory running
            stats["failed"] += 1
            print(json.dumps({"sample_id": sample_id, "error": str(exc)[:120]}))
            continue
        split = "validation" if (idx % round(1 / max(args.val_ratio, 1e-6))) == 0 else "train"
        rows.append({
            "sample_id": sample_id,
            "dataset": "m4_synthetic_corpus_v1",
            "split": split,
            "work_id": sample_id,
            "musicxml_path": str(xml_path.resolve()),
            "sha256": sha256_file(xml_path),
            "generator": {"masterSeed": args.master_seed, "pieceSeed": seed, **meta},
        })
        stats[split] += 1
        stats["pieces"] += 1

    merged = base_rows + rows
    manifest = out_root / "clarity-synthetic-merged-split.jsonl"
    manifest.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in merged),
                        encoding="utf-8")
    summary = {
        "evalOnly": True,
        "studentRuntimeTouched": False,
        "masterSeed": args.master_seed,
        "synthetic": stats,
        "baseRowsPreserved": len(base_rows),
        "mergedRows": len(merged),
        "holdoutContaminationPossible": False,
        "manifest": str(manifest),
    }
    (out_root / "corpus-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1),
                                                  encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
