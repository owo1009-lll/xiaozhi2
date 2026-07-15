from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m3plus_coarse_states import evaluate, merge_review_features  # noqa: E402


def review_row(index: int, recording: str, behavior: str) -> tuple[dict, dict]:
    onset = index / 10
    candidate = {
        "stable": "stable", "variable-f0": "variable-f0",
        "slide": "slide-like", "trill": "trill-like",
    }[behavior]
    label = {
        "recordingId": recording, "noteId": f"n{index}",
        "predictedOnsetSeconds": str(onset), "predictedDurationSeconds": "1.0",
        "candidateMode": candidate, "measureIndex": str(index + 1),
        "audioScoreMatch": "match", "observedPitchBehavior": behavior,
    }
    metrics = {
        "voicedFrameCount": 80,
        "spreadCentsP95P05": 15 if behavior == "stable" else 80,
        "netMotionCents": 5 if behavior == "stable" else (150 if behavior == "slide" else 20),
        "monotonicity": 0.2 if behavior in {"stable", "trill"} else 0.8,
        "trillSwitchCountApprox": 8 if behavior == "trill" else 1,
    }
    return label, {**label, "metrics": metrics}


def test_join_is_exact_and_teacher_states_are_eval_only() -> None:
    labels, features = [], []
    index = 0
    for recording_index in range(5):
        for behavior in ["stable", "stable", "variable-f0", "variable-f0", "slide", "trill"]:
            label, feature = review_row(index, f"r{recording_index}", behavior)
            labels.append(label)
            features.append(feature)
            index += 1
    rows, diagnostics = merge_review_features(labels, features)
    report = evaluate(rows, diagnostics, min_positive_rows=4, min_positive_recordings=4)
    assert diagnostics["joinReady"] is True
    assert len(rows) == 30
    assert report["studentGateReady"] is False
    assert report["coarseStateRuntimeReady"] is False
    assert report["tasks"]["active"]["positiveRecordings"] == 5
    assert report["tasks"]["directional"]["positiveRecordings"] == 5
    assert report["tasks"]["alternating"]["positiveRecordings"] == 5


def test_missing_feature_fails_join_closed() -> None:
    label, _ = review_row(1, "r1", "stable")
    rows, diagnostics = merge_review_features([label], [])
    report = evaluate(rows, diagnostics)
    assert rows == []
    assert diagnostics["joinReady"] is False
    assert report["ok"] is False
    assert "review-label-feature-join-not-ready" in report["blockingReasons"]


if __name__ == "__main__":
    test_join_is_exact_and_teacher_states_are_eval_only()
    test_missing_feature_fails_join_closed()
    print("western M3+ coarse-state tests passed")
