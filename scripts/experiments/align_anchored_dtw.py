# -*- coding: utf-8 -*-
"""坎2 Pilot A: local (block-wise) rubato alignment vs global DTW, on clean pieces.

Global DTW drifts on rubato because one cost matrix lets spurious cheap matches pull
the path. LOCAL alignment inside trusted blocks caps drift (it resets at block bounds).
This pilot measures whether that helps, with TWO honest variants (lower/upper bound):

  baseline  : whole-piece global DTW (current state).
  A0        : AUTOMATIC blocks from the global coarse page curve -> local DTW per block.
              Real automatic lower bound (inherits the coarse step's page errors).
  A1-LOAO   : leave-one-anchor-out ORACLE upper bound. For held-out anchor j, build ONE
              block spanning anchors {j-1,j,j+1} (j's own boundary is NOT used), local-DTW
              it, predict j. Non-circular for j -> measures "if the page span is known,
              can local DTW place the segment". (A page-level eval on anchor-defined blocks
              would be circular -> trivially ~1.0; LOAO avoids that.)

Robust page->column mapping (fixes the old first_col_of_page bug): a block covering pages
[pLo,pHi] uses the CONTIGUOUS column range where pages in [pLo,pHi] (pages are monotonic
in the template since notes are ordered by global measure).

Run (clean piece only -- 炫动 is the one range-matched score):
  python-service/.venv/Scripts/python.exe scripts/experiments/align_anchored_dtw.py \
    --score-id score-mofx8cdb-sbrqgx --audio data/real-tests/originals/xuan-dong-full.mp3 \
    --manifest data/teacher-manual-anchors/manifest-xuandong.csv --feature crepe
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import anchor_eval  # noqa: E402
import librosa  # noqa: E402
import soundfile as sf  # noqa: E402

_spec = importlib.util.spec_from_file_location("gdtw", str(Path(__file__).resolve().parent / "align-global-dtw-experiment.py"))
gdtw = importlib.util.module_from_spec(_spec)
sys.modules["gdtw"] = gdtw
_spec.loader.exec_module(gdtw)


def cols_for_pages(pages, p_lo, p_hi):
    idx = np.where((pages >= p_lo) & (pages <= p_hi))[0]
    if idx.size == 0:
        return None
    return int(idx[0]), int(idx[-1]) + 1


def local_align(template, pages, feat, audio_hop, blocks):
    """blocks: list of (f0,f1,c0,c1). DTW each block independently; pred page per frame."""
    n_audio = feat.shape[1]
    pred = np.full(n_audio, -1, dtype=np.int32)
    for (f0, f1, c0, c1) in blocks:
        f0 = max(0, int(f0)); f1 = min(n_audio, int(f1))
        if f1 - f0 < 2 or c1 - c0 < 2:
            if f1 > f0:
                pred[f0:f1] = int(pages[min(max(c0, 0), len(pages) - 1)])
            continue
        _acc, wp = librosa.sequence.dtw(X=template[:, c0:c1], Y=feat[:, f0:f1], subseq=False, metric="cosine")
        col_lists = [[] for _ in range(f1 - f0)]
        for s_idx, a_idx in wp:
            if 0 <= a_idx < (f1 - f0):
                col_lists[a_idx].append(int(pages[c0 + s_idx]))
        for a_local, plist in enumerate(col_lists):
            if plist:
                pred[f0 + a_local] = int(np.median(plist))
    last = -1
    for i in range(n_audio):
        if pred[i] < 0:
            pred[i] = last
        else:
            last = pred[i]
    return pred


def a0_auto_blocks(global_pred, pages, audio_hop):
    """Blocks = contiguous runs of the global coarse page curve -> that page's columns."""
    blocks = []
    n = len(global_pred)
    i = 0
    while i < n:
        p = int(global_pred[i])
        j = i
        while j < n and int(global_pred[j]) == p:
            j += 1
        if p >= 0:
            cr = cols_for_pages(pages, p, p)
            if cr:
                blocks.append((i, j, cr[0], cr[1]))
        i = j
    return blocks


def a1_loao(template, pages, feat, audio_hop, anchors):
    """Leave-one-anchor-out. For each j, one block spanning {j-1,j,j+1} (j's bound unused),
    predict j. Returns aggregated metrics over held-out anchors."""
    hits, time_errs, usable20, usable10 = 0, [], 0, 0
    per = []
    for j in range(len(anchors)):
        lo = max(0, j - 1)
        hi = min(len(anchors) - 1, j + 1)
        merged = anchors[lo:hi + 1]
        f0 = int(min(x["start"] for x in merged) / audio_hop)
        f1 = int(max(x["end"] for x in merged) / audio_hop)
        p_lo = min(x["pageLo"] for x in merged)
        p_hi = max(x["pageHi"] for x in merged)
        cr = cols_for_pages(pages, p_lo, p_hi)
        if cr is None:
            continue
        pred = local_align(template, pages, feat, audio_hop, [(f0, f1, cr[0], cr[1])])
        m = anchor_eval.evaluate([anchors[j]], pred, audio_hop)
        r = m["perAnchor"][0]
        per.append({"start": r["start"], "end": r["end"], "predPage": r["predPage"],
                    "hit": r["hit"], "timeErr": r.get("timeErr")})
        hits += int(r["hit"])
        te = r.get("timeErr")
        if te is not None:
            time_errs.append(abs(te))
            if r["hit"] and abs(te) <= 20:
                usable20 += 1
            if r["hit"] and abs(te) <= 10:
                usable10 += 1
    n = len(per)
    return {
        "anchorCount": n,
        "pageHitRate": round(hits / n, 3) if n else None,
        "medianAbsTimeErrSec": round(float(np.median(time_errs)), 1) if time_errs else None,
        "usableRate@20s": round(usable20 / n, 3) if n else None,
        "usableRate@10s": round(usable10 / n, 3) if n else None,
        "perAnchor": per,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--score-id", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--feature", default="crepe", choices=["chroma", "cens", "hpss", "crepe"])
    ap.add_argument("--crepe-fmax", type=float, default=1400.0)
    args = ap.parse_args()

    template, pages = gdtw.load_erhu_columns(args.score_id)
    anchors = anchor_eval.load_anchors(REPO_ROOT / args.manifest)
    waveform, sr = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sr != gdtw.SR:
        waveform = librosa.resample(waveform, orig_sr=sr, target_sr=gdtw.SR)
    feat, audio_hop = gdtw.audio_feature(waveform, args.feature, crepe_fmax=args.crepe_fmax)

    # baseline: whole-piece global DTW
    global_pred = gdtw.global_dtw_page_of_time(template, pages, feat)
    m_base = anchor_eval.evaluate(anchors, global_pred, audio_hop)

    # A0: automatic blocks from the global coarse page curve -> local DTW
    a0_pred = local_align(template, pages, feat, audio_hop, a0_auto_blocks(global_pred, pages, audio_hop))
    m_a0 = anchor_eval.evaluate(anchors, a0_pred, audio_hop)

    # A1-LOAO: oracle upper bound, non-circular
    m_a1 = a1_loao(template, pages, feat, audio_hop, anchors)

    def line(tag, m):
        return (f"  {tag:18} pageHit={m['pageHitRate']} usable@20s={m['usableRate@20s']} "
                f"usable@10s={m['usableRate@10s']} medAbsTimeErr={m['medianAbsTimeErrSec']}s")

    print(f"[坎2 pilot A | {args.score_id} | {args.feature}/fmax={args.crepe_fmax} | anchors={len(anchors)}]")
    print(line("baseline(global)", m_base))
    print(line("A0(auto-local)", m_a0))
    print(line("A1-LOAO(oracle)", m_a1))

    out = {
        "scoreId": args.score_id, "feature": args.feature, "crepeFmax": args.crepe_fmax,
        "baseline": {k: v for k, v in m_base.items() if k != "perAnchor"},
        "A0_auto_local": {k: v for k, v in m_a0.items() if k != "perAnchor"},
        "A1_loao_oracle": {k: v for k, v in m_a1.items() if k != "perAnchor"},
        "A1_perAnchor": m_a1["perAnchor"],
    }
    out_dir = REPO_ROOT / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"pilotA-localrubato-{args.score_id}-{args.feature}.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
