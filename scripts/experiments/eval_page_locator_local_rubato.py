# -*- coding: utf-8 -*-
"""Independent page locator -> local rubato alignment, evaluated by M1 fine truth.

This tests the new bottleneck found by Pilot A:

  A1 oracle local rubato is good when the page block is known.
  A0 automatic local is bad because the coarse locator is bad.

This script replaces the coarse locator with a separate page locator:
  1. build one ERHU template per PDF page;
  2. run subsequence DTW over the whole audio, keep top-k candidate windows per page;
  3. choose one monotonic page path with the existing content-alignment DP;
  4. run local rubato DTW inside the selected page windows;
  5. score seconds error against independent M1 fine truth.

Eval-only: writes only under data/experiments, does not touch server, packs, or store.
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


def page_templates(template: np.ndarray, pages: np.ndarray) -> list[dict]:
    slots = []
    for page in sorted({int(p) for p in pages if int(p) > 0}):
        cr = m1.cols_for_pages(pages, page, page)
        if cr is None:
            continue
        c0, c1 = cr
        slots.append({
            "page": page,
            "c0": c0,
            "c1": c1,
            "template": template[:, c0:c1],
        })
    return slots


def choose_page_path(slot_candidates: list[list[dict]], *, span_penalty: float, min_gap_seconds: float = -15.0) -> tuple[list[dict], dict]:
    """Pick one page window per page with non-decreasing START times.

    This is intentionally weaker than content_alignment.choose_monotonic_path's
    non-overlap constraint. Page candidates are coarse and may overlap near page turns;
    requiring next.start >= current.end made the page path fall back to greedy even
    when useful candidates were present. min_gap_seconds allows limited overlap.
    """
    n = len(slot_candidates)
    if n == 0:
        return [], {"slotCount": 0, "greedyFallbackCount": 0, "monotonicFeasible": True, "orderMode": "start"}
    inf = float("inf")
    def path_cost(item: dict) -> float:
        return float(item.get("pathCost", item["cost"]))
    best = [[(inf, -1)] * len(cands) for cands in slot_candidates]
    for j, cand in enumerate(slot_candidates[-1]):
        best[-1][j] = (path_cost(cand), -1)
    for i in range(n - 2, -1, -1):
        for j, cand in enumerate(slot_candidates[i]):
            choice = (inf, -1)
            for jn, nxt in enumerate(slot_candidates[i + 1]):
                if float(nxt["start"]) + 1e-6 >= float(cand["start"]) + min_gap_seconds:
                    gap = max(0.0, float(nxt["start"]) - float(cand["end"]))
                    next_window = max(float(nxt["end"]) - float(nxt["start"]), 1e-6)
                    transition = span_penalty * (gap / next_window)
                    total = transition + best[i + 1][jn][0]
                    if total < choice[0]:
                        choice = (total, jn)
            best[i][j] = (path_cost(cand) + (choice[0] if choice[0] != inf else inf), choice[1])
    start_j = min(range(len(best[0])), key=lambda idx: best[0][idx][0]) if best[0] else -1
    path = []
    greedy = 0
    j = start_j
    for i in range(n):
        if j < 0 or j >= len(slot_candidates[i]):
            j = min(range(len(slot_candidates[i])), key=lambda idx: slot_candidates[i][idx]["cost"])
            greedy += 1
        path.append({**slot_candidates[i][j]})
        j = best[i][j][1]
    starts = [float(item["start"]) for item in path]
    violations = sum(1 for i in range(len(starts) - 1) if starts[i] > starts[i + 1] + 1e-6)
    return path, {
        "slotCount": n,
        "greedyFallbackCount": greedy,
        "monotonicFeasible": greedy == 0,
        "monotonicViolationRate": round(violations / max(1, n - 1), 4),
        "orderMode": "start",
        "minGapSeconds": min_gap_seconds,
    }


def locate_pages(
    slots: list[dict],
    feat: np.ndarray,
    audio_hop: float,
    *,
    top_k: int,
    span_penalty: float,
    min_gap_seconds: float,
    position_prior_weight: float,
) -> tuple[list[dict], dict, dict]:
    slot_candidates = []
    candidates_by_page = {}
    audio_duration = float(feat.shape[1] * audio_hop)
    expected_span = max(audio_duration / max(1, len(slots)), audio_hop)
    for idx, slot in enumerate(slots):
        cands = ca.topk_candidates(slot["template"], feat, audio_hop, k=top_k)
        enriched = []
        expected_center = (idx + 0.5) * expected_span
        for cand in cands:
            center = (float(cand["start"]) + float(cand["end"])) / 2.0
            position_penalty = float(position_prior_weight) * (abs(center - expected_center) / expected_span)
            enriched.append({
                **cand,
                "pathCost": float(cand["cost"]) + position_penalty,
                "positionPenalty": position_penalty,
                "expectedCenter": expected_center,
                "page": slot["page"],
                "c0": slot["c0"],
                "c1": slot["c1"],
            })
        if not enriched:
            enriched = [{
                "start": 0.0,
                "end": audio_hop,
                "cost": float("inf"),
                "pathCost": float("inf"),
                "positionPenalty": 0.0,
                "expectedCenter": expected_center,
                "page": slot["page"],
                "c0": slot["c0"],
                "c1": slot["c1"],
            }]
        slot_candidates.append(enriched)
        candidates_by_page[slot["page"]] = enriched
    path, diagnostics = choose_page_path(slot_candidates, span_penalty=span_penalty, min_gap_seconds=min_gap_seconds)
    return path, diagnostics, candidates_by_page


def blocks_from_page_path(
    path: list[dict],
    audio_hop: float,
    *,
    pad_seconds: float = 0.0,
    audio_frames: int | None = None,
) -> list[tuple[int, int, int, int]]:
    blocks = []
    for item in path:
        f0 = int((float(item["start"]) - pad_seconds) / audio_hop)
        f1 = int((float(item["end"]) + pad_seconds) / audio_hop)
        if audio_frames is not None:
            f0 = max(0, min(audio_frames, f0))
            f1 = max(0, min(audio_frames, f1))
        blocks.append((f0, max(f0 + 1, f1), int(item["c0"]), int(item["c1"])))
    return blocks


def measure_page_lookup(measures: np.ndarray, pages: np.ndarray) -> dict[int, int]:
    lookup = {}
    for meas in sorted({int(m) for m in measures if int(m) > 0}):
        page_values = pages[measures == meas]
        page_values = page_values[page_values > 0]
        if page_values.size:
            vals, counts = np.unique(page_values, return_counts=True)
            lookup[meas] = int(vals[int(np.argmax(counts))])
    return lookup


def page_for_measure(measure: int, lookup: dict[int, int]) -> tuple[int | None, int | None, bool]:
    if not lookup:
        return None, None, False
    if measure in lookup:
        return lookup[measure], measure, True
    nearest = min(lookup, key=lambda item: abs(item - measure))
    return lookup[nearest], nearest, False


def candidate_recall(
    truth: list[tuple[float, float]],
    candidates_by_page: dict[int, list[dict]],
    measure_to_page: dict[int, int],
    path: list[dict],
    *,
    tolerance: float = 10.0,
    window_pad_seconds: float = 0.0,
) -> dict:
    selected_by_page = {int(item["page"]): item for item in path}
    rows = []
    top1 = topk = selected = 0
    for t_true, m_true in truth:
        page, mapped_measure, exact_measure_page = page_for_measure(int(round(m_true)), measure_to_page)
        cands = candidates_by_page.get(page, []) if page is not None else []
        def contains(cand):
            pad = max(float(tolerance), float(window_pad_seconds))
            return float(cand["start"]) - pad <= t_true <= float(cand["end"]) + pad
        in_top1 = bool(cands[:1]) and contains(cands[0])
        in_topk = any(contains(cand) for cand in cands)
        sel = selected_by_page.get(page)
        in_selected = bool(sel) and contains(sel)
        top1 += int(in_top1)
        topk += int(in_topk)
        selected += int(in_selected)
        rows.append({
            "measure": int(round(m_true)),
            "truthTime": float(t_true),
            "page": page,
            "pageMappedFromMeasure": mapped_measure,
            "pageExactMeasureMatch": exact_measure_page,
            "top1ContainsTruth": in_top1,
            "topKContainsTruth": in_topk,
            "selectedContainsTruth": in_selected,
            "topCandidates": [
                {"start": cand["start"], "end": cand["end"], "cost": cand["cost"]}
                for cand in cands[:3]
            ],
            "selectedWindow": None if not sel else {"start": sel["start"], "end": sel["end"], "cost": sel["cost"]},
        })
    n = max(1, len(truth))
    return {
        "top1RecallAt10s": round(top1 / n, 3),
        "topKRecallAt10s": round(topk / n, 3),
        "selectedRecallAt10s": round(selected / n, 3),
        "rows": rows,
    }


def topk_truth_oracle_path(
    truth: list[tuple[float, float]],
    candidates_by_page: dict[int, list[dict]],
    measure_to_page: dict[int, int],
    *,
    tolerance: float = 10.0,
) -> list[dict]:
    """Fine-truth oracle over candidate choice, for diagnosis only.

    If this performs well, top-k candidates contain the answer and the remaining
    problem is ranking/path selection. If this is still bad, the page candidates
    themselves are insufficient. It emits only pages covered by M1 truth so
    unscored pages cannot pollute the diagnostic upper bound.
    """
    truth_by_page: dict[int, list[float]] = {}
    for t_true, m_true in truth:
        page, _mapped_measure, _exact_measure_page = page_for_measure(int(round(m_true)), measure_to_page)
        if page is not None:
            truth_by_page.setdefault(page, []).append(float(t_true))
    selected = []
    for page, times in truth_by_page.items():
        cands = candidates_by_page.get(page, [])
        if not cands:
            continue
        def score(cand):
            contained = sum(float(cand["start"]) - tolerance <= t <= float(cand["end"]) + tolerance for t in times)
            distances = [
                0.0 if float(cand["start"]) <= t <= float(cand["end"])
                else min(abs(t - float(cand["start"])), abs(t - float(cand["end"])))
                for t in times
            ]
            return (-contained, float(np.median(distances)), float(cand["cost"]))
        selected.append({**min(cands, key=score)})
    return sorted(selected, key=lambda item: int(item["page"]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--score-id", default="score-mofx8cdb-sbrqgx")
    parser.add_argument("--audio", default="data/real-tests/originals/xuan-dong-full.mp3")
    parser.add_argument("--truth", default=m1.DEFAULT_TRUTH)
    parser.add_argument("--feature", default="crepe", choices=["chroma", "cens", "hpss", "crepe"])
    parser.add_argument("--crepe-fmax", type=float, default=1400.0)
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--span-penalty", type=float, default=0.5)
    parser.add_argument("--min-gap-seconds", type=float, default=-15.0)
    parser.add_argument("--window-pad-seconds", type=float, default=0.0)
    parser.add_argument("--position-prior-weight", type=float, default=0.0)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    truth = [(float(a), float(b)) for a, b in (part.split(":") for part in args.truth.split(","))]
    template, pages, measures = m1.load_columns_with_measure(args.score_id)
    waveform, sr = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sr != gdtw.SR:
        waveform = librosa.resample(waveform, orig_sr=sr, target_sr=gdtw.SR)
    feat, audio_hop = gdtw.audio_feature(waveform, args.feature, crepe_fmax=args.crepe_fmax)

    n_score = template.shape[1]
    baseline_pred = m1.dtw_pred_measure(template, measures, feat, audio_hop, [(0, feat.shape[1], 0, n_score)])
    baseline = m1.eval_fine(baseline_pred, audio_hop, truth)

    slots = page_templates(template, pages)
    page_path, diagnostics, candidates_by_page = locate_pages(
        slots,
        feat,
        audio_hop,
        top_k=args.top_k,
        span_penalty=args.span_penalty,
        min_gap_seconds=args.min_gap_seconds,
        position_prior_weight=args.position_prior_weight,
    )
    page_blocks = blocks_from_page_path(
        page_path,
        audio_hop,
        pad_seconds=args.window_pad_seconds,
        audio_frames=feat.shape[1],
    )
    located_pred = m1.dtw_pred_measure(template, measures, feat, audio_hop, page_blocks)
    located = m1.eval_fine(located_pred, audio_hop, truth)
    measure_to_page = measure_page_lookup(measures, pages)
    recall = candidate_recall(
        truth,
        candidates_by_page,
        measure_to_page,
        page_path,
        window_pad_seconds=args.window_pad_seconds,
    )

    oracle_path = topk_truth_oracle_path(truth, candidates_by_page, measure_to_page)
    oracle_pred = m1.dtw_pred_measure(
        template,
        measures,
        feat,
        audio_hop,
        blocks_from_page_path(
            oracle_path,
            audio_hop,
            pad_seconds=args.window_pad_seconds,
            audio_frames=feat.shape[1],
        ),
    )
    topk_oracle = m1.eval_fine(oracle_pred, audio_hop, truth)

    print(f"[page-locator -> local rubato | {args.score_id} | {args.feature}/fmax={args.crepe_fmax} | pages={len(slots)} | topK={args.top_k}]")
    print(f"  baseline(global)     median={baseline['medianSecErr']}s mean={baseline['meanSecErr']}s <=10s={baseline['within10s']} <=5s={baseline['within5s']}")
    print(f"  page-locator+local   median={located['medianSecErr']}s mean={located['meanSecErr']}s <=10s={located['within10s']} <=5s={located['within5s']}")
    print(f"  topK-truth-oracle    median={topk_oracle['medianSecErr']}s mean={topk_oracle['meanSecErr']}s <=10s={topk_oracle['within10s']} <=5s={topk_oracle['within5s']}")
    print(f"  candidate recall@10s top1={recall['top1RecallAt10s']} topK={recall['topKRecallAt10s']} selected={recall['selectedRecallAt10s']}")
    print(f"  path diagnostics: {diagnostics}")

    out = {
        "scoreId": args.score_id,
        "feature": args.feature,
        "crepeFmax": args.crepe_fmax,
        "topK": args.top_k,
        "spanPenalty": args.span_penalty,
        "minGapSeconds": args.min_gap_seconds,
        "windowPadSeconds": args.window_pad_seconds,
        "positionPriorWeight": args.position_prior_weight,
        "baseline": {key: value for key, value in baseline.items() if key != "rows"},
        "pageLocatorLocal": {key: value for key, value in located.items() if key != "rows"},
        "topKTruthOracleLocal": {key: value for key, value in topk_oracle.items() if key != "rows"},
        "candidateRecall": {key: value for key, value in recall.items() if key != "rows"},
        "pathDiagnostics": diagnostics,
        "selectedPageWindows": [
            {
                "page": item["page"],
                "start": item["start"],
                "end": item["end"],
                "cost": item["cost"],
                "pathCost": item.get("pathCost", item["cost"]),
                "positionPenalty": item.get("positionPenalty", 0.0),
                "expectedCenter": item.get("expectedCenter"),
            }
            for item in page_path
        ],
        "topKTruthOraclePageWindows": [
            {
                "page": item["page"],
                "start": item["start"],
                "end": item["end"],
                "cost": item["cost"],
                "pathCost": item.get("pathCost", item["cost"]),
                "positionPenalty": item.get("positionPenalty", 0.0),
                "expectedCenter": item.get("expectedCenter"),
            }
            for item in oracle_path
        ],
        "candidateRecallRows": recall["rows"],
        "pageLocatorLocalRows": located["rows"],
        "topKTruthOracleLocalRows": topk_oracle["rows"],
        "baselineRows": baseline["rows"],
    }
    out_dir = REPO_ROOT / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    span_token = str(args.span_penalty).replace("-", "m").replace(".", "p")
    gap_token = str(args.min_gap_seconds).replace("-", "m").replace(".", "p")
    pad_token = str(args.window_pad_seconds).replace("-", "m").replace(".", "p")
    prior_token = str(args.position_prior_weight).replace("-", "m").replace(".", "p")
    out_path = Path(args.out) if args.out else out_dir / (
        f"page-locator-localrubato-{args.score_id}-{args.feature}-topk{args.top_k}-span{span_token}-gap{gap_token}-pad{pad_token}-prior{prior_token}.json"
    )
    if not out_path.is_absolute():
        out_path = REPO_ROOT / out_path
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
