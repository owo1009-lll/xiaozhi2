# -*- coding: utf-8 -*-
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import time
from typing import Any


@dataclass(slots=True)
class AudioArtifact:
    raw_bytes: bytes
    duration_seconds: float | None
    sample_rate: int | None = None
    waveform: Any = None
    decode_method: str = "none"
    ffmpeg_path: str | None = None
    audio_hash: str = ""
    cache_key: str | None = None
    source_cache_key: str | None = None
    source_waveform: Any = None
    source_sample_rate: int | None = None
    source_duration_seconds: float | None = None
    window_start_seconds: float | None = None
    window_end_seconds: float | None = None
    pitch_hop_ms: float | None = None


@dataclass(slots=True)
class DecodedAudioCacheItem:
    cache_key: str
    waveform: Any
    sample_rate: int
    duration_seconds: float
    decode_method: str
    last_access: float


def is_sha1_hex(value: str | None) -> bool:
    text = str(value or "").strip().lower()
    return len(text) == 40 and all(character in "0123456789abcdef" for character in text)


def mono_float32(samples: Any, np_module: Any) -> Any:
    waveform = np_module.asarray(samples, dtype=np_module.float32)
    if getattr(waveform, "ndim", 1) > 1:
        waveform = waveform.mean(axis=1)
    return waveform


def audio_file_cache_identity(audio_path: str, sample_rate: int, version: str = "decoded-audio-memory-v1") -> dict[str, Any] | None:
    try:
        path = Path(audio_path)
        stat = path.stat()
        return {
            "path": str(path.resolve()).lower(),
            "size": int(stat.st_size),
            "mtimeNs": int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))),
            "sampleRate": int(sample_rate),
            "version": version,
        }
    except Exception:
        return None


def decoded_cache_item(cache_key: str, waveform: Any, sample_rate: int, decode_method: str) -> DecodedAudioCacheItem:
    duration_seconds = float(len(waveform) / max(int(sample_rate), 1))
    return DecodedAudioCacheItem(
        cache_key=cache_key,
        waveform=waveform,
        sample_rate=int(sample_rate),
        duration_seconds=duration_seconds,
        decode_method=decode_method or "file-memory-cache",
        last_access=time.time(),
    )
