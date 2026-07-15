from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

import eval_western_strings_offline_dynamic_timing as timing_audit  # noqa: E402


aggregate = timing_audit.aggregate
issue_counts = timing_audit.issue_counts


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
        {
            "noteCount": 4,
            "timingAssignmentCount": 3,
            "pitchSupportWithin80CentsCount": 1,
            "totalReviewEvidenceCount": 3,
            "measureCount": 2,
            "measurePitchReviewEvidenceReadyCount": 1,
            "measureRhythmReviewEvidenceReadyCount": 0,
            "measureCombinedReviewEvidenceReadyCount": 0,
            "medianAbsCents": 10,
        },
        {
            "noteCount": 6,
            "timingAssignmentCount": 5,
            "pitchSupportWithin80CentsCount": 4,
            "totalReviewEvidenceCount": 2,
            "measureCount": 3,
            "measurePitchReviewEvidenceReadyCount": 2,
            "measureRhythmReviewEvidenceReadyCount": 1,
            "measureCombinedReviewEvidenceReadyCount": 1,
            "medianAbsCents": 20,
        },
    ])
    assert summary["timingAssignmentRate"] == 0.8
    assert summary["pitchSupportRate"] == 0.5
    assert summary["measurePitchReviewEvidenceRate"] == 0.6
    assert summary["measureRhythmReviewEvidenceRate"] == 0.2
    assert summary["measureCombinedReviewEvidenceRate"] == 0.2
    assert summary["medianOfRecordingMedianAbsCents"] == 15.0
    with tempfile.TemporaryDirectory(prefix="western-dynamic-f0-cache-") as temp_dir:
        root = Path(temp_dir)
        audio_path = root / "audio.bin"
        audio_path.write_bytes(b"stable-audio-content")
        original_extract = timing_audit.extract_f0
        timing_audit.extract_f0 = lambda _: (
            np.asarray([0.0, 0.1]),
            np.asarray([69.0, 69.0]),
            0.2,
        )
        first = timing_audit.load_or_extract_f0(audio_path, root / "cache", "recording")
        timing_audit.extract_f0 = lambda _: (_ for _ in ()).throw(AssertionError("cache-miss"))
        second = timing_audit.load_or_extract_f0(audio_path, root / "cache", "recording")
        timing_audit.extract_f0 = original_extract
        assert np.array_equal(first[0], second[0])
        assert np.array_equal(first[1], second[1])
        assert first[2] == second[2] == 0.2
    print("western offline dynamic timing audit tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
