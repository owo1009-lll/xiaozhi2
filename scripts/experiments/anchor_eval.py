# -*- coding: utf-8 -*-
"""Shared anchor-based evaluation for audio<->score aligners.

Ground truth = manual-anchor manifests: each anchor is (audioStart,audioEnd) <-> score
PAGE range. (The OMR store's measureIndex numbering does NOT match the anchors' printed
measure numbers, but PAGE numbers match on both sides, so we evaluate at page level.)

An aligner is evaluated through ONE interface: a per-audio-frame predicted page array
(`pred_page`, length = audio frames, -1 = unknown) plus the audio frame hop in seconds.
Both the global CREPE-DTW locator and the AAAI align_score_to_audio.py adapt to this.

Metrics (per the agreed eval spec):
  pageHitRate        median predicted page in the anchor's [pLo,pHi]
  pageOverlapRate    any predicted page in the window overlaps [pLo,pHi]
  medianPageError    |median pred page - nearest end of range| (0 when in range)
  startTimeErrSec    aligner's predicted start of the anchor's page-range vs anchor start
  endTimeErrSec      same for the end
  medianAbsTimeErr   median over anchors of max(|startErr|,|endErr|)
  usableRate@20s     fraction with median page in range AND time err <= 20s
  usableRate@10s     stricter
Caveats: anchors are 45s coarse windows (5s overlap, human-rounded) -> time error has a
~5-10s noise floor. Page numbering is reliable; sub-page time precision is not.
"""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np


def load_anchors(manifest_path: Path):
    anchors = []
    with Path(manifest_path).open(encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            page = str(row.get("scorePage", "")).strip()
            if "-" in page:
                lo, hi = page.split("-", 1)
                plo, phi = int(lo), int(hi)
            else:
                plo = phi = int(page)
            anchors.append({
                "start": float(row["audioStartSeconds"]),
                "end": float(row["audioEndSeconds"]),
                "pageLo": plo, "pageHi": phi,
            })
    return anchors


def evaluate(anchors, pred_page, audio_hop, usable_time_tol=(20.0, 10.0)):
    n_frames = len(pred_page)
    pred_page = np.asarray(pred_page)

    # page p -> contiguous audio time block (monotonic aligners) for time-error
    valid = pred_page >= 0
    page_first, page_last = {}, {}
    for f in range(n_frames):
        p = int(pred_page[f])
        if p < 0:
            continue
        t = f * audio_hop
        if p not in page_first:
            page_first[p] = t
        page_last[p] = t

    # page width (median audio seconds per located page) -> the inherent time-resolution
    # floor of page-level anchors: a page covers ~this many seconds, so time alignment
    # cannot be validated finer than ~half a page from these anchors.
    page_widths = [page_last[p] - page_first[p] for p in page_first if page_last[p] > page_first[p]]
    median_page_width = round(float(np.median(page_widths)), 1) if page_widths else None

    per = []
    page_hits = page_overlaps = 0
    page_errors, abs_time_errors, signed_time_errors = [], [], []
    usable20 = usable10 = 0
    for a in anchors:
        f0 = int(a["start"] / audio_hop)
        f1 = max(f0 + 1, int(a["end"] / audio_hop))
        window = pred_page[f0:f1]
        window = window[window >= 0]
        if window.size == 0:
            per.append({**a, "predPage": None, "hit": False, "overlap": False, "timeErr": None})
            page_errors.append(99)
            continue
        med = int(np.median(window))
        hit = a["pageLo"] <= med <= a["pageHi"]
        overlap = any(a["pageLo"] <= int(p) <= a["pageHi"] for p in np.unique(window))
        perr = 0 if hit else min(abs(med - a["pageLo"]), abs(med - a["pageHi"]))

        # time error (center-based): anchor center time vs the time the aligner places
        # this anchor's center page. Avoids the shared-page endpoint artifact. Signed:
        # +ve = aligner is LATE (places the page later than truth), -ve = aligner ahead.
        t_center = 0.5 * (a["start"] + a["end"])
        p_target = int(round(0.5 * (a["pageLo"] + a["pageHi"])))
        time_err = None
        if p_target in page_first:
            block_center = 0.5 * (page_first[p_target] + page_last[p_target])
            time_err = block_center - t_center

        page_hits += int(hit)
        page_overlaps += int(overlap)
        page_errors.append(perr)
        if time_err is not None:
            abs_time_errors.append(abs(time_err))
            signed_time_errors.append(time_err)
        if hit and time_err is not None and abs(time_err) <= usable_time_tol[0]:
            usable20 += 1
        if hit and time_err is not None and abs(time_err) <= usable_time_tol[1]:
            usable10 += 1
        per.append({**a, "predPage": med, "hit": hit, "overlap": overlap, "pageError": perr,
                    "timeErr": None if time_err is None else round(time_err, 1)})

    n = len(anchors)
    starts = [r["start"] for r in per]
    # monotonicity of the page curve (for the teacher-ready-gate sanity note)
    seq = [int(p) for p in pred_page if p >= 0]
    viol = sum(1 for i in range(len(seq) - 1) if seq[i] > seq[i + 1])
    viol_rate = round(viol / max(1, len(seq) - 1), 4)
    pages_located = len(page_first)
    pages_total = int(max(seq)) if seq else 0
    coverage = round(pages_located / max(1, pages_total), 3)

    return {
        "anchorCount": n,
        "pageHitRate": round(page_hits / n, 3) if n else None,
        "pageOverlapRate": round(page_overlaps / n, 3) if n else None,
        "medianPageError": float(np.median(page_errors)) if page_errors else None,
        "medianPageWidthSec": median_page_width,
        "medianAbsTimeErrSec": round(float(np.median(abs_time_errors)), 1) if abs_time_errors else None,
        "medianSignedTimeErrSec": round(float(np.median(signed_time_errors)), 1) if signed_time_errors else None,
        "usableRate@20s": round(usable20 / n, 3) if n else None,
        "usableRate@10s": round(usable10 / n, 3) if n else None,
        # teacher-ready-gate sanity (monotonic aligners pass trivially -> NOT proof of accuracy)
        "gateMonotonicViolationRate": viol_rate,
        "gatePageCoverage": coverage,
        "perAnchor": per,
    }


def print_report(tag, metrics):
    m = metrics
    print(f"[{tag}]")
    print(f"  pageHitRate={m['pageHitRate']} pageOverlap={m['pageOverlapRate']} medPageErr={m['medianPageError']}")
    print(f"  medAbsTimeErr={m['medianAbsTimeErrSec']}s signedTimeErr={m['medianSignedTimeErrSec']}s "
          f"(pageWidth~{m['medianPageWidthSec']}s) usable@20s={m['usableRate@20s']} usable@10s={m['usableRate@10s']}")
    print(f"  [gate-sanity] monoViolRate={m['gateMonotonicViolationRate']} pageCoverage={m['gatePageCoverage']} "
          f"(monotonic aligner passes scatter checks trivially -> not proof of accuracy)")
    for r in m["perAnchor"]:
        pp = r["predPage"]
        flag = "HIT" if r["hit"] else ("ovl" if r.get("overlap") else "MISS")
        print(f"    {r['start']:.0f}-{r['end']:.0f}s truth=p{r['pageLo']}-{r['pageHi']} pred=p{pp} {flag} "
              f"startErr={r['startErr']}s endErr={r['endErr']}s")
