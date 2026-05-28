# -*- coding: utf-8 -*-
from __future__ import annotations

import math
from typing import Any

from analyzer_audio import AudioArtifact


def build_full_audio_artifact(window_audio: AudioArtifact, pitch_hop_ms: int) -> AudioArtifact | None:
    if (
        not window_audio.source_cache_key
        or window_audio.source_waveform is None
        or not window_audio.source_sample_rate
        or window_audio.window_start_seconds is None
        or window_audio.window_end_seconds is None
    ):
        return None
    return AudioArtifact(
        raw_bytes=b"",
        duration_seconds=window_audio.source_duration_seconds,
        sample_rate=int(window_audio.source_sample_rate),
        waveform=window_audio.source_waveform,
        decode_method="decoded-full-feature-reuse",
        ffmpeg_path=window_audio.ffmpeg_path,
        audio_hash=window_audio.source_cache_key,
        cache_key=window_audio.source_cache_key,
        pitch_hop_ms=float(max(1, int(pitch_hop_ms))),
    )


def crop_feature_track(
    track: list[dict[str, float]],
    start_seconds: float | None,
    end_seconds: float | None,
    padding_seconds: float = 0.02,
) -> list[dict[str, float]]:
    if start_seconds is None or end_seconds is None or end_seconds <= start_seconds:
        return []
    start = float(start_seconds)
    end = float(end_seconds)
    cropped: list[dict[str, float]] = []
    for item in track:
        try:
            time_value = float(item.get("time", math.nan))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(time_value) or time_value < start - padding_seconds or time_value > end + padding_seconds:
            continue
        shifted = dict(item)
        shifted["time"] = round(max(0.0, time_value - start), 6)
        cropped.append(shifted)
    return cropped


def reusable_full_feature_source(kind: str, source: str) -> bool:
    text = str(source or "").strip().lower()
    if not text or text.startswith("synthetic") or text.startswith("score-") or text == "beat-unavailable":
        return False
    if kind == "beat" and "beat" not in text:
        return False
    return True


def estimate_window_feature_from_full_audio(
    analyzer: Any,
    request: Any,
    audio: AudioArtifact,
    kind: str,
) -> tuple[list[dict[str, float]], str] | None:
    if not bool(getattr(analyzer.settings, "enable_full_audio_feature_reuse", False)):
        return None
    full_pitch_hop_ms = int(getattr(analyzer.settings, "full_audio_feature_pitch_hop_ms", 10) or 10)
    if kind == "pitch":
        window_pitch_hop_ms = int(round(float(audio.pitch_hop_ms or getattr(analyzer.settings, "pitch_hop_ms", 10) or 10)))
        if full_pitch_hop_ms != window_pitch_hop_ms:
            return None
    full_audio = build_full_audio_artifact(
        audio,
        full_pitch_hop_ms,
    )
    if full_audio is None:
        return None
    max_seconds = float(getattr(analyzer.settings, "full_audio_feature_max_seconds", 180) or 0)
    if max_seconds > 0 and float(full_audio.duration_seconds or 0) > max_seconds:
        return None
    if kind == "pitch" and request is not None:
        full_track, source = analyzer._estimate_pitch_track(request, full_audio, [])
    elif kind == "onset":
        full_track, source = analyzer._estimate_onsets(full_audio, [])
    elif kind == "beat":
        full_track, source = analyzer._estimate_beats(full_audio, [])
    else:
        return None
    if not reusable_full_feature_source(kind, source):
        return None
    track = crop_feature_track(full_track, audio.window_start_seconds, audio.window_end_seconds)
    if not track:
        return None
    window_source = f"{source}-full-window"
    analyzer._write_cached_feature(audio, kind, track, window_source)
    return track, window_source
