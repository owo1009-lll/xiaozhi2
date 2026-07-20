#!/usr/bin/env python3
"""Unit tests for the Zeus challenger metric contract."""

from __future__ import annotations

import importlib.util
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts" / "experiments" / "eval_western_m4_zeus_challenger.py"
SPEC = importlib.util.spec_from_file_location("zeus_challenger", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def row(precision: float, recall: float, onset: float, measure: float, strict: bool):
    gold = 100
    draft = 100
    pitch = round(recall * gold)
    return {
        "goldNotes": gold,
        "draftNotes": draft,
        "pitchExact": pitch,
        "pitchPrecision": precision,
        "pitchRecall": recall,
        "onsetQuarterAccuracy": onset,
        "measureAccuracy": measure,
        "strictPass": strict,
        "segmentationReady": True,
    }


def test_aggregate_passes_only_with_all_frozen_thresholds() -> None:
    passing = [row(0.99, 0.99, 0.99, 0.99, True) for _ in range(10)]
    assert MODULE.aggregate(passing)["passesFrozenRealPhotoGate"] is True

    one_failed_page = passing[:-1] + [row(0.99, 0.99, 0.99, 0.99, False)]
    assert MODULE.aggregate(one_failed_page)["passesFrozenRealPhotoGate"] is True

    two_failed_pages = passing[:-2] + [
        row(0.99, 0.99, 0.99, 0.99, False),
        row(0.99, 0.99, 0.99, 0.99, False),
    ]
    assert MODULE.aggregate(two_failed_pages)["passesFrozenRealPhotoGate"] is False


def test_aggregate_does_not_infer_student_release() -> None:
    report = MODULE.aggregate([row(0.99, 0.99, 0.99, 0.99, True)])
    assert "studentGateReady" not in report


if __name__ == "__main__":
    test_aggregate_passes_only_with_all_frozen_thresholds()
    test_aggregate_does_not_infer_student_release()
    print("western M4 Zeus challenger tests passed")
