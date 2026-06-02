# -*- coding: utf-8 -*-
"""Content-driven section alignment (B2a: extracted reusable core).

Locates each score section inside a long recording by content, not by sequence-index
guessing. Pipeline:
  1. whole-audio chroma_cqt (once).
  2. per-section chroma template from ERHU-line notes only.
  3. subsequence DTW -> top-K candidate windows per section/occurrence.
  4. global monotonic DP -> one window per section/occurrence, in order.

This module is imported by both the gold experiment
(scripts/experiments/align-piece-sections-experiment.py) and the scan pipeline,
so the exact algorithm validated by the gold set is what runs in production.

A "section" here is the minimal dict the algorithm needs:
  {"sectionId": str, "sequenceIndex": int, "tempo": float, "notes": [note...]}
where each note is {"midiPitch": int, "beatStart": float, "beatDuration": float,
"role": "erhu"|other}. The caller adapts real piece sections / gold sections into
this shape (real notes carry role at notePosition.scoreLineRole).
"""
from __future__ import annotations

import math

import numpy as np

try:
    import librosa
except Exception as exc:  # pragma: no cover
    librosa = None
    _LIBROSA_ERROR = exc

DEFAULT_SR = 22050
DEFAULT_HOP = 2048
DEFAULT_TOP_K = 4
# B3.1 span/continuity penalty. The monotonic DP minimises total subsequence-DTW
# cost; on long, accompaniment-polluted recordings the cheapest windows for similar
# phrases sit far apart, so the path scatters across the whole piece. This penalty
# charges each section->next-section transition for the time GAP between them,
# normalised by the next section's own duration (so it is scale-free across pieces
# and tempos). A real rest of a few section-lengths costs little; a jump of tens of
# section-lengths (scatter) costs a lot, enough to overcome the cost saving of a far
# clean decoy. 0 restores the pre-B3.1 behaviour.
DEFAULT_SPAN_PENALTY = 0.5


def _require_librosa():
    if librosa is None:  # pragma: no cover
        raise RuntimeError(f"librosa unavailable: {_LIBROSA_ERROR}")


def whole_audio_chroma(audio: np.ndarray, sr: int = DEFAULT_SR, hop: int = DEFAULT_HOP) -> np.ndarray:
    """12 x T column-L2-normalised chroma for the whole recording. Silent frames
    (zero energy) are set to a uniform unit vector instead of left at zero, so the
    cosine-metric DTW never sees a zero column (which would make its cost matrix NaN
    and raise). A uniform column is pitch-neutral: weakly similar to everything."""
    _require_librosa()
    chroma = librosa.feature.chroma_cqt(y=audio, sr=sr, hop_length=hop)
    norm = np.linalg.norm(chroma, axis=0, keepdims=True)
    silent = norm[0] == 0
    norm[norm == 0] = 1.0
    chroma = chroma / norm
    if silent.any():
        chroma[:, silent] = 1.0 / math.sqrt(12.0)
    return chroma.astype(np.float32)


def section_template_chroma(section: dict, hop_seconds: float) -> np.ndarray:
    """12 x T template from the section's ERHU notes, expanded by beat duration.
    Non-erhu roles are excluded so piano/accompaniment lines do not pollute it."""
    erhu = [n for n in section.get("notes", []) if str(n.get("role", "erhu")) == "erhu"]
    if not erhu:
        return np.zeros((12, 1), dtype=np.float32)
    tempo = max(30.0, float(section.get("tempo") or 72.0))
    spb = 60.0 / tempo
    cols = []
    for note in sorted(erhu, key=lambda x: float(x.get("beatStart", 0.0))):
        beat_duration = float(note.get("beatDuration", 1.0))
        n_frames = max(1, int(round((beat_duration * spb) / hop_seconds)))
        col = np.zeros(12, dtype=np.float32)
        col[int(round(float(note.get("midiPitch", 0)))) % 12] = 1.0
        cols.extend([col] * n_frames)
    return np.stack(cols, axis=1)


def topk_candidates(template: np.ndarray, chroma: np.ndarray, hop_seconds: float, k: int = DEFAULT_TOP_K) -> list[dict]:
    """Subsequence DTW -> up to k non-overlapping {start,end,cost} candidate windows
    (lower cost = better), found by repeatedly taking the lowest-cost path end in the
    accumulated last row and suppressing a template-width region around it.

    A section with no erhu-line notes yields an all-zero template; cosine DTW on a
    zero column is undefined (NaN cost matrix -> librosa raises). Such a section is
    not content-locatable, so return [] -- the caller substitutes an inf-cost
    placeholder window, preserving the 1:1 section<->result contract."""
    _require_librosa()
    if template.size == 0 or not np.any(template):
        return []
    accumulated, _ = librosa.sequence.dtw(X=template, Y=chroma, subseq=True, metric="cosine")
    last_row = accumulated[-1, :]
    finite = np.isfinite(last_row)
    if not finite.any():
        return []
    template_frames = template.shape[1]
    work = last_row.copy()
    work[~finite] = np.inf
    candidates = []
    for _ in range(k):
        end_idx = int(np.argmin(work))
        if not np.isfinite(work[end_idx]):
            break
        cost = float(work[end_idx])
        start_idx = max(0, end_idx - template_frames)
        candidates.append({
            "start": round(start_idx * hop_seconds, 3),
            "end": round(end_idx * hop_seconds, 3),
            "cost": round(cost, 4),
        })
        lo = max(0, end_idx - template_frames)
        hi = min(len(work), end_idx + template_frames)
        work[lo:hi] = np.inf
    return candidates


def choose_monotonic_path(slot_candidates: list[list[dict]], hop_seconds: float,
                          span_penalty: float = DEFAULT_SPAN_PENALTY) -> list[dict]:
    """Pick one window per slot (section in order, or occurrence in play order)
    minimizing total cost subject to non-decreasing start, so repeats cannot
    collapse onto an earlier occurrence. A span/continuity penalty (span_penalty)
    charges each transition for the normalised time gap to the next window, so the
    path cannot scatter similar phrases across the whole recording (B3.1).

    Boundary: the penalty charges EVERY inter-slot gap, with no notion of an
    expected interval, so it assumes the slots are contiguous in the performance.
    That holds for a full play-order scan; it does NOT hold when the caller feeds a
    non-contiguous subset (sparse section ids, or omitted middle sections) where a
    large gap is legitimate -- there the caller should pass span_penalty=0. A future
    refinement would penalise only the gap exceeding a score-expected interval.

    Returns (path, diagnostics). diagnostics carries greedyFallbackCount (how many
    slots had NO valid monotonic continuation and fell back to per-slot min-cost,
    ignoring order) and monotonicFeasible (whether a full ordered path existed at
    all). On real long recordings the true windows are rarely all in the cheap
    candidate set, so no monotonic path exists, the DP falls back, and the result
    scatters -- these fields make that failure visible instead of silent."""
    n = len(slot_candidates)
    if n == 0:
        return [], {"slotCount": 0, "greedyFallbackCount": 0, "monotonicFeasible": True}
    INF = float("inf")
    slack = hop_seconds
    best = [[(INF, -1)] * len(c) for c in slot_candidates]
    for j in range(len(slot_candidates[-1])):
        best[-1][j] = (slot_candidates[-1][j]["cost"], -1)
    for i in range(n - 2, -1, -1):
        for j, cand in enumerate(slot_candidates[i]):
            choice = (INF, -1)
            for jn, nxt in enumerate(slot_candidates[i + 1]):
                if nxt["start"] + 1e-6 >= cand["end"] - slack:
                    gap = max(0.0, nxt["start"] - cand["end"])
                    next_window = max(nxt["end"] - nxt["start"], hop_seconds)
                    transition = span_penalty * (gap / next_window)
                    total = transition + best[i + 1][jn][0]
                    if total < choice[0]:
                        choice = (total, jn)
            best[i][j] = (cand["cost"] + (choice[0] if choice[0] != INF else INF), choice[1])
    start_j = min(range(len(best[0])), key=lambda j: best[0][j][0]) if best[0] else -1
    path = []
    greedy_fallbacks = 0
    j = start_j
    for i in range(n):
        if j < 0 or j >= len(slot_candidates[i]):
            j = min(range(len(slot_candidates[i])), key=lambda jj: slot_candidates[i][jj]["cost"])
            greedy_fallbacks += 1
        path.append({**slot_candidates[i][j]})
        j = best[i][j][1]
    diagnostics = {
        "slotCount": n,
        "greedyFallbackCount": greedy_fallbacks,
        "monotonicFeasible": greedy_fallbacks == 0,
    }
    return path, diagnostics


def _diagnostics_with_violation_rate(results: list[dict], diag: dict) -> dict:
    """Add the empirical monotonicViolationRate (windows out of time order / total
    transitions) to the DP diagnostics. This is the symptom the teacher-ready gate
    keys on: a high rate means the located windows are scattered, not in order."""
    starts = [r["start"] for r in results]
    violations = sum(1 for i in range(len(starts) - 1) if starts[i] > starts[i + 1] + 1e-6)
    denom = max(1, len(starts) - 1)
    return {**diag, "monotonicViolations": violations,
            "monotonicViolationRate": round(violations / denom, 4)}


def align_sections(sections: list[dict], audio: np.ndarray, *, sr: int = DEFAULT_SR,
                   hop: int = DEFAULT_HOP, top_k: int = DEFAULT_TOP_K, chroma: np.ndarray | None = None,
                   span_penalty: float = DEFAULT_SPAN_PENALTY) -> tuple[list[dict], dict]:
    """One window per unique section (first occurrence), in sequence-index order.
    Returns (results, diagnostics) -- see choose_monotonic_path for diagnostics."""
    hop_seconds = hop / sr
    if chroma is None:
        chroma = whole_audio_chroma(audio, sr=sr, hop=hop)
    ordered = sorted(sections, key=lambda s: int(s.get("sequenceIndex") or 0))
    slot_candidates = []
    for section in ordered:
        template = section_template_chroma(section, hop_seconds)
        cands = topk_candidates(template, chroma, hop_seconds, top_k) or [{"start": 0.0, "end": hop_seconds, "cost": float("inf")}]
        slot_candidates.append(cands)
    path, diag = choose_monotonic_path(slot_candidates, hop_seconds, span_penalty=span_penalty)
    results = [
        {"sectionId": section.get("sectionId"), "start": chosen["start"], "end": chosen["end"], "cost": chosen["cost"]}
        for section, chosen in zip(ordered, path)
    ]
    return results, _diagnostics_with_violation_rate(results, diag)


def align_occurrences(play_order: list[dict], audio: np.ndarray, *, sr: int = DEFAULT_SR,
                      hop: int = DEFAULT_HOP, top_k: int = DEFAULT_TOP_K, chroma: np.ndarray | None = None,
                      span_penalty: float = DEFAULT_SPAN_PENALTY) -> tuple[list[dict], dict]:
    """One window per occurrence in play order (repeats expanded), in order. This is
    the model the scan pipeline uses (each sectionPass is one occurrence).
    Returns (results, diagnostics) -- see choose_monotonic_path for diagnostics."""
    hop_seconds = hop / sr
    if chroma is None:
        chroma = whole_audio_chroma(audio, sr=sr, hop=hop)
    slot_candidates = []
    for section in play_order:
        template = section_template_chroma(section, hop_seconds)
        cands = topk_candidates(template, chroma, hop_seconds, top_k) or [{"start": 0.0, "end": hop_seconds, "cost": float("inf")}]
        slot_candidates.append(cands)
    path, diag = choose_monotonic_path(slot_candidates, hop_seconds, span_penalty=span_penalty)
    results = [
        {"sectionId": section.get("sectionId"), "occurrence": idx, "start": chosen["start"], "end": chosen["end"], "cost": chosen["cost"]}
        for idx, (section, chosen) in enumerate(zip(play_order, path))
    ]
    return results, _diagnostics_with_violation_rate(results, diag)
