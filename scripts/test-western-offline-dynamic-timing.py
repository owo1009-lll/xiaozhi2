from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_offline_dynamic_timing import aggregate, issue_counts  # noqa: E402


def main() -> int:
    decisions = [
        {"evidence": {"timingAssignmentAvailable": False}},
        {"evidence": {"timingAssignmentAvailable": True, "basicPitchPitchDistanceSemitones": 2, "pitchSupportWithin80Cents": False}},
        {"evidence": {"timingAssignmentAvailable": True, "basicPitchPitchDistanceSemitones": 0, "pitchSupportWithin80Cents": False}},
        {"evidence": {"timingAssignmentAvailable": True, "basicPitchPitchDistanceSemitones": 0, "pitchSupportWithin80Cents": True}},
    ]
    counts = issue_counts(decisions)
    assert counts == {
        "unassignedNoteCount": 1,
        "eventPitchConflictCount": 1,
        "stableF0ConflictCount": 1,
        "totalReviewEvidenceCount": 3,
    }
    summary = aggregate([
        {"noteCount": 4, "timingAssignmentCount": 3, "pitchSupportWithin80CentsCount": 1, "totalReviewEvidenceCount": 3, "medianAbsCents": 10},
        {"noteCount": 6, "timingAssignmentCount": 5, "pitchSupportWithin80CentsCount": 4, "totalReviewEvidenceCount": 2, "medianAbsCents": 20},
    ])
    assert summary["timingAssignmentRate"] == 0.8
    assert summary["pitchSupportRate"] == 0.5
    assert summary["medianOfRecordingMedianAbsCents"] == 15.0
    print("western offline dynamic timing audit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
