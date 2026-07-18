#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Frozen duration/extra quantization contract (v1), consumed on three domains.

The diagnosis gate keeps duration (drag/时值) and extra (多余音) as
review-only categories. Until now they had no frozen measurement contract:
no unit, no tolerance, no unsafe definition, no seed aggregation rule. This
evaluator freezes that contract and consumes it against

  1. the waveform-injected r2 sets (v1 and v2 variants, 2 pieces x 3 seeds),
  2. the owner-confirmed round-3 real-error takes (r3-04/r3-05), and
  3. the natural clean student-domain takes (r2-01, r2-08, r3-01..r3-03),

so the review lanes have a stable measurement to build on later.

Frozen contract (western-duration-extra-quantization-v1):

  units      timing: relativeIoiDeviationRatio (dimensionless, local-tempo
             relative; identical primitive to the frozen shadow gate);
             duration: eventDurationRatio (observed/expected note length);
             extra: count of unassigned same-pitch audio events within
             +/-3.0 s of the reference row (the r3 verification window).
  tolerance  timingDeviationRatioLimit = 0.15 (the already-frozen shadow
             deviationLimit; nothing new is tuned here);
             extra detection = unmatchedSamePitchNearby >= 1.
  unsafe     drag: target row AND its successor both selected by the frozen
             6-guard shadow (the timing error is completely invisible);
             extra: both adjacent rows selected AND no unmatched same-pitch
             event (the inserted note is completely invisible).
  seeds      per (piece, seed) rows plus pooled sums; the worst seed is
             reported explicitly so pooling cannot hide a bad seed.

preGateOnly: duration/extra stay review-only; this report must NOT alone
open any student-facing behavior.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_injected_errors_dynamic_gate import (  # noqa: E402
    CACHE,
    EVENT_FILTER,
    FROZEN_POLICY,
    INJECT_DIR,
    PRIVATE,
    build_rows,
    dynamic_selected,
    score_notes,
)
from eval_western_strings_m0_bach10 import basic_pitch_events  # noqa: E402
from eval_western_bach_violin_basic_pitch_transcription import filter_events  # noqa: E402
from run_western_strings_offline_feature_analysis import assign_basic_pitch_events  # noqa: E402

CONTRACT_VERSION = "western-duration-extra-quantization-v1"
TIMING_DEVIATION_RATIO_LIMIT = FROZEN_POLICY["deviationLimit"]  # 0.15, frozen
MIN_EVENT_DURATION_RATIO = 0.15  # frozen shadow guard (sweep-selected)
EXTRA_SAME_PITCH_WINDOW_SECONDS = 3.0  # r3 verification window, owner-confirmed

ROUND3 = REPO / "data" / "private" / "western-strings-round3"
R3_TRUTH = REPO / "data" / "experiments" / "western-strings-round3-real-errors" / "report.json"
OUT_DIR = REPO / "data" / "experiments" / "western-strings-duration-extra-quantization"

V1_SETS = [f"{piece}-injected-{seed}" for piece in ("r2-01", "r2-08")
           for seed in (20260717, 20260718, 20260719)]
V2_SETS = [f"{piece}-injected-v2-{seed}" for piece in ("r2-01", "r2-08")
           for seed in (20260717, 20260718, 20260719)]
NATURAL_TAKES = [
    ("r2-01", PRIVATE / "r2-01.musicxml", PRIVATE / "r2-01.m4a"),
    ("r2-08", PRIVATE / "r2-08.musicxml", PRIVATE / "r2-08.m4a"),
    ("r3-01", ROUND3 / "r3-01.musicxml", ROUND3 / "r3-01.m4a"),
    ("r3-02", ROUND3 / "r3-02.musicxml", ROUND3 / "r3-02.m4a"),
    ("r3-03", ROUND3 / "r3-03.musicxml", ROUND3 / "r3-03.m4a"),
]


def shadow_selected(row: dict) -> bool:
    """Production 6-guard shadow: frozen 5-guard policy + duration-ratio floor."""
    if not dynamic_selected(row):
        return False
    ratio = row.get("eventDurationRatio")
    return ratio is not None and float(ratio) >= MIN_EVENT_DURATION_RATIO


def analyze_take(gold: Path, audio: Path) -> dict:
    notes = score_notes(gold)
    events = filter_events(basic_pitch_events(audio, CACHE),
                           EVENT_FILTER["minConfidence"], EVENT_FILTER["minDurationSeconds"])
    rows = build_rows(notes, events)
    for row in rows:
        row["selected"] = shadow_selected(row)
    assignments = assign_basic_pitch_events(notes, events)
    matched = {assignment["eventIndex"] for assignment in assignments if assignment}
    unassigned = [event for index, event in enumerate(events) if index not in matched]
    return {"notes": notes, "rows": rows, "events": events, "unassigned": unassigned}


def timing_visible(row: dict) -> bool:
    deviation = row.get("relativeIoiDeviationRatio")
    return deviation is not None and float(deviation) > TIMING_DEVIATION_RATIO_LIMIT


def unmatched_same_pitch_nearby(take: dict, index: int) -> int:
    row = take["rows"][index]
    base_time = row.get("predictedTime")
    midi = take["notes"][index]["midi"]
    if base_time is None:
        return sum(1 for event in take["unassigned"] if int(event["midi"]) == midi)
    return sum(1 for event in take["unassigned"]
               if int(event["midi"]) == midi
               and abs(float(event["start"]) - float(base_time)) <= EXTRA_SAME_PITCH_WINDOW_SECONDS)


def drag_metrics(take: dict, index: int, injected: set[int]) -> dict:
    rows = take["rows"]
    successor = index + 1 if index + 1 < len(rows) and index + 1 not in injected else None
    target_selected = bool(rows[index]["selected"])
    successor_selected = bool(rows[successor]["selected"]) if successor is not None else None
    detected = timing_visible(rows[index]) or (
        successor is not None and timing_visible(rows[successor])
    ) or not target_selected or (successor is not None and not successor_selected)
    unsafe = target_selected and (successor is None or successor_selected)
    return {
        "targetSelected": target_selected,
        "successorIndex": successor,
        "successorSelected": successor_selected,
        "targetDeviationRatio": rows[index].get("relativeIoiDeviationRatio"),
        "successorDeviationRatio": rows[successor].get("relativeIoiDeviationRatio") if successor is not None else None,
        "eventDurationRatio": rows[index].get("eventDurationRatio"),
        "timingVisible": detected,
        "unsafeInvisible": unsafe,
    }


def extra_metrics(take: dict, index: int) -> dict:
    rows = take["rows"]
    neighbor = index + 1 if index + 1 < len(rows) else index - 1
    nearby = unmatched_same_pitch_nearby(take, index)
    row_selected = bool(rows[index]["selected"])
    neighbor_selected = bool(rows[neighbor]["selected"]) if 0 <= neighbor < len(rows) else None
    detected = nearby >= 1 or not row_selected or (neighbor_selected is not None and not neighbor_selected)
    unsafe = nearby == 0 and row_selected and (neighbor_selected is None or neighbor_selected)
    return {
        "rowSelected": row_selected,
        "neighborIndex": neighbor,
        "neighborSelected": neighbor_selected,
        "unmatchedSamePitchNearby": nearby,
        "extraVisible": detected,
        "unsafeInvisible": unsafe,
    }


def evaluate_injected_set(name: str) -> dict:
    piece = name.split("-injected")[0]
    labels = json.loads((INJECT_DIR / f"{name}.labels.json").read_text(encoding="utf-8"))
    take = analyze_take(PRIVATE / f"{piece}.musicxml", INJECT_DIR / f"{name}.wav")
    injected = {int(item["scoreEventIndex"]) for item in labels["injections"]}
    entries = []
    for item in labels["injections"]:
        index = int(item["scoreEventIndex"])
        kind = item["type"]
        entry = {"scoreEventIndex": index, "type": kind}
        if kind == "drag":
            entry.update(drag_metrics(take, index, injected))
        elif kind == "extra":
            entry.update(extra_metrics(take, index))
        else:  # wrong/missing: hard categories, leak tally only
            entry["selected"] = bool(take["rows"][index]["selected"])
        entries.append(entry)
    seed = int(labels["seed"])
    variant = "v2" if "-v2-" in name else "v1"
    return {"set": name, "piece": piece, "seed": seed, "variant": variant,
            "entries": entries}


def pool(sets: list[dict]) -> dict:
    def tally(kind: str, flag: str):
        rows = [entry for item in sets for entry in item["entries"] if entry["type"] == kind]
        return {"targets": len(rows), flag: sum(1 for row in rows if row.get(flag))}
    per_seed = []
    for item in sets:
        drags = [entry for entry in item["entries"] if entry["type"] == "drag"]
        extras = [entry for entry in item["entries"] if entry["type"] == "extra"]
        per_seed.append({
            "set": item["set"],
            "dragTargets": len(drags),
            "dragUnsafeInvisible": sum(1 for entry in drags if entry["unsafeInvisible"]),
            "dragTimingVisible": sum(1 for entry in drags if entry["timingVisible"]),
            "extraTargets": len(extras),
            "extraUnsafeInvisible": sum(1 for entry in extras if entry["unsafeInvisible"]),
            "extraVisible": sum(1 for entry in extras if entry["extraVisible"]),
            "hardSelected": sum(1 for entry in item["entries"]
                                if entry["type"] in ("wrong", "missing") and entry.get("selected")),
        })
    return {
        "perSeed": per_seed,
        "drag": {**tally("drag", "unsafeInvisible"),
                 "timingVisible": sum(row["dragTimingVisible"] for row in per_seed)},
        "extra": {**tally("extra", "unsafeInvisible"),
                  "extraVisible": sum(row["extraVisible"] for row in per_seed)},
        "hardSelected": sum(row["hardSelected"] for row in per_seed),
        "worstSeedDragUnsafe": max((row["dragUnsafeInvisible"] for row in per_seed), default=0),
        "worstSeedExtraUnsafe": max((row["extraUnsafeInvisible"] for row in per_seed), default=0),
    }


def evaluate_r3_real() -> dict:
    truth = json.loads(R3_TRUTH.read_text(encoding="utf-8"))
    takes_out = []
    for take_truth in truth["takes"]:
        name = take_truth["take"]
        take = analyze_take(ROUND3 / f"{name}.musicxml", ROUND3 / f"{name}.m4a")
        performed = [entry for entry in take_truth["entries"]
                     if entry.get("verified") and "not-performed" not in str(entry.get("asPerformed", ""))]
        injected = {int(entry["scoreEventIndex"]) for entry in performed}
        entries = []
        for entry in performed:
            index = int(entry["scoreEventIndex"])
            kind = entry["type"]
            row = {"scoreEventIndex": index, "type": kind,
                   "checklistNumber": entry["checklistNumber"]}
            if kind == "drag":
                row.update(drag_metrics(take, index, injected))
            elif kind == "extra":
                row.update(extra_metrics(take, index))
            else:
                row["selected"] = bool(take["rows"][index]["selected"])
            entries.append(row)
        takes_out.append({"set": name, "piece": name, "seed": 0, "variant": "real",
                          "entries": entries})
    return {"takes": takes_out, "pooled": pool(takes_out)}


def evaluate_natural() -> dict:
    takes = []
    for name, gold, audio in NATURAL_TAKES:
        take = analyze_take(gold, audio)
        rows = take["rows"]
        deviations = [float(row["relativeIoiDeviationRatio"]) for row in rows
                      if row.get("relativeIoiDeviationRatio") is not None]
        ratios = [float(row["eventDurationRatio"]) for row in rows
                  if row.get("eventDurationRatio") is not None]
        flagged = sum(1 for row in rows if timing_visible(row))
        score_midis = {note["midi"] for note in take["notes"]}
        stray_same_pitch = sum(1 for event in take["unassigned"] if int(event["midi"]) in score_midis)
        takes.append({
            "take": name,
            "rows": len(rows),
            "selected": sum(1 for row in rows if row["selected"]),
            "coverage": round(sum(1 for row in rows if row["selected"]) / len(rows), 4),
            "timingFlaggedRows": flagged,
            "timingFlagRate": round(flagged / len(rows), 4),
            "deviationP50": round(statistics.median(deviations), 4) if deviations else None,
            "deviationP90": round(sorted(deviations)[int(0.9 * (len(deviations) - 1))], 4) if deviations else None,
            "durationRatioP50": round(statistics.median(ratios), 4) if ratios else None,
            "unassignedEvents": len(take["unassigned"]),
            "unassignedSamePitchEvents": stray_same_pitch,
            "extraFlagBurdenPerRow": round(stray_same_pitch / len(rows), 4),
        })
    return {
        "takes": takes,
        "meanTimingFlagRate": round(statistics.fmean(t["timingFlagRate"] for t in takes), 4),
        "meanExtraFlagBurdenPerRow": round(statistics.fmean(t["extraFlagBurdenPerRow"] for t in takes), 4),
        "meanCoverage": round(statistics.fmean(t["coverage"] for t in takes), 4),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-natural", action="store_true")
    args = parser.parse_args(argv)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    v1 = [evaluate_injected_set(name) for name in V1_SETS]
    v2 = [evaluate_injected_set(name) for name in V2_SETS]
    r3 = evaluate_r3_real()
    natural = None if args.skip_natural else evaluate_natural()

    report = {
        "evalOnly": True,
        "preGateOnly": True,
        "studentGateReady": False,
        "reviewOnlyCategories": ["duration", "extra"],
        "note": "frozen duration/extra quantization; review-only evidence that must "
                "NOT alone open any student-facing behavior (house rules)",
        "contract": {
            "contractVersion": CONTRACT_VERSION,
            "units": {
                "timing": "relativeIoiDeviationRatio (dimensionless, local-tempo relative)",
                "duration": "eventDurationRatio (observed/expected note length)",
                "extra": f"unassigned same-pitch audio events within +/-{EXTRA_SAME_PITCH_WINDOW_SECONDS}s",
            },
            "tolerances": {
                "timingDeviationRatioLimit": TIMING_DEVIATION_RATIO_LIMIT,
                "minEventDurationRatio": MIN_EVENT_DURATION_RATIO,
                "extraSamePitchWindowSeconds": EXTRA_SAME_PITCH_WINDOW_SECONDS,
                "provenance": "deviation/duration limits reuse the frozen shadow policy; "
                              "the extra window reuses the owner-confirmed r3 verification "
                              "convention; nothing is newly tuned here",
            },
            "unsafeDefinition": {
                "drag": "target and successor rows both shadow-selected (timing error invisible)",
                "extra": "adjacent rows shadow-selected and no unmatched same-pitch event (insertion invisible)",
            },
            "seedAggregation": "per (piece, seed) rows + pooled sums + explicit worst seed",
            "shadowPolicy": {**FROZEN_POLICY, "minEventDurationRatio": MIN_EVENT_DURATION_RATIO},
        },
        "injectedV1": {"sets": v1, "pooled": pool(v1)},
        "injectedV2": {"sets": v2, "pooled": pool(v2)},
        "r3RealErrors": r3,
        "naturalStudentDomain": natural,
    }
    (OUT_DIR / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                         encoding="utf-8")

    def fmt_pool(label: str, pooled: dict) -> list[str]:
        return [
            f"## {label}",
            "",
            f"- drag: targets {pooled['drag']['targets']}, unsafe-invisible "
            f"{pooled['drag']['unsafeInvisible']}, timing-visible {pooled['drag']['timingVisible']}",
            f"- extra: targets {pooled['extra']['targets']}, unsafe-invisible "
            f"{pooled['extra']['unsafeInvisible']}, visible {pooled['extra']['extraVisible']}",
            f"- hard (wrong/missing) selected: {pooled['hardSelected']}",
            f"- worst seed: drag unsafe {pooled['worstSeedDragUnsafe']}, "
            f"extra unsafe {pooled['worstSeedExtraUnsafe']}",
            "",
        ]

    lines = [
        "# Duration/Extra Quantization (frozen v1)",
        "",
        f"Contract: {CONTRACT_VERSION} (review-only; preGateOnly)",
        "",
        *fmt_pool("Injected v1 (6 sets)", report["injectedV1"]["pooled"]),
        *fmt_pool("Injected v2 (6 sets)", report["injectedV2"]["pooled"]),
        *fmt_pool("Round-3 real errors (owner-confirmed)", r3["pooled"]),
    ]
    if natural:
        lines += [
            "## Natural student domain (clean takes)",
            "",
            f"- mean clean coverage: {natural['meanCoverage']}",
            f"- mean timing flag rate (deviation > {TIMING_DEVIATION_RATIO_LIMIT}): "
            f"{natural['meanTimingFlagRate']}",
            f"- mean extra flag burden per row: {natural['meanExtraFlagBurdenPerRow']}",
            "",
        ]
    (OUT_DIR / "report.md").write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps({
        "injectedV1": report["injectedV1"]["pooled"] | {"perSeed": "..."},
        "injectedV2": report["injectedV2"]["pooled"] | {"perSeed": "..."},
        "r3Real": r3["pooled"] | {"perSeed": "..."},
        "natural": ({k: natural[k] for k in ("meanCoverage", "meanTimingFlagRate",
                                             "meanExtraFlagBurdenPerRow")} if natural else None),
        "out": str((OUT_DIR / "report.json").relative_to(REPO)),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
