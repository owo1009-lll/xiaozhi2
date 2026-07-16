#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "scripts" / "experiments"))

from audit_western_strings_m3plus_feature_separability import (  # noqa: E402
    audit_report,
)


def row(split: str, positive: bool, value: float, *, ready: bool = True) -> dict:
    return {
        "evaluationSplit": split,
        "localizationUnitReady": ready,
        "expectedPositiveModes": ["ornament"] if positive else [],
        "expectedNegativeModes": [] if positive else ["ornament"],
        "modeDiagnostics": {
            "f0QualityReady": True,
            "knownUpperFrameRatio": value,
            "knownUpperBoutCount": value,
            "ornamentUpperSeconds": value,
            "ornamentFirstUpperOffsetSeconds": 0.01,
        },
    }


def test_audit_requires_four_reliable_rows_per_class_and_split() -> None:
    rows = [
        row(split, positive, 0.9 if positive else 0.1)
        for split in ("calibration", "holdout")
        for positive in (True, False)
        for _ in range(3)
    ]
    report = {"recordings": [{"rows": rows}]}
    result = audit_report(report)
    assert result["anyFeaturePassesHeldoutGate"] is False
    assert (
        result["modes"]["ornament"]["knownUpperFrameRatio"]["reason"]
        == "insufficient-reliable-class-rows"
    )


def test_audit_passes_only_on_heldout_precision_and_recall() -> None:
    rows = [
        row(split, positive, 0.9 if positive else 0.1)
        for split in ("calibration", "holdout")
        for positive in (True, False)
        for _ in range(4)
    ]
    report = {"recordings": [{"rows": rows}]}
    result = audit_report(report)
    assert result["anyFeaturePassesHeldoutGate"] is True
    feature = result["modes"]["ornament"]["knownUpperFrameRatio"]
    assert feature["holdout"]["precision"] == 1.0
    assert feature["holdout"]["recall"] == 1.0


if __name__ == "__main__":
    test_audit_requires_four_reliable_rows_per_class_and_split()
    test_audit_passes_only_on_heldout_precision_and_recall()
    print("western M3+ feature-separability audit tests passed")
