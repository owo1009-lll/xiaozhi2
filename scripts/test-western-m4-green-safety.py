from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_green_safety import (  # noqa: E402
    classify_false_green,
    evaluate_nested_feature_selection,
    fit_zero_false_positive_threshold,
    passes_threshold,
)


def test_zero_false_positive_threshold() -> None:
    rows = [
        {"pieceId": "safe-a", "safe": True, "signal": 0.10},
        {"pieceId": "safe-b", "safe": True, "signal": 0.20},
        {"pieceId": "unsafe", "safe": False, "signal": 0.80},
    ]
    gate = fit_zero_false_positive_threshold(rows, "signal")
    assert gate is not None
    assert gate["direction"] == "le"
    assert passes_threshold(rows[0], "signal", gate)
    assert not passes_threshold(rows[2], "signal", gate)


def test_nested_selection_exposes_held_out_unsafe_piece() -> None:
    rows = [
        {"pieceId": "safe-a", "safe": True, "x": 0.10, "y": 0.10},
        {"pieceId": "safe-b", "safe": True, "x": 0.20, "y": 0.20},
        {"pieceId": "unsafe-near", "safe": False, "x": 0.30, "y": 0.30},
        {"pieceId": "unsafe-far", "safe": False, "x": 0.80, "y": 0.80},
    ]
    result = evaluate_nested_feature_selection(rows, ["x", "y"])
    assert result["unsafePassed"] >= 1
    assert result["releaseCandidate"] is False


def test_false_green_mechanisms_are_explicit() -> None:
    per_note = [
        {"scoreMidis": [64]},
        {"scoreMidis": [64]},
    ]
    repeated = Counter({((64,), (67,)): 1, ((78,), (77,)): 2})
    missing = classify_false_green(
        "piece",
        {
            "draftIndex": 1,
            "draftMidis": [64],
            "goldMidis": [67],
            "sequenceGoldIndex": 1,
            "structuralGoldIndex": 1,
        },
        per_note,
        repeated,
    )
    assert missing == "missing-onset-repeated-pitch-collapse"
    drift = classify_false_green(
        "piece",
        {
            "draftIndex": 0,
            "draftMidis": [80],
            "goldMidis": [81],
            "sequenceGoldIndex": 3,
            "structuralGoldIndex": 2,
        },
        per_note,
        repeated,
    )
    assert drift == "score-audio-coincidence-with-structure-drift"


if __name__ == "__main__":
    test_zero_false_positive_threshold()
    test_nested_selection_exposes_held_out_unsafe_piece()
    test_false_green_mechanisms_are_explicit()
    print("western M4 green safety tests passed")
