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


def main() -> None:
    module = load_module()
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
    print('{"ok": true, "checks": ["basic-pitch-dtw-assignment", "dynamic-timing-fail-closed", "legacy-candidate-id-compatible", "managed-ffmpeg-resolved", "m4a-decoded-to-mono-float"]}')


if __name__ == "__main__":
    main()
