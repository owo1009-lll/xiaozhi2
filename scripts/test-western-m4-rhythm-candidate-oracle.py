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
    build_visual_candidate_provider,
    generate_visual_rhythm_candidates,
    reachable_gold_rhythm,
    relative_ioi_shape_matches,
    visual_candidate_duration_ticks,
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


def test_visual_candidates_are_bounded_by_notation() -> None:
    quarter = RhythmToken(1.0, True, notation_type="quarter")
    assert visual_candidate_duration_ticks(quarter) == (24, 48)
    half = RhythmToken(2.0, True, notation_type="half")
    assert visual_candidate_duration_ticks(half) == (96,)
    dotted_rest = RhythmToken(1.5, False, notation_type="quarter", dot_count=1, is_rest=True)
    assert visual_candidate_duration_ticks(dotted_rest) == (24, 36, 48, 72)


def test_visual_oracle_does_not_enumerate_unseen_third_note() -> None:
    draft = MeasureRhythm(
        measure_index=1,
        pitches=(60, 62, 64),
        note_onset_ticks=(),
        tokens=tuple(
            RhythmToken(1.0, True, notation_type="quarter") for _ in range(3)
        ),
        expected_ticks=3 * TICKS_PER_QUARTER,
        has_backup=False,
    )
    gold = (0, 16, 32)
    result = reachable_gold_rhythm(
        draft,
        gold,
        3 * TICKS_PER_QUARTER,
        candidate_provider=visual_candidate_duration_ticks,
    )
    assert result["reachable"] is False


def test_beam_evidence_adds_only_adjacent_duration_classes() -> None:
    row = MeasureRhythm(
        measure_index=1,
        pitches=(60,),
        note_onset_ticks=(),
        tokens=(RhythmToken(0.5, True, notation_type="eighth", beam_count=1),),
        expected_ticks=4 * TICKS_PER_QUARTER,
        has_backup=False,
    )
    provider = build_visual_candidate_provider(row)
    assert provider(row.tokens[0]) == (12, 24, 48)


def test_triplet_context_propagates_after_three_visible_examples() -> None:
    triplet = RhythmToken(1 / 3, True, notation_type="eighth", beam_count=1)
    ordinary = RhythmToken(0.5, True, notation_type="eighth", beam_count=1)
    row = MeasureRhythm(
        measure_index=1,
        pitches=(60, 62, 64, 65),
        note_onset_ticks=(),
        tokens=(triplet, triplet, triplet, ordinary),
        expected_ticks=3 * TICKS_PER_QUARTER,
        has_backup=False,
    )
    assert 16 in build_visual_candidate_provider(row)(ordinary)


def test_single_tuplet_like_token_does_not_propagate_context() -> None:
    triplet = RhythmToken(1 / 3, True, notation_type="eighth", beam_count=1)
    ordinary = RhythmToken(0.5, True, notation_type="eighth", beam_count=1)
    row = MeasureRhythm(
        measure_index=1,
        pitches=(60, 62),
        note_onset_ticks=(),
        tokens=(triplet, ordinary),
        expected_ticks=3 * TICKS_PER_QUARTER,
        has_backup=False,
    )
    assert 16 not in build_visual_candidate_provider(row)(ordinary)


def test_generated_candidates_are_meter_bounded_and_gold_free() -> None:
    row = MeasureRhythm(
        measure_index=1,
        pitches=(60, 62, 64, 65),
        note_onset_ticks=(),
        tokens=tuple(
            RhythmToken(0.5, True, notation_type="eighth", beam_count=1)
            for _ in range(4)
        ),
        expected_ticks=2 * TICKS_PER_QUARTER,
        has_backup=False,
    )
    candidates = generate_visual_rhythm_candidates(
        row,
        2 * TICKS_PER_QUARTER,
        top_k=8,
    )
    assert candidates
    assert candidates[0]["noteOnsetTicks"] == [0, 24, 48, 72]
    assert all(sum(candidate["durationTicks"]) == 96 for candidate in candidates)
    assert all(len(candidate["noteOnsetTicks"]) == 4 for candidate in candidates)


def test_generated_candidates_preserve_distinct_onset_hypotheses() -> None:
    row = MeasureRhythm(
        measure_index=1,
        pitches=(60, 62, 64),
        note_onset_ticks=(),
        tokens=tuple(
            RhythmToken(0.5, True, notation_type="eighth", beam_count=1)
            for _ in range(3)
        ),
        expected_ticks=2 * TICKS_PER_QUARTER,
        has_backup=False,
    )
    candidates = generate_visual_rhythm_candidates(
        row,
        2 * TICKS_PER_QUARTER,
        top_k=16,
    )
    onset_hypotheses = {tuple(candidate["noteOnsetTicks"]) for candidate in candidates}
    assert len(onset_hypotheses) >= 2


if __name__ == "__main__":
    test_wrong_meter_blocks_otherwise_reachable_rhythm()
    test_already_correct_rhythm_is_zero_edit()
    test_backup_measure_is_fail_closed()
    test_relative_ioi_shape_ignores_uniform_meter_scale()
    test_visual_candidates_are_bounded_by_notation()
    test_visual_oracle_does_not_enumerate_unseen_third_note()
    test_beam_evidence_adds_only_adjacent_duration_classes()
    test_triplet_context_propagates_after_three_visible_examples()
    test_single_tuplet_like_token_does_not_propagate_context()
    test_generated_candidates_are_meter_bounded_and_gold_free()
    test_generated_candidates_preserve_distinct_onset_hypotheses()
    print("western M4 rhythm candidate oracle tests passed")
