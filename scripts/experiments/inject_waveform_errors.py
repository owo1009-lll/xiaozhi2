#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Waveform-level student-error injection with exact labels.

Takes a CORRECT take + its construction-grade gold MusicXML, aligns audio
events to score events, then performs seeded waveform surgery to fabricate
labelled student errors:

  wrong    pitch-shift one note segment by ±1..2 semitones (crossfaded)
  missing  attenuate the note segment to silence (timing preserved)
  extra    duplicate the note segment and insert it after itself
  drag     time-stretch the note segment ~1.6x (delays what follows)

Output: <out>/<name>.wav + <name>.labels.json giving, per injection:
type, score event index, measure, original window, parameters, and the
verdict the diagnosis layer is EXPECTED to produce.

House rules honored: this is a PRE-GATE evidence source (like M2b/M2e but
at waveform level). Per the manual, synthetic evidence alone must not open
the student runtime; it hardens full-piece validation and calibrates
duration/extra detectors. Eval-only; deterministic per seed.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import numpy as np  # noqa: E402

import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402

SR = 44100
FADE = int(0.015 * SR)  # 15ms crossfades


def crossfade_replace(y: np.ndarray, s: int, e: int, seg: np.ndarray) -> np.ndarray:
    """Replace y[s:e] with seg (any length), fading at both seams."""
    head, tail = y[:s].copy(), y[e:].copy()
    if len(head) >= FADE and len(seg) >= FADE:
        ramp = np.linspace(1, 0, FADE, dtype=np.float32)
        mixed = head[-FADE:] * ramp + seg[:FADE] * (1 - ramp)
        head = np.concatenate([head[:-FADE], mixed])
        seg = seg[FADE:]
    if len(seg) >= FADE and len(tail) >= FADE:
        ramp = np.linspace(1, 0, FADE, dtype=np.float32)
        mixed = seg[-FADE:] * ramp + tail[:FADE] * (1 - ramp)
        seg = np.concatenate([seg[:-FADE], mixed])
        tail = tail[FADE:]
    return np.concatenate([head, seg, tail])


def pick_sites(match, events, aev, counts, rng):
    """Well-matched, isolated, long-enough notes; spread across the piece."""
    good = []
    for i, mi in enumerate(match):
        if mi is None or i == 0 or i == len(match) - 1:
            continue
        if match[i - 1] is None or (i + 1 < len(match) and match[i + 1] is None):
            continue
        if len(events[i]["midis"]) != 1:
            continue  # single notes only for surgery
        start = aev[mi]["start"]
        nxt = aev[match[i + 1]]["start"] if match[i + 1] is not None else start + 1.0
        if nxt - start < 0.28:
            continue
        good.append((i, start, min(nxt, aev[mi].get("end", nxt))))
    rng.shuffle(good)
    total = sum(counts.values())
    if len(good) < total:
        raise SystemExit(f"only {len(good)} usable sites for {total} injections")
    picked, used = [], set()
    for kind, n in counts.items():
        taken = 0
        for site in good:
            if site[0] in used or taken >= n:
                continue
            # keep sites at least 2 events apart
            if any(abs(site[0] - u) < 2 for u in used):
                continue
            picked.append((kind, *site)); used.add(site[0]); taken += 1
        if taken < n:
            raise SystemExit(f"could not place {n} '{kind}' injections")
    return picked


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--audio", type=Path, required=True)
    ap.add_argument("--gold", type=Path, required=True)
    ap.add_argument("--out", type=Path,
                    default=REPO / "data" / "experiments" / "western-strings-injected-errors")
    ap.add_argument("--name", default=None)
    ap.add_argument("--seed", type=int, default=20260717)
    ap.add_argument("--wrong", type=int, default=5)
    ap.add_argument("--missing", type=int, default=5)
    ap.add_argument("--extra", type=int, default=5)
    ap.add_argument("--drag", type=int, default=4)
    ap.add_argument("--pre-onset-extend", type=float, default=0.0,
                    help="extend wrong/missing surgery windows this many seconds "
                         "before the basic-pitch onset (bounded by the previous "
                         "note's event start +0.15s). basic-pitch onsets lag true "
                         "attacks on slow legato playing, so without this the "
                         "note's real beginning survives the surgery and leaks "
                         "as injection-artifact evidence")
    args = ap.parse_args(argv)

    import random
    import librosa
    import soundfile as sf

    rng = random.Random(args.seed)
    y, _ = librosa.load(str(args.audio), sr=SR, mono=True)
    y = y.astype(np.float32)

    events = anchor.mxl_events(args.gold)
    aev = anchor.audio_events(args.audio)
    match, _ = anchor.align(events, aev)
    matched_n = sum(1 for m in match if m is not None)
    counts = {"wrong": args.wrong, "missing": args.missing,
              "extra": args.extra, "drag": args.drag}
    sites = pick_sites(match, events, aev, counts, rng)
    sites.sort(key=lambda s: -s[2])  # surgery from END to START keeps earlier samples valid

    labels = []
    for kind, idx, t0, t1 in sites:
        if kind in ("wrong", "missing") and args.pre_onset_extend > 0:
            prev_start = (aev[match[idx - 1]]["start"]
                          if idx > 0 and match[idx - 1] is not None else 0.0)
            t0 = max(prev_start + 0.15, t0 - args.pre_onset_extend, 0.0)
        s, e = int(t0 * SR), int(t1 * SR)
        seg = y[s:e].copy()
        entry = {"type": kind, "scoreEventIndex": idx,
                 "measure": events[idx]["measure"],
                 "goldMidi": events[idx]["midis"][0],
                 "windowSec": [round(t0, 3), round(t1, 3)],
                 "preOnsetExtendSec": args.pre_onset_extend if kind in ("wrong", "missing") else 0.0}
        if kind == "wrong":
            steps = rng.choice([-2, -1, 1, 2])
            seg2 = librosa.effects.pitch_shift(y=seg, sr=SR, n_steps=steps).astype(np.float32)
            y = crossfade_replace(y, s, e, seg2)
            entry.update({"shiftSemitones": steps, "expectedVerdict": "wrong-pitch"})
        elif kind == "missing":
            y = crossfade_replace(y, s, e, np.zeros_like(seg))
            entry.update({"expectedVerdict": "missing-note"})
        elif kind == "extra":
            y = crossfade_replace(y, s, e, np.concatenate([seg, seg]))
            entry.update({"expectedVerdict": "extra-note",
                          "insertedAfterSec": round(t1, 3)})
        elif kind == "drag":
            rate = 1.0 / 1.6
            seg2 = librosa.effects.time_stretch(y=seg, rate=rate).astype(np.float32)
            y = crossfade_replace(y, s, e, seg2)
            entry.update({"stretch": 1.6, "expectedVerdict": "late-onset/duration-long"})
        labels.append(entry)

    name = args.name or f"{args.audio.stem}-injected-{args.seed}"
    out_dir = args.out.resolve(); out_dir.mkdir(parents=True, exist_ok=True)
    wav_path = out_dir / f"{name}.wav"
    sf.write(str(wav_path), y, SR)
    labels.sort(key=lambda r: r["scoreEventIndex"])
    meta = {"evalOnly": True, "preGateOnly": True,
            "note": "synthetic waveform evidence; per house rules it must NOT alone open the student runtime",
            "sourceAudio": str(args.audio), "gold": str(args.gold), "seed": args.seed,
            "alignmentMatchedEvents": matched_n, "totalScoreEvents": len(events),
            "injections": labels, "wav": str(wav_path)}
    (out_dir / f"{name}.labels.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1),
                                                 encoding="utf-8")
    print(json.dumps({"wav": str(wav_path), "injections": len(labels),
                      "byType": {k: sum(1 for l in labels if l['type'] == k) for k in counts}},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
