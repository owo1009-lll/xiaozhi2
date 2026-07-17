#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pre-gate exam: frozen dynamic-gate policy vs injected student-domain errors.

Runs the ordinary-upload executor's DYNAMIC gate (one-to-one gap-penalty pitch
DP + relative-IOI deviation + confidence/duration/same-pitch-isolation guards;
policy frozen by the 2026-07-16 three-stage public confirmation at
deviation<=0.15, eventConf>=0.4, relConf>=0.8, dur>=0.08s, samePitch>=0.5q)
on the six waveform-injected r2 recordings plus the two clean takes, scoring
against the exact injection labels by scoreEventIndex.

Why this exam exists (owner ask: optimize the executor toward usable): the
Bach research gate proved 97.91%/36.00% on public professional recordings
with synthetic perturbations; its blocking caveats are estimated reference
times and synthetic-only errors. The injection sets attack the domain half of
the second caveat: REAL student-domain recordings (owner-played violin, real
room/mic) with exact per-note injected-error ground truth. preGateOnly per
house rules: this evidence must NOT alone open the student runtime.

The energy-veto stage is intentionally excluded: in the Bach evaluation the
core error scenarios (missing/wrong-pitch/late-onset) were gated by the
dynamic stage alone, and the energy models' dB baselines / anchor times do
not transfer untested across recording domains.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

import proto_western_strings_score_anchored_feedback as anchor  # noqa: E402
from run_western_strings_offline_feature_analysis import (  # noqa: E402
    assign_basic_pitch_events,
    compute_relative_ioi_features,
)
from eval_western_strings_m0_bach10 import basic_pitch_events  # noqa: E402
from eval_western_bach_violin_basic_pitch_transcription import filter_events  # noqa: E402

# authoritative source: data/experiments/western-strings-m3/
#   dynamic-weak-combined-gate-confirmation/report.json selectedPolicy
FROZEN_POLICY = {
    "deviationLimit": 0.15,
    "minEventConfidence": 0.4,
    "minRelativeEventConfidence": 0.8,
    "minEventDurationSeconds": 0.08,
    "minSamePitchScoreDistanceQuarters": 0.5,
}
EVENT_FILTER = {"minConfidence": 0.38, "minDurationSeconds": 0.08}

INJECT_DIR = REPO / "data" / "experiments" / "western-strings-injected-errors"
PRIVATE = REPO / "data" / "private" / "western-strings-round2"
OUT_DIR = INJECT_DIR / "dynamic-gate-preexam"
CACHE = OUT_DIR / "basic-pitch-cache"

SETS = [f"{piece}-injected-{seed}" for piece in ("r2-01", "r2-08")
        for seed in (20260717, 20260718, 20260719)]


def score_notes(gold: Path) -> list[dict]:
    """Flattened single-voice note list with quarter offsets; index-isomorphic
    to anchor.mxl_events (the injection labels' scoreEventIndex space)."""
    from music21 import converter
    stream = converter.parse(str(gold))
    notes = []
    for n in stream.flatten().notes:
        midis = sorted(int(p.midi) for p in n.pitches)
        notes.append({"midi": midis[0], "midis": midis,
                      "scoreUnit": float(n.offset), "scoreOnsetUnit": float(n.offset)})
    events = anchor.mxl_events(gold)
    if len(events) != len(notes):
        raise SystemExit(f"isomorphism-broken:count {len(events)} != {len(notes)} for {gold}")
    for index, (event, note) in enumerate(zip(events, notes)):
        if sorted(event["midis"]) != note["midis"]:
            raise SystemExit(f"isomorphism-broken:midi at {index} for {gold}")
    return notes


def same_pitch_distances(notes: list[dict]) -> list[float | None]:
    by_pitch: dict[int, list[tuple[float, int]]] = {}
    for index, note in enumerate(notes):
        by_pitch.setdefault(note["midi"], []).append((note["scoreUnit"], index))
    out: list[float | None] = [None] * len(notes)
    for positions in by_pitch.values():
        positions.sort()
        for k, (score_time, index) in enumerate(positions):
            distances = []
            if k > 0:
                distances.append(score_time - positions[k - 1][0])
            if k + 1 < len(positions):
                distances.append(positions[k + 1][0] - score_time)
            out[index] = min(distances) if distances else None
    return out


def build_rows(notes: list[dict], events: list[dict]) -> list[dict]:
    assignments = assign_basic_pitch_events(notes, events)
    ioi = compute_relative_ioi_features(
        notes, assignments, consistency_limit=FROZEN_POLICY["deviationLimit"])
    spd = same_pitch_distances(notes)
    # local tempo (seconds per quarter): median over adjacent aligned pairs;
    # feeds the candidate duration-ceiling guard (expected note length)
    tempo_samples = []
    for index in range(len(notes) - 1):
        left, right = assignments[index], assignments[index + 1]
        dq = notes[index + 1]["scoreUnit"] - notes[index]["scoreUnit"]
        if left is not None and right is not None and dq > 1e-6:
            dt = float(right["time"]) - float(left["time"])
            if dt > 0:
                tempo_samples.append(dt / dq)
    tempo_samples.sort()
    sec_per_quarter = tempo_samples[len(tempo_samples) // 2] if tempo_samples else None
    rows = []
    for index, (assignment, features) in enumerate(zip(assignments, ioi)):
        neighbor_confidences = [
            float(assignments[c]["confidence"])
            for c in range(max(0, index - 2), min(len(assignments), index + 3))
            if c != index and assignments[c] is not None
        ]
        neighbor_confidence = (sum(neighbor_confidences) / len(neighbor_confidences)
                               if neighbor_confidences else None)
        relative_confidence = (
            float(assignment["confidence"]) / max(0.01, neighbor_confidence)
            if assignment is not None and neighbor_confidence is not None else None)
        if index + 1 < len(notes):
            score_ioi_quarters = notes[index + 1]["scoreUnit"] - notes[index]["scoreUnit"]
        elif index > 0:
            score_ioi_quarters = notes[index]["scoreUnit"] - notes[index - 1]["scoreUnit"]
        else:
            score_ioi_quarters = None
        duration = (max(0.0, float(assignment["end"]) - float(assignment["time"]))
                    if assignment else None)
        expected_duration = (score_ioi_quarters * sec_per_quarter
                             if score_ioi_quarters and sec_per_quarter else None)
        duration_ratio = (duration / max(0.15, expected_duration)
                          if duration is not None and expected_duration else None)
        neighbor_pitch_aligned = all(
            assignments[c] is not None and assignments[c]["pitchDistanceSemitones"] == 0
            for c in (index - 1, index + 1) if 0 <= c < len(assignments)
        )
        rows.append({
            "noteIndex": index,
            "midi": notes[index]["midi"],
            "pitchDistanceSemitones": assignment.get("pitchDistanceSemitones") if assignment else None,
            "eventConfidence": round(float(assignment["confidence"]), 6) if assignment else None,
            "eventDurationSeconds": round(duration, 6) if duration is not None else None,
            "relativeIoiDeviationRatio": features.get("relativeIoiDeviationRatio"),
            "relativeEventConfidence": round(relative_confidence, 6) if relative_confidence is not None else None,
            "nearestSamePitchScoreDistanceQuarters": spd[index],
            "predictedTime": round(float(assignment["time"]), 6) if assignment else None,
            "expectedDurationSeconds": round(expected_duration, 6) if expected_duration else None,
            "eventDurationRatio": round(duration_ratio, 6) if duration_ratio is not None else None,
            "neighborPitchAligned": neighbor_pitch_aligned,
        })
    return rows


def dynamic_selected(row: dict, policy: dict = FROZEN_POLICY) -> bool:
    """Mirrors eval_western_strings_combined_dynamic_weak_gate.dynamic_selected."""
    if row["pitchDistanceSemitones"] != 0:
        return False
    if row["eventConfidence"] is None or row["eventConfidence"] < policy["minEventConfidence"]:
        return False
    deviation = row["relativeIoiDeviationRatio"]
    if deviation is None or float(deviation) > policy["deviationLimit"]:
        return False
    if row["eventDurationSeconds"] is None \
            or row["eventDurationSeconds"] < policy["minEventDurationSeconds"]:
        return False
    same_pitch = row["nearestSamePitchScoreDistanceQuarters"]
    if same_pitch is not None and same_pitch < policy["minSamePitchScoreDistanceQuarters"]:
        return False
    relative = row["relativeEventConfidence"]
    if relative is None or relative < policy["minRelativeEventConfidence"]:
        return False
    return True


FEATURE_KEYS = ("pitchDistanceSemitones", "eventConfidence", "relativeIoiDeviationRatio",
                "relativeEventConfidence", "eventDurationSeconds",
                "nearestSamePitchScoreDistanceQuarters")


def evaluate_take(name: str, gold: Path, wav: Path, labels: dict | None) -> dict:
    notes = score_notes(gold)
    events = filter_events(basic_pitch_events(wav, CACHE),
                           EVENT_FILTER["minConfidence"], EVENT_FILTER["minDurationSeconds"])
    rows = build_rows(notes, events)
    for row in rows:
        row["selected"] = dynamic_selected(row)
    selected = sum(1 for row in rows if row["selected"])
    result = {"take": name, "wav": str(wav.relative_to(REPO)), "notes": len(notes),
              "audioEvents": len(events), "selected": selected,
              "coverage": round(selected / len(notes), 4)}
    if labels is not None:
        injections = {int(item["scoreEventIndex"]): item for item in labels["injections"]}
        per_type: dict[str, dict] = {}
        details = []
        for index, item in sorted(injections.items()):
            row = rows[index]
            bucket = per_type.setdefault(item["type"], {"targets": 0, "selected": 0})
            bucket["targets"] += 1
            bucket["selected"] += int(row["selected"])
            details.append({"noteIndex": index, "type": item["type"],
                            "expectedVerdict": item.get("expectedVerdict"),
                            "selected": row["selected"],
                            **{key: row[key] for key in FEATURE_KEYS}})
        drag_successor = {"targets": 0, "selected": 0}
        for index, item in injections.items():
            follower = index + 1
            if item["type"] == "drag" and follower < len(rows) and follower not in injections:
                drag_successor["targets"] += 1
                drag_successor["selected"] += int(rows[follower]["selected"])
        non_injected = [i for i in range(len(rows)) if i not in injections]
        non_injected_selected = sum(1 for i in non_injected if rows[i]["selected"])
        result.update({
            "perType": per_type,
            "dragSuccessor": drag_successor,
            "nonInjectedNotes": len(non_injected),
            "nonInjectedSelected": non_injected_selected,
            "nonInjectedCoverage": round(non_injected_selected / len(non_injected), 4),
            "targetDetails": details,
        })
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sets", nargs="+", default=SETS)
    parser.add_argument("--skip-clean", action="store_true")
    args = parser.parse_args(argv)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    takes = []
    if not args.skip_clean:
        for piece in ("r2-01", "r2-08"):
            takes.append(evaluate_take(f"{piece}-clean", PRIVATE / f"{piece}.musicxml",
                                       PRIVATE / f"{piece}.m4a", None))
            print(json.dumps({k: takes[-1][k] for k in ("take", "notes", "selected", "coverage")}))
    for name in args.sets:
        piece = name.split("-injected-")[0]
        labels = json.loads((INJECT_DIR / f"{name}.labels.json").read_text(encoding="utf-8"))
        takes.append(evaluate_take(name, PRIVATE / f"{piece}.musicxml",
                                   INJECT_DIR / f"{name}.wav", labels))
        print(json.dumps({k: takes[-1][k] for k in
                          ("take", "coverage", "nonInjectedCoverage", "perType", "dragSuccessor")},
                         ensure_ascii=False))

    injected = [t for t in takes if "perType" in t]
    def type_total(kind, field):
        return sum(t["perType"].get(kind, {}).get(field, 0) for t in injected)
    aggregate = {
        "cleanCoverage": {t["take"]: t["coverage"] for t in takes if "perType" not in t},
        "meanNonInjectedCoverage": (round(sum(t["nonInjectedCoverage"] for t in injected)
                                          / len(injected), 4) if injected else None),
        "byType": {kind: {"targets": type_total(kind, "targets"),
                          "selected": type_total(kind, "selected")}
                   for kind in ("wrong", "missing", "extra", "drag")},
        "dragSuccessor": {"targets": sum(t["dragSuccessor"]["targets"] for t in injected),
                          "selected": sum(t["dragSuccessor"]["selected"] for t in injected)},
    }
    aggregate["hardUnsafeAutoPass"] = (aggregate["byType"]["wrong"]["selected"]
                                       + aggregate["byType"]["missing"]["selected"])
    report = {
        "evalOnly": True,
        "preGateOnly": True,
        "studentGateReady": False,
        "note": "synthetic-injection pre-exam on real student-domain recordings; "
                "must NOT alone open the student runtime (house rules)",
        "policy": FROZEN_POLICY,
        "policySource": "data/experiments/western-strings-m3/dynamic-weak-combined-gate-confirmation/report.json",
        "eventFilter": EVENT_FILTER,
        "energyVetoIncluded": False,
        "takes": takes,
        "aggregate": aggregate,
    }
    (OUT_DIR / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                         encoding="utf-8")
    print(json.dumps({"aggregate": aggregate, "out": str((OUT_DIR / 'report.json').relative_to(REPO))},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
