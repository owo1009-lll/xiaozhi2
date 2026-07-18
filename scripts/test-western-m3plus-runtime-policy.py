from __future__ import annotations

import importlib.util
import hashlib
import inspect
import json
import sys
from pathlib import Path

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPERIMENTS = REPO_ROOT / "scripts" / "experiments"
if str(EXPERIMENTS) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS))

import western_strings_m3plus_runtime_policy as policy  # noqa: E402


RUNNER_PATH = EXPERIMENTS / "run_western_strings_offline_feature_analysis.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("western_offline_feature_analysis_m3plus_test", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("offline-feature-analysis-module-unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ready_inputs(**overrides: object) -> dict[str, object]:
    inputs: dict[str, object] = {
        "score_midi": 60,
        "score_techniques": [],
        "score_notations": [],
        "timing_assignment_available": True,
        "window_start_seconds": 0.1,
        "window_end_seconds": 0.9,
        "total_frame_count": 40,
        "voiced_frame_count": 36,
        "voiced_frame_ratio": 0.9,
        "median_observed_midi": 60.0,
        "spread_cents_p95_p05": 20.0,
        "iqr_cents": 10.0,
    }
    inputs.update(overrides)
    return inputs


def evaluate(**overrides: object) -> dict[str, object]:
    return policy.evaluate_m3plus_pitch_safety(**ready_inputs(**overrides))


def assert_review_only(evidence: dict[str, object]) -> None:
    assert evidence["reviewOnly"] is True
    assert evidence["feedbackAuthorized"] is False
    assert evidence["studentFacing"] is False


def test_contract_and_gold_free_signature() -> None:
    descriptor = policy.runtime_policy_descriptor()
    assert descriptor["evaluationContract"] == "m3plus-rescope-four-zone-v2"
    assert descriptor["runtimeContract"] == "m3plus-gold-free-runtime-v1"
    assert descriptor["policyVersion"] == "m3plus-gold-free-pitch-safety-policy-v1"
    assert len(descriptor["policySemanticSha256"]) == 64
    assert descriptor["policySemanticSha256"] == policy.M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256
    assert_review_only(descriptor)

    parameter_names = set(inspect.signature(policy.evaluate_m3plus_pitch_safety).parameters)
    forbidden = {
        "expectedBehavior",
        "expected_behavior",
        "evaluationSplit",
        "evaluation_split",
        "humanGold",
        "human_gold",
        "gold",
    }
    assert not (parameter_names & forbidden)
    try:
        policy.evaluate_m3plus_pitch_safety(**ready_inputs(), expectedBehavior="wrong")
    except TypeError:
        pass
    else:
        raise AssertionError("gold-derived arguments must not be accepted")


def test_stable_center_and_accusation_boundary() -> None:
    confirmed = evaluate(median_observed_midi=60.5)
    assert confirmed["zone"] == "stable_center"
    assert confirmed["decision"] == "confirmed_center"
    assert confirmed["centerErrorCents"] == 50.0
    assert confirmed["accusationIssued"] is False
    assert confirmed["timingAssignmentAvailable"] is True
    assert_review_only(confirmed)

    issue = evaluate(median_observed_midi=60.5001)
    assert issue["decision"] == "issue_detected"
    assert issue["reason"] == "center-pitch-outside-tolerance"
    assert issue["accusationIssued"] is True
    assert_review_only(issue)


def test_score_marked_regions_are_neutral() -> None:
    for techniques, notations in (
        ("natural-harmonic", []),
        ([], ["trill-mark"]),
        (["inverted-mordent"], []),
        ([], ["other-ornament"]),
    ):
        evidence = evaluate(
            score_techniques=techniques,
            score_notations=notations,
            median_observed_midi=67.0,
            spread_cents_p95_p05=500.0,
        )
        assert evidence["zone"] == "score_marked_neutral"
        assert evidence["decision"] == "insufficient_evidence"
        assert evidence["reason"] == "score-marked-region-neutralized"
        assert evidence["protectedMarkings"]
        assert evidence["accusationIssued"] is False
        assert_review_only(evidence)

    protected_glissando = evaluate(
        score_techniques=["natural-harmonic", "glissando"],
        glissando_target_midi=62,
        target_tail_window_start_seconds=0.65,
        target_tail_window_end_seconds=0.9,
        target_tail_total_frame_count=20,
        target_tail_voiced_frame_count=18,
        target_tail_voiced_frame_ratio=0.9,
        target_tail_median_observed_midi=62.0,
        target_tail_spread_cents_p95_p05=20.0,
        target_tail_iqr_cents=10.0,
    )
    assert protected_glissando["zone"] == "score_marked_neutral"
    assert protected_glissando["analysisWindowKind"] == "stable-center"
    assert protected_glissando["targetMidi"] == 60
    assert protected_glissando["reason"] == "score-marked-region-neutralized"
    assert_review_only(protected_glissando)


def test_fail_closed_evidence_floors() -> None:
    cases = (
        ({"timing_assignment_available": False}, "timing-assignment-missing"),
        ({"window_start_seconds": None}, "pitch-window-missing"),
        ({"total_frame_count": 11}, "pitch-window-frame-count-below-floor"),
        (
            {"total_frame_count": 40, "voiced_frame_count": 11, "voiced_frame_ratio": 0.9},
            "voiced-frame-count-below-floor",
        ),
        ({"voiced_frame_ratio": 0.699999}, "voiced-frame-ratio-below-floor"),
        ({"median_observed_midi": None}, "center-pitch-missing"),
        ({"spread_cents_p95_p05": None}, "pitch-dispersion-missing"),
        ({"iqr_cents": None}, "pitch-dispersion-missing"),
        ({"spread_cents_p95_p05": 80.0001}, "pitch-dispersion-too-high"),
        ({"iqr_cents": 80.0001}, "pitch-dispersion-too-high"),
    )
    for overrides, expected_reason in cases:
        evidence = evaluate(**overrides)
        assert evidence["decision"] == "insufficient_evidence", (overrides, evidence)
        assert evidence["reason"] == expected_reason, (overrides, evidence)
        assert evidence["accusationIssued"] is False
        assert_review_only(evidence)
    assert evaluate(spread_cents_p95_p05=80.0001)["highDispersion"] is True


def test_glissando_target_tail_and_polyphony() -> None:
    glissando = evaluate(
        score_notations=["glissando"],
        median_observed_midi=60.0,
        glissando_target_midi=62,
        target_tail_window_start_seconds=0.65,
        target_tail_window_end_seconds=0.9,
        target_tail_total_frame_count=20,
        target_tail_voiced_frame_count=18,
        target_tail_voiced_frame_ratio=0.9,
        target_tail_median_observed_midi=62.0,
        target_tail_spread_cents_p95_p05=20.0,
        target_tail_iqr_cents=10.0,
    )
    assert glissando["zone"] == "glissando_target_tail"
    assert glissando["analysisWindowKind"] == "glissando-target-tail"
    assert glissando["targetMidi"] == 62
    assert glissando["medianObservedMidi"] == 62.0
    assert glissando["decision"] == "confirmed_center"
    assert_review_only(glissando)

    unresolved = evaluate(score_notations=["glissando"])
    assert unresolved["decision"] == "insufficient_evidence"
    assert unresolved["reason"] == "glissando-target-unavailable"
    assert unresolved["accusationIssued"] is False

    polyphonic = evaluate(polyphonic_score_region=True, median_observed_midi=67.0)
    assert polyphonic["zone"] == "multi_f0_review_only"
    assert polyphonic["decision"] == "insufficient_evidence"
    assert polyphonic["reason"] == "polyphonic-score-region-requires-multi-f0"
    assert polyphonic["accusationIssued"] is False


def test_analyzer_score_context_and_candidate_schema() -> None:
    runner = load_runner()
    analyzer_bytes = RUNNER_PATH.read_bytes()
    analyzer_runtime = runner.m3plus_analyzer_runtime_descriptor()
    assert analyzer_runtime["analyzerArtifactPath"] == (
        "scripts/experiments/run_western_strings_offline_feature_analysis.py"
    )
    assert analyzer_runtime["analyzerArtifactSha256"] == hashlib.sha256(analyzer_bytes).hexdigest()
    assert analyzer_runtime["analyzerArtifactSemanticSha256"] == hashlib.sha256(
        analyzer_bytes.replace(b"\r\n", b"\n")
    ).hexdigest()
    assert analyzer_runtime["pyinRuntime"] == {
        "backend": "librosa-pyin",
        "pythonVersion": "3.11.9",
        "librosaVersion": "0.11.0",
        "numpyVersion": "1.26.4",
        "sampleRateHz": 22050,
        "hopLength": 512,
        "frameLength": 2048,
        "fminNote": "C2",
        "fmaxNote": "A7",
        "voicedMask": "finite-f0-and-librosa-voiced",
    }
    store = {
        "scores": [
            {
                "scoreId": "runtime-policy-fixture",
                "sections": [
                    {
                        "sectionId": "s1",
                        "tempo": 60,
                        "meter": "4/4",
                        "notes": [
                            {
                                "noteId": "gliss-start",
                                "midiPitch": 60,
                                "measureIndex": 1,
                                "beatStart": 0,
                                "beatDuration": 1,
                                "articulations": ["Accent"],
                                "techniques": ["Legato"],
                                "notations": ["Glissando"],
                            },
                            {
                                "noteId": "gliss-stop",
                                "midiPitch": 62,
                                "measureIndex": 1,
                                "beatStart": 1,
                                "beatDuration": 1,
                                "notations": ["Glissando"],
                            },
                            {
                                "noteId": "chord-a",
                                "midiPitch": 64,
                                "measureIndex": 1,
                                "beatStart": 2,
                                "beatDuration": 1,
                            },
                            {
                                "noteId": "chord-b",
                                "midiPitch": 67,
                                "measureIndex": 1,
                                "beatStart": 2,
                                "beatDuration": 1,
                            },
                        ],
                    }
                ],
            }
        ]
    }
    _, notes = runner.collect_score_notes(store, "runtime-policy-fixture")
    assert notes[0]["articulations"] == ["accent"]
    assert notes[0]["techniques"] == ["legato"]
    assert notes[0]["notations"] == ["glissando"]
    assert notes[0]["glissandoTargetMidi"] == 62
    assert notes[0]["glissandoTargetNoteId"] == "gliss-stop"
    assert notes[1]["glissandoTargetMidi"] is None
    assert notes[2]["onsetGroupSize"] == notes[3]["onsetGroupSize"] == 2
    assert notes[2]["polyphonicScoreRegion"] is True

    runtime_note = {
        "noteId": "stable-note",
        "sectionId": "s1",
        "sectionTitle": "fixture",
        "measureIndex": 1,
        "beatStart": 0.0,
        "beatDuration": 1.0,
        "position": {"measureIndex": 1, "pageNumber": 1},
        "midi": 60,
        "scoreUnit": 0.0,
        "scoreOnsetUnit": 0.0,
        "articulations": ["accent"],
        "techniques": [],
        "notations": [],
        "onsetGroupSize": 1,
        "polyphonicScoreRegion": False,
        "glissandoTargetMidi": None,
        "glissandoTargetNoteId": None,
    }
    times = np.linspace(0.0, 1.0, 101)
    midi_track = np.full(times.shape, 60.0)
    assignment = {
        "time": 0.0,
        "end": 1.0,
        "eventMidi": 60,
        "confidence": 0.9,
        "pitchDistanceSemitones": 0,
    }
    decisions = runner.build_decisions(
        [runtime_note],
        times,
        midi_track,
        1.0,
        0,
        timing_assignments=[assignment],
        analysis_mode="basic-pitch-dtw-pyin-review-v1",
    )
    rows = runner.build_candidate_rows(decisions)
    assert len(rows) == 1
    row = rows[0]
    evidence = row["m3plusPitchSafetyEvidence"]
    assert row["beatStart"] == 0.0
    assert row["beatDuration"] == 1.0
    assert row["scoreArticulations"] == ["accent"]
    assert row["onsetGroupSize"] == 1
    assert row["polyphonicScoreRegion"] is False
    assert row["totalFrameCount"] >= 12
    assert row["voicedFrameRatio"] == 1.0
    assert row["spreadCentsP95P05"] == 0.0
    assert row["iqrCents"] == 0.0
    assert evidence["decision"] == "confirmed_center"
    assert evidence["timingAssignmentAvailable"] is True
    assert row["m3plusTimingAssignmentAvailable"] is True
    assert row["feedbackAuthorized"] is False
    assert row["studentFacing"] is False
    assert_review_only(evidence)

    summary = runner.summarize(decisions, {"scoreId": "runtime-policy-fixture"}, 1.0, 1, "test")
    runtime = summary["m3plusPitchSafetyRuntime"]
    assert runtime["policySemanticSha256"] == policy.M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256
    assert runtime["analyzerArtifactSha256"] == analyzer_runtime["analyzerArtifactSha256"]
    assert runtime["analyzerArtifactSemanticSha256"] == analyzer_runtime["analyzerArtifactSemanticSha256"]
    assert runtime["pyinRuntime"] == analyzer_runtime["pyinRuntime"]
    assert runtime["reviewOnlyRuntimeWired"] is True
    assert runtime["decisionCounts"]["confirmed_center"] == 1
    assert_review_only(runtime)

    linear_decisions = runner.build_decisions(
        [runtime_note],
        times,
        midi_track,
        1.0,
        0,
        timing_assignments=None,
    )
    linear_row = runner.build_candidate_rows(linear_decisions)[0]
    assert linear_row["timingAssignmentAvailable"] is True  # Legacy ordinary-pipeline meaning.
    assert linear_row["m3plusTimingAssignmentAvailable"] is False
    assert linear_row["m3plusPitchSafetyEvidence"]["reason"] == "timing-assignment-missing"


def main() -> None:
    test_contract_and_gold_free_signature()
    test_stable_center_and_accusation_boundary()
    test_score_marked_regions_are_neutral()
    test_fail_closed_evidence_floors()
    test_glissando_target_tail_and_polyphony()
    test_analyzer_score_context_and_candidate_schema()
    print(
        json.dumps(
            {
                "ok": True,
                "checks": [
                    "gold-free-contract",
                    "stable-center-boundary",
                    "protected-score-markings",
                    "fail-closed-evidence-floors",
                    "glissando-target-tail",
                    "polyphonic-review-only",
                    "analyzer-candidate-schema",
                    "analyzer-artifact-and-pyin-runtime-binding",
                    "student-feedback-disabled",
                ],
                "policySemanticSha256": policy.M3PLUS_RUNTIME_POLICY_SEMANTIC_SHA256,
            }
        )
    )


if __name__ == "__main__":
    main()
