#!/usr/bin/env python3
"""Regression checks for the M4 repeated-pitch confirmation audit."""
from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments/eval_western_strings_m4_repeated_pitch_confirmation.py"
)
SPEC = importlib.util.spec_from_file_location("m4_repeated_pitch_confirmation", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def note(midi: int) -> MODULE.consensus.Note:
    return MODULE.consensus.Note(
        midi=midi,
        onset_quarters=0.0,
        duration_quarters=1.0,
        measure_index=1,
    )


def main() -> int:
    notes = [note(60), note(62), note(62), note(64), note(65), note(65)]
    assert not MODULE.has_adjacent_repeated_pitch(notes, 0)
    assert MODULE.has_adjacent_repeated_pitch(notes, 1)
    assert MODULE.has_adjacent_repeated_pitch(notes, 2)
    assert not MODULE.has_adjacent_repeated_pitch(notes, 3)
    assert MODULE.has_adjacent_repeated_pitch(notes, 4)
    assert MODULE.has_adjacent_repeated_pitch(notes, 5)

    failed = MODULE.build_report(
        {"repeatedPitchFiltered": {"passed": False}}
    )
    assert failed["candidateRejected"] is True
    assert failed["runtimeReady"] is False
    assert failed["studentGateReady"] is False
    assert failed["remainingIndependentPiecesConsumed"] == 0
    print("western M4 repeated-pitch confirmation tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
