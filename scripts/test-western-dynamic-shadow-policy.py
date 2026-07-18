from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPERIMENTS = REPO_ROOT / "scripts" / "experiments"
if str(EXPERIMENTS) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS))

import western_strings_dynamic_shadow_policy as policy  # noqa: E402
import eval_western_strings_injected_errors_dynamic_gate as frozen_eval  # noqa: E402


RUNNER_PATH = EXPERIMENTS / "run_western_strings_offline_feature_analysis.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("western_offline_feature_analysis_shadow_test", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("offline-feature-analysis-module-unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ready_features(**overrides: object) -> dict[str, object]:
    features: dict[str, object] = {
        "pitchDistanceSemitones": 0,
        "eventConfidence": 0.8,
        "relativeIoiDeviationRatio": 0.05,
        "relativeEventConfidence": 1.0,
        "eventDurationSeconds": 0.2,
        "nearestSamePitchScoreDistanceQuarters": None,
        "expectedDurationSeconds": 0.5,
        "eventDurationRatio": 0.4,
    }
    features.update(overrides)
    return features


def test_policy_contract() -> None:
    evidence = policy.build_dynamic_shadow_evidence(
        ready_features(),
        timing_mode="basic-pitch-dtw",
    )
    assert evidence["contractVersion"] == "western-ordinary-dynamic-shadow-candidate-v1"
    assert evidence["policyVersion"] == "western-ordinary-dynamic-shadow-policy-v1"
    assert evidence["selected"] is True
    assert evidence["blockingReasons"] == []
    assert evidence["energyVetoIncluded"] is False
    assert evidence["causalEnergyStatus"] == "excluded-review-only"
    assert policy.DYNAMIC_SHADOW_POLICY["minEventDurationRatio"] == 0.15
    assert not ({"target", "goldTime", "onsetErrorSeconds"} & set(evidence))

    floor = policy.build_dynamic_shadow_evidence(
        ready_features(eventDurationRatio=0.15),
        timing_mode="basic-pitch-dtw",
    )
    assert floor["selected"] is True
    below = policy.build_dynamic_shadow_evidence(
        ready_features(eventDurationRatio=0.149999),
        timing_mode="basic-pitch-dtw",
    )
    assert below["selected"] is False
    assert "event-duration-ratio-below-minimum" in below["blockingReasons"]
    wrong_pitch = policy.build_dynamic_shadow_evidence(
        ready_features(pitchDistanceSemitones=1),
        timing_mode="basic-pitch-dtw",
    )
    assert wrong_pitch["selected"] is False
    assert "pitch-distance-not-zero" in wrong_pitch["blockingReasons"]
    linear = policy.build_dynamic_shadow_evidence(ready_features(), timing_mode="linear")
    assert linear["selected"] is False
    assert "timing-mode-not-basic-pitch-dtw" in linear["blockingReasons"]
    missing_same_pitch = ready_features()
    missing_same_pitch.pop("nearestSamePitchScoreDistanceQuarters")
    missing = policy.build_dynamic_shadow_evidence(
        missing_same_pitch,
        timing_mode="basic-pitch-dtw",
    )
    assert missing["selected"] is False
    assert "same-pitch-distance-missing" in missing["blockingReasons"]


def test_runtime_feature_builder() -> None:
    notes = [{"midi": 60 + index, "scoreUnit": float(index)} for index in range(5)]
    assignments = [
        {
            "time": float(index),
            "end": float(index) + 0.5,
            "confidence": 0.9,
            "pitchDistanceSemitones": 0,
        }
        for index in range(5)
    ]
    relative_ioi = [{"relativeIoiDeviationRatio": 0.0} for _ in notes]
    rows = policy.build_dynamic_candidate_features(notes, assignments, relative_ioi)
    assert len(rows) == len(notes)
    assert rows[2]["eventDurationSeconds"] == 0.5
    assert rows[2]["expectedDurationSeconds"] == 1.0
    assert rows[2]["eventDurationRatio"] == 0.5
    assert rows[2]["relativeEventConfidence"] == 1.0
    assert rows[2]["pitchDistanceSemitones"] == 0
    evidence = policy.build_dynamic_shadow_evidence(rows[2], timing_mode="basic-pitch-dtw")
    assert evidence["selected"] is True

    # Four tempo samples [1, 1, 3, 3] must preserve the frozen evaluator's
    # upper-middle convention (3), rather than statistics.median (2).
    uneven_assignments = [
        {**assignment, "time": time, "end": time + 0.5}
        for assignment, time in zip(assignments, (0.0, 1.0, 2.0, 5.0, 8.0))
    ]
    uneven_rows = policy.build_dynamic_candidate_features(
        notes,
        uneven_assignments,
        relative_ioi,
    )
    assert uneven_rows[2]["expectedDurationSeconds"] == 3.0

    chord_notes = [dict(note) for note in notes]
    chord_notes[3]["scoreUnit"] = chord_notes[2]["scoreUnit"]
    chord_rows = policy.build_dynamic_candidate_features(
        chord_notes,
        uneven_assignments,
        relative_ioi,
    )
    assert chord_rows[2]["expectedDurationSeconds"] is None
    assert chord_rows[2]["eventDurationRatio"] is None


def test_content_addressed_basic_pitch_cache() -> None:
    runner = load_runner()
    calls: list[str] = []

    def fake_predict(audio_path: str, **_kwargs: object):
        calls.append(audio_path)
        return None, None, [(0.0, 0.25, 60, 0.9)]

    with tempfile.TemporaryDirectory(prefix="western-dynamic-shadow-cache-") as temp_dir:
        root = Path(temp_dir)
        cache = root / "cache"
        first_audio = root / "first.wav"
        same_audio = root / "renamed.wav"
        first_audio.write_bytes(b"same-audio-content")
        same_audio.write_bytes(b"same-audio-content")

        first, cold = runner.load_basic_pitch_events_with_provenance(
            first_audio,
            cache,
            model_version="model-v1",
            predict_fn=fake_predict,
        )
        second, warm = runner.load_basic_pitch_events_with_provenance(
            same_audio,
            cache,
            model_version="model-v1",
            predict_fn=fake_predict,
        )
        assert first == second
        assert len(calls) == 1, "renaming identical audio must keep the same content cache key"
        assert cold["cacheHit"] is False
        assert warm["cacheHit"] is True
        assert cold["cachePath"] == warm["cachePath"]
        assert cold["cacheArtifactSha256"] == warm["cacheArtifactSha256"]
        assert cold["audioSha256"] == warm["audioSha256"]
        assert cold["modelVersion"] == warm["modelVersion"] == "model-v1"
        assert cold["modelArtifactSha256"] == warm["modelArtifactSha256"]
        assert cold["identityBound"] is True and warm["identityBound"] is True
        assert cold["policyVersion"] == "western-ordinary-dynamic-shadow-policy-v1"

        runner.load_basic_pitch_events(
            same_audio,
            cache,
            model_version="model-v2",
            predict_fn=fake_predict,
        )
        assert len(calls) == 2, "model version changes must invalidate the cache"
        same_audio.write_bytes(b"changed-audio-content")
        runner.load_basic_pitch_events(
            same_audio,
            cache,
            model_version="model-v2",
            predict_fn=fake_predict,
        )
        assert len(calls) == 3, "audio content changes must invalidate the cache"

        payloads = [json.loads(path.read_text(encoding="utf-8")) for path in cache.glob("*.json")]
        assert len(payloads) == 3
        assert all(payload["schemaVersion"] == 3 for payload in payloads)
        assert all(len(payload["cacheIdentity"]["audioSha256"]) == 64 for payload in payloads)
        assert all(
            payload["cacheIdentity"]["modelArtifactSha256"]
            == runner.BASIC_PITCH_MODEL_ARTIFACT_SHA256
            for payload in payloads
        )
        assert all(
            payload["cacheIdentity"]["policyVersion"]
            == "western-ordinary-dynamic-shadow-policy-v1"
            for payload in payloads
        )
        assert all(
            payload["cacheIdentity"]["runtimeConfigSemanticSha256"]
            == runner.ORDINARY_AUDIO_RUNTIME_CONFIG_SHA256
            for payload in payloads
        )
        assert all(
            payload["cacheIdentity"]["runtimeRequirementsLockSha256"]
            == runner.ORDINARY_AUDIO_RUNTIME_LOCK_SHA256
            for payload in payloads
        )


def test_frozen_feature_equivalence() -> None:
    runner = load_runner()
    notes = [
        {"midi": midi, "scoreUnit": float(index), "scoreOnsetUnit": float(index)}
        for index, midi in enumerate((60, 62, 64, 65, 67, 69))
    ]
    events = [
        {"start": start, "end": start + duration, "midi": midi, "confidence": confidence}
        for start, duration, midi, confidence in (
            (0.0, 0.3, 60, 0.8),
            (1.0, 0.4, 62, 0.9),
            (2.0, 0.2, 64, 0.7),
            (4.0, 0.6, 65, 0.8),
            (6.0, 0.5, 67, 0.9),
            (8.0, 0.7, 69, 0.85),
        )
    ]
    frozen_rows = frozen_eval.build_rows(notes, events)
    assignments = runner.assign_basic_pitch_events(notes, events)
    relative_ioi = runner.compute_relative_ioi_features(
        notes,
        assignments,
        consistency_limit=frozen_eval.FROZEN_POLICY["deviationLimit"],
    )
    runtime_rows = policy.build_dynamic_candidate_features(notes, assignments, relative_ioi)
    for frozen_row, runtime_row in zip(frozen_rows, runtime_rows):
        for field in policy.DYNAMIC_FEATURE_FIELDS:
            assert runtime_row[field] == frozen_row.get(field), (
                field,
                runtime_row[field],
                frozen_row.get(field),
            )


def main() -> None:
    test_policy_contract()
    test_runtime_feature_builder()
    test_content_addressed_basic_pitch_cache()
    test_frozen_feature_equivalence()
    print(
        json.dumps(
            {
                "ok": True,
                "checks": [
                    "gold-free-policy-fail-closed",
                    "duration-ratio-floor-0.15",
                    "runtime-feature-contract",
                    "audio-sha256-model-policy-cache-key",
                    "frozen-feature-equivalence",
                    "causal-energy-excluded",
                ],
            }
        )
    )


if __name__ == "__main__":
    main()
