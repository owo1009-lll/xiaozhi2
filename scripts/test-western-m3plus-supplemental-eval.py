from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_strings_m3plus_supplemental import (  # noqa: E402
    DEFAULT_SOURCE,
    align_units_to_track,
    attach_session_pitch_baseline,
    build_alignment_units,
    evaluate_track,
    infer_modes,
    mode_metrics,
    periodic_pitch_features,
    resolve_f0_backend,
    run_evaluation,
    validate_score_technique_intent,
)


def synthetic_track(recording: dict) -> tuple[np.ndarray, np.ndarray, float]:
    units = build_alignment_units(recording)
    frames_per_unit = 80
    frame_seconds = 0.025
    times: list[float] = []
    midi: list[float] = []
    cursor = 0.0
    for unit in units:
        base = float(unit["baseMidi"])
        auxiliary = unit.get("auxiliaryMidi")
        local_times = np.arange(frames_per_unit, dtype=np.float64) * frame_seconds
        behavior = str(unit.get("expectedBehavior") or "")
        if behavior == "vibrato":
            values = base + 0.35 * np.sin(2.0 * np.pi * 5.0 * local_times)
        elif behavior == "trill":
            assert auxiliary is not None
            values = np.where((np.arange(frames_per_unit) // 4) % 2 == 0, base, float(auxiliary))
        elif behavior == "ornament-upper-mordent":
            assert auxiliary is not None
            values = np.full(frames_per_unit, base, dtype=np.float64)
            values[6:12] = float(auxiliary)
        elif behavior == "slide-source":
            assert auxiliary is not None
            values = np.linspace(base, float(auxiliary), frames_per_unit)
        else:
            values = np.full(frames_per_unit, base, dtype=np.float64)
        times.extend((cursor + local_times).tolist())
        midi.extend(values.tolist())
        cursor += frames_per_unit * frame_seconds
    return np.asarray(times), np.asarray(midi), cursor


def test_synthetic_fixed_sequences_localize_and_separate_modes() -> None:
    intent = json.loads((DEFAULT_SOURCE / "score-intent.json").read_text(encoding="utf-8"))
    reports = []
    for recording in intent["recordings"]:
        times, midi, duration = synthetic_track(recording)
        report = evaluate_track(recording, times, midi, duration)
        assert report["localization"]["ready"] is True, recording["recordingId"]
        assert report["analyzedUnitCount"] == report["expectedUnitCount"]
        reports.append(report)
    baseline = attach_session_pitch_baseline(reports)
    rows = [row for report in reports for row in report["rows"]]
    metrics = mode_metrics(rows)
    holdout = mode_metrics([row for row in rows if row["evaluationSplit"] == "holdout"])
    assert baseline["ready"] is True, baseline
    assert baseline["controlCount"] >= 4
    straight_rows = [row for row in rows if row["expectedBehavior"] == "stable"]
    assert all(
        row["modeDiagnostics"]["relativePitchActivityState"] == "straight"
        for row in straight_rows
    )
    assert all(metric["passed"] is True for metric in metrics.values()), metrics
    assert all(metric["passed"] is True for metric in holdout.values()), holdout


def test_score_markings_are_the_source_of_expected_techniques() -> None:
    intent = json.loads((DEFAULT_SOURCE / "score-intent.json").read_text(encoding="utf-8"))
    reports = [validate_score_technique_intent(DEFAULT_SOURCE, recording) for recording in intent["recordings"]]
    assert all(report["ready"] is True for report in reports), reports
    assert sum(report["checkedLabelCount"] for report in reports) == 64


def test_localization_tolerates_realistic_pitch_offset_without_certifying_intonation() -> None:
    intent = json.loads((DEFAULT_SOURCE / "score-intent.json").read_text(encoding="utf-8"))
    straight = next(recording for recording in intent["recordings"] if recording["recordingId"] == "m3p-01")
    times, midi, duration = synthetic_track(straight)
    within_localization_tolerance = evaluate_track(straight, times, midi + 0.90, duration)
    outside_localization_tolerance = evaluate_track(straight, times, midi + 1.30, duration)
    assert within_localization_tolerance["localization"]["ready"] is True
    assert outside_localization_tolerance["localization"]["ready"] is False
    assert all(row["studentFacing"] is False for row in within_localization_tolerance["rows"])


def test_declared_octave_transposition_is_localization_only() -> None:
    intent = json.loads((DEFAULT_SOURCE / "score-intent.json").read_text(encoding="utf-8"))
    straight = next(
        recording
        for recording in intent["recordings"]
        if recording["recordingId"] == "m3p-01"
    )
    times, midi, duration = synthetic_track(straight)
    without_transposition = evaluate_track(straight, times, midi + 12.0, duration)
    with_transposition = evaluate_track(
        straight,
        times,
        midi + 12.0,
        duration,
        score_transpose_semitones=12.0,
    )
    assert without_transposition["localization"]["ready"] is False
    assert with_transposition["localization"]["ready"] is True
    assert with_transposition["localization"]["scoreTransposeSemitones"] == 12.0
    assert all(row["studentFacing"] is False for row in with_transposition["rows"])


def test_repeated_units_keep_nontrivial_frame_runs() -> None:
    units = [
        {"baseMidi": 60.0, "auxiliaryMidi": None, "unitIndex": index}
        for index in range(8)
    ]
    times = np.arange(0.0, 8.0, 0.01, dtype=np.float64)
    midi = np.full(times.size, 60.0, dtype=np.float64)
    alignment = align_units_to_track(units, times, midi)
    assert alignment["localizationReady"] is True
    assert alignment["minUnitFrames"] >= 4
    assert (
        min(unit["assignedVoicedFrameCount"] for unit in alignment["units"])
        >= alignment["minUnitFrames"]
    )
    assert (
        max(unit["assignedVoicedFrameCount"] for unit in alignment["units"])
        <= alignment["maxUnitFrames"]
    )


def test_borderline_modulation_is_uncertain_instead_of_forced_binary() -> None:
    times = np.arange(0.0, 1.0, 0.01, dtype=np.float64)
    midi = 60.0 + 0.15 * np.sin(2.0 * np.pi * 5.0 * times)
    unit = {
        "baseMidi": 60.0,
        "auxiliaryMidi": None,
        "startSeconds": 0.0,
        "endSeconds": 0.99,
        "localizationUnitReady": True,
    }
    predicted, decisions, diagnostics = infer_modes(unit, times, midi)
    assert decisions["vibrato"] == "uncertain"
    assert "vibrato" not in predicted
    assert 4.0 <= diagnostics["periodicDominantRateHz"] <= 8.0


def test_periodic_pitch_features_expose_vibrato_autocorrelation() -> None:
    times = np.arange(0.0, 1.2, 0.01, dtype=np.float64)
    midi = 60.0 + 0.30 * np.sin(2.0 * np.pi * 5.0 * times)
    features = periodic_pitch_features(times, midi, center_midi=60.0)
    assert features["periodicAutocorrelationPeak4To8Hz"] is not None
    assert float(features["periodicAutocorrelationPeak4To8Hz"]) > 0.80
    assert 4.5 <= float(features["periodicAutocorrelationRateHz"]) <= 5.5


def test_uncertain_rows_reduce_gate_coverage_and_positive_recall() -> None:
    rows = []
    for index in range(8):
        expected_positive = index < 4
        rows.append(
            {
                "expectedPositiveModes": ["vibrato"] if expected_positive else [],
                "expectedNegativeModes": [] if expected_positive else ["vibrato"],
                "modeDecisions": {"vibrato": "uncertain"},
            }
        )
    metric = mode_metrics(rows)["vibrato"]
    assert metric["decisionCoverage"] == 0.0
    assert metric["recall"] == 0.0
    assert metric["passed"] is False


def test_dirty_f0_is_review_only_not_false_absence() -> None:
    times = np.arange(0.0, 1.0, 0.01, dtype=np.float64)
    midi = np.full(times.size, 60.0, dtype=np.float64)
    midi[::2] = np.nan
    midi[5::20] = 72.0
    unit = {
        "baseMidi": 60.0,
        "auxiliaryMidi": None,
        "startSeconds": 0.0,
        "endSeconds": 0.99,
        "localizationUnitReady": True,
    }
    predicted, decisions, diagnostics = infer_modes(unit, times, midi)
    assert predicted == []
    assert set(decisions.values()) == {"uncertain"}
    assert diagnostics["f0QualityReady"] is False
    assert diagnostics["voicedCoverageRate"] < 0.70


def test_missing_real_audio_fails_closed_without_fake_gold() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        source = Path(temporary)
        (source / "score-intent.json").write_text(
            (DEFAULT_SOURCE / "score-intent.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        report = run_evaluation(source, performance_confirmed=False)
    assert report["machineAnalysisComplete"] is False
    assert report["studentGateReady"] is False
    assert report["performanceGoldReady"] is False
    assert report["humanTask"] == "record-m3plus-supplemental-takes"
    assert len([reason for reason in report["blockingReasons"] if reason.endswith("audio-missing")]) == 4


def test_f0_backend_selection_is_explicit_and_bounded() -> None:
    assert resolve_f0_backend("pyin") == "pyin"
    assert resolve_f0_backend("crepe") == "crepe"
    assert resolve_f0_backend("auto") in {"crepe", "pyin"}
    try:
        resolve_f0_backend("unknown")
    except ValueError as error:
        assert str(error) == "unsupported-f0-backend:unknown"
    else:
        raise AssertionError("unsupported F0 backends must fail closed")


def test_crepe_model_defaults_to_bounded_tiny_model() -> None:
    import inspect

    assert inspect.signature(run_evaluation).parameters["crepe_model"].default == "tiny"
    assert (
        inspect.signature(run_evaluation)
        .parameters["crepe_periodicity_threshold"]
        .default
        == 0.30
    )
    with tempfile.TemporaryDirectory() as temporary:
        try:
            run_evaluation(Path(temporary), performance_confirmed=False, crepe_model="unknown")
        except ValueError as error:
            assert str(error) == "unsupported-crepe-model:unknown"
        else:
            raise AssertionError("unsupported CREPE models must fail closed")
        try:
            run_evaluation(
                Path(temporary),
                performance_confirmed=False,
                crepe_periodicity_threshold=1.1,
            )
        except ValueError as error:
            assert str(error) == "crepe_periodicity_threshold must be between 0 and 1"
        else:
            raise AssertionError("invalid CREPE periodicity thresholds must fail closed")


if __name__ == "__main__":
    test_synthetic_fixed_sequences_localize_and_separate_modes()
    test_score_markings_are_the_source_of_expected_techniques()
    test_localization_tolerates_realistic_pitch_offset_without_certifying_intonation()
    test_declared_octave_transposition_is_localization_only()
    test_repeated_units_keep_nontrivial_frame_runs()
    test_borderline_modulation_is_uncertain_instead_of_forced_binary()
    test_periodic_pitch_features_expose_vibrato_autocorrelation()
    test_uncertain_rows_reduce_gate_coverage_and_positive_recall()
    test_dirty_f0_is_review_only_not_false_absence()
    test_missing_real_audio_fails_closed_without_fake_gold()
    test_f0_backend_selection_is_explicit_and_bounded()
    test_crepe_model_defaults_to_bounded_tiny_model()
    print("western M3+ supplemental machine-eval tests passed")
