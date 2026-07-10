#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fast fail-closed tests for the photo-score pipeline (pure logic, no OMR/audio)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from western_photo_score_pipeline import decide, MIN_CONFIRMED, MIN_AGREEMENT  # noqa: E402
from proto_western_strings_score_anchored_feedback import _pitch_cost, align  # noqa: E402

checks = []

def check(name, cond):
    checks.append(name)
    assert cond, f"FAILED: {name}"

# ---- decide(): machine-only layered decisions ----
ok = {"status": "ok", "variant": "up2", "confirmed": 50, "agreement": 0.9}
check("decide-full", decide([ok]) == "full-feedback:up2")
weak = {**ok, "confirmed": 5}
check("decide-degraded-low-confirmed", decide([weak]) == "degraded-feedback:up2")
lowagr = {**ok, "agreement": 0.3}
check("decide-degraded-low-agreement", decide([lowagr]) == "degraded-feedback:up2")
check("decide-retake-no-output", decide([{"status": "omr-no-output", "variant": "up2",
                                          "confirmed": 0, "agreement": 0.0}]) == "retake-photo")
check("decide-retake-zero-confirmed", decide([{**ok, "confirmed": 0}]) == "retake-photo")
best = {**ok, "variant": "up3", "confirmed": 80}
check("decide-picks-max-confirmed", decide([ok, best]) == "full-feedback:up3")
check("decide-thresholds-documented", MIN_CONFIRMED == 20 and abs(MIN_AGREEMENT - 0.6) < 1e-9)

# ---- _pitch_cost(): octave fold + chord awareness ----
check("cost-exact-zero", _pitch_cost([60], [60]) == 0.0)
check("cost-octave-half", _pitch_cost([60], [72]) == 0.5)
check("cost-wrong-semitone", _pitch_cost([60], [61]) == 1.0)
check("cost-chord-nearest", _pitch_cost([60, 67], [67]) == 0.0)

# ---- align(): substitution catches an isolated wrong note; monotonic ----
score = [{"midis": [m]} for m in [60, 62, 64, 65, 67, 69, 71, 72, 74, 76]]
audio = [{"start": i * 0.5, "midis": [m]} for i, m in enumerate([60, 62, 64, 66, 67, 69, 71, 72, 74, 76])]
match, time_pred = align(score, audio)
check("align-all-matched", all(mi is not None for mi in match))
check("align-monotonic", all(match[i] < match[i + 1] for i in range(len(match) - 1)))
check("align-substitution-kept", match[3] == 3)  # wrong note (66 vs 65) matched, not gapped
check("align-timepred-fitted", time_pred is not None and abs(time_pred[1] - time_pred[0] - 0.5) < 0.05)

# ---- fail-closed audit contract fields exist in pipeline source ----
src = (REPO / "scripts" / "western_photo_score_pipeline.py").read_text(encoding="utf-8")
for token in ("studentRuntimeTouched", "missingExtraVerdictsEmitted", "retake-photo", "degraded-feedback"):
    check(f"audit-contract-{token}", token in src)

print(json.dumps({"ok": True, "checks": checks}, ensure_ascii=False))
