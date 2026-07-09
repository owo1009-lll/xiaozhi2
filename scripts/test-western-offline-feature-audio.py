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
    print('{"ok": true, "checks": ["managed-ffmpeg-resolved", "m4a-decoded-to-mono-float"]}')


if __name__ == "__main__":
    main()
