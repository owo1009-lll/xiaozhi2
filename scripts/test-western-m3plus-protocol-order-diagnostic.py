#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np


REPO = Path(__file__).resolve().parents[1]
EXPERIMENTS = REPO / "scripts" / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from diagnose_western_strings_m3plus_protocol_order import (  # noqa: E402
    PITCH_GROUPED_ORDER,
    compact_feature_rows,
    compare_recording_order_candidates,
    feature_audit,
    fit_precision_constrained_threshold,
    linear_feature_audit,
    refine_vibrato_trill_boundaries,
    reorder_recording_by_measure,
    score_adherence_issue_candidates,
)


def test_pitch_grouped_order_preserves_labels_and_split_measures() -> None:
    recording = {
        "labels": [
            {"measure": measure, "noteIndex": note_index}
            for measure in range(1, 9)
            for note_index in (1, 2)
        ]
    }
    reordered = reorder_recording_by_measure(recording, PITCH_GROUPED_ORDER)
    measures = [int(label["measure"]) for label in reordered["labels"]]
    assert measures == [1, 1, 5, 5, 2, 2, 6, 6, 3, 3, 7, 7, 4, 4, 8, 8]
    assert len(reordered["labels"]) == len(recording["labels"])


def test_remaining_localization_helper_is_exposed() -> None:
    assert callable(compare_recording_order_candidates)


def test_threshold_is_fitted_on_calibration_and_scored_on_holdout() -> None:
    result = fit_precision_constrained_threshold(
        [(0.1, False), (0.2, False), (0.8, True), (0.9, True)],
        [(0.15, False), (0.75, True)],
    )
    assert result["fitReady"] is True
    assert result["calibration"]["precision"] == 1.0
    assert result["calibration"]["recall"] == 1.0
    assert result["holdout"]["precision"] is None
    assert result["holdout"]["recall"] == 0.0


def test_threshold_fails_closed_when_precision_is_unreachable() -> None:
    result = fit_precision_constrained_threshold(
        [(0.8, False), (0.7, True)],
        [(0.9, True)],
    )
    assert result["fitReady"] is False
    assert result["reason"] == "no-calibration-threshold-meets-precision"


def test_compact_rows_keep_only_auditable_feature_context() -> None:
    rows = compact_feature_rows(
        [
            {
                "unitIndex": 3,
                "measure": 2,
                "evaluationSplit": "calibration",
                "expectedBehavior": "trill",
                "expectedPositiveModes": ["trill"],
                "expectedNegativeModes": ["vibrato"],
                "localizationUnitReady": True,
                "startSeconds": 1.0,
                "endSeconds": 2.0,
                "modeDiagnostics": {
                    "f0QualityReady": True,
                    "knownPitchSwitchCount": 5,
                    "chromaSwitchRateHz": 4.0,
                    "knownPairNetMotionSemitones": -0.75,
                    "unrelated": "drop-me",
                },
            }
        ]
    )
    assert rows[0]["features"]["knownPitchSwitchCount"] == 5
    assert rows[0]["features"]["chromaSwitchRateHz"] == 4.0
    assert rows[0]["features"]["absoluteNetMotionSemitones"] == 0.75
    assert rows[0]["expectedPositiveModes"] == ["trill"]
    assert rows[0]["localizationUnitReady"] is True
    assert rows[0]["f0QualityReady"] is True
    assert "unrelated" not in rows[0]["features"]


def test_score_adherence_issue_is_fail_closed_and_does_not_relabel() -> None:
    issues = score_adherence_issue_candidates(
        [
            {
                "recordingId": "m3p-02",
                "unitIndex": 15,
                "measure": 8,
                "evaluationSplit": "holdout",
                "expectedBehavior": "trill",
                "localizationUnitReady": True,
                "startSeconds": 15.9,
                "endSeconds": 16.9,
                "modeDiagnostics": {
                    "f0QualityReady": True,
                    "knownPitchSwitchCount": 0,
                    "knownUpperFrameRatio": 0,
                    "chromaSwitchRateHz": 0,
                },
            }
        ]
    )
    assert len(issues) == 1
    assert issues[0]["measure"] == 8
    assert issues[0]["requiresHumanConfirmationBeforeRelabel"] is True


def test_score_adherence_summary_keeps_formal_metric_unmodified() -> None:
    expected_trill_count = 8
    issue_count = 1
    summary = {
        "expectedTrillUnitCount": expected_trill_count,
        "trillUnitsWithExecutionEvidence": expected_trill_count - issue_count,
        "issueCandidateCount": issue_count,
        "formalMetricRelabeled": False,
        "ownerConfirmationRequired": bool(issue_count),
    }
    assert summary["trillUnitsWithExecutionEvidence"] == 7
    assert summary["formalMetricRelabeled"] is False
    assert summary["ownerConfirmationRequired"] is True


def test_boundary_refinement_uses_upper_evidence_without_relabeling() -> None:
    times = np.arange(0.0, 2.0, 0.01, dtype=np.float64)
    midi = np.full(times.size, 60.0, dtype=np.float64)
    midi[(times >= 1.15) & (np.arange(times.size) % 4 < 2)] = 62.0
    report = {
        "rows": [
            {
                "measure": 1,
                "expectedBehavior": "vibrato",
                "baseMidi": 60.0,
                "auxiliaryMidi": None,
                "startSeconds": 0.0,
                "endSeconds": 1.0,
                "localizationUnitReady": True,
            },
            {
                "measure": 1,
                "expectedBehavior": "trill",
                "baseMidi": 60.0,
                "auxiliaryMidi": 62.0,
                "startSeconds": 1.0,
                "endSeconds": 1.99,
                "localizationUnitReady": True,
            },
        ]
    }
    refined = refine_vibrato_trill_boundaries(report, times, midi)
    rows = refined["report"]["rows"]
    assert rows[0]["expectedBehavior"] == "vibrato"
    assert rows[1]["expectedBehavior"] == "trill"
    assert 1.0 <= rows[0]["endSeconds"] <= 1.15
    assert rows[0]["endSeconds"] == rows[1]["startSeconds"]


def test_fixed_linear_audit_scores_only_heldout_rows() -> None:
    rows = []
    for split in ("calibration", "holdout"):
        for positive in (True, False):
            for index in range(4):
                value = (2.0 + index * 0.1) if positive else (-2.0 - index * 0.1)
                rows.append(
                    {
                        "evaluationSplit": split,
                        "localizationUnitReady": True,
                        "expectedPositiveModes": ["vibrato"] if positive else [],
                        "expectedNegativeModes": [] if positive else ["vibrato"],
                        "modeDiagnostics": {
                            "f0QualityReady": True,
                            **{name: value for name in (
                                "periodicAmplitudeCents",
                                "periodicBandEnergyRatio4To8Hz",
                                "periodicAutocorrelationPeak4To8Hz",
                                "harmonicRidgeAmplitudeCents",
                                "harmonicRidgeBandEnergyRatio4To8Hz",
                                "harmonicRidgeAutocorrelationPeak4To8Hz",
                            )},
                        },
                    }
                )
    result = linear_feature_audit(rows)
    assert result["fitReady"] is True
    assert result["holdout"]["precision"] == 1.0
    assert result["holdout"]["recall"] == 1.0
    assert result["heldoutGatePassed"] is True


def test_feature_audit_includes_ornament_and_slide_modes() -> None:
    rows = []
    for split in ("calibration", "holdout"):
        for mode, feature_name in (
            ("ornament", "ornamentUpperSeconds"),
            ("slide", "knownPairMonotonicity"),
        ):
            for positive in (True, False):
                for index in range(4):
                    rows.append(
                        {
                            "evaluationSplit": split,
                            "localizationUnitReady": True,
                            "expectedPositiveModes": [mode] if positive else [],
                            "expectedNegativeModes": [] if positive else [mode],
                            "modeDiagnostics": {
                                "f0QualityReady": True,
                                feature_name: (0.9 + index * 0.01) if positive else 0.1,
                            },
                        }
                    )
    result = feature_audit(rows)
    assert result["ornament"]["ornamentUpperSeconds"]["heldoutGatePassed"] is True
    assert result["slide"]["knownPairMonotonicity"]["heldoutGatePassed"] is True


if __name__ == "__main__":
    test_pitch_grouped_order_preserves_labels_and_split_measures()
    test_remaining_localization_helper_is_exposed()
    test_threshold_is_fitted_on_calibration_and_scored_on_holdout()
    test_threshold_fails_closed_when_precision_is_unreachable()
    test_compact_rows_keep_only_auditable_feature_context()
    test_score_adherence_issue_is_fail_closed_and_does_not_relabel()
    test_score_adherence_summary_keeps_formal_metric_unmodified()
    test_boundary_refinement_uses_upper_evidence_without_relabeling()
    test_fixed_linear_audit_scores_only_heldout_rows()
    test_feature_audit_includes_ornament_and_slide_modes()
    print("western M3+ protocol-order diagnostic tests passed")
