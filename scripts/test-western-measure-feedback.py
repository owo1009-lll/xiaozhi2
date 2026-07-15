from __future__ import annotations

import sys
from pathlib import Path


LIB = Path(__file__).resolve().parent / "lib"
sys.path.insert(0, str(LIB))

from western_measure_feedback import summarize_measure_evidence  # noqa: E402


def note(measure: int, state: str) -> dict:
    return {"measureIndex": measure, "evidenceState": state}


def test_issue_has_priority_over_clean_coverage() -> None:
    report = summarize_measure_evidence([
        note(1, "confirmed_correct"),
        note(1, "confirmed_correct"),
        note(1, "confirmed_correct"),
        note(1, "confirmed_correct"),
        note(1, "issue_detected"),
    ])
    assert report["measures"][0]["decision"] == "issue_detected"
    assert report["measures"][0]["studentMessageAllowed"] is True


def test_unknown_is_not_silently_promoted_to_clean() -> None:
    report = summarize_measure_evidence([
        note(2, "confirmed_correct"),
        note(2, "confirmed_correct"),
        note(2, "uncertain"),
        note(2, "unsupported"),
    ])
    assert report["measures"][0]["confirmedFraction"] == 0.5
    assert report["measures"][0]["decision"] == "insufficient_evidence"
    assert report["measures"][0]["studentMessageAllowed"] is False


def test_eighty_percent_clean_can_form_a_measure_summary() -> None:
    report = summarize_measure_evidence([
        *[note(3, "confirmed_correct") for _ in range(4)],
        note(3, "uncertain"),
    ])
    assert report["measures"][0]["decision"] == "confirmed_clean"
    assert report["decisionCoverage"] == 1.0


def test_invalid_rows_are_ignored_and_reported() -> None:
    report = summarize_measure_evidence([
        {"measureIndex": 0, "evidenceState": "confirmed_correct"},
        {"measureIndex": 1, "evidenceState": "not-a-state"},
    ])
    assert report["measureCount"] == 0
    assert report["invalidRowCount"] == 2


if __name__ == "__main__":
    test_issue_has_priority_over_clean_coverage()
    test_unknown_is_not_silently_promoted_to_clean()
    test_eighty_percent_clean_can_form_a_measure_summary()
    test_invalid_rows_are_ignored_and_reported()
    print("western measure-feedback tests passed")
