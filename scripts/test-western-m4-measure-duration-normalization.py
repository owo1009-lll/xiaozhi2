from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_measure_duration_normalization import (  # noqa: E402
    minimal_edit_measure_durations,
    normalized_measure_duration,
)


def test_normalization_is_bounded_and_preserves_partial_bars() -> None:
    assert normalized_measure_duration(
        6.0, 4.0, first_or_last=False, implicit=False, has_backup=False
    ) == (4.0, "normalized-to-time-signature")
    assert normalized_measure_duration(
        2.0, 4.0, first_or_last=True, implicit=False, has_backup=False
    ) == (2.0, "pickup-or-partial-measure")
    assert normalized_measure_duration(
        4.0, 4.0, first_or_last=False, implicit=False, has_backup=True
    ) == (4.0, "polyphonic-backup-unsupported")
    assert normalized_measure_duration(
        10.0, 4.0, first_or_last=False, implicit=False, has_backup=False
    ) == (10.0, "structural-ratio-out-of-range")


def test_minimal_edit_repairs_common_half_double_confusion() -> None:
    repaired, detail = minimal_edit_measure_durations([0.5, 2.0, 1.0], 4.0)
    assert repaired is not None
    assert abs(sum(repaired) - 4.0) < 1e-9
    assert detail["reason"] == "minimal-edit-time-signature"
    assert detail["changed"] == 1

    unchanged, detail = minimal_edit_measure_durations([1.0, 1.0, 1.0, 1.0], 4.0)
    assert unchanged == [1.0, 1.0, 1.0, 1.0]
    assert detail["changed"] == 0


if __name__ == "__main__":
    test_normalization_is_bounded_and_preserves_partial_bars()
    test_minimal_edit_repairs_common_half_double_confusion()
    print("western M4 measure-duration normalization tests passed")
