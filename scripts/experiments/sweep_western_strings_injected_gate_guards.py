#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Guard sweep for the dynamic gate on the injected-error pre-exam.

The baseline frozen policy leaked 12 injected targets (5 hard wrong/missing)
on real student-domain recordings; the shared leak signature is same-pitch
audio borrowed at plausible times, usually with an event duration far beyond
the score note length. This sweep quantifies candidate guards ON TOP of the
frozen policy:

  durationCeiling  eventDurationRatio <= K        (K in 1.4 / 1.6 / 2.0 / off)
  bothNeighbor     neighborPitchAligned == True   (on / off)
  tighterDeviation relativeIoiDeviationRatio <= D (0.10 / 0.15)

Method discipline: guards are CHOSEN on the r2-01 sets (development piece)
and verified once on the r2-08 sets (held-out piece, different key/length).
preGateOnly: results calibrate the executor before fresh-blind; they must NOT
alone open the student runtime.
"""
from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_injected_errors_dynamic_gate import (  # noqa: E402
    EVENT_FILTER,
    FROZEN_POLICY,
    INJECT_DIR,
    OUT_DIR,
    PRIVATE,
    SETS,
    CACHE,
    build_rows,
    dynamic_selected,
    score_notes,
)
from eval_western_strings_m0_bach10 import basic_pitch_events  # noqa: E402
from eval_western_bach_violin_basic_pitch_transcription import filter_events  # noqa: E402

DEV_PIECE, HOLDOUT_PIECE = "r2-01", "r2-08"
V2_SETS = [f"{piece}-injected-v2-{seed}" for piece in ("r2-01", "r2-08")
           for seed in (20260717, 20260718, 20260719)]


def guarded_selected(row: dict, guards: dict) -> bool:
    if not dynamic_selected(row, FROZEN_POLICY):
        return False
    ceiling = guards.get("maxEventDurationRatio")
    if ceiling is not None:
        ratio = row.get("eventDurationRatio")
        if ratio is None or ratio > ceiling:
            return False
    floor = guards.get("minEventDurationRatio")
    if floor is not None:
        ratio = row.get("eventDurationRatio")
        if ratio is None or ratio < floor:
            return False
    if guards.get("requireNeighborPitchAligned") and not row.get("neighborPitchAligned"):
        return False
    deviation_limit = guards.get("deviationLimit")
    if deviation_limit is not None:
        deviation = row.get("relativeIoiDeviationRatio")
        if deviation is None or float(deviation) > deviation_limit:
            return False
    return True


def load_take(name: str, piece: str, wav: Path, labels_path: Path | None):
    notes = score_notes(PRIVATE / f"{piece}.musicxml")
    events = filter_events(basic_pitch_events(wav, CACHE),
                           EVENT_FILTER["minConfidence"], EVENT_FILTER["minDurationSeconds"])
    rows = build_rows(notes, events)
    labels = (json.loads(labels_path.read_text(encoding="utf-8"))
              if labels_path is not None else None)
    injected = ({int(item["scoreEventIndex"]): item["type"] for item in labels["injections"]}
                if labels else {})
    return {"name": name, "piece": piece, "rows": rows, "injected": injected}


def evaluate(takes: list[dict], guards: dict) -> dict:
    hard_unsafe = drag_selected = extra_selected = 0
    hard_targets = drag_targets = extra_targets = 0
    clean_selected = clean_notes = 0
    non_injected_selected = non_injected_notes = 0
    for take in takes:
        rows, injected = take["rows"], take["injected"]
        for row in rows:
            selected = guarded_selected(row, guards)
            kind = injected.get(row["noteIndex"])
            if kind is None:
                if injected:
                    non_injected_notes += 1
                    non_injected_selected += int(selected)
                else:
                    clean_notes += 1
                    clean_selected += int(selected)
            elif kind in ("wrong", "missing"):
                hard_targets += 1
                hard_unsafe += int(selected)
            elif kind == "drag":
                drag_targets += 1
                drag_selected += int(selected)
            else:
                extra_targets += 1
                extra_selected += int(selected)
    return {
        "hardUnsafe": hard_unsafe, "hardTargets": hard_targets,
        "dragSelected": drag_selected, "dragTargets": drag_targets,
        "extraSelected": extra_selected, "extraTargets": extra_targets,
        "cleanCoverage": round(clean_selected / clean_notes, 4) if clean_notes else None,
        "nonInjectedCoverage": (round(non_injected_selected / non_injected_notes, 4)
                                if non_injected_notes else None),
    }


def main() -> int:
    takes = {"dev": [], "holdout": []}
    for piece, bucket in ((DEV_PIECE, "dev"), (HOLDOUT_PIECE, "holdout")):
        takes[bucket].append(load_take(f"{piece}-clean", piece, PRIVATE / f"{piece}.m4a", None))
        for name in V2_SETS:
            if name.startswith(piece):
                takes[bucket].append(load_take(name, piece, INJECT_DIR / f"{name}.wav",
                                               INJECT_DIR / f"{name}.labels.json"))

    grid = []
    for floor, neighbor, deviation in itertools.product(
            (None, 0.15, 0.2, 0.25, 0.3), (False, True), (0.15, 0.10)):
        guards = {"minEventDurationRatio": floor,
                  "requireNeighborPitchAligned": neighbor,
                  "deviationLimit": deviation}
        dev = evaluate(takes["dev"], guards)
        grid.append({"guards": guards, "dev": dev})
        print(json.dumps({"guards": guards, "dev": dev}, ensure_ascii=False))

    # choose on development only: zero hard unsafe, then max clean coverage,
    # then fewest drag/extra passes
    safe = [g for g in grid if g["dev"]["hardUnsafe"] == 0]
    chosen = max(safe, key=lambda g: (g["dev"]["cleanCoverage"],
                                      -(g["dev"]["dragSelected"] + g["dev"]["extraSelected"])),
                 default=None)
    result = {"evalOnly": True, "preGateOnly": True, "studentGateReady": False,
              "basePolicy": FROZEN_POLICY, "grid": grid, "chosen": None, "holdout": None}
    if chosen is not None:
        holdout = evaluate(takes["holdout"], chosen["guards"])
        baseline_holdout = evaluate(takes["holdout"], {"deviationLimit": 0.15})
        result.update({"chosen": chosen, "holdout": holdout,
                       "holdoutBaseline": baseline_holdout})
        print(json.dumps({"chosen": chosen["guards"], "devResult": chosen["dev"],
                          "holdout": holdout, "holdoutBaseline": baseline_holdout},
                         ensure_ascii=False))
    (OUT_DIR / "guard-sweep.json").write_text(json.dumps(result, ensure_ascii=False, indent=1),
                                              encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
