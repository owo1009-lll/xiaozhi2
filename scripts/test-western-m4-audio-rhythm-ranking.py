from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_audio_rhythm_ranking import (  # noqa: E402
    choose_measure_margin,
    leave_one_piece_out_measure_eval,
    measure_rows_at_coverage,
    normalized_ioi_error,
    select_candidate,
    select_measure_candidate,
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


if __name__ == "__main__":
    test_relative_ioi_is_tempo_invariant()
    test_candidate_selection_is_fail_closed()
    test_measure_selection_uses_a_margin_and_fails_closed()
    test_measure_margin_is_selected_only_from_training_rows()
    test_measure_lopo_reports_holdout_failures_without_runtime_release()
    test_measure_coverage_sensitivity_recomputes_evidence_without_changing_errors()
    print("western M4 audio rhythm ranking tests passed")
