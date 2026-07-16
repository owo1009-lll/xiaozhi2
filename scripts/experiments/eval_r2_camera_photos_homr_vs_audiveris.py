#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HOMR vs Audiveris on the 8 round-2 photos against construction-grade gold.

Gold = the generator-source MusicXML (音频/round2-谱子/r2-NN.musicxml) — the
pages were PRINTED FROM these files and then captured by the project owner,
so the gold is independent of every OMR engine by construction.

Domain honesty (lesson from the Beijing mislabel): each image gets a
domain-audit column (size, skew/noise heuristics) and the report does NOT
claim camera-photo domain per row until the input-domain gate classifies it;
rows are labelled `owner-captured-print` pending that classification.

Metrics: pitch-sequence precision/recall/F1 (octave-strict), measure-count
agreement, onset-quarter accuracy over matched pairs (|Δoffset| <= 0.25
quarters). Same comparator for both engines -> internally consistent
head-to-head. Eval-only; no production gate touched.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_m4_omr_render_gold import run_audiveris, DEFAULT_AUDIVERIS  # noqa: E402
from eval_western_strings_m4_real_jpg_omr import preprocess  # noqa: E402

PHOTOS = REPO / "data" / "private" / "western-strings-round2"
GOLD = REPO / "音频" / "round2-谱子"
HOMR_EXE = (REPO / "data" / "experiments" / "western-strings-m4"
            / "homr-compat-venv" / "Scripts" / "homr.exe")
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "r2-camera-photo-benchmark"


def score_events(mxl_path: Path):
    """Ordered (offset_quarters, sorted midi tuple) chord events + measure count."""
    from music21 import converter
    s = converter.parse(str(mxl_path))
    ev: dict[float, set[int]] = {}
    for n in s.flatten().notes:
        ev.setdefault(round(float(n.offset), 3), set()).update(int(p.midi) for p in n.pitches)
    events = [(off, tuple(sorted(ev[off]))) for off in sorted(ev)]
    measures = len(s.parts[0].getElementsByClass("Measure")) if s.parts else 0
    return events, measures


def compare(gold_ev, rec_ev):
    g = [m for _, ch in gold_ev for m in ch]
    r = [m for _, ch in rec_ev for m in ch]
    sm = SequenceMatcher(a=g, b=r, autojunk=False)
    matched = sum(b.size for b in sm.get_matching_blocks())
    P = matched / len(r) if r else 0.0
    R = matched / len(g) if g else 0.0
    # onset-quarter over chord-level alignment
    gm = [m for _, ch in gold_ev for m in ch]
    # pair chords via chord-level matcher for offsets
    gseq = [ch for _, ch in gold_ev]; rseq = [ch for _, ch in rec_ev]
    sm2 = SequenceMatcher(a=gseq, b=rseq, autojunk=False)
    ok = tot = 0
    for blk in sm2.get_matching_blocks():
        for k in range(blk.size):
            tot += 1
            if abs(gold_ev[blk.a + k][0] - rec_ev[blk.b + k][0]) <= 0.25:
                ok += 1
    onset_q = ok / tot if tot else 0.0
    return {"goldNotes": len(g), "recNotes": len(r), "matched": matched,
            "pitchPrecision": round(P, 4), "pitchRecall": round(R, 4),
            "pitchF1": round(2 * P * R / (P + R), 4) if P + R else 0.0,
            "onsetQuarterAccuracy": round(onset_q, 4), "onsetPairs": tot}


def domain_audit(img_path: Path) -> dict:
    import numpy as np
    from PIL import Image
    im = Image.open(img_path).convert("L")
    arr = np.asarray(im, dtype=np.float32)
    return {"width": im.width, "height": im.height,
            "meanLuma": round(float(arr.mean()), 1),
            "lumaStd": round(float(arr.std()), 1),
            "domainLabel": "owner-captured-print (pending input-domain gate classification)"}


def run_homr(photo: Path, work: Path, timeout_s: int) -> Path | None:
    work.mkdir(parents=True, exist_ok=True)
    local = work / photo.name
    if not local.is_file():
        shutil.copyfile(photo, local)
    existing = list(work.glob("*.musicxml")) + list(work.glob("*.mxl"))
    if existing:
        return existing[0]
    log = work / "homr.log"
    with log.open("wb") as h:
        subprocess.run([str(HOMR_EXE), local.name], cwd=work, stdout=h,
                       stderr=subprocess.STDOUT, timeout=timeout_s, check=False)
    out = list(work.glob("*.musicxml")) + list(work.glob("*.mxl"))
    return out[0] if out else None


def run_audiveris_up2(photo: Path, work: Path, timeout_s: int) -> Path | None:
    work.mkdir(parents=True, exist_ok=True)
    existing = list(work.rglob("*.mxl"))
    if existing:
        return existing[0]
    prep = preprocess(photo, work / f"{photo.stem}-up2.png", "up2")
    run_audiveris(DEFAULT_AUDIVERIS, prep, work / "omr", timeout_s)
    out = list(work.rglob("*.mxl"))
    return out[0] if out else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pieces", nargs="+", default=[f"r2-{i:02d}" for i in range(1, 9)])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args(argv)
    out_root = args.out.resolve(); out_root.mkdir(parents=True, exist_ok=True)

    rows = []
    for piece in args.pieces:
        photo = PHOTOS / f"{piece}.png"
        gold = GOLD / f"{piece}.musicxml"
        row = {"piece": piece, "photo": str(photo), "gold": str(gold)}
        if not photo.is_file() or not gold.is_file():
            row["status"] = "missing-input"; rows.append(row); print(json.dumps(row)); continue
        row["domainAudit"] = domain_audit(photo)
        gold_ev, gold_meas = score_events(gold)
        row["goldMeasures"] = gold_meas
        for engine, runner in (("homr", run_homr), ("audiverisUp2", run_audiveris_up2)):
            t0 = time.monotonic()
            try:
                rec = runner(photo, out_root / piece / engine, args.timeout)
            except subprocess.TimeoutExpired:
                rec = None
            eng = {"seconds": round(time.monotonic() - t0, 1)}
            if rec is None:
                eng["status"] = "no-output"
            else:
                try:
                    rec_ev, rec_meas = score_events(rec)
                    eng.update(compare(gold_ev, rec_ev))
                    eng.update({"recMeasures": rec_meas,
                                "measureCountMatch": rec_meas == gold_meas, "status": "ok"})
                except Exception as exc:
                    eng["status"] = f"parse-error: {exc}"[:160]
            row[engine] = eng
        rows.append(row)
        print(json.dumps({k: row[k] for k in ("piece", "homr", "audiverisUp2") if k in row},
                         ensure_ascii=False))

    def agg(engine):
        ok = [r[engine] for r in rows if isinstance(r.get(engine), dict)
              and r[engine].get("status") == "ok"]
        if not ok:
            return {"evaluated": 0}
        tg = sum(o["goldNotes"] for o in ok); tr = sum(o["recNotes"] for o in ok)
        tm = sum(o["matched"] for o in ok)
        op = sum(o["onsetPairs"] for o in ok)
        oo = sum(round(o["onsetQuarterAccuracy"] * o["onsetPairs"]) for o in ok)
        return {"evaluated": len(ok),
                "pitchPrecision": round(tm / tr, 4) if tr else 0,
                "pitchRecall": round(tm / tg, 4) if tg else 0,
                "onsetQuarterAccuracy": round(oo / op, 4) if op else 0,
                "measureCountMatches": sum(1 for o in ok if o.get("measureCountMatch"))}

    report = {"createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "goldProvenance": "generator-source MusicXML; pages printed then captured by owner",
              "domainNote": "rows pending input-domain gate classification; not auto-counted as CameraPhotoRows",
              "comparator": "pitch-sequence SequenceMatcher (octave-strict) + chord-offset onset-quarter",
              "rows": rows,
              "aggregate": {"homr": agg("homr"), "audiverisUp2": agg("audiverisUp2")}}
    (out_root / "r2-camera-photo-benchmark.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report["aggregate"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
