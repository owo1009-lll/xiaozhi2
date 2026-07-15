from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts" / "experiments" / "eval_western_strings_round2_m3plus.py"
SPEC = importlib.util.spec_from_file_location("eval_western_strings_round2_m3plus", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    first = {"midi": 60}
    second = {"midi": 64}
    first_event = {"start": 0.0, "end": 0.8}
    second_event = {"start": 0.8, "end": 1.2}
    times = np.arange(0.0, 1.21, 0.05)
    sliding = np.linspace(60.0, 64.0, len(times))
    detected, frames = MODULE.slide_pair_detected(first, second, first_event, second_event, times, sliding)
    assert detected is True and frames >= 3

    stepped = np.where(times < 0.8, 60.0, 64.0)
    detected, _ = MODULE.slide_pair_detected(first, second, first_event, second_event, times, stepped)
    assert detected is False

    notes = [
        {"measureIndex": 1, "beatStart": 0.0, "midi": 62},
        {"measureIndex": 1, "beatStart": 0.0, "midi": 69},
        {"measureIndex": 2, "beatStart": 0.0, "midi": 62},
        {"measureIndex": 2, "beatStart": 0.0, "midi": 69},
    ]
    matched = [
        {"pitchDiff": 0},
        {"pitchDiff": 0},
        {"pitchDiff": 0},
        None,
    ]
    double = MODULE.evaluate_double_stop(notes, matched)
    assert double["expectedGroupCount"] == 2
    assert double["allPitchesDetectedGroupCount"] == 1
    assert double["groupRecall"] == 0.5

    unison = MODULE.evaluate_double_stop(
        [
            {"measureIndex": 1, "beatStart": 0.0, "midi": 62},
            {"measureIndex": 1, "beatStart": 0.0, "midi": 62},
        ],
        [{"pitchDiff": 0}, {"pitchDiff": 0}],
    )
    assert unison["expectedGroupCount"] == 0

    technique_notes = [
        {"measureIndex": 1, "midi": 62, "techniques": ["trill-mark"]},
        {"measureIndex": 2, "midi": 64, "techniques": []},
    ]
    technique_matched = [None, {"start": 0.0, "end": 0.4}]
    technique_times = np.arange(0.0, 0.41, 0.05)
    technique_track = np.full_like(technique_times, 64.0)
    technique = MODULE.evaluate_trill_vibrato(
        technique_notes,
        technique_matched,
        technique_times,
        technique_track,
    )
    assert technique["trill"]["expectedNoteCount"] == 1
    assert technique["trill"]["matchedNoteCount"] == 0
    assert technique["trill"]["rows"][0]["alignmentStatus"] == "unmatched"
    assert technique["vibrato"]["instructionExpectedLongNoteCount"] == 1
    assert technique["vibrato"]["matchedNoteCount"] == 1

    items = [
        {"ok": True, "scenario": "slide", "modeEvidence": {"detectionRate": 1.0}},
        {
            "ok": True,
            "scenario": "trill_vibrato",
            "humanGold": {"performanceExecutionVerified": True},
            "modeEvidence": {
                "trill": {"detectionRate": 1.0},
                "vibrato": {"detectionRate": 1.0},
            },
        },
        {"ok": True, "scenario": "double_stop", "modeEvidence": {"groupRecall": 1.0}},
    ]
    report = MODULE.build_report(items)
    assert report["humanVerifiedPerformanceGold"] is True
    assert report["machineThresholdPassed"] is True
    assert report["studentGateReady"] is False
    assert "m3plus-round2-performance-execution-not-human-verified" not in report["blockingReasons"]
    assert "m3plus-round2-mode-detection-below-90-percent" not in report["blockingReasons"]
    assert "第二轮 M3+" in MODULE.render_markdown(report)

    items[0]["modeEvidence"]["detectionRate"] = 0.5
    report = MODULE.build_report(items)
    assert report["machineThresholdPassed"] is False
    assert "m3plus-round2-mode-detection-below-90-percent" in report["blockingReasons"]

    print("western round2 M3+ tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
