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

# Import the extracted reusable core so the gold set validates the SAME code that
# the scan pipeline will run (B2a). The inline copies that used to live here are
# gone -- algorithm lives only in scripts/lib/content_alignment.py now.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import content_alignment as ca  # noqa: E402

try:
    import librosa  # noqa: F401  (kept so the experiment fails fast if missing)
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"librosa unavailable: {exc}"}))
    sys.exit(1)

SR = ca.DEFAULT_SR
HOP = ca.DEFAULT_HOP
TOP_K = ca.DEFAULT_TOP_K
A4 = 440.0

# Teacher-ready alignment bar (mirrors the gate in teacherValidationService.js /
# teacher-validation-support.mjs): windows that span far more audio than the
# sections themselves occupy are scattered, not aligned.
MAX_SPAN_RATIO = 2.0


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


def similar_phrase_sections() -> list[GoldSection]:
    """B3.0 RED case material: three SHORT 'entry' sections that share a near-identical
    head contour, so a pure pitch-class aligner cannot tell them apart -- the real
    long-recording failure mode. Each entry carries a LOUD sustained accompaniment
    triad (non-erhu, pitch classes 0/4/7) that pollutes the whole-audio chroma at its
    TRUE location. The clean decoys placed far away (clean_decoy) therefore become the
    cheaper subsequence-DTW match for entries 2/3, pulling their windows across the
    whole piece -- exactly the 14s/278s/336s scatter seen on the real 481s mix."""
    heads = [
        [62, 64, 65, 64],   # e1
        [62, 64, 66, 64],   # e2  (one note differs from e1)
        [62, 64, 65, 67],   # e3  (one note differs from e1)
    ]
    acc_triad = [48, 52, 55]  # pitch classes 0,4,7 sustained -> strong chroma pollution
    sections = []
    for index, pitches in enumerate(heads):
        notes = [GoldNote(midi=p, beat_start=float(i), beat_duration=1.0) for i, p in enumerate(pitches)]
        for chord_note in acc_triad:
            notes.append(GoldNote(midi=chord_note, beat_start=0.0, beat_duration=float(len(pitches)), role="piano"))
        sections.append(GoldSection(section_id=f"e{index+1}", sequence_index=index, tempo=72.0, notes=notes))
    return sections


def clean_decoy(section: GoldSection, decoy_id: str) -> GoldSection:
    """A clean (erhu-only, no accompaniment) copy of section's erhu contour with a
    DISTINCT id, so it appears in the audio as luring filler material -- not as the
    section itself. Its chroma matches the section's erhu-only template better than the
    accompaniment-polluted true occurrence does."""
    erhu = [GoldNote(midi=n.midi, beat_start=n.beat_start, beat_duration=n.beat_duration)
            for n in section.notes if n.role == "erhu"]
    return GoldSection(section_id=decoy_id, sequence_index=99, tempo=section.tempo, notes=erhu)


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
# Alignment delegates to the extracted module (scripts/lib/content_alignment.py).
# These adapters convert GoldSection/GoldNote into the minimal dict shape the
# module expects, so the gold set exercises the real production code path.
# --------------------------------------------------------------------------- #
def _section_to_dict(section: GoldSection) -> dict:
    return {
        "sectionId": section.section_id,
        "sequenceIndex": section.sequence_index,
        "tempo": section.tempo,
        "notes": [
            {"midiPitch": n.midi, "beatStart": n.beat_start, "beatDuration": n.beat_duration, "role": n.role}
            for n in section.notes
        ],
    }


def align(sections: list[GoldSection], audio: np.ndarray, span_penalty: float | None = None) -> tuple[list[dict], float]:
    kwargs = {} if span_penalty is None else {"span_penalty": span_penalty}
    result = ca.align_sections([_section_to_dict(s) for s in sections], audio, sr=SR, hop=HOP, top_k=TOP_K, **kwargs)
    return result, HOP / SR


def align_occurrences(play_order: list[GoldSection], audio: np.ndarray) -> tuple[list[dict], float]:
    result = ca.align_occurrences([_section_to_dict(s) for s in play_order], audio, sr=SR, hop=HOP, top_k=TOP_K)
    return result, HOP / SR


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
    # Span scatter (mirrors the teacher-ready gate's aligned-span-ratio): how much
    # audio the chosen windows span vs how much the sections themselves occupy. A
    # correct contiguous alignment is ~1x (plus gaps); scattered windows blow it up.
    predicted_span = (max(p["end"] for p in predicted) - min(p["start"] for p in predicted)) if predicted else 0.0
    expected_span = sum((first_occ[p["sectionId"]][1] - first_occ[p["sectionId"]][0])
                        for p in predicted if p["sectionId"] in first_occ)
    aligned_span_ratio = round(predicted_span / expected_span, 3) if expected_span > 0 else None
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
        "predictedSpanSec": round(predicted_span, 3),
        "expectedSpanSec": round(expected_span, 3),
        "alignedSpanRatio": aligned_span_ratio,
        "hopSeconds": round(hop_seconds, 4),
    }


def run_case(name: str, sections: list[GoldSection], layout: list[dict], *,
             baseline_penalty: float | None = None, **synth_kwargs) -> dict:
    audio, truth = synth_piece(layout, **synth_kwargs)
    t0 = time.time()
    predicted, hop = align(sections, audio)
    runtime = time.time() - t0
    metrics = evaluate(predicted, truth, hop)
    metrics["runtimeSec"] = round(runtime, 2)
    metrics["audioDurationSec"] = round(len(audio) / SR, 1)
    result = {"case": name, "truth": truth, "predicted": predicted, "metrics": metrics}
    # Control: re-align the SAME audio with the penalty disabled (or another value),
    # so the report records what this case looks like without the span penalty -- proof
    # that the penalty, not the synthetic data, is what keeps it aligned (reviewer #3).
    if baseline_penalty is not None:
        base_pred, _ = align(sections, audio, span_penalty=baseline_penalty)
        base = evaluate(base_pred, truth, hop)
        result["baselineWithoutPenalty"] = {
            "spanPenalty": baseline_penalty,
            "alignedSpanRatio": base["alignedSpanRatio"],
            "firstOccurrenceMismatchCount": base["firstOccurrenceMismatchCount"],
            "startErrMean": base["startErr"]["mean"],
        }
    return result


def run_occurrence_case(name: str, layout: list[dict], **synth_kwargs) -> dict:
    """Repeat-rounds gold: align each OCCURRENCE in play order and check every
    occurrence lands on its own round (not collapsed onto an earlier repeat)."""
    audio, truth = synth_piece(layout, **synth_kwargs)  # truth is already per-occurrence, in order
    play_order = [entry["section"] for entry in layout]
    t0 = time.time()
    predicted, hop = align_occurrences(play_order, audio)
    runtime = time.time() - t0
    # pair predicted[i] with truth[i] -- both are in play order
    start_err, iou, wrong_round = [], [], 0
    for pred, (sid, ts, te) in zip(predicted, truth):
        ps, pe = pred["start"], pred["end"]
        start_err.append(abs(ps - ts))
        inter = max(0.0, min(pe, te) - max(ps, ts))
        union = max(pe, te) - min(ps, ts)
        iou.append(inter / union if union > 0 else 0.0)
        if inter <= 0:
            wrong_round += 1
    starts = [p["start"] for p in predicted]
    monotonic = all(starts[i] <= starts[i + 1] + 1e-6 for i in range(len(starts) - 1))
    metrics = {
        "startErr": {"mean": round(float(np.mean(start_err)), 3), "max": round(float(np.max(start_err)), 3)},
        "iou": {"mean": round(float(np.mean(iou)), 3), "min": round(float(np.min(iou)), 3)},
        "wrongRoundCount": wrong_round,
        "occurrenceCount": len(predicted),
        "monotonic": monotonic,
        "runtimeSec": round(runtime, 2),
        "audioDurationSec": round(len(audio) / SR, 1),
    }
    return {"case": name, "truth": truth, "predicted": predicted, "metrics": metrics}


def meets_alignment_bar(metrics: dict) -> bool:
    """A case is aligned (not scattered) when no window misses its section's first
    occurrence AND the chosen windows do not span far more audio than the sections
    occupy. Same bar the teacher-ready gate enforces."""
    ratio = metrics.get("alignedSpanRatio")
    return (
        ratio is not None
        and ratio <= MAX_SPAN_RATIO
        and metrics.get("firstOccurrenceMismatchCount", 0) == 0
    )


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
    # similar phrases + long background + accompaniment pollution. Three similar entry
    # sections; their true heads are accompaniment-polluted, while clean copies of
    # entries 2 & 3 sit ~140s and ~280s later. WITHOUT the span/continuity penalty
    # (B3.0) entries 2/3 were pulled to the far clean decoys -> windows scattered
    # across the whole piece (spanRatio ~28, the real failure). The B3.1 span penalty
    # in choose_monotonic_path now keeps the path contiguous, so this case aligns to
    # the true heads (spanRatio ~1.1) -- it is a GREEN regression guard against scatter.
    entries = similar_phrase_sections()
    layout_scatter = [
        {"section": entries[0], "gap": 0.5},
        {"section": entries[1], "gap": 0.5},
        {"section": entries[2], "gap": 0.5},
        {"section": clean_decoy(entries[1], "d2"), "gap": 130.0},
        {"section": clean_decoy(entries[2], "d3"), "gap": 130.0},
    ]
    cases.append(run_case("similar-phrase-long-mix", entries, layout_scatter,
                          baseline_penalty=0.0, with_accompaniment=True, seed=7))

    # Expectation tracking. Green cases must meet the bar; xfail cases must currently
    # FAIL it (failure reproduced and stable). An xfail case that starts meeting the bar
    # is an XPASS -> stop and decide (promote to green if a fix landed, or strengthen the
    # case if it became too easy). similar-phrase-long-mix was the B3.0 xfail; the B3.1
    # span penalty fixed it, so it is now a GREEN case (kept here as a scatter regression
    # guard). XFAIL_CASES is empty until the next not-yet-fixed failure is added.
    XFAIL_CASES: set[str] = set()
    overall_ok = True
    for c in cases:
        passed = meets_alignment_bar(c["metrics"])
        is_xfail = c["case"] in XFAIL_CASES
        if is_xfail:
            status = "xfail-reproduced" if not passed else "XPASS-promote"
        else:
            status = "pass" if passed else "REGRESSION"
        if (is_xfail and passed) or (not is_xfail and not passed):
            overall_ok = False
        c["expectation"] = {"expected": "xfail" if is_xfail else "pass", "meetsBar": passed, "status": status}
    # Repeat-ROUNDS gold (reviewer point 4): align each occurrence in play order and
    # require every repeat to land on its own round, not collapse onto an earlier one.
    occurrence_cases = [
        run_occurrence_case("repeat-rounds", layout_repeat),
        run_occurrence_case("repeat-rounds-mix", layout_repeat, with_accompaniment=True, seed=7),
    ]
    report = {"ok": overall_ok, "sr": SR, "hop": HOP, "topK": TOP_K, "cases": cases, "occurrenceCases": occurrence_cases}
    out_dir = Path(__file__).resolve().parents[2] / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "latest-alignment-gold.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    # compact stdout summary
    for c in cases:
        m = c["metrics"]
        print(f"{c['case']:>20}: startErr.mean={m['startErr']['mean']} max={m['startErr']['max']} "
              f"iou.mean={m['iou'].get('mean')} firstOccMismatch={m['firstOccurrenceMismatchCount']} "
              f"spanRatio={m['alignedSpanRatio']} mono={m['monotonic']} overlap={m['hasOverlap']} "
              f"[{c['expectation']['status']}] {m['runtimeSec']}s/{m['audioDurationSec']}s")
        base = c.get("baselineWithoutPenalty")
        if base:
            print(f"{'  (no penalty)':>20}: spanRatio={base['alignedSpanRatio']} "
                  f"firstOccMismatch={base['firstOccurrenceMismatchCount']} startErr.mean={base['startErrMean']} "
                  f"<- proves the span penalty (not the data) keeps this case aligned")
    for c in occurrence_cases:
        m = c["metrics"]
        print(f"{c['case']:>20}: startErr.mean={m['startErr']['mean']} max={m['startErr']['max']} "
              f"iou.mean={m['iou']['mean']} wrongRound={m['wrongRoundCount']}/{m['occurrenceCount']} "
              f"mono={m['monotonic']} {m['runtimeSec']}s/{m['audioDurationSec']}s")
    print(f"overall ok={overall_ok} (green cases meet bar AND xfail cases still scatter)")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
