# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))

import numpy as np  # noqa: E402
from analyzer_audio import (  # noqa: E402
    AudioArtifact,
    audio_file_cache_identity,
    decoded_cache_item,
    is_sha1_hex,
    mono_float32,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    require(is_sha1_hex("a" * 40), "valid SHA-1 hex should be accepted")
    require(not is_sha1_hex("二胡"), "non-hex text should be rejected as audio cache hash")
    stereo = np.asarray([[1.0, 3.0], [3.0, 5.0]], dtype=np.float32)
    mono = mono_float32(stereo, np)
    require(mono.tolist() == [2.0, 4.0], "stereo waveform should collapse to mono mean")
    cache_item = decoded_cache_item("cache-key", mono, 2, "unit-test")
    require(cache_item.duration_seconds == 1.0, "decoded cache item duration should derive from waveform length")
    artifact = AudioArtifact(raw_bytes=b"abc", duration_seconds=1.0, sample_rate=2, waveform=mono)
    require(artifact.decode_method == "none", "audio artifact should keep default decode method")
    with tempfile.TemporaryDirectory(prefix="ai-erhu-audio-helper-test-") as temp_dir:
        file_path = Path(temp_dir) / "sample.wav"
        file_path.write_bytes(b"audio")
        identity = audio_file_cache_identity(str(file_path), 16000)
        require(identity is not None and identity["sampleRate"] == 16000, "audio file identity should include sample rate")
    print(json.dumps({"ok": True, "checks": ["sha1", "mono-float32", "cache-item", "file-identity"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
