# -*- coding: utf-8 -*-
"""Independent page/slot locator -> local rubato alignment, evaluated by M1 fine truth.

Pilot A found: local rubato is good with correct blocks (A1 oracle 3.8s) but the auto
coarse locator is the bottleneck. A first single-page locator capped even its topK-truth
ORACLE at ~16-23s (padding did not help) -> the candidate WINDOWS, not just ranking, are
the limit. A1 succeeded with MULTI-page (anchor) windows, so this version supports
multi-page SLOTS (longer, more distinctive templates):

  --pages-per-slot N  slot = N consecutive PDF pages (1 = old single-page behaviour)
  --stride S          step between slot starts (S=1 sliding/overlapping so a truth point
                      near a page edge is not split; S=N non-overlapping)

Pipeline: build slot templates -> per-slot subsequence DTW top-k windows -> monotonic DP
path -> local rubato DTW inside selected windows -> seconds error vs independent M1 truth.
Also reports the topK-truth ORACLE (ceiling if ranking were perfect) and candidate recall.

Eval-only: writes only under data/experiments.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import librosa

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import content_alignment as ca  # noqa: E402
import eval_m1_finetruth as m1  # noqa: E402

_spec = importlib.util.spec_from_file_location("gdtw", str(Path(__file__).resolve().parent / "align-global-dtw-experiment.py"))
gdtw = importlib.util.module_from_spec(_spec)
sys.modules["gdtw_page_locator"] = gdtw
_spec.loader.exec_module(gdtw)


def build_slots(template, pages, pages_per_slot, stride):
    """Multi-page slots over the unique PDF pages. Each slot covers pages_per_slot
    consecutive pages, starting every `stride` pages (overlap if stride < per_slot)."""
    upages = sorted({int(p) for p in pages if int(p) > 0})
    slots = []
    idx = 0
    seen = set()
    for start in range(0, len(upages), max(1, stride)):
        group = upages[start:start + pages_per_slot]
        if not group:
            break
        p_lo, p_hi = group[0], group[-1]
        if (p_lo, p_hi) in seen:
            continue
        seen.add((p_lo, p_hi))
        cr = m1.cols_for_pages(pages, p_lo, p_hi)
        if cr is None:
            continue
        c0, c1 = cr
        slots.append({"slotIdx": idx, "pageStart": p_lo, "pageEnd": p_hi,
                      "pages": set(group), "c0": c0, "c1": c1, "template": template[:, c0:c1]})
        idx += 1
        if p_hi == upages[-1]:
            break
    return slots


def locate_slots(slots, feat, audio_hop, *, top_k, span_penalty, min_gap_seconds, position_prior_weight):
    slot_candidates = []
    candidates_by_slot = {}
    audio_duration = float(feat.shape[1] * audio_hop)
    expected_span = max(audio_duration / max(1, len(slots)), audio_hop)
    for i, slot in enumerate(slots):
        cands = ca.topk_candidates(slot["template"], feat, audio_hop, k=top_k)
        expected_center = (i + 0.5) * expected_span
        enriched = []
        for cand in cands:
            center = (float(cand["start"]) + float(cand["end"])) / 2.0
            pos_pen = float(position_prior_weight) * (abs(center - expected_center) / expected_span)
            enriched.append({**cand, "pathCost": float(cand["cost"]) + pos_pen, "positionPenalty": pos_pen,
                             "expectedCenter": expected_center, "slotIdx": slot["slotIdx"],
                             "pageStart": slot["pageStart"], "pageEnd": slot["pageEnd"],
                             "pages": slot["pages"], "c0": slot["c0"], "c1": slot["c1"]})
        if not enriched:
            enriched = [{"start": 0.0, "end": audio_hop, "cost": float("inf"), "pathCost": float("inf"),
                         "positionPenalty": 0.0, "expectedCenter": expected_center, "slotIdx": slot["slotIdx"],
                         "pageStart": slot["pageStart"], "pageEnd": slot["pageEnd"],
                         "pages": slot["pages"], "c0": slot["c0"], "c1": slot["c1"]}]
        slot_candidates.append(enriched)
        candidates_by_slot[slot["slotIdx"]] = enriched
    path, diag = choose_path(slot_candidates, span_penalty=span_penalty, min_gap_seconds=min_gap_seconds)
    return path, diag, candidates_by_slot


def choose_path(slot_candidates, *, span_penalty, min_gap_seconds):
    n = len(slot_candidates)
    if n == 0:
        return [], {"slotCount": 0, "greedyFallbackCount": 0}
    inf = float("inf")
    best = [[(inf, -1)] * len(c) for c in slot_candidates]
    for j, cand in enumerate(slot_candidates[-1]):
        best[-1][j] = (float(cand["pathCost"]), -1)
    for i in range(n - 2, -1, -1):
        for j, cand in enumerate(slot_candidates[i]):
            choice = (inf, -1)
            for jn, nxt in enumerate(slot_candidates[i + 1]):
                if float(nxt["start"]) + 1e-6 >= float(cand["start"]) + min_gap_seconds:
                    gap = max(0.0, float(nxt["start"]) - float(cand["end"]))
                    nw = max(float(nxt["end"]) - float(nxt["start"]), 1e-6)
                    total = span_penalty * (gap / nw) + best[i + 1][jn][0]
                    if total < choice[0]:
                        choice = (total, jn)
            best[i][j] = (float(cand["pathCost"]) + (choice[0] if choice[0] != inf else inf), choice[1])
    start_j = min(range(len(best[0])), key=lambda idx: best[0][idx][0]) if best[0] else -1
    path, greedy, j = [], 0, start_j
    for i in range(n):
        if j < 0 or j >= len(slot_candidates[i]):
            j = min(range(len(slot_candidates[i])), key=lambda idx: slot_candidates[i][idx]["cost"])
            greedy += 1
        path.append({**slot_candidates[i][j]})
        j = best[i][j][1]
    return path, {"slotCount": n, "greedyFallbackCount": greedy}


def blocks_from_path(path, audio_hop, *, pad_seconds, audio_frames):
    blocks = []
    for item in path:
        f0 = int((float(item["start"]) - pad_seconds) / audio_hop)
        f1 = int((float(item["end"]) + pad_seconds) / audio_hop)
        f0 = max(0, min(audio_frames, f0)); f1 = max(0, min(audio_frames, f1))
        blocks.append((f0, max(f0 + 1, f1), int(item["c0"]), int(item["c1"])))
    return blocks


def page_to_slot_index(slots):
    idx = {}
    for slot in slots:
        for p in slot["pages"]:
            idx.setdefault(int(p), []).append(slot["slotIdx"])
    return idx


def candidate_recall(truth, candidates_by_slot, page_to_slots, measure_to_page, path, *, tolerance=10.0, pad=0.0):
    selected_by_slot = {int(it["slotIdx"]): it for it in path}
    top1 = topk = selected = 0
    rows = []
    for t_true, m_true in truth:
        page, mapped, exact = m1_page(m_true, measure_to_page)
        slot_idxs = page_to_slots.get(page, []) if page is not None else []
        cands = [c for si in slot_idxs for c in candidates_by_slot.get(si, [])]
        def contains(c):
            p = max(float(tolerance), float(pad))
            return float(c["start"]) - p <= t_true <= float(c["end"]) + p
        in_top1 = any(candidates_by_slot.get(si) and contains(candidates_by_slot[si][0]) for si in slot_idxs)
        in_topk = any(contains(c) for c in cands)
        in_sel = any(si in selected_by_slot and contains(selected_by_slot[si]) for si in slot_idxs)
        top1 += int(in_top1); topk += int(in_topk); selected += int(in_sel)
        rows.append({"measure": int(round(m_true)), "truthTime": float(t_true), "page": page,
                     "top1": in_top1, "topK": in_topk, "selected": in_sel})
    n = max(1, len(truth))
    return {"top1RecallAt10s": round(top1 / n, 3), "topKRecallAt10s": round(topk / n, 3),
            "selectedRecallAt10s": round(selected / n, 3), "rows": rows}


def m1_page(measure, lookup):
    return m1_page_for(int(round(measure)), lookup)


def m1_page_for(measure, lookup):
    if not lookup:
        return None, None, False
    if measure in lookup:
        return lookup[measure], measure, True
    nearest = min(lookup, key=lambda k: abs(k - measure))
    return lookup[nearest], nearest, False


def topk_truth_oracle_blocks(truth, slots, candidates_by_slot, measure_to_page, audio_hop, *, tolerance=10.0):
    """For each slot, pick the candidate best matching the truth times whose page is in
    that slot. Non-circular ceiling: 'if ranking were perfect, how good are the windows'."""
    truth_by_slot = {}
    for t_true, m_true in truth:
        page, _m, _e = m1_page(m_true, measure_to_page)
        for slot in slots:
            if page in slot["pages"]:
                truth_by_slot.setdefault(slot["slotIdx"], []).append(float(t_true))
    chosen = []
    for si, times in truth_by_slot.items():
        cands = candidates_by_slot.get(si, [])
        if not cands:
            continue
        def score(c):
            contained = sum(float(c["start"]) - tolerance <= t <= float(c["end"]) + tolerance for t in times)
            dist = [0.0 if float(c["start"]) <= t <= float(c["end"]) else min(abs(t - float(c["start"])), abs(t - float(c["end"]))) for t in times]
            return (-contained, float(np.median(dist)), float(c["cost"]))
        chosen.append(min(cands, key=score))
    return chosen


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--score-id", default="score-mofx8cdb-sbrqgx")
    ap.add_argument("--audio", default="data/real-tests/originals/xuan-dong-full.mp3")
    ap.add_argument("--truth", default=m1.DEFAULT_TRUTH)
    ap.add_argument("--feature", default="crepe", choices=["chroma", "cens", "hpss", "crepe"])
    ap.add_argument("--crepe-fmax", type=float, default=1400.0)
    ap.add_argument("--top-k", type=int, default=8)
    ap.add_argument("--span-penalty", type=float, default=0.5)
    ap.add_argument("--min-gap-seconds", type=float, default=-15.0)
    ap.add_argument("--window-pad-seconds", type=float, default=0.0)
    ap.add_argument("--position-prior-weight", type=float, default=0.5)
    ap.add_argument("--pages-per-slot", type=int, default=1)
    ap.add_argument("--stride", type=int, default=0, help="0 -> = pages-per-slot (non-overlapping)")
    args = ap.parse_args()
    stride = args.stride if args.stride > 0 else args.pages_per_slot

    truth = [(float(a), float(b)) for a, b in (p.split(":") for p in args.truth.split(","))]
    template, pages, measures = m1.load_columns_with_measure(args.score_id)
    waveform, sr = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sr != gdtw.SR:
        waveform = librosa.resample(waveform, orig_sr=sr, target_sr=gdtw.SR)
    feat, audio_hop = gdtw.audio_feature(waveform, args.feature, crepe_fmax=args.crepe_fmax)
    af = feat.shape[1]

    slots = build_slots(template, pages, args.pages_per_slot, stride)
    measure_to_page = build_measure_page(measures, pages)
    page_to_slots = page_to_slot_index(slots)

    path, diag, cbs = locate_slots(slots, feat, audio_hop, top_k=args.top_k, span_penalty=args.span_penalty,
                                   min_gap_seconds=args.min_gap_seconds, position_prior_weight=args.position_prior_weight)
    sel_pred = m1.dtw_pred_measure(template, measures, feat, audio_hop,
                                   blocks_from_path(path, audio_hop, pad_seconds=args.window_pad_seconds, audio_frames=af))
    selected = m1.eval_fine(sel_pred, audio_hop, truth)
    recall = candidate_recall(truth, cbs, page_to_slots, measure_to_page, path, pad=args.window_pad_seconds)
    oracle_blocks = topk_truth_oracle_blocks(truth, slots, cbs, measure_to_page, audio_hop)
    oracle_pred = m1.dtw_pred_measure(template, measures, feat, audio_hop,
                                      blocks_from_path(oracle_blocks, audio_hop, pad_seconds=args.window_pad_seconds, audio_frames=af))
    oracle = m1.eval_fine(oracle_pred, audio_hop, truth)

    print(f"[slot-locator | {args.score_id} | perSlot={args.pages_per_slot} stride={stride} | slots={len(slots)} topK={args.top_k} pad={args.window_pad_seconds}]")
    print(f"  selected(auto)     median={selected['medianSecErr']}s <=10s={selected['within10s']} <=5s={selected['within5s']}")
    print(f"  topK-truth-oracle  median={oracle['medianSecErr']}s <=10s={oracle['within10s']} <=5s={oracle['within5s']}")
    print(f"  recall@10s  top1={recall['top1RecallAt10s']} topK={recall['topKRecallAt10s']} selected={recall['selectedRecallAt10s']}  greedyFallback={diag['greedyFallbackCount']}/{diag['slotCount']}")
    print("  selected slot windows: " + " ".join(f"p{it['pageStart']}-{it['pageEnd']}:{it['start']:.0f}-{it['end']:.0f}({it['cost']:.2f})" for it in path))

    out = {"scoreId": args.score_id, "pagesPerSlot": args.pages_per_slot, "stride": stride,
           "slots": len(slots), "topK": args.top_k, "windowPadSeconds": args.window_pad_seconds,
           "positionPriorWeight": args.position_prior_weight,
           "selected": {k: v for k, v in selected.items() if k != "rows"},
           "topKTruthOracle": {k: v for k, v in oracle.items() if k != "rows"},
           "candidateRecall": {k: v for k, v in recall.items() if k != "rows"},
           "selectedSlotWindows": [{"pageStart": it["pageStart"], "pageEnd": it["pageEnd"],
                                    "start": it["start"], "end": it["end"], "cost": it["cost"]} for it in path],
           "selectedRows": selected["rows"], "oracleRows": oracle["rows"], "recallRows": recall["rows"]}
    out_dir = REPO_ROOT / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"slot-locator-{args.score_id}-{args.feature}-perslot{args.pages_per_slot}-stride{stride}-pad{int(args.window_pad_seconds)}.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


def build_measure_page(measures, pages):
    lookup = {}
    for meas in sorted({int(m) for m in measures if int(m) > 0}):
        pv = pages[measures == meas]
        pv = pv[pv > 0]
        if pv.size:
            vals, counts = np.unique(pv, return_counts=True)
            lookup[meas] = int(vals[int(np.argmax(counts))])
    return lookup


if __name__ == "__main__":
    sys.exit(main())
