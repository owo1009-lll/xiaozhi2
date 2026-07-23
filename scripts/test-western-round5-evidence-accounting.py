#!/usr/bin/env python3
"""Regression checks for consumed Round-5 evidence accounting."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments"
    / "audit_western_round5_evidence_accounting.py"
)
SPEC = importlib.util.spec_from_file_location("round5_evidence_accounting", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        report = MODULE.run(root / "report.json", root / "report.md")
    by_id = {row["candidateId"]: row for row in report["accounting"]}
    assert len(by_id) == 13
    assert report["freshBlindRetuned"] is False
    assert report["modelRetrained"] is False
    assert report["thresholdChanged"] is False
    assert report["conclusions"]["positionControlledCandidatePassed"] is False
    assert report["conclusions"]["strictConfirmedRecall"] == "2/12"
    assert by_id["segment-rf-extra"]["accountingClass"] == (
        "invalidated-by-position-confounding"
    )
    assert by_id["gap-refinement-self-check"]["observedFreshBlind"]["recall"] == 0.083333
    assert by_id["gap-strict-missing"]["observedFreshBlind"]["recall"] == 0.166667
    assert by_id["rhythm-strict-extra-drag"]["observedFreshBlind"]["truePositive"] == 4
    assert by_id["waveform-energy-absence"]["observedAllRound5"]["truePositive"] == 0
    assert by_id["waveform-target-pitch-absence"]["observedAllRound5"][
        "falsePositive"
    ] == 49
    assert set(report["conclusions"]["invalidatedByPositionConfounding"]) == {
        f"segment-rf-{gate}" for gate in MODULE.GATES
    }
    print("western Round-5 evidence-accounting tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
