# -*- coding: utf-8 -*-
"""B3 Phase 2 (experiment only): coarse-grained section alignment for long recordings.

This is a STANDALONE, falsifiable experiment. It does NOT touch the production
content-alignment module, scan-piece-segments.py, the analyzer, or the teacher
backend. Its job is to test ONE hypothesis on real long recordings before any
"coarse-locate then refine" implementation is attempted:

  The piecewise top-k + monotonic-DP alignment fails on long recordings because the
  score's sections are too SHORT and similar -- their chroma templates are not
  distinctive enough, so the true window is rarely in the cheap top-k candidates and
  the DP falls back to a scattered greedy pick. Merging fine sections into COARSER
  units (longer, more distinctive templates) should let a monotonic path exist.

What it does
------------
  1. Load a score (by id) + its real recording.
  2. Drop sections with an empty erhu template (accompaniment-only / no melody).
  3. Group the remaining fine sections into COARSE units (fixed chunk of N
     consecutive sections, or adaptive: merge until the unit template reaches
     --min-frames). Each unit's template is the concatenation of its members'
     erhu-only chroma templates (so per-section tempo is preserved).
  4. Locate each coarse unit by subsequence DTW top-k + the SAME monotonic DP
     (content_alignment.choose_monotonic_path) the production path uses, so the
     diagnostics (greedyFallbackCount / monotonicViolationRate) are comparable.
  5. Emit metrics + a human spot-check list (per unit: member sections, score pages,
     measure range, audio window) to JSON and stdout.

It reuses the production content_alignment module and scan-piece-segments'
section_to_alignment_dict so the experiment exercises the real feature/template code.

Run:
  python-service/.venv/Scripts/python.exe \
    scripts/experiments/align-piece-coarse-sections-experiment.py \
    --score-id score-... --audio data/real-tests/originals/second-rhapsody-full.mp3 \
    --chunk-size 6
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "lib"))
import content_alignment as ca  # noqa: E402

try:
    import librosa  # noqa: F401
    import soundfile as sf
except Exception as exc:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"audio libs unavailable: {exc}"}))
    sys.exit(1)

# Reuse the production section->alignment-dict mapping (erhu-role filtering etc.) so
# the experiment builds templates exactly like the scan pipeline does.
_scan_spec = importlib.util.spec_from_file_location("scanmod", str(REPO_ROOT / "scripts" / "scan-piece-segments.py"))
scan = importlib.util.module_from_spec(_scan_spec)
sys.modules["scanmod"] = scan
_scan_spec.loader.exec_module(scan)

SR, HOP = ca.DEFAULT_SR, ca.DEFAULT_HOP
HOP_SECONDS = HOP / SR


def load_ordered_sections(score_id: str) -> list[dict]:
    store = json.loads((REPO_ROOT / "data" / "erhu-score-imports.json").read_text(encoding="utf-8"))
    score = next((s for s in store.get("scores", []) if s.get("scoreId") == score_id), None)
    if score is None:
        raise SystemExit(f"score not found: {score_id}")
    sections = [s for s in (score.get("sections") or []) if s.get("notes")]
    return sorted(sections, key=lambda s: int(scan.safe_number(s.get("sequenceIndex"), 0)))


def section_page(section: dict) -> int | None:
    match = re.match(r"page-(\d+)", str(section.get("sectionId", "")))
    if match:
        return int(match.group(1))
    notes = section.get("notes") or []
    if notes:
        page = (notes[0].get("notePosition") or {}).get("pageNumber")
        if page is not None:
            return int(scan.safe_number(page, 0))
    return None


def section_measure_range(section: dict) -> tuple[int, int] | None:
    measures = [int(scan.safe_number(n.get("measureIndex"), 0)) for n in (section.get("notes") or [])]
    measures = [m for m in measures if m > 0]
    return (min(measures), max(measures)) if measures else None


def build_units(sections: list[dict], chunk_size: int, min_frames: int):
    """Return a list of coarse units, each {sections, alignmentDicts, template}.
    Sections with an empty erhu template are dropped (not content-locatable)."""
    locatable = []
    for section in sections:
        alignment = scan.section_to_alignment_dict(section)
        template = ca.section_template_chroma(alignment, HOP_SECONDS)
        if not template.any():
            continue
        locatable.append((section, alignment, template))

    groups: list[list[tuple]] = []
    if chunk_size and chunk_size > 0:
        for index in range(0, len(locatable), chunk_size):
            groups.append(locatable[index:index + chunk_size])
    else:
        current: list[tuple] = []
        current_frames = 0
        for entry in locatable:
            current.append(entry)
            current_frames += entry[2].shape[1]
            if current_frames >= min_frames:
                groups.append(current)
                current, current_frames = [], 0
        if current:
            if groups:
                groups[-1].extend(current)  # attach a short tail to the last unit
            else:
                groups.append(current)

    units = []
    for group in groups:
        template = np.concatenate([entry[2] for entry in group], axis=1)
        units.append({
            "sections": [entry[0] for entry in group],
            "alignmentDicts": [entry[1] for entry in group],
            "template": template,
        })
    return units, len(locatable)


def topk_for_template(template: np.ndarray, chroma: np.ndarray, top_k: int) -> list[dict]:
    cands = ca.topk_candidates(template, chroma, HOP_SECONDS, top_k)
    return cands or [{"start": 0.0, "end": HOP_SECONDS, "cost": float("inf")}]


def run(score_id: str, audio_rel: str, chunk_size: int, min_frames: int,
        top_k: int, span_penalty: float) -> dict:
    sections = load_ordered_sections(score_id)
    units, fine_count = build_units(sections, chunk_size, min_frames)

    audio_path = (REPO_ROOT / audio_rel).resolve()
    waveform, sample_rate = sf.read(str(audio_path), dtype="float32")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    if sample_rate != SR:
        waveform = librosa.resample(waveform, orig_sr=sample_rate, target_sr=SR)
    audio_duration = len(waveform) / SR
    chroma = ca.whole_audio_chroma(waveform)

    slot_candidates = [topk_for_template(unit["template"], chroma, top_k) for unit in units]
    path, diag = ca.choose_monotonic_path(slot_candidates, HOP_SECONDS, span_penalty=span_penalty)

    starts = [p["start"] for p in path]
    ends = [p["end"] for p in path]
    # choose_monotonic_path returns only greedyFallbackCount/monotonicFeasible; the
    # empirical violation rate is computed here from the chosen window order.
    transitions = max(1, len(starts) - 1)
    monotonic_violations = sum(1 for i in range(len(starts) - 1) if starts[i] > starts[i + 1] + 1e-6)
    monotonic_violation_rate = round(monotonic_violations / transitions, 4)
    aligned_span = round(max(ends) - min(starts), 2) if path else 0.0
    expected_span = round(sum(unit["template"].shape[1] * HOP_SECONDS for unit in units), 2)
    aligned_span_ratio = round(aligned_span / expected_span, 3) if expected_span > 0 else None

    unit_reports = []
    for index, (unit, chosen) in enumerate(zip(units, path)):
        members = unit["sections"]
        pages = sorted({p for p in (section_page(s) for s in members) if p is not None})
        measure_lo = measure_hi = None
        for section in members:
            rng = section_measure_range(section)
            if rng:
                measure_lo = rng[0] if measure_lo is None else min(measure_lo, rng[0])
                measure_hi = rng[1] if measure_hi is None else max(measure_hi, rng[1])
        unit_reports.append({
            "unitIndex": index,
            "memberSectionIds": [s.get("sectionId") for s in members],
            "memberCount": len(members),
            "scorePages": pages,
            "measureRange": [measure_lo, measure_hi] if measure_lo is not None else None,
            "templateFrames": int(unit["template"].shape[1]),
            "startSeconds": round(float(chosen["start"]), 2),
            "endSeconds": round(float(chosen["end"]), 2),
            "durationSeconds": round(float(chosen["end"]) - float(chosen["start"]), 2),
            "cost": round(float(chosen["cost"]), 3),
        })

    return {
        "ok": True,
        "scoreId": score_id,
        "audio": str(audio_path),
        "audioDurationSeconds": round(audio_duration, 1),
        "groupMode": f"chunk:{chunk_size}" if chunk_size and chunk_size > 0 else f"adaptive:{min_frames}",
        "fineSectionCount": fine_count,
        "coarseUnitCount": len(units),
        "topK": top_k,
        "spanPenalty": span_penalty,
        "metrics": {
            "greedyFallbackCount": diag["greedyFallbackCount"],
            "slotCount": diag["slotCount"],
            "monotonicFeasible": diag["monotonicFeasible"],
            "monotonicViolations": monotonic_violations,
            "monotonicViolationRate": monotonic_violation_rate,
            "alignedSpanDurationSeconds": aligned_span,
            "expectedAlignedSpanDurationSeconds": expected_span,
            "alignedSpanRatio": aligned_span_ratio,
        },
        "spotCheck": unit_reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Coarse-grained section alignment experiment (no production change).")
    parser.add_argument("--score-id", required=True, help="scoreId in data/erhu-score-imports.json")
    parser.add_argument("--audio", required=True, help="Recording path (relative to repo root).")
    parser.add_argument("--chunk-size", type=int, default=6,
                        help="Fixed number of consecutive sections per coarse unit (default 6). 0 -> adaptive.")
    parser.add_argument("--min-frames", type=int, default=600,
                        help="Adaptive mode (chunk-size 0): merge sections until the unit template reaches this many chroma frames (~%.2fs each)." % HOP_SECONDS)
    parser.add_argument("--top-k", type=int, default=ca.DEFAULT_TOP_K)
    parser.add_argument("--span-penalty", type=float, default=ca.DEFAULT_SPAN_PENALTY)
    parser.add_argument("--out", default="", help="Optional explicit output JSON path.")
    args = parser.parse_args()

    report = run(args.score_id, args.audio, args.chunk_size, args.min_frames, args.top_k, args.span_penalty)

    out_dir = REPO_ROOT / "data" / "experiments" / "content-alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    mode_tag = report["groupMode"].replace(":", "")
    out_path = Path(args.out) if args.out else out_dir / f"coarse-alignment-{args.score_id}-{mode_tag}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    m = report["metrics"]
    print(f"score={report['scoreId']} fine={report['fineSectionCount']} mode={report['groupMode']} "
          f"coarseUnits={report['coarseUnitCount']} audio={report['audioDurationSeconds']}s")
    print(f"  greedyFallback={m['greedyFallbackCount']}/{m['slotCount']} feasible={m['monotonicFeasible']} "
          f"violations={m['monotonicViolations']}/{max(1, m['slotCount']-1)} rate={m['monotonicViolationRate']} "
          f"alignedSpanRatio={m['alignedSpanRatio']}")
    print("  spot-check (listen at each window vs the score page/measures):")
    for unit in report["spotCheck"]:
        pages = ",".join(str(p) for p in unit["scorePages"]) or "?"
        mr = unit["measureRange"]
        mrs = f"m{mr[0]}-{mr[1]}" if mr else "m?"
        print(f"    unit{unit['unitIndex']:>2} ({unit['memberCount']}sec, pages {pages}, {mrs}) "
              f"-> {unit['startSeconds']:.1f}-{unit['endSeconds']:.1f}s cost={unit['cost']:.3f}")
    print(f"  wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
