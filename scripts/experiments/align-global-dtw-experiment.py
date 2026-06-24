# -*- coding: utf-8 -*-
"""Global monotonic DTW audio<->score alignment, evaluated against manual anchors.

NEW hypothesis vs the per-section approach (content_alignment / coarse experiment):
  The per-section method locates each section INDEPENDENTLY by subsequence DTW then
  stitches with a monotonic DP. On accompaniment-polluted long recordings the true
  window is rarely in the cheap top-k, the DP falls back, and windows SCATTER.

  A single GLOBAL DTW between the whole score note sequence and the whole audio is
  MONOTONIC BY CONSTRUCTION -- it physically cannot scatter. It can only DRIFT
  (rubato) or lock onto the wrong global offset. This experiment measures, with the
  37 manual anchors as ground truth, whether a global path is actually accurate.

Ground truth: manual-anchor manifests give (audioStart,audioEnd) -> score PAGE range.
We evaluate at PAGE granularity (the score store's measureIndex numbering does NOT
match the anchors' printed measure numbers, but PAGE numbers match on both sides).

Metric per anchor: take the audio window, read which score pages the alignment maps
into that window, compare the median predicted page to the anchor's page range.
  - pageHit = median predicted page within [pageLo, pageHi]
  - pageError = distance from median predicted page to the nearest end of the range

Run:
  python-service/.venv/Scripts/python.exe \
    scripts/experiments/align-global-dtw-experiment.py \
    --score-id score-mofx8cdb-sbrqgx \
    --audio data/real-tests/originals/xuan-dong-full.mp3 \
    --manifest data/teacher-manual-anchors/manifest-xuandong.csv \
    --feature chroma
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
import content_alignment as ca  # noqa: E402

import librosa  # noqa: E402
import soundfile as sf  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import anchor_eval  # noqa: E402

SR, HOP = ca.DEFAULT_SR, ca.DEFAULT_HOP
HOP_SECONDS = HOP / SR


def load_erhu_columns(score_id: str):
    """Whole-piece erhu note sequence -> (12 x S one-hot pitch-class template,
    page-per-column array). Ordered by (globalMeasureIndex, beatStart). Each note is
    expanded to its beat-duration in frames using its section tempo."""
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((s for s in store.get("scores", []) if s.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")

    rows = []  # (gmeasure, beatStart, midiPitch, beatDuration, tempo, page)
    for section in score.get("sections", []):
        tempo = float(section.get("tempo") or 72.0)
        for note in section.get("notes", []) or []:
            pos = note.get("notePosition") or {}
            if str(pos.get("scoreLineRole", "erhu")) != "erhu":
                continue
            midi = note.get("midiPitch")
            if midi is None:
                continue
            gm = pos.get("globalMeasureIndex") or note.get("measureIndex") or 0
            page = pos.get("pageNumber")
            rows.append((
                float(gm), float(note.get("beatStart", 0.0)),
                int(round(float(midi))), float(note.get("beatDuration", 1.0)),
                max(30.0, tempo), int(page) if page is not None else 0,
            ))
    if not rows:
        raise SystemExit("no erhu notes")
    rows.sort(key=lambda r: (r[0], r[1]))

    cols, pages = [], []
    for gm, _bs, midi, beat_dur, tempo, page in rows:
        spb = 60.0 / tempo
        n_frames = max(1, int(round((beat_dur * spb) / HOP_SECONDS)))
        col = np.zeros(12, dtype=np.float32)
        col[midi % 12] = 1.0
        for _ in range(n_frames):
            cols.append(col)
            pages.append(page)
    template = np.stack(cols, axis=1)
    return template, np.array(pages)


def audio_feature(waveform, feature: str, crepe_fmax: float = 1400.0):
    """Return (12 x T feature, frame_hop_seconds)."""
    if feature == "chroma":
        return ca.whole_audio_chroma(waveform), HOP_SECONDS
    if feature == "cens":
        ch = librosa.feature.chroma_cens(y=waveform, sr=SR, hop_length=HOP)
        norm = np.linalg.norm(ch, axis=0, keepdims=True); norm[norm == 0] = 1.0
        return (ch / norm).astype(np.float32), HOP_SECONDS
    if feature == "hpss":  # harmonic-only chroma: drop percussive, reduce accompaniment transients
        harm = librosa.effects.harmonic(waveform, margin=3.0)
        ch = librosa.feature.chroma_cqt(y=harm, sr=SR, hop_length=HOP)
        norm = np.linalg.norm(ch, axis=0, keepdims=True)
        silent = norm[0] == 0; norm[norm == 0] = 1.0
        ch = ch / norm
        if silent.any():
            ch[:, silent] = 1.0 / np.sqrt(12.0)
        return ch.astype(np.float32), HOP_SECONDS
    if feature == "crepe":  # melody pitch tracking -> pitch-class one-hot (confidence-weighted)
        import torch, torchcrepe
        sr16 = 16000
        audio16 = librosa.resample(waveform, orig_sr=SR, target_sr=sr16)
        hop16 = int(round(HOP_SECONDS * sr16))
        audio_t = torch.tensor(audio16, dtype=torch.float32)[None]
        f0, periodicity = torchcrepe.predict(
            audio_t, sr16, hop16, fmin=150.0, fmax=crepe_fmax, model="tiny",
            batch_size=1024, device="cpu", return_periodicity=True,
        )
        f0 = f0[0].cpu().numpy(); conf = periodicity[0].cpu().numpy()
        n = f0.shape[0]
        feat = np.full((12, n), 1.0 / np.sqrt(12.0), dtype=np.float32)
        voiced = (conf > 0.3) & (f0 > 0)
        midi = np.zeros(n)
        midi[voiced] = 69.0 + 12.0 * np.log2(np.maximum(f0[voiced], 1e-6) / 440.0)
        for i in range(n):
            if voiced[i]:
                pc = int(round(midi[i])) % 12
                col = np.zeros(12, dtype=np.float32); col[pc] = 1.0
                feat[:, i] = col
        return feat, hop16 / sr16
    raise SystemExit(f"unknown feature: {feature}")


def load_anchors(manifest_path: Path):
    anchors = []
    with manifest_path.open(encoding="utf-8-sig") as fh:
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


def global_dtw_page_of_time(template, pages, audio_chroma):
    """Single monotonic DTW (subseq=False). Returns a function-like array mapping each
    audio frame -> predicted score page (median page of score cols aligned to it)."""
    _acc, wp = librosa.sequence.dtw(X=template, Y=audio_chroma, subseq=False, metric="cosine")
    # wp: array of (score_idx, audio_idx) pairs from end to start.
    n_audio = audio_chroma.shape[1]
    page_lists = [[] for _ in range(n_audio)]
    for s_idx, a_idx in wp:
        if 0 <= a_idx < n_audio:
            page_lists[a_idx].append(int(pages[s_idx]))
    pred = np.full(n_audio, -1, dtype=np.int32)
    for a_idx, plist in enumerate(page_lists):
        if plist:
            pred[a_idx] = int(np.median(plist))
    # fill gaps (frames with no wp pair) by forward fill
    last = -1
    for i in range(n_audio):
        if pred[i] < 0:
            pred[i] = last
        else:
            last = pred[i]
    return pred


def evaluate(anchors, pred_page, audio_hop):
    results = []
    hits = 0
    errors = []
    for a in anchors:
        f0 = int(a["start"] / audio_hop)
        f1 = max(f0 + 1, int(a["end"] / audio_hop))
        window = pred_page[f0:f1]
        window = window[window >= 0]
        if window.size == 0:
            results.append({**a, "predPage": None, "hit": False, "pageError": None})
            continue
        med = int(np.median(window))
        hit = a["pageLo"] <= med <= a["pageHi"]
        err = 0 if hit else min(abs(med - a["pageLo"]), abs(med - a["pageHi"]))
        hits += int(hit)
        errors.append(err)
        results.append({**a, "predPage": med, "hit": hit, "pageError": err})
    n = len(anchors)
    return {
        "anchorCount": n,
        "pageHitRate": round(hits / n, 3) if n else None,
        "medianPageError": float(np.median(errors)) if errors else None,
        "meanPageError": round(float(np.mean(errors)), 2) if errors else None,
        "perAnchor": results,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--score-id", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--feature", default="chroma", choices=["chroma", "cens", "hpss", "crepe"])
    ap.add_argument("--crepe-fmax", type=float, default=1400.0, help="CREPE fmax (Hz); 1400 aligns better than production's 2000")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    template, pages = load_erhu_columns(args.score_id)
    anchors = anchor_eval.load_anchors(REPO_ROOT / args.manifest)

    waveform, sample_rate = sf.read(str((REPO_ROOT / args.audio).resolve()), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sample_rate != SR:
        waveform = librosa.resample(waveform, orig_sr=sample_rate, target_sr=SR)
    audio_dur = len(waveform) / SR

    chroma, audio_hop = audio_feature(waveform, args.feature, crepe_fmax=args.crepe_fmax)
    pred_page = global_dtw_page_of_time(template, pages, chroma)
    metrics = anchor_eval.evaluate(anchors, pred_page, audio_hop)

    report = {
        "ok": True, "method": "global-dtw", "feature": args.feature,
        "scoreId": args.score_id, "audio": args.audio,
        "audioDurationSeconds": round(audio_dur, 1),
        "scoreTemplateFrames": int(template.shape[1]),
        "audioFrames": int(chroma.shape[1]),
        "scorePages": sorted(set(int(p) for p in pages)),
        "metrics": {k: v for k, v in metrics.items() if k != "perAnchor"},
        "perAnchor": metrics["perAnchor"],
    }
    out_dir = REPO_ROOT / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else out_dir / f"global-dtw-{args.score_id}-{args.feature}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    anchor_eval.print_report(f"global-dtw/{args.feature} {args.score_id} {report['audioDurationSeconds']}s", metrics)
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
