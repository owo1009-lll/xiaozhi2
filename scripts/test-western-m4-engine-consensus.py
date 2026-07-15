from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_engine_consensus import (  # noqa: E402
    Note,
    evaluate_selection,
    select_anchor_indexes,
)


def note(midi: int, onset: float, measure: int = 1) -> Note:
    return Note(midi=midi, onset_quarters=onset, duration_quarters=1.0, measure_index=measure)


def main() -> int:
    anchor = [note(60, 0), note(62, 1), note(64, 2)]
    homr = [note(60, 0), note(62, 1.1), note(65, 2)]
    mapping = {0: 0, 1: 1, 2: 2}
    selected = select_anchor_indexes(
        anchor,
        {"homr": homr},
        {"homr": mapping},
        required_engines=("homr",),
        local_onset_tolerance=0.25,
    )
    assert selected == [0, 1]
    metrics = evaluate_selection(anchor, anchor, selected)
    assert metrics["selectedNotes"] == 2
    assert metrics["correctNotes"] == 2
    assert metrics["precision"] == 1.0
    assert metrics["precisionPassed"] is False  # Fewer than the release minimum of ten notes.

    shifted = [note(60, 0), note(62, 1.4), note(64, 2)]
    selected_shifted = select_anchor_indexes(
        anchor,
        {"homr": shifted},
        {"homr": mapping},
        required_engines=("homr",),
        local_onset_tolerance=0.25,
    )
    assert selected_shifted == [0, 2]
    print("western m4 engine consensus tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
