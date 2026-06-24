# -*- coding: utf-8 -*-
"""坎2 Pilot A / M1: second-level alignment accuracy against fine note-level truth.

The page-level anchors can only validate ~half-a-page (~20s); they cannot judge whether
local rubato alignment reaches teacher-ready SECOND-level accuracy. This script uses
INDEPENDENT fine truth (human-marked "audio second -> PDF measure" points) to measure
the real seconds error, non-circularly:

  - anchors define the page BLOCKS (oracle), but the fine-truth points are measures at
    arbitrary seconds, which the anchors do NOT constrain -> evaluating the anchor-blocked
    local alignment at these points is non-circular.

Compares:
  baseline   : whole-piece global DTW (audio frame -> measure)
  A1-oracle  : anchor-page-blocked local DTW (audio frame -> measure)
For each truth (t_true, m_true): the aligner says measure m_true happens at t_pred(m_true)
(inverse of its monotone audio->measure curve). secondsError = |t_pred - t_true|.

Run:
  python-service/.venv/Scripts/python.exe scripts/experiments/eval_m1_finetruth.py \
    --score-id score-mofx8cdb-sbrqgx --audio data/real-tests/originals/xuan-dong-full.mp3 \
    --manifest data/teacher-manual-anchors/manifest-xuandong.csv
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

# 炫动 fine truth: audio seconds -> PDF printed measure (human-marked, independent of anchors)
DEFAULT_TRUTH = "7:2,110:23,135:39,159:55,182:71,206:87,283:113,314:122,344:130,363:144,413:178"


def load_columns_with_measure(score_id: str):
    """12 x S template + per-column page + per-column PDF measure (measureIndex, now 1-181
    after the store rebuild). Mirrors gdtw.load_erhu_columns but also tracks measure."""
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((s for s in store.get("scores", []) if s.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")
    rows = []
    for section in score.get("sections", []):
        tempo = max(30.0, float(section.get("tempo") or 72.0))
        for note in section.get("notes", []) or []:
            pos = note.get("notePosition") or {}
            if str(pos.get("scoreLineRole", "erhu")) != "erhu":
                continue
            midi = note.get("midiPitch")
            if midi is None:
                continue
            gm = pos.get("globalMeasureIndex") or note.get("measureIndex") or 0
            meas = int(note.get("measureIndex") or pos.get("globalMeasureIndex") or 0)
            page = int(pos.get("pageNumber") or 0)
            rows.append((float(gm), float(note.get("beatStart", 0.0)), int(round(float(midi))),
                         float(note.get("beatDuration", 1.0)), tempo, page, meas))
    rows.sort(key=lambda r: (r[0], r[1]))
    cols, pages, measures = [], [], []
    hop_seconds = gdtw.HOP_SECONDS
    for gm, _bs, midi, beat_dur, tempo, page, meas in rows:
        spb = 60.0 / tempo
        nframes = max(1, int(round((beat_dur * spb) / hop_seconds)))
        col = np.zeros(12, dtype=np.float32)
        col[midi % 12] = 1.0
        for _ in range(nframes):
            cols.append(col); pages.append(page); measures.append(meas)
    return np.stack(cols, axis=1), np.array(pages), np.array(measures)


def cols_for_pages(pages, p_lo, p_hi):
    idx = np.where((pages >= p_lo) & (pages <= p_hi))[0]
    return (int(idx[0]), int(idx[-1]) + 1) if idx.size else None


def dtw_pred_measure(template, measures, feat, audio_hop, blocks):
    """blocks: list of (f0,f1,c0,c1). Returns pred_measure per audio frame (median of
    aligned score columns' measures), forward-filled."""
    n_audio = feat.shape[1]
    pred = np.full(n_audio, -1.0)
    for (f0, f1, c0, c1) in blocks:
        f0 = max(0, int(f0)); f1 = min(n_audio, int(f1))
        if f1 - f0 < 2 or c1 - c0 < 2:
            continue
        _acc, wp = librosa.sequence.dtw(X=template[:, c0:c1], Y=feat[:, f0:f1], subseq=False, metric="cosine")
        lists = [[] for _ in range(f1 - f0)]
        for s_idx, a_idx in wp:
            if 0 <= a_idx < (f1 - f0):
                lists[a_idx].append(int(measures[c0 + s_idx]))
        for a_local, vals in enumerate(lists):
            if vals:
                pred[f0 + a_local] = float(np.median(vals))
    last = -1.0
    for i in range(n_audio):
        if pred[i] < 0:
            pred[i] = last
        else:
            last = pred[i]
    return pred


def measure_to_time(pred_measure, audio_hop):
    """Invert the monotone audio->measure curve: measure -> median audio time."""
    by_measure = {}
    for f, m in enumerate(pred_measure):
        if m < 0:
            continue
        by_measure.setdefault(int(round(m)), []).append(f * audio_hop)
    ms = sorted(by_measure)
    ts = [float(np.median(by_measure[m])) for m in ms]
    return np.array(ms, dtype=float), np.array(ts, dtype=float)


def eval_fine(pred_measure, audio_hop, truth):
    ms, ts = measure_to_time(pred_measure, audio_hop)
    rows, errs = [], []
    for t_true, m_true in truth:
        t_pred = float(np.interp(m_true, ms, ts)) if ms.size else float("nan")
        err = abs(t_pred - t_true)
        errs.append(err)
        rows.append({"t_true": t_true, "m_true": m_true, "t_pred": round(t_pred, 1), "errSec": round(err, 1)})
    return {"medianSecErr": round(float(np.median(errs)), 1),
            "meanSecErr": round(float(np.mean(errs)), 1),
            "within5s": round(sum(e <= 5 for e in errs) / len(errs), 3),
            "within10s": round(sum(e <= 10 for e in errs) / len(errs), 3),
            "rows": rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--score-id", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--truth", default=DEFAULT_TRUTH)
    ap.add_argument("--crepe-fmax", type=float, default=1400.0)
    args = ap.parse_args()

    truth = [(float(a), float(b)) for a, b in (p.split(":") for p in args.truth.split(","))]
    template, pages, measures = load_columns_with_measure(args.score_id)
    anchors = anchor_eval.load_anchors(REPO_ROOT / args.manifest)
    waveform, sr = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sr != gdtw.SR:
        waveform = librosa.resample(waveform, orig_sr=sr, target_sr=gdtw.SR)
    feat, audio_hop = gdtw.audio_feature(waveform, "crepe", crepe_fmax=args.crepe_fmax)

    n_score = template.shape[1]
    base_pred = dtw_pred_measure(template, measures, feat, audio_hop, [(0, feat.shape[1], 0, n_score)])
    anchor_blocks = []
    for a in anchors:
        cr = cols_for_pages(pages, a["pageLo"], a["pageHi"])
        if cr:
            anchor_blocks.append((int(a["start"] / audio_hop), int(a["end"] / audio_hop), cr[0], cr[1]))
    a1_pred = dtw_pred_measure(template, measures, feat, audio_hop, anchor_blocks)

    base = eval_fine(base_pred, audio_hop, truth)
    a1 = eval_fine(a1_pred, audio_hop, truth)

    print(f"[M1 fine-truth | {args.score_id} | {len(truth)} points | measures 1-{int(measures.max())}]")
    print(f"  baseline(global)  medianSecErr={base['medianSecErr']}s meanSecErr={base['meanSecErr']}s within10s={base['within10s']} within5s={base['within5s']}")
    print(f"  A1-oracle(local)  medianSecErr={a1['medianSecErr']}s meanSecErr={a1['meanSecErr']}s within10s={a1['within10s']} within5s={a1['within5s']}")
    print("  per-point (A1-oracle): t_true -> t_pred (errSec)")
    for r in a1["rows"]:
        print(f"    m{int(r['m_true']):>3} @ {r['t_true']:.0f}s -> pred {r['t_pred']:.0f}s  err={r['errSec']}s")

    out = {"scoreId": args.score_id, "truthPoints": len(truth),
           "baseline": {k: v for k, v in base.items() if k != "rows"},
           "A1_oracle": {k: v for k, v in a1.items() if k != "rows"},
           "A1_perPoint": a1["rows"], "baseline_perPoint": base["rows"]}
    out_dir = REPO_ROOT / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"m1-finetruth-{args.score_id}.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_dir / f'm1-finetruth-{args.score_id}.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
