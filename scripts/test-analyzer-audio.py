# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import sys
import tempfile
import importlib.util
from pathlib import Path
from types import SimpleNamespace

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
from analyzer_feature_reuse import build_full_audio_artifact, estimate_window_feature_from_full_audio  # noqa: E402
from config import Settings  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_piece_pass_default_pitch_hop() -> str:
    old_piece_hop = os.environ.pop("ERHU_PIECE_PASS_PITCH_HOP_MS", None)
    old_global_hop = os.environ.pop("ERHU_PITCH_HOP_MS", None)
    try:
        spec = importlib.util.spec_from_file_location("run_piece_pass_defaults", ROOT / "scripts" / "run-piece-pass.py")
        require(spec is not None and spec.loader is not None, "run-piece-pass script should be importable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return str(module.PIECE_PASS_PITCH_HOP_MS)
    finally:
        if old_piece_hop is not None:
            os.environ["ERHU_PIECE_PASS_PITCH_HOP_MS"] = old_piece_hop
        if old_global_hop is not None:
            os.environ["ERHU_PITCH_HOP_MS"] = old_global_hop


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
    settings = Settings()
    require(settings.pitch_hop_ms == 10, "default analyzer pitch hop should stay high precision")
    require(settings.piece_pass_pitch_hop_ms == 10, "default piece-pass pitch hop should stay high precision")
    require(settings.full_audio_feature_pitch_hop_ms == 10, "full-audio feature reuse must default to high precision")
    require(not settings.enable_full_audio_feature_reuse, "full-audio feature reuse should be opt-in for high precision")
    require(load_piece_pass_default_pitch_hop() == "10", "piece-pass runner cache keys must default to high precision hop")
    window_artifact = AudioArtifact(
        raw_bytes=b"",
        duration_seconds=0.5,
        sample_rate=2,
        waveform=mono[:1],
        source_cache_key="full-cache-key",
        source_waveform=mono,
        source_sample_rate=2,
        source_duration_seconds=1.0,
        window_start_seconds=0.0,
        window_end_seconds=0.5,
        pitch_hop_ms=10.0,
    )
    full_artifact = build_full_audio_artifact(window_artifact, 10)
    require(full_artifact is not None and full_artifact.pitch_hop_ms == 10.0, "full-audio artifact should preserve high precision hop")
    disabled_analyzer = SimpleNamespace(settings=SimpleNamespace(enable_full_audio_feature_reuse=False))
    require(
        estimate_window_feature_from_full_audio(disabled_analyzer, None, window_artifact, "pitch") is None,
        "full-audio feature reuse should be disabled by default",
    )
    mismatch_analyzer = SimpleNamespace(
        settings=SimpleNamespace(
            enable_full_audio_feature_reuse=True,
            full_audio_feature_pitch_hop_ms=25,
            pitch_hop_ms=10,
            full_audio_feature_max_seconds=180,
        )
    )
    require(
        estimate_window_feature_from_full_audio(mismatch_analyzer, None, window_artifact, "pitch") is None,
        "pitch reuse must not mix low-resolution full-audio hop with high-precision windows",
    )
    with tempfile.TemporaryDirectory(prefix="ai-erhu-audio-helper-test-") as temp_dir:
        file_path = Path(temp_dir) / "sample.wav"
        file_path.write_bytes(b"audio")
        identity = audio_file_cache_identity(str(file_path), 16000)
        require(identity is not None and identity["sampleRate"] == 16000, "audio file identity should include sample rate")
    print(json.dumps({"ok": True, "checks": ["sha1", "mono-float32", "cache-item", "file-identity", "high-precision-cache", "piece-pass-hop"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
