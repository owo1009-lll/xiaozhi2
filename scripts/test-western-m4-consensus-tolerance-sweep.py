#!/usr/bin/env python3
"""Regression checks for the M4 uniform consensus tolerance audit."""
from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments/eval_western_strings_m4_consensus_tolerance_sweep.py"
)
SPEC = importlib.util.spec_from_file_location("m4_consensus_tolerance_sweep", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    assert MODULE.configuration_is_candidate(
        {"allPiecesPrecisionPassed": True, "allPiecesCoveragePassed": True}
    )
    assert not MODULE.configuration_is_candidate(
        {"allPiecesPrecisionPassed": False, "allPiecesCoveragePassed": True}
    )
    assert not MODULE.configuration_is_candidate(
        {"allPiecesPrecisionPassed": True, "allPiecesCoveragePassed": False}
    )
    print("western M4 consensus tolerance sweep tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
