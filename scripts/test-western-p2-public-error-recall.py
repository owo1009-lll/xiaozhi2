#!/usr/bin/env python3
"""Regression checks for the P2 public-data error-recall audit."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parent
    / "experiments"
    / "audit_western_p2_public_error_recall.py"
)
SPEC = importlib.util.spec_from_file_location("p2_public_error_recall", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        report = MODULE.run(root / "report.json", root / "report.md")

    assert report["contract"] == "western-p2-public-error-recall-audit-v1"
    assert len(report["datasets"]) == 4
    by_id = {row["datasetId"]: row for row in report["datasets"]}
    assert by_id["bach10"]["uniqueAlignedReferenceNotes"] == 425
    assert by_id["urmp"]["uniqueAlignedReferenceNotes"] == 146
    assert by_id["musicnet-solo"]["uniqueAlignedReferenceNotes"] == 1517
    assert by_id["musicnet-accompanied-violin"][
        "uniqueInstrumentLabelledReferenceNotes"
    ] == 3238
    assert report["profile"]["m0AlignedReferenceNotes"] == 2088
    assert report["profile"]["totalReferenceNoteEventsInspected"] == 5326
    assert report["profile"]["samePartRepeatedPerformancePairs"] == 0
    assert report["profile"]["adjudicatedRealErrorPositiveCount"] == 0
    assert report["decision"]["realErrorRecallMetricDerivable"] is False
    assert report["decision"]["weakRealRecallEvidenceAvailable"] is False
    assert report["decision"]["p2ReducesPositiveErrorRecordingNeed"] is False
    assert all(
        row["adjudicatedErrorLabelColumns"] == []
        and row["realErrorRecallDerivable"] is False
        for row in report["datasets"]
    )
    assert all(
        row["pairingAudit"]["samePartRepeatedPerformancePairs"] == 0
        for row in report["datasets"]
    )
    assert report["reproducibility"]["indexedDatasetRows"] == 14
    assert report["reproducibility"]["locallyPresentByIndex"] == {
        "audioExists": 0,
        "scoreExists": 0,
        "goldExists": 0,
    }
    assert report["reproducibility"]["rawM0ReplayableWithoutRedownload"] is False
    assert report["releaseSafety"]["postBlindRetuning"] is False
    assert report["releaseSafety"]["studentSwitchesRemainFalse"] is True
    assert report["stopLines"]["m4OmrFurtherInvestment"] is False
    assert report["stopLines"][
        "waveformEnergyMissingNoteFurtherInvestment"
    ] is False
    print("western P2 public error-recall audit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
