from __future__ import annotations

import sys
from pathlib import Path

import numpy as np


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_audio_rhythm_ranking import (  # noqa: E402
    choose_generated_margin,
    choose_measure_margin,
    leave_one_piece_out_generated_eval,
    leave_one_piece_out_measure_eval,
    measure_rows_at_coverage,
    normalized_ioi_error,
    score_generated_candidate_f0,
    select_candidate,
    select_generated_candidate,
    select_measure_candidate,
)
from eval_western_strings_m4_rhythm_candidate_oracle import (  # noqa: E402
    MeasureRhythm,
    RhythmToken,
)


def test_relative_ioi_is_tempo_invariant() -> None:
    assert normalized_ioi_error([1.0, 0.5, 1.0], [2.0, 1.0, 2.0]) == 0.0
    wrong = normalized_ioi_error([1.0, 0.5, 1.0], [1.0, 1.0, 1.0])
    assert wrong is not None and wrong > 0.0


def test_candidate_selection_is_fail_closed() -> None:
    ready = {"evidenceReady": True, "relativeIoiError": 0.10}
    worse = {"evidenceReady": True, "relativeIoiError": 0.30}
    missing = {"evidenceReady": False, "relativeIoiError": None}
    assert select_candidate(ready, worse) == "gold"
    assert select_candidate(worse, ready) == "draft"
    assert select_candidate(ready, missing) == "uncertain"


def measure_row(piece: str, gold_error: float, draft_error: float) -> dict:
    return {
        "pieceId": piece,
        "gold": {"evidenceReady": True, "relativeIoiError": gold_error},
        "draft": {"evidenceReady": True, "relativeIoiError": draft_error},
    }


def test_measure_selection_uses_a_margin_and_fails_closed() -> None:
    row = measure_row("piece-a", 0.10, 0.30)
    assert select_measure_candidate(row, 0.05) == "gold"
    assert select_measure_candidate(row, 0.25) == "uncertain"
    row["draft"]["evidenceReady"] = False
    assert select_measure_candidate(row, 0.0) == "uncertain"


def test_measure_margin_is_selected_only_from_training_rows() -> None:
    rows = [measure_row("piece-a", 0.10, 0.30) for _ in range(5)]
    assert choose_measure_margin(rows) == 0.0
    mixed = rows + [measure_row("piece-b", 0.30, 0.10)]
    assert choose_measure_margin(mixed) is None


def test_measure_lopo_reports_holdout_failures_without_runtime_release() -> None:
    rows = []
    for piece_index in range(5):
        piece = f"piece-{piece_index}"
        rows.extend(measure_row(piece, 0.10, 0.30) for _ in range(6))
    report = leave_one_piece_out_measure_eval(rows)
    assert report["selectionPrecision"] == 1.0
    assert report["selectionCoverage"] == 1.0
    assert report["evalOnlyGatePassed"] is True
    assert report["runtimeReady"] is False


def test_measure_coverage_sensitivity_recomputes_evidence_without_changing_errors() -> None:
    row = measure_row("piece-a", 0.10, 0.30)
    for key in ("gold", "draft"):
        row[key].update({"evaluatedIntervalCount": 2, "intervalCoverage": 0.4})
    strict = measure_rows_at_coverage([row], 0.6)[0]
    relaxed = measure_rows_at_coverage([row], 0.3)[0]
    assert strict["gold"]["evidenceReady"] is False
    assert relaxed["gold"]["evidenceReady"] is True
    assert relaxed["gold"]["relativeIoiError"] == 0.10


def generated_row(piece: str, *, correct_error: float, wrong_error: float) -> dict:
    return {
        "pieceId": piece,
        "goldMeasure": 1,
        "draftMeasure": 1,
        "correctCandidatePresent": True,
        "candidates": [
            {
                "isGold": True,
                "cost": 1.0,
                "changed": 1,
                "audio": {"evidenceReady": True, "relativeIoiError": correct_error},
            },
            {
                "isGold": False,
                "cost": 0.0,
                "changed": 0,
                "audio": {"evidenceReady": True, "relativeIoiError": wrong_error},
            },
        ],
    }


def test_generated_candidate_selection_requires_audio_margin() -> None:
    row = generated_row("piece-a", correct_error=0.10, wrong_error=0.30)
    selected = select_generated_candidate(row, 0.05)
    assert selected is not None and selected["isGold"] is True
    assert select_generated_candidate(row, 0.25) is None
    tied = generated_row("piece-a", correct_error=0.10, wrong_error=0.10)
    assert select_generated_candidate(tied, 0.0) is None


def test_generated_margin_is_learned_from_training_rows_only() -> None:
    rows = [generated_row("piece-a", correct_error=0.10, wrong_error=0.30) for _ in range(5)]
    assert choose_generated_margin(rows) == 0.0
    mixed = rows + [generated_row("piece-b", correct_error=0.30, wrong_error=0.10)]
    assert choose_generated_margin(mixed) is None


def test_generated_lopo_can_pass_eval_without_enabling_runtime() -> None:
    rows = []
    for piece_index in range(5):
        rows.extend(
            generated_row(f"piece-{piece_index}", correct_error=0.10, wrong_error=0.30)
            for _ in range(6)
        )
    report = leave_one_piece_out_generated_eval(rows)
    assert report["selectionPrecision"] == 1.0
    assert report["selectionCoverage"] == 1.0
    assert report["evalOnlyGatePassed"] is True
    assert report["runtimeReady"] is False


def test_continuous_f0_shape_distinguishes_duration_patterns() -> None:
    measure = MeasureRhythm(
        measure_index=1,
        pitches=(60, 62, 64),
        note_onset_ticks=(0, 48, 96),
        tokens=(
            RhythmToken(1.0, True),
            RhythmToken(1.0, True),
            RhythmToken(1.0, True),
        ),
        expected_ticks=144,
        has_backup=False,
    )
    times = np.linspace(0.0, 3.0, 31)
    midi = np.where(times < 1.0, 60.0, np.where(times < 2.0, 62.0, 64.0))
    observation = {
        "evidenceReady": True,
        "startSeconds": 0.0,
        "endSeconds": 3.0,
        "frameTimes": times,
        "frameMidi": midi,
        "frameValid": np.ones(times.shape, dtype=bool),
    }
    correct = score_generated_candidate_f0(
        {"targetTicks": 144, "durationTicks": [48, 48, 48]},
        measure,
        observation,
    )
    wrong = score_generated_candidate_f0(
        {"targetTicks": 144, "durationTicks": [24, 96, 24]},
        measure,
        observation,
    )
    assert correct["evidenceReady"] is True
    assert correct["shapeError"] < wrong["shapeError"]


if __name__ == "__main__":
    test_relative_ioi_is_tempo_invariant()
    test_candidate_selection_is_fail_closed()
    test_measure_selection_uses_a_margin_and_fails_closed()
    test_measure_margin_is_selected_only_from_training_rows()
    test_measure_lopo_reports_holdout_failures_without_runtime_release()
    test_measure_coverage_sensitivity_recomputes_evidence_without_changing_errors()
    test_generated_candidate_selection_requires_audio_margin()
    test_generated_margin_is_learned_from_training_rows_only()
    test_generated_lopo_can_pass_eval_without_enabling_runtime()
    test_continuous_f0_shape_distinguishes_duration_patterns()
    print("western M4 audio rhythm ranking tests passed")
