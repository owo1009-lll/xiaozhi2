from __future__ import annotations

import importlib.util
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts" / "experiments" / "diagnose_western_strings_round2_trill_vibrato.py"
SPEC = importlib.util.spec_from_file_location("diagnose_western_strings_round2_trill_vibrato", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    score_notes = [
        {"scoreBeat": 0.0, "durationBeats": 1.0, "midi": 69},
        {"scoreBeat": 1.0, "durationBeats": 1.0, "midi": 71},
    ]
    events = [
        {"start": 1.0, "end": 1.8, "midi": 69, "confidence": 0.9},
        {"start": 1.9, "end": 3.0, "midi": 71, "confidence": 0.9},
    ]
    windows, span = MODULE.derive_activity_anchored_windows(score_notes, events)
    assert len(windows) == 2
    assert span["performanceStartSeconds"] == 1.0
    assert span["performanceEndSeconds"] == 3.0
    assert windows[0]["start"] < windows[0]["end"] <= windows[1]["start"]

    result = MODULE.best_single_feature_threshold([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])
    assert result["direction"] == "greater-or-equal"
    assert result["precision"] == 1.0
    assert result["recall"] == 1.0
    assert result["balancedAccuracy"] == 1.0

    metrics = MODULE.classification_metrics([1, 1, 0, 0], [1, 0, 1, 0])
    assert metrics["tp"] == 1
    assert metrics["fp"] == 1
    assert metrics["tn"] == 1
    assert metrics["fn"] == 1
    assert metrics["balancedAccuracy"] == 0.5

    print("western round2 M3+ diagnostic tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
