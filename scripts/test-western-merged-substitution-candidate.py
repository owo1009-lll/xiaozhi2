from __future__ import annotations

import importlib.util
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts/experiments/eval_western_strings_merged_substitution_candidate.py"


def load_module():
    spec = importlib.util.spec_from_file_location("merged_substitution_candidate", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("merged-substitution-module-unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def row(*, midi: int, duration: float = 1.0, assigned: bool = True,
        pitch_distance: int | None = 0, duration_ratio: float | None = 1.0):
    return {
        "scoreMidi": midi,
        "beatDuration": duration,
        "assigned": assigned,
        "pitchDistanceSemitones": pitch_distance,
        "eventDurationRatio": duration_ratio,
        "protected": False,
        "onsetGroupSize": 1,
        "polyphonic": False,
    }


def main() -> None:
    module = load_module()
    positive = [
        row(midi=64),
        row(midi=72, assigned=False, pitch_distance=None, duration_ratio=None),
        row(midi=71, duration_ratio=2.0),
        row(midi=69),
    ]
    assert len(module.detect_merged_substitution_candidates(positive)) == 1

    double_gap = [positive[0], {**positive[1]}, {**positive[1]}, positive[2]]
    assert module.detect_merged_substitution_candidates(double_gap) == []

    short_following = [positive[0], positive[1], row(midi=71, duration_ratio=1.7), positive[3]]
    assert module.detect_merged_substitution_candidates(short_following) == []

    distant_pitch = [positive[0], row(midi=76, assigned=False, pitch_distance=None, duration_ratio=None), positive[2], positive[3]]
    assert module.detect_merged_substitution_candidates(distant_pitch) == []

    inexact_following = [positive[0], positive[1], row(midi=71, pitch_distance=1, duration_ratio=2.0), positive[3]]
    assert module.detect_merged_substitution_candidates(inexact_following) == []

    protected = [positive[0], {**positive[1], "protected": True}, positive[2], positive[3]]
    assert module.detect_merged_substitution_candidates(protected) == []
    print('{"ok": true, "checks": ["isolated-gap", "combined-duration", "pitch-distance", "exact-following", "protected-zone"]}')


if __name__ == "__main__":
    main()
