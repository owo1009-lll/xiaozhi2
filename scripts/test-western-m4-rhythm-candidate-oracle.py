#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from eval_western_strings_m4_rhythm_candidate_oracle import (  # noqa: E402
    MeasureRhythm,
    RhythmToken,
    TICKS_PER_QUARTER,
    reachable_gold_rhythm,
    relative_ioi_shape_matches,
)


def measure(durations: list[float], expected: float) -> MeasureRhythm:
    return MeasureRhythm(
        measure_index=1,
        pitches=tuple(range(60, 60 + len(durations))),
        note_onset_ticks=(),
        tokens=tuple(RhythmToken(duration, True) for duration in durations),
        expected_ticks=round(expected * TICKS_PER_QUARTER),
        has_backup=False,
    )


def test_wrong_meter_blocks_otherwise_reachable_rhythm() -> None:
    draft = measure([1 / 3] * 6, 2.0)
    gold = tuple(round(index * 0.5 * TICKS_PER_QUARTER) for index in range(6))
    current = reachable_gold_rhythm(draft, gold, 2 * TICKS_PER_QUARTER)
    corrected = reachable_gold_rhythm(draft, gold, 3 * TICKS_PER_QUARTER)
    assert current["reachable"] is False
    assert corrected["reachable"] is True
    assert corrected["changed"] == 6


def test_already_correct_rhythm_is_zero_edit() -> None:
    draft = measure([0.25] * 16, 4.0)
    gold = tuple(round(index * 0.25 * TICKS_PER_QUARTER) for index in range(16))
    result = reachable_gold_rhythm(draft, gold, 4 * TICKS_PER_QUARTER)
    assert result["reachable"] is True
    assert result["changed"] == 0
    assert result["cost"] == 0.0


def test_backup_measure_is_fail_closed() -> None:
    draft = MeasureRhythm(
        measure_index=1,
        pitches=(60,),
        note_onset_ticks=(),
        tokens=(RhythmToken(1.0, True),),
        expected_ticks=4 * TICKS_PER_QUARTER,
        has_backup=True,
    )
    result = reachable_gold_rhythm(draft, (0,), 4 * TICKS_PER_QUARTER)
    assert result["reachable"] is False


def test_relative_ioi_shape_ignores_uniform_meter_scale() -> None:
    assert relative_ioi_shape_matches((0, 16, 32, 48), (0, 24, 48, 72)) is True
    assert relative_ioi_shape_matches((0, 16, 40, 48), (0, 24, 48, 72)) is False
    assert relative_ioi_shape_matches((0,), (0,)) is None


if __name__ == "__main__":
    test_wrong_meter_blocks_otherwise_reachable_rhythm()
    test_already_correct_rhythm_is_zero_edit()
    test_backup_measure_is_fail_closed()
    test_relative_ioi_shape_ignores_uniform_meter_scale()
    print("western M4 rhythm candidate oracle tests passed")
