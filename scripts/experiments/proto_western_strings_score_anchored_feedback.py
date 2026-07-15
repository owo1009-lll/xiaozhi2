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
    """basic-pitch note events grouped into audio chords by onset proximity."""
    from basic_pitch.inference import predict
    _, _, notes = predict(str(audio_path))
    notes = sorted(notes, key=lambda n: n[0])  # (start, end, midi, amplitude, bends)
    chords: list[dict] = []
    TOL = 0.06  # seconds; simultaneous-onset grouping (double stops)
    for n in notes:
        start, end, midi = float(n[0]), float(n[1]), int(n[2])
        if chords and start - chords[-1]["start"] <= TOL:
            chords[-1]["midis"].append(midi)
            chords[-1]["end"] = max(float(chords[-1]["end"]), end)
        else:
            chords.append({"start": start, "end": end, "midis": [midi]})
    for c in chords:
        c["midis"] = sorted(set(c["midis"]))
    return chords


def _pitch_cost(score_midis: list[int], audio_midis: list[int]) -> float:
    """Chord-aware, octave-tolerant cost: mean over audio tones of distance to
    the nearest score tone; a pure-octave fold costs 0.5 instead of 12."""
    total = 0.0
    for am in audio_midis:
        best = 12.0
        for sm in score_midis:
            d = abs(am - sm)
            if d % 12 == 0 and d > 0:
                d = 0.5  # detector octave artifact, common on weak bow
            best = min(best, float(min(d, 12)))
        total += best
    return total / len(audio_midis)


def strict_audio_verdict(score_midis: list[int], audio_midis: list[int]) -> str:
    """Use tolerance for alignment, but exact pitch sets for green evidence."""

    score_set = set(int(value) for value in score_midis)
    audio_set = set(int(value) for value in audio_midis)
    if score_set == audio_set:
        return "confirmed"
    if audio_set and audio_set.issubset(score_set):
        return "no-audio-evidence"
    return "pitch-mismatch"


def align(events: list[dict], audio: list[dict]) -> tuple[list[int | None], list[float] | None]:
    """Two-pass chord-level alignment: pass 1 pitch-only NW; pass 2 adds a
    time-anchoring term from a robust linear fit of matched (index -> time),
    which suppresses off-by-one drift in scale passages.
    Returns (match, time_pred); time_pred is the fitted expected time per
    score event (None when too few matches to fit) — the basis for timing
    (rhythm) deviation output."""
    import numpy as np
    A = [e["midis"] for e in events]
    B = [c["midis"] for c in audio]
    T = [c["start"] for c in audio]
    GAP = 1.6
    n, m = len(A), len(B)

    def nw(time_pred=None, tw=0.0):
        D = np.zeros((n + 1, m + 1)); P = np.zeros((n + 1, m + 1), dtype=int)
        D[:, 0] = np.arange(n + 1) * GAP; D[0, :] = np.arange(m + 1) * GAP
        P[:, 0] = 1; P[0, :] = 2
        for i in range(1, n + 1):
            for j in range(1, m + 1):
                d = _pitch_cost(A[i - 1], B[j - 1])
                if time_pred is not None:
                    d += tw * min(abs(T[j - 1] - time_pred[i - 1]) / 2.0, 2.0)
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

    first = nw()
    pairs = [(i, T[mi]) for i, mi in enumerate(first) if mi is not None]
    if len(pairs) < 8:
        return first, None
    # robust linear fit index->time (median of pairwise slopes over a sample)
    import random
    rng = random.Random(7)
    slopes = []
    for _ in range(min(200, len(pairs) * 2)):
        (i1, t1), (i2, t2) = rng.sample(pairs, 2)
        if i1 != i2:
            slopes.append((t2 - t1) / (i2 - i1))
    slope = float(np.median(slopes)) if slopes else 0.0
    if slope <= 0:
        return first, None
    inter = float(np.median([t - slope * i for i, t in pairs]))
    time_pred = [slope * i + inter for i in range(n)]
    return nw(time_pred=time_pred, tw=0.8), time_pred


# ---------- 4/5. verdicts + overlay ----------

COLORS = {"confirmed": (46, 160, 67), "pitch-mismatch": (220, 38, 38),
          "no-audio-evidence": (250, 204, 21), "beyond-recording": (156, 163, 175),
          "anchor-uncertain": (59, 130, 246)}

def run_piece(piece: str, variant: str, out_root: Path,
              omr_root: Path | None = None, aev: list[dict] | None = None,
              photo_path: Path | None = None, audio_path: Path | None = None) -> dict:
    from PIL import Image, ImageDraw
    omr_dir = (omr_root or OMR_ROOT) / piece / variant / "omr"
    omrs = sorted(omr_dir.glob("*.omr")); mxls = sorted(omr_dir.glob("*.mxl"))
    if not omrs or not mxls:
        return {"piece": piece, "variant": variant, "status": "omr-no-output"}
    omr, mxl = omrs[0], mxls[0]
    photo = photo_path or (PRIVATE / f"{piece}-score.jpg")
    audio = audio_path or (PRIVATE / f"{piece}.m4a")

    manchors = measure_anchor_map(omr)
    events = mxl_events(mxl)
    if aev is None:
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

    match, time_pred = align(events, aev)
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
        else:
            verdicts.append(strict_audio_verdict(events[i]["midis"], aev[mi]["midis"]))

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

    # piece gate uses RAW alignment agreement (pre-demotion) — an unreliable
    # alignment must never accuse, and demotion must not re-open the gate.
    heard_raw = [v for v in verdicts if v in ("confirmed", "pitch-mismatch")]
    agree = (verdicts.count("confirmed") / len(heard_raw)) if heard_raw else 0.0
    piece_gate = "ok" if agree >= 0.6 else "low-agreement-review"
    if piece_gate != "ok":
        verdicts = ["no-audio-evidence" if v == "pitch-mismatch" else v for v in verdicts]
    else:
        # neighbor-context rule: a red is only trustworthy when the alignment is
        # locally reliable on BOTH sides; drift zones demote to neutral.
        for i, v in enumerate(verdicts):
            if v == "pitch-mismatch":
                left_ok = i > 0 and verdicts[i - 1] == "confirmed"
                right_ok = i + 1 < len(verdicts) and verdicts[i + 1] == "confirmed"
                if not (left_ok and right_ok):
                    verdicts[i] = "no-audio-evidence"
    counts = {v: verdicts.count(v) for v in COLORS}
    row = {"piece": piece, "variant": variant, "events": len(events), "audioNotes": len(aev),
           "uncertainMeasures": uncertain_measures, "verdictCounts": counts,
           "audioAgreementHeard": round(agree, 4), "pieceGate": piece_gate,
           "annotated": str(annotated.relative_to(REPO)),
           "caveat": "eval-only prototype; production gate untouched"}
    (out_dir / f"{piece}-verdicts.json").write_text(json.dumps(
        {**row, "perNote": [{"i": i, "measure": per_note[i]["measure"], "verdict": verdicts[i],
                             "scoreMidis": events[i]["midis"],
                             "audioMidis": aev[match[i]]["midis"] if match[i] is not None else None,
                             # timing (rhythm) deviation vs fitted tempo line; informational,
                             # feeds a future M3 onset verdict after its own validation
                             "timingDeviationSec": (round(aev[match[i]]["start"] - time_pred[i], 3)
                                                    if match[i] is not None and time_pred is not None else None)}
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
