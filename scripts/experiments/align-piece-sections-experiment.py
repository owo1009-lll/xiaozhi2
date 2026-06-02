# -*- coding: utf-8 -*-
"""B1 (experiment only): content-driven section alignment for long recordings.

This is a STANDALONE experiment. It does NOT touch scan-piece-segments.py,
run-piece-pass.py, the analyzer, or the teacher backend. Its only job is to prove
the alignment idea on a synthetic gold set before any integration (B2).

Idea
----
Current alignment guesses each section's time from its sequence index (linear)
and searches a tiny +/-radius window, which drifts badly on long real
recordings. Instead:

  1. Extract whole-audio chroma once (librosa.feature.chroma_cqt).
  2. For each score section, build a chroma TEMPLATE from its ERHU-line notes
     only (notePosition.scoreLineRole == "erhu"), expanded by beat duration.
  3. For each section, run subsequence DTW (librosa.sequence.dtw subseq=True) of
     its template against the whole-audio chroma and keep the TOP-K candidate
     windows (not just the single best) -- repeats need alternatives.
  4. Choose one window per section with a GLOBAL MONOTONIC DP over sections in
     sequence order, so repeated passages cannot all collapse onto the first
     occurrence and windows stay ordered / non-overlapping.

Gold harness
------------
Synthesizes audio from a known section layout with known section start/end, in
five conditions (clean / tempo-varied / long-rest / repeated-section /
accompaniment-mix), and reports start/end/midpoint error, window IoU, repeat
mismatch, monotonicity, overlap, and runtime.

Run:
  python-service/.venv/Scripts/python.exe scripts/experiments/align-piece-sections-experiment.py
"""
from __future__ import annotations

import io
import json
import math
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

try:
    import librosa
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"librosa unavailable: {exc}"}))
    sys.exit(1)

SR = 22050
HOP = 2048  # ~0.093s/frame at 22050 -> ~6500 frames for a 600s piece, DTW-friendly
TOP_K = 4
A4 = 440.0


# --------------------------------------------------------------------------- #
# Synthetic score + audio (gold)
# --------------------------------------------------------------------------- #
@dataclass
class GoldNote:
    midi: int
    beat_start: float
    beat_duration: float
    role: str = "erhu"


@dataclass
class GoldSection:
    section_id: str
    sequence_index: int
    tempo: float
    notes: list[GoldNote]


def midi_to_hz(midi: float) -> float:
    return A4 * (2.0 ** ((midi - 69.0) / 12.0))


def base_sections() -> list[GoldSection]:
    """A small multi-section line. Distinct pitch contours per section so a correct
    aligner can tell them apart; one section is duplicated later for the repeat test."""
    contours = [
        [62, 64, 66, 67, 69],          # s1
        [74, 72, 71, 69, 67],          # s2
        [69, 71, 74, 76, 78],          # s3
        [81, 79, 78, 76, 74],          # s4
        [66, 67, 69, 71, 69],          # s5
    ]
    sections = []
    for index, pitches in enumerate(contours):
        notes = [GoldNote(midi=p, beat_start=float(i), beat_duration=1.0) for i, p in enumerate(pitches)]
        # add a piano-ish accompaniment note tagged non-erhu, to be excluded from templates
        notes.append(GoldNote(midi=48 + index, beat_start=0.0, beat_duration=4.0, role="piano"))
        sections.append(GoldSection(section_id=f"s{index+1}", sequence_index=index, tempo=72.0, notes=notes))
    return sections


def synth_piece(layout, *, tempo_scale=1.0, rest_after=None, with_accompaniment=False, seed=0):
    """Render audio for an ordered layout of (section, gap_before_seconds).
    Returns (wav_float32, [(section_id, start_s, end_s)]) -- the GOLD truth."""
    rng = np.random.default_rng(seed)
    segments = []  # (audio, section_id)
    truth = []
    cursor = 0.0
    pieces = []
    for entry in layout:
        section = entry["section"]
        gap = entry.get("gap", 0.0)
        if gap > 0:
            silence = np.zeros(int(gap * SR), dtype=np.float32)
            pieces.append(silence)
            cursor += gap
        spb = (60.0 / section.tempo) * tempo_scale
        seg_start = cursor
        # render erhu notes (and optionally piano) into a local buffer
        seg_notes = [n for n in section.notes if (with_accompaniment or n.role == "erhu")]
        seg_len_beats = max((n.beat_start + n.beat_duration) for n in section.notes)
        seg_dur = seg_len_beats * spb
        buf = np.zeros(int(seg_dur * SR) + 1, dtype=np.float32)
        for n in seg_notes:
            f = midi_to_hz(n.midi)
            a = int(n.beat_start * spb * SR)
            b = int((n.beat_start + n.beat_duration) * spb * SR)
            t = np.arange(b - a, dtype=np.float32) / SR
            gain = 0.32 if n.role == "erhu" else 0.16
            tone = gain * np.sin(2 * math.pi * f * t)
            tone += (gain * 0.5) * np.sin(2 * math.pi * f * 2 * t)
            env = np.ones_like(t)
            atk = max(1, int(0.01 * SR)); rel = max(1, int(0.04 * SR))
            env[:atk] = np.linspace(0, 1, atk); env[-rel:] = np.linspace(1, 0, rel)
            buf[a:a + len(t)] += tone * env
        pieces.append(buf)
        cursor += len(buf) / SR
        truth.append((section.section_id, round(seg_start, 3), round(cursor, 3)))
    audio = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
    if seed:
        rms = float(np.sqrt(np.mean(audio ** 2))) or 1e-6
        audio = audio + rng.normal(0, rms / (10 ** (45 / 20)), audio.shape).astype(np.float32)
    peak = float(np.max(np.abs(audio))) or 1.0
    if peak > 1:
        audio = audio / peak
    return audio.astype(np.float32), truth


# --------------------------------------------------------------------------- #
# Chroma template from erhu-line notes
# --------------------------------------------------------------------------- #
def section_template_chroma(section: GoldSection, hop_seconds: float) -> np.ndarray:
    """12 x T template: each erhu note contributes a one-hot pitch-class column run
    sized by its beat duration. Non-erhu roles are excluded (reviewer point 3)."""
    erhu = [n for n in section.notes if n.role == "erhu"]
    if not erhu:
        return np.zeros((12, 1), dtype=np.float32)
    spb = 60.0 / section.tempo
    cols = []
    for n in sorted(erhu, key=lambda x: x.beat_start):
        n_frames = max(1, int(round((n.beat_duration * spb) / hop_seconds)))
        col = np.zeros(12, dtype=np.float32)
        col[int(round(n.midi)) % 12] = 1.0
        cols.extend([col] * n_frames)
    template = np.stack(cols, axis=1)
    return template


def whole_audio_chroma(audio: np.ndarray) -> np.ndarray:
    chroma = librosa.feature.chroma_cqt(y=audio, sr=SR, hop_length=HOP)
    # L2-normalise columns so DTW cosine-like cost is scale-free
    norm = np.linalg.norm(chroma, axis=0, keepdims=True)
    norm[norm == 0] = 1.0
    return (chroma / norm).astype(np.float32)


# --------------------------------------------------------------------------- #
# Subsequence DTW -> top-K candidate windows per section
# --------------------------------------------------------------------------- #
def topk_candidates(template: np.ndarray, chroma: np.ndarray, hop_seconds: float, k: int) -> list[dict]:
    """Run subseq DTW and return up to k non-overlapping candidate windows, each
    {start, end, cost}. Cost lower = better. Candidates are found by taking the
    global best path end, then suppressing that region and re-scanning the
    accumulated cost's last row for other low-cost end points."""
    # D: accumulated cost matrix, wp: warping path for the global best
    D, wp = librosa.sequence.dtw(X=template, Y=chroma, subseq=True, metric="cosine")
    last_row = D[-1, :]  # cost of matching whole template ending at each audio frame
    finite = np.isfinite(last_row)
    if not finite.any():
        return []
    template_frames = template.shape[1]
    cands = []
    work = last_row.copy()
    work[~finite] = np.inf
    for _ in range(k):
        end_idx = int(np.argmin(work))
        if not np.isfinite(work[end_idx]):
            break
        cost = float(work[end_idx])
        start_idx = max(0, end_idx - template_frames)
        cands.append({
            "start": round(start_idx * hop_seconds, 3),
            "end": round(end_idx * hop_seconds, 3),
            "cost": round(cost, 4),
        })
        # suppress a window around this end so the next candidate is elsewhere
        lo = max(0, end_idx - template_frames)
        hi = min(len(work), end_idx + template_frames)
        work[lo:hi] = np.inf
    return cands


# --------------------------------------------------------------------------- #
# Global monotonic path over sections (DP) -- reviewer point 1
# --------------------------------------------------------------------------- #
def choose_monotonic_path(section_candidates: list[list[dict]]) -> list[dict]:
    """section_candidates is ordered by sequence index; each is a list of
    {start,end,cost}. Pick one per section minimizing total cost subject to
    non-decreasing start (and start >= previous end - small slack), so repeats
    cannot collapse onto an earlier occurrence."""
    n = len(section_candidates)
    INF = float("inf")
    # dp[i][j] = min total cost aligning sections i..end, choosing candidate j for i
    best = [[(INF, -1)] * len(c) for c in section_candidates]
    for j in range(len(section_candidates[-1])):
        best[-1][j] = (section_candidates[-1][j]["cost"], -1)
    for i in range(n - 2, -1, -1):
        for j, cand in enumerate(section_candidates[i]):
            choice = (INF, -1)
            for jn, nxt in enumerate(section_candidates[i + 1]):
                # monotonic: next section must start at/after this one's end (slack 1 frame)
                if nxt["start"] + 1e-6 >= cand["end"] - HOP / SR:
                    total = section_candidates[i + 1] and best[i + 1][jn][0]
                    if total < choice[0]:
                        choice = (total, jn)
            base = cand["cost"]
            best[i][j] = (base + (choice[0] if choice[0] != INF else INF), choice[1])
    # pick start
    start_j = min(range(len(best[0])), key=lambda j: best[0][j][0]) if best[0] else -1
    path = []
    j = start_j
    for i in range(n):
        if j < 0 or j >= len(section_candidates[i]):
            # monotonic chain broke; fall back to per-section best for the rest
            j = min(range(len(section_candidates[i])), key=lambda jj: section_candidates[i][jj]["cost"])
        chosen = section_candidates[i][j]
        path.append({**chosen})
        j = best[i][j][1]
    return path


def align(sections: list[GoldSection], audio: np.ndarray) -> tuple[list[dict], float]:
    hop_seconds = HOP / SR
    chroma = whole_audio_chroma(audio)
    section_candidates = []
    for section in sorted(sections, key=lambda s: s.sequence_index):
        template = section_template_chroma(section, hop_seconds)
        cands = topk_candidates(template, chroma, hop_seconds, TOP_K)
        if not cands:
            cands = [{"start": 0.0, "end": hop_seconds, "cost": float("inf")}]
        section_candidates.append(cands)
    path = choose_monotonic_path(section_candidates)
    result = []
    for section, chosen in zip(sorted(sections, key=lambda s: s.sequence_index), path):
        result.append({"sectionId": section.section_id, "start": chosen["start"], "end": chosen["end"], "cost": chosen["cost"]})
    return result, hop_seconds


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
def evaluate(predicted: list[dict], truth: list[tuple], hop_seconds: float) -> dict:
    # The aligner emits ONE window per unique section id. When a section recurs in
    # the audio (truth lists it more than once), the honest target is its FIRST
    # occurrence; matching that is correct, not a mismatch. (Multi-occurrence
    # alignment is a separate, deliberate product decision -- see report notes.)
    first_occ = {}
    occ_counts = {}
    for sid, s, e in truth:
        occ_counts[sid] = occ_counts.get(sid, 0) + 1
        if sid not in first_occ:
            first_occ[sid] = (s, e)
    start_err, end_err, mid_err, ious = [], [], [], []
    repeat_mismatch = 0
    for pred in predicted:
        sid = pred["sectionId"]
        if sid not in first_occ:
            continue
        ts, te = first_occ[sid]
        ps, pe = pred["start"], pred["end"]
        start_err.append(abs(ps - ts))
        end_err.append(abs(pe - te))
        mid_err.append(abs((ps + pe) / 2 - (ts + te) / 2))
        inter = max(0.0, min(pe, te) - max(ps, ts))
        union = max(pe, te) - min(ps, ts)
        ious.append(inter / union if union > 0 else 0.0)
        # mismatch: predicted window does not overlap the section's first occurrence
        if inter <= 0:
            repeat_mismatch += 1
    multi_occurrence_sections = sorted(sid for sid, c in occ_counts.items() if c > 1)
    starts = [p["start"] for p in predicted]
    monotonic = all(starts[i] <= starts[i + 1] + 1e-6 for i in range(len(starts) - 1))
    overlap = any(predicted[i]["end"] > predicted[i + 1]["start"] + 1.0 for i in range(len(predicted) - 1))
    def stat(xs):
        return {"mean": round(float(np.mean(xs)), 3), "max": round(float(np.max(xs)), 3)} if xs else {"mean": None, "max": None}
    return {
        "startErr": stat(start_err),
        "endErr": stat(end_err),
        "midpointErr": stat(mid_err),
        "iou": {"mean": round(float(np.mean(ious)), 3), "min": round(float(np.min(ious)), 3)} if ious else {},
        "firstOccurrenceMismatchCount": repeat_mismatch,
        "multiOccurrenceSections": multi_occurrence_sections,
        "monotonic": monotonic,
        "hasOverlap": overlap,
        "hopSeconds": round(hop_seconds, 4),
    }


def run_case(name: str, sections: list[GoldSection], layout: list[dict], **synth_kwargs) -> dict:
    audio, truth = synth_piece(layout, **synth_kwargs)
    t0 = time.time()
    predicted, hop = align(sections, audio)
    runtime = time.time() - t0
    metrics = evaluate(predicted, truth, hop)
    metrics["runtimeSec"] = round(runtime, 2)
    metrics["audioDurationSec"] = round(len(audio) / SR, 1)
    return {"case": name, "truth": truth, "predicted": predicted, "metrics": metrics}


def main() -> int:
    secs = base_sections()
    layout_plain = [{"section": s, "gap": 0.5} for s in secs]
    # repeat case: s1..s5 then s2,s3 again
    layout_repeat = layout_plain + [{"section": secs[1], "gap": 0.5}, {"section": secs[2], "gap": 0.5}]
    # long-rest case: big silence between s3 and s4
    layout_rest = [{"section": secs[0], "gap": 0.5}, {"section": secs[1], "gap": 0.5},
                   {"section": secs[2], "gap": 0.5}, {"section": secs[3], "gap": 8.0},
                   {"section": secs[4], "gap": 0.5}]
    cases = [
        run_case("clean", secs, layout_plain),
        run_case("tempo-varied", secs, layout_plain, tempo_scale=1.25),
        run_case("long-rest", secs, layout_rest),
        run_case("repeated-section", secs, layout_repeat),
        run_case("accompaniment-mix", secs, layout_plain, with_accompaniment=True, seed=7),
    ]
    report = {"ok": True, "sr": SR, "hop": HOP, "topK": TOP_K, "cases": cases}
    out_dir = Path(__file__).resolve().parents[2] / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "latest-alignment-gold.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    # compact stdout summary
    for c in cases:
        m = c["metrics"]
        print(f"{c['case']:>18}: startErr.mean={m['startErr']['mean']} max={m['startErr']['max']} "
              f"iou.mean={m['iou'].get('mean')} firstOccMismatch={m['firstOccurrenceMismatchCount']} "
              f"multiOcc={m['multiOccurrenceSections']} mono={m['monotonic']} overlap={m['hasOverlap']} "
              f"{m['runtimeSec']}s/{m['audioDurationSec']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
