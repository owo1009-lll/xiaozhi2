#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prototype: photo score + recording -> problems anchored back onto the photo.

EVAL-ONLY prototype of the end-to-end goal. NOT wired to the production
student gate; verdict wording is prototype-level ("audio-check"), the
fail-closed runtime remains untouched.

Steps per piece (violin-exNN from the M2f set):
  1. Audiveris .omr sheet XML  -> notehead pixel bounds -> chord-level anchors
     ordered by (staff, x). Coordinates are in the up2 image space (photo * 2).
  2. Recognized MusicXML       -> chord-level note events (ordered pitch sets).
     Anchor[i] <-> Event[i] (same recognition, same order).
  3. Recording -> basic-pitch note events -> Needleman-Wunsch alignment to the
     score pitch sequence (semitone cost).
  4. Verdict per score event: audio-confirmed / pitch-mismatch / not-heard.
  5. Render overlay boxes on the ORIGINAL photo (green/red/orange) + JSON.
Also reports audioAgreement = confirmed/total, usable as the variant-racing
arbitration metric (layer B of the M4 gate).
"""
from __future__ import annotations

import argparse
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PRIVATE = REPO / "data" / "private" / "western-strings-m2"
OMR_ROOT = REPO / "data" / "experiments" / "western-strings-m4" / "real-jpg-omr"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "score-anchored-proto"


# ---------- 1. anchors from .omr (measure-scoped) ----------

def measure_anchor_map(omr_path: Path) -> dict[int, list[dict]]:
    """measure number -> chord bounding boxes, from the authoritative
    <measure><head-chords> id list + <head-chord id><bounds> inters."""
    xml = zipfile.ZipFile(omr_path).read("sheet#1/sheet#1.xml").decode("utf-8", errors="replace")
    chord_bounds: dict[int, dict] = {}
    for m in re.finditer(r'<head-chord [^>]*id="(\d+)"[^>]*>\s*'
                         r'<bounds x="(-?\d+)" y="(-?\d+)" w="(\d+)" h="(\d+)"/>', xml):
        chord_bounds[int(m.group(1))] = {"x0": int(m.group(2)), "y0": int(m.group(3)),
                                         "x1": int(m.group(2)) + int(m.group(4)),
                                         "y1": int(m.group(3)) + int(m.group(5))}
    out: dict[int, list[dict]] = {}
    for i, m in enumerate(re.finditer(r'<head-chords>([\d ]+)</head-chords>', xml), start=1):
        boxes = [chord_bounds[int(cid)] for cid in m.group(1).split() if int(cid) in chord_bounds]
        boxes.sort(key=lambda b: b["x0"])
        out[i] = boxes
    return out


# ---------- 2. events from recognized MusicXML (with measure numbers) ----------

def mxl_events(mxl_path: Path) -> list[dict]:
    """Ordered chord-level events: {measure, midis[]}."""
    from music21 import converter
    s = converter.parse(str(mxl_path))
    ev: dict[float, dict] = {}
    for n in s.flatten().notes:
        off = round(float(n.offset), 4)
        e = ev.setdefault(off, {"measure": int(n.measureNumber or 0), "midis": set()})
        e["midis"].update(int(p.midi) for p in n.pitches)
    return [{"measure": ev[o]["measure"], "midis": sorted(ev[o]["midis"])} for o in sorted(ev)]


# ---------- 3. audio events ----------

def audio_events(audio_path: Path) -> list[dict]:
    from basic_pitch.inference import predict
    _, _, notes = predict(str(audio_path))
    notes = sorted(notes, key=lambda n: n[0])  # (start, end, midi, amplitude, bends)
    return [{"start": float(n[0]), "end": float(n[1]), "midi": int(n[2]), "amp": float(n[3])}
            for n in notes]


def align(score_midis: list[int], audio: list[dict]) -> list[int | None]:
    """NW alignment; returns audio index per score note (None = unmatched)."""
    A, B = score_midis, [a["midi"] for a in audio]
    GAP = 1.6  # substitution (wrong pitch <=3 semitones) preferred over insert+delete
    n, m = len(A), len(B)
    import numpy as np
    D = np.zeros((n + 1, m + 1)); P = np.zeros((n + 1, m + 1), dtype=int)
    D[:, 0] = np.arange(n + 1) * GAP; D[0, :] = np.arange(m + 1) * GAP
    P[:, 0] = 1; P[0, :] = 2
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d = min(abs(A[i - 1] - B[j - 1]), 12)  # octave-capped semitone cost
            opts = (D[i - 1, j - 1] + d, D[i - 1, j] + GAP, D[i, j - 1] + GAP)
            k = int(np.argmin(opts)); D[i, j] = opts[k]; P[i, j] = k
    out: list[int | None] = [None] * n
    i, j = n, m
    while i > 0 and j > 0:
        if P[i, j] == 0:
            out[i - 1] = j - 1; i -= 1; j -= 1
        elif P[i, j] == 1:
            i -= 1
        else:
            j -= 1
    return out


# ---------- 4/5. verdicts + overlay ----------

COLORS = {"confirmed": (46, 160, 67), "pitch-mismatch": (220, 38, 38),
          "no-audio-evidence": (250, 204, 21), "beyond-recording": (156, 163, 175),
          "anchor-uncertain": (59, 130, 246)}

def run_piece(piece: str, variant: str, out_root: Path) -> dict:
    from PIL import Image, ImageDraw
    omr_dir = OMR_ROOT / piece / variant / "omr"
    omr = next(omr_dir.glob("*.omr")); mxl = next(omr_dir.glob("*.mxl"))
    photo = PRIVATE / f"{piece}-score.jpg"; audio = PRIVATE / f"{piece}.m4a"

    manchors = measure_anchor_map(omr)
    events = mxl_events(mxl)
    aev = audio_events(audio)

    # measure-scoped anchor<->event mapping; count-mismatch measures -> anchor-uncertain
    per_note: list[dict] = []          # {event_i, box|None, measure, uncertain}
    ev_by_measure: dict[int, list[int]] = {}
    for i, e in enumerate(events):
        ev_by_measure.setdefault(e["measure"], []).append(i)
    uncertain_measures = []
    for meas, idxs in ev_by_measure.items():
        groups = manchors.get(meas, [])
        if len(groups) == len(idxs):
            for k, i in enumerate(idxs):
                per_note.append({"i": i, "box": groups[k], "measure": meas, "uncertain": False})
        else:
            uncertain_measures.append(meas)
            for k, i in enumerate(idxs):
                per_note.append({"i": i, "box": groups[k] if k < len(groups) else None,
                                 "measure": meas, "uncertain": True})
    per_note.sort(key=lambda r: r["i"])

    smidis = [e["midis"][-1] for e in events]
    match = align(smidis, aev)
    # recording-coverage end = last index whose local (+-6) match density >= 0.5;
    # a short recording covers a prefix of the page — beyond it is neutral, not an error
    W = 6
    cover_end = -1
    for i in range(len(match)):
        lo, hi = max(0, i - W), min(len(match), i + W + 1)
        dens = sum(1 for k in range(lo, hi) if match[k] is not None) / (hi - lo)
        if dens >= 0.5:
            cover_end = i
    verdicts = []
    for i, mi in enumerate(match):
        if per_note[i]["uncertain"]:
            verdicts.append("anchor-uncertain")
        elif mi is None:
            # neutral: detector miss and player miss are indistinguishable here -> never accuse
            verdicts.append("no-audio-evidence" if i <= cover_end else "beyond-recording")
        elif aev[mi]["midi"] == smidis[i]:
            verdicts.append("confirmed")
        else:
            verdicts.append("pitch-mismatch")

    im = Image.open(photo).convert("RGB")
    dr = ImageDraw.Draw(im)
    sc = 0.5 if variant in ("up2", "up2-otsu") else (1 / 3 if variant == "up3" else 0.5)
    pad = 6
    for i, rec in enumerate(per_note):
        if rec["box"] is None:
            continue
        b = rec["box"]
        box = [b["x0"] * sc - pad, b["y0"] * sc - pad, b["x1"] * sc + pad, b["y1"] * sc + pad]
        dr.rectangle(box, outline=COLORS[verdicts[i]], width=3)
    out_dir = out_root / piece; out_dir.mkdir(parents=True, exist_ok=True)
    annotated = out_dir / f"{piece}-annotated.jpg"
    im.save(annotated, quality=90)

    heard = [v for v in verdicts if v in ("confirmed", "pitch-mismatch")]
    agree = (verdicts.count("confirmed") / len(heard)) if heard else 0.0
    # fail-closed: unreliable alignment must not accuse — demote reds to neutral
    piece_gate = "ok" if agree >= 0.6 else "low-agreement-review"
    if piece_gate != "ok":
        verdicts = ["no-audio-evidence" if v == "pitch-mismatch" else v for v in verdicts]
    counts = {v: verdicts.count(v) for v in COLORS}
    row = {"piece": piece, "variant": variant, "events": len(events), "audioNotes": len(aev),
           "uncertainMeasures": uncertain_measures, "verdictCounts": counts,
           "audioAgreementHeard": round(agree, 4), "pieceGate": piece_gate,
           "annotated": str(annotated.relative_to(REPO)),
           "caveat": "eval-only prototype; production gate untouched"}
    (out_dir / f"{piece}-verdicts.json").write_text(json.dumps(
        {**row, "perNote": [{"i": i, "measure": per_note[i]["measure"], "verdict": verdicts[i],
                             "scoreMidi": smidis[i],
                             "audioMidi": aev[match[i]]["midi"] if match[i] is not None else None}
                            for i in range(len(events))]}, ensure_ascii=False, indent=1), encoding="utf-8")
    return row


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pieces", nargs="+", required=True)
    ap.add_argument("--variant", default="up2")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)
    out_root = Path(args.out).resolve()
    rows = []
    for piece in args.pieces:
        try:
            rows.append(run_piece(piece, args.variant, out_root))
        except Exception as exc:
            rows.append({"piece": piece, "status": f"error: {exc}"[:200]})
        print(json.dumps(rows[-1], ensure_ascii=False))
    (out_root / "summary.json").write_text(json.dumps(
        {"createdAt": datetime.now(timezone.utc).isoformat(), "rows": rows},
        ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
