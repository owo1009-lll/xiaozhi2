from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_audio_rhythm_ranking import (  # noqa: E402
    normalized_ioi_error,
    select_candidate,
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


if __name__ == "__main__":
    test_relative_ioi_is_tempo_invariant()
    test_candidate_selection_is_fail_closed()
    print("western M4 audio rhythm ranking tests passed")
