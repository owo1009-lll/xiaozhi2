from __future__ import annotations

import sys
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m4_op45_public_reference import local_pitch_alignment  # noqa: E402


def test_edition_prefix_does_not_hide_exact_public_sequence() -> None:
    draft = [90, 91, 92, 60, 62, 64, 65, 67, 69]
    reference = [60, 62, 64, 65, 67, 69, 71]
    result = local_pitch_alignment(draft, reference)
    assert result["draftSpan"] == [3, 8]
    assert result["referenceSpan"] == [0, 5]
    assert result["exactMatches"] == 6
    assert result["substitutions"] == 0
    assert result["draftGaps"] == 0
    assert result["referenceGaps"] == 0


def test_substitution_is_not_reported_as_exact() -> None:
    result = local_pitch_alignment([60, 62, 63, 65], [60, 62, 64, 65])
    assert result["exactMatches"] == 3
    assert result["substitutions"] == 1
    assert result["alignedExactRate"] == 0.75


if __name__ == "__main__":
    test_edition_prefix_does_not_hide_exact_public_sequence()
    test_substitution_is_not_reported_as_exact()
    print("western M4 Op.45 public-reference tests passed")
