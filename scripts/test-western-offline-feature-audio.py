from __future__ import annotations

import importlib.util
import math
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "experiments" / "run_western_strings_offline_feature_analysis.py"


def load_module():
    spec = importlib.util.spec_from_file_location("western_offline_feature_analysis", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("offline-feature-analysis-module-unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_tone(path: Path, sample_rate: int = 22050, duration_seconds: float = 0.5) -> None:
    count = round(sample_rate * duration_seconds)
    samples = np.asarray(
        [0.25 * math.sin(2.0 * math.pi * 440.0 * index / sample_rate) for index in range(count)],
        dtype=np.float64,
    )
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def reference_event_indices(module, notes, events):
    n, m = len(notes), len(events)
    dp = np.full((n + 1, m + 1), np.inf, dtype=np.float64)
    back = np.zeros((n + 1, m + 1), dtype=np.uint8)
    dp[0, 0] = 0.0
    for i in range(1, n + 1):
        dp[i, 0] = dp[i - 1, 0] + 1.35
        back[i, 0] = 2
    for j in range(1, m + 1):
        dp[0, j] = dp[0, j - 1] + 0.75
        back[0, j] = 3
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            choices = (
                dp[i - 1, j - 1] + module.basic_pitch_match_cost(notes[i - 1]["midi"], events[j - 1]["midi"]) + j * 1e-7,
                dp[i - 1, j] + 1.35,
                dp[i, j - 1] + 0.75,
            )
            action = int(np.argmin(choices)) + 1
            dp[i, j] = choices[action - 1]
            back[i, j] = action
    result = [None] * n
    i, j = n, m
    while i > 0 or j > 0:
        action = int(back[i, j])
        if action == 1 and i > 0 and j > 0:
            result[i - 1] = j - 1
            i -= 1
            j -= 1
        elif action == 2 and i > 0:
            i -= 1
        elif action == 3 and j > 0:
            j -= 1
        else:
            break
    return result


def main() -> None:
    module = load_module()
    chord_timeline = module.build_symbolic_timeline(
        [
            {"measureIndex": 1, "beatStart": 0.0, "beatDuration": 1.0},
            {"measureIndex": 1, "beatStart": 0.0, "beatDuration": 1.0},
            {"measureIndex": 1, "beatStart": 1.0, "beatDuration": 1.0},
        ]
    )
    assert [item["scoreOnsetUnit"] for item in chord_timeline] == [0.0, 0.0, 1.0]
    assert chord_timeline[1]["scoreUnit"] > chord_timeline[0]["scoreUnit"]
    compound_meter_timeline = module.build_symbolic_timeline(
        [
            {"measureIndex": 1, "beatStart": 0.0, "beatDuration": 0.5, "measureQuarterSpan": 3.0},
            {"measureIndex": 2, "beatStart": 0.0, "beatDuration": 0.5, "measureQuarterSpan": 3.0},
        ]
    )
    assert compound_meter_timeline[1]["scoreOnsetUnit"] == 3.0
    assert module.meter_quarter_span("6/8") == 3.0
    notes = [{"midi": 60}, {"midi": 62}, {"midi": 64}]
    events = [
        {"start": 0.1, "end": 0.4, "midi": 60, "confidence": 0.8},
        {"start": 0.5, "end": 0.8, "midi": 62, "confidence": 0.7},
        {"start": 0.9, "end": 1.2, "midi": 65, "confidence": 0.9},
    ]
    assignments = module.assign_basic_pitch_events(notes, events)
    assert [round(item["time"], 3) if item else None for item in assignments] == [0.1, 0.5, 0.9]
    assert [round(item["end"], 3) if item else None for item in assignments] == [0.4, 0.8, 1.2]
    assert [item["pitchDistanceSemitones"] if item else None for item in assignments] == [0, 0, 1]
    assert len({item["eventIndex"] for item in assignments if item}) == len([item for item in assignments if item])
    generator = np.random.default_rng(20260716)
    for _ in range(20):
        random_notes = [{"midi": int(value)} for value in generator.integers(55, 82, size=8)]
        random_events = [
            {"start": index * 0.1, "end": index * 0.1 + 0.08, "midi": int(value), "confidence": 0.8}
            for index, value in enumerate(generator.integers(55, 82, size=10))
        ]
        expected_indices = reference_event_indices(module, random_notes, random_events)
        actual = module.assign_basic_pitch_events(random_notes, random_events)
        actual_indices = [item["eventIndex"] if item else None for item in actual]
        assert actual_indices == expected_indices
    timed_notes = [
        {"midi": 60, "scoreUnit": 0.0},
        {"midi": 62, "scoreUnit": 1.0},
        {"midi": 64, "scoreUnit": 2.0},
    ]
    steady_assignments = [
        {"time": 0.0},
        {"time": 1.0},
        {"time": 2.0},
    ]
    steady_ioi = module.compute_relative_ioi_features(timed_notes, steady_assignments)
    assert steady_ioi[1]["relativeIoiEvidenceAvailable"] is True
    assert steady_ioi[1]["relativeIoiDeviationRatio"] == 0.0
    assert steady_ioi[1]["relativeIoiConsistent"] is True
    shifted_assignments = [
        {"time": 0.0},
        {"time": 1.8},
        {"time": 2.0},
    ]
    shifted_ioi = module.compute_relative_ioi_features(timed_notes, shifted_assignments)
    assert shifted_ioi[1]["relativeIoiDeviationRatio"] == 0.8
    assert shifted_ioi[1]["relativeIoiConsistent"] is False
    timeline_note = {
        "noteId": "n1",
        "sectionId": "s1",
        "sectionTitle": "section 1",
        "position": {"measureIndex": 1, "pageNumber": 1},
        "midi": 60,
        "scoreUnit": 0.0,
    }
    decisions = module.build_decisions(
        [timeline_note],
        np.asarray([0.0]),
        np.asarray([60.0]),
        1.0,
        1,
        timing_assignments=[None],
        analysis_mode="basic-pitch-dtw-pyin-review-v1",
    )
    assert decisions[0]["predictedOnsetSeconds"] is None
    assert decisions[0]["evidence"]["timingAssignmentAvailable"] is False
    dynamic_rows = module.build_candidate_rows(decisions)
    assert dynamic_rows[0]["candidateId"] == "offline-basic-pitch-dtw:n1"
    measure_notes = []
    measure_assignments = []
    for index in range(5):
        measure_notes.append(
            {
                "noteId": f"m1-n{index}",
                "sectionId": "s1",
                "sectionTitle": "section 1",
                "position": {"measureIndex": 1, "pageNumber": 1},
                "measureIndex": 1,
                "midi": 60 + index,
                "scoreUnit": float(index),
            }
        )
        measure_assignments.append(
            {
                "time": float(index),
                "end": float(index) + 0.5,
                "eventMidi": 60 + index,
                "confidence": 0.9,
                "pitchDistanceSemitones": 0,
            }
        )
    measure_decisions = module.build_decisions(
        measure_notes,
        np.asarray([value for index in range(5) for value in (index + 0.2, index + 0.3)], dtype=np.float64),
        np.asarray([value for index in range(5) for value in (60.0 + index, 60.0 + index)], dtype=np.float64),
        5.0,
        5,
        timing_assignments=measure_assignments,
        analysis_mode="basic-pitch-dtw-pyin-review-v1",
    )
    measure_rows = module.aggregate_measure_evidence(measure_decisions)
    assert len(measure_rows) == 1
    assert measure_rows[0]["measurePitchReviewEvidenceReady"] is True
    assert measure_rows[0]["measureRhythmReviewEvidenceReady"] is True
    assert measure_rows[0]["measureCombinedReviewEvidenceReady"] is True
    assert measure_rows[0]["autoDecision"] == "review_required"
    linear_decisions = module.build_decisions(
        [timeline_note],
        np.asarray([0.0]),
        np.asarray([60.0]),
        1.0,
        1,
    )
    linear_rows = module.build_candidate_rows(linear_decisions)
    assert linear_rows[0]["candidateId"] == "offline-pyin-linear:n1"
    ffmpeg = module.resolve_ffmpeg_executable()
    assert ffmpeg, "managed FFmpeg must be available for compressed pilot audio"
    with tempfile.TemporaryDirectory(prefix="western-offline-audio-test-") as temp_dir:
        root = Path(temp_dir)
        source_wav = root / "tone.wav"
        compressed = root / "tone.m4a"
        write_tone(source_wav)
        encoded = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", str(source_wav), str(compressed)],
            capture_output=True,
            check=False,
            timeout=30,
        )
        assert encoded.returncode == 0, encoded.stderr.decode("utf-8", errors="replace")
        waveform, sample_rate = module.load_audio_mono(compressed, target_sr=22050)
        assert sample_rate == 22050
        assert 0.45 <= waveform.size / sample_rate <= 0.55
        assert float(np.max(np.abs(waveform))) > 0.05
    print('{"ok": true, "checks": ["basic-pitch-dtw-assignment", "relative-ioi-evidence", "measure-review-evidence-fail-closed", "dynamic-timing-fail-closed", "legacy-candidate-id-compatible", "managed-ffmpeg-resolved", "m4a-decoded-to-mono-float"]}')


if __name__ == "__main__":
    main()
