# -*- coding: utf-8 -*-
"""Anchored (piecewise) DTW: pin the alignment at a few boundary points so rubato
drift cannot accumulate across them (the user's idea: re-sync at free-rhythm bounds).

Tests how FEW pins are needed for teacher-ready time accuracy. Pins are drawn from the
manual anchors (audioStart <-> pageLo) subsampled by --pin-every:
  --pin-every 1  pin at EVERY anchor (upper bound: does pinning solve drift at all?)
  --pin-every 3  pin at every 3rd anchor (sparse: do in-between anchors still align?)
Between consecutive pins we run an independent DTW (score pages of that span vs that
audio span). Evaluation uses ALL anchors; --report-nonpin shows accuracy on the
anchors that were NOT used as pins (the honest, non-leaky test).

Run:
  python-service/.venv/Scripts/python.exe scripts/experiments/align_anchored_dtw.py \
    --score-id score-moef6aiw-f1evny --audio data/real-tests/originals/second-rhapsody-full.mp3 \
    --manifest data/teacher-manual-anchors/manifest-rhapsody-2.csv --feature crepe --pin-every 3
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import anchor_eval  # noqa: E402
import librosa  # noqa: E402

# import helpers from the hyphenated global-dtw script
_spec = importlib.util.spec_from_file_location("gdtw", str(Path(__file__).resolve().parent / "align-global-dtw-experiment.py"))
gdtw = importlib.util.module_from_spec(_spec)
sys.modules["gdtw"] = gdtw
_spec.loader.exec_module(gdtw)


def first_col_of_page(pages: np.ndarray, page: int) -> int:
    idx = np.where(pages == page)[0]
    return int(idx[0]) if idx.size else 0


def piecewise_pred_page(template, pages, feat, audio_hop, pins):
    """pins: sorted list of (audio_frame, score_col). DTW each [pin_i, pin_{i+1}] span
    independently; concatenate predicted page per audio frame."""
    n_audio = feat.shape[1]
    n_score = template.shape[1]
    pins = sorted(set([(0, 0)] + pins + [(n_audio, n_score)]))
    pred = np.full(n_audio, -1, dtype=np.int32)
    for (f0, c0), (f1, c1) in zip(pins, pins[1:]):
        if f1 <= f0 or c1 <= c0:
            # degenerate span: fill by nearest page
            pred[f0:f1] = pages[min(max(c0, 0), n_score - 1)]
            continue
        sub_t = template[:, c0:c1]
        sub_a = feat[:, f0:f1]
        _acc, wp = librosa.sequence.dtw(X=sub_t, Y=sub_a, subseq=False, metric="cosine")
        col_lists = [[] for _ in range(f1 - f0)]
        for s_idx, a_idx in wp:
            if 0 <= a_idx < (f1 - f0):
                col_lists[a_idx].append(int(pages[c0 + s_idx]))
        for a_local, plist in enumerate(col_lists):
            if plist:
                pred[f0 + a_local] = int(np.median(plist))
    # forward-fill any gaps
    last = -1
    for i in range(n_audio):
        if pred[i] < 0:
            pred[i] = last
        else:
            last = pred[i]
    return pred


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--score-id", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--feature", default="crepe", choices=["chroma", "cens", "hpss", "crepe"])
    ap.add_argument("--pin-every", type=int, default=3)
    args = ap.parse_args()

    template, pages = gdtw.load_erhu_columns(args.score_id)
    anchors = anchor_eval.load_anchors(REPO_ROOT / args.manifest)

    import soundfile as sf
    waveform, sr = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sr != gdtw.SR:
        waveform = librosa.resample(waveform, orig_sr=sr, target_sr=gdtw.SR)
    feat, audio_hop = gdtw.audio_feature(waveform, args.feature)

    # pins: every Nth anchor -> (audio frame of its start, first score col of its pageLo)
    pin_anchor_idx = set(range(0, len(anchors), max(1, args.pin_every)))
    pins = []
    for i in sorted(pin_anchor_idx):
        a = anchors[i]
        f = int(a["start"] / audio_hop)
        c = first_col_of_page(pages, a["pageLo"])
        pins.append((f, c))

    pred_page = piecewise_pred_page(template, pages, feat, audio_hop, pins)
    metrics = anchor_eval.evaluate(anchors, pred_page, audio_hop)

    print(f"[anchored-dtw/{args.feature} pin-every={args.pin_every}] {args.score_id} pins={len(pins)}/{len(anchors)}")
    anchor_eval.print_report(f"anchored pin-every={args.pin_every}", metrics)

    # honest non-pin subset accuracy
    nonpin = [j for j in range(len(anchors)) if j not in pin_anchor_idx]
    if nonpin:
        per = metrics["perAnchor"]
        hits = sum(1 for j in nonpin if per[j]["hit"])
        terrs = [abs(per[j]["timeErr"]) for j in nonpin if per[j].get("timeErr") is not None]
        print(f"  [non-pin only: {len(nonpin)} anchors] pageHit={round(hits/len(nonpin),3)} "
              f"medTimeErr={round(float(np.median(terrs)),1) if terrs else None}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
