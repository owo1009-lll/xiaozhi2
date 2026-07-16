#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HOMR as an A/B-layer arbitration candidate: dual-evidence evaluation.

For each m2f piece (REAL photo + REAL recording): run HOMR on the photo,
parse its MusicXML, align the student's recording (basic-pitch events) and
count audio-confirmed notes + agreement — the SAME arbitration currency the
production pool uses. Compare against the cached Audiveris-variant winners
from data/analysis-photo-score/<piece>/audit.json.

Also runs a MusicXML-level structure probe (clef/key presence + bar-sum
consistency under the exported meter) since HOMR emits no Audiveris .omr.

Eval-only: production pipeline files are NOT touched; wiring happens after
repo consolidation via the existing gated flow. Student runtime unaffected.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402

HOMR_EXE = (REPO / "data" / "experiments" / "western-strings-m4"
            / "homr-compat-venv" / "Scripts" / "homr.exe")
PRIVATE = REPO / "data" / "private" / "western-strings-m2"
AUDITS = REPO / "data" / "analysis-photo-score"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "homr-pool-candidate"


def run_homr(photo: Path, work: Path, timeout_s: int) -> Path | None:
    work.mkdir(parents=True, exist_ok=True)
    local = work / photo.name
    if not local.is_file():
        shutil.copyfile(photo, local)
    got = list(work.glob("*.musicxml")) + list(work.glob("*.mxl"))
    if got:
        return got[0]
    with (work / "homr.log").open("wb") as h:
        subprocess.run([str(HOMR_EXE), local.name], cwd=work, stdout=h,
                       stderr=subprocess.STDOUT, timeout=timeout_s, check=False)
    got = list(work.glob("*.musicxml")) + list(work.glob("*.mxl"))
    return got[0] if got else None


def structure_probe(mxl: Path) -> dict:
    from music21 import converter
    s = converter.parse(str(mxl))
    parts = s.parts
    if not parts:
        return {"ok": False, "reason": "no-parts"}
    p = parts[0]
    clefs = list(p.recurse().getElementsByClass("Clef"))
    meters = list(p.recurse().getElementsByClass("TimeSignature"))
    measures = list(p.getElementsByClass("Measure"))
    bar_ok = bar_tot = 0
    if meters and measures:
        beats = meters[0].barDuration.quarterLength
        for i, m in enumerate(measures):
            dur = sum(n.quarterLength for n in m.notesAndRests)
            bar_tot += 1
            if abs(dur - beats) < 1e-3 or (i in (0, len(measures) - 1) and dur <= beats):
                bar_ok += 1
    return {"ok": True, "clefPresent": bool(clefs), "meterPresent": bool(meters),
            "measures": len(measures),
            "barSumConsistency": round(bar_ok / bar_tot, 3) if bar_tot else None}


def cached_audiveris_winner(piece: str) -> dict | None:
    audit = AUDITS / piece / "audit.json"
    if not audit.is_file():
        return None
    j = json.loads(audit.read_text(encoding="utf-8"))
    ok = [c for c in j.get("candidates", []) if c.get("status") == "ok"]
    win = max(ok, key=lambda c: (c.get("confirmed", 0), c.get("agreement", 0)), default=None)
    return {"decision": j.get("decision"), "variant": win.get("variant") if win else None,
            "confirmed": win.get("confirmed") if win else 0,
            "agreement": win.get("agreement") if win else 0.0}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pieces", nargs="+",
                    default=[f"violin-ex{i:02d}" for i in range(1, 13)])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args(argv)
    out_root = args.out.resolve(); out_root.mkdir(parents=True, exist_ok=True)

    rows = []
    for piece in args.pieces:
        photo = PRIVATE / f"{piece}-score.jpg"
        audio = PRIVATE / f"{piece}.m4a"
        row = {"piece": piece}
        if not photo.is_file() or not audio.is_file():
            row["status"] = "missing-input"; rows.append(row); print(json.dumps(row)); continue
        t0 = time.monotonic()
        try:
            mxl = run_homr(photo, out_root / piece, args.timeout)
        except subprocess.TimeoutExpired:
            mxl = None
        row["homrSeconds"] = round(time.monotonic() - t0, 1)
        if mxl is None:
            row["homr"] = {"status": "no-output"}
        else:
            try:
                events = anchor.mxl_events(mxl)
                aev = anchor.audio_events(audio)
                match, _ = anchor.align(events, aev)
                heard = [i for i, m in enumerate(match) if m is not None]
                confirmed = sum(1 for i in heard
                                if set(aev[match[i]]["midis"]) == set(events[i]["midis"]))
                agree = confirmed / len(heard) if heard else 0.0
                row["homr"] = {"status": "ok", "events": len(events),
                               "confirmed": confirmed, "agreement": round(agree, 4),
                               "structure": structure_probe(mxl)}
            except Exception as exc:
                row["homr"] = {"status": f"error: {exc}"[:160]}
        row["audiverisCached"] = cached_audiveris_winner(piece)
        h = row.get("homr") or {}
        a = row.get("audiverisCached") or {}
        if h.get("status") == "ok" and a:
            row["poolWinner"] = ("homr" if (h["confirmed"], h["agreement"])
                                 > (a.get("confirmed", 0), a.get("agreement", 0.0))
                                 else "audiveris")
        rows.append(row)
        print(json.dumps({k: row.get(k) for k in ("piece", "homr", "audiverisCached", "poolWinner")},
                         ensure_ascii=False))

    ok = [r for r in rows if (r.get("homr") or {}).get("status") == "ok"]
    wins = sum(1 for r in rows if r.get("poolWinner") == "homr")
    both = sum(1 for r in rows if r.get("poolWinner"))
    report = {"createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "evalOnly": True, "productionTouched": False,
              "rows": rows,
              "aggregate": {"homrOk": len(ok), "poolComparisons": both, "homrWins": wins,
                            "meanHomrConfirmed": round(sum(r['homr']['confirmed'] for r in ok) / len(ok), 1) if ok else None}}
    (out_root / "homr-pool-candidate.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report["aggregate"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
