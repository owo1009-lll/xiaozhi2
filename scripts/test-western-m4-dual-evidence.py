from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_dual_evidence_precision import (  # noqa: E402
    aggregate,
    align_event_indexes,
    frame_pitch_confirmation,
    measure_ordinal_map,
    wilson_lower_bound,
)


def event(measure: int, *midis: int) -> dict:
    return {"measure": measure, "midis": list(midis)}


def test_alignment_preserves_insertions_and_order() -> None:
    gold = [event(1, 60), event(1, 62), event(2, 64)]
    draft = [event(1, 60), event(1, 61), event(1, 62), event(2, 64)]
    mapping = align_event_indexes(gold, draft)
    assert mapping[0] == 0
    assert mapping[2] == 1
    assert mapping[3] == 2


def test_measure_ordinals_are_explicit() -> None:
    keys = measure_ordinal_map([event(1, 60), event(1, 62), event(2, 64)])
    assert keys == {0: (1, 0), 1: (1, 1), 2: (2, 0)}


def test_aggregate_gate_is_strict_and_eval_only() -> None:
    rows = [
        {
            "goldEvents": 100,
            "caughtOmrPitchErrors": 9,
            "escapedOmrPitchErrors": 1,
            "sequence": {"correct": 99, "total": 100, "precision": 0.99},
            "structural": {"correct": 99, "total": 100, "precision": 0.99},
            "consensus": {"correct": 99, "total": 100, "precision": 0.99},
            "f0Consensus": {"correct": 49, "total": 50, "precision": 0.98},
        }
    ]
    summary = aggregate(rows)
    assert summary["consensus"]["precision"] == 0.99
    assert summary["omrPitchErrorCatchRate"] == 0.9
    assert summary["evalOnlyGatePassed"] is False
    assert wilson_lower_bound(99, 100) < 0.95


def test_continuous_f0_confirmation_is_fail_closed() -> None:
    import numpy as np

    times = np.arange(0.0, 1.0, 0.02)
    good = np.full_like(times, 69.15)
    confirmed = frame_pitch_confirmation(
        [69], {"start": 0.1, "end": 0.8, "midis": [69]}, times, good
    )
    assert confirmed["state"] == "confirmed"
    wrong = frame_pitch_confirmation(
        [70], {"start": 0.1, "end": 0.8, "midis": [70]}, times, good
    )
    assert wrong["state"] == "mismatch"
    polyphonic = frame_pitch_confirmation(
        [69, 76], {"start": 0.1, "end": 0.8, "midis": [69, 76]}, times, good
    )
    assert polyphonic["state"] == "uncertain"
    sparse = good.copy()
    sparse[::2] = np.nan
    uncertain = frame_pitch_confirmation(
        [69], {"start": 0.1, "end": 0.8, "midis": [69]}, times, sparse
    )
    assert uncertain["state"] == "uncertain"


if __name__ == "__main__":
    test_alignment_preserves_insertions_and_order()
    test_measure_ordinals_are_explicit()
    test_aggregate_gate_is_strict_and_eval_only()
    test_continuous_f0_confirmation_is_fail_closed()
    print("western M4 dual-evidence tests passed")
