from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import wave
import zipfile
import collections
import collections.abc
import gc
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from statistics import median
import time
from typing import Any
from xml.etree import ElementTree as ET

if not hasattr(collections, "MutableSequence"):
    collections.MutableSequence = collections.abc.MutableSequence

from config import Settings
from schemas import (
    AnalyzeRequest,
    AnalyzeResult,
    DemoSegment,
    MeasureFinding,
    NoteEvent,
    NoteFinding,
    PiecePack,
    PracticeTarget,
    RankedSectionCandidate,
    RankSectionsRequest,
    ScoreImportJobResult,
    ScoreImportRequest,
    SeparateErhuRequest,
    SeparateErhuResult,
)

try:
    import numpy as np
except ImportError:  # pragma: no cover - optional dependency
    np = None

if np is not None:
    if not hasattr(np, "float"):
        np.float = float  # type: ignore[attr-defined]
    if not hasattr(np, "int"):
        np.int = int  # type: ignore[attr-defined]
    if not hasattr(np, "complex"):
        np.complex = np.complex128  # type: ignore[attr-defined]

try:
    import librosa
except ImportError:  # pragma: no cover - optional dependency
    librosa = None

try:
    import soundfile as sf
except ImportError:  # pragma: no cover - optional dependency
    sf = None

try:
    import torch
    import torchcrepe
except ImportError:  # pragma: no cover - optional dependency
    torch = None
    torchcrepe = None

try:
    import imageio_ffmpeg
except ImportError:  # pragma: no cover - optional dependency
    imageio_ffmpeg = None

try:
    import pretty_midi
except ImportError:  # pragma: no cover - optional dependency
    pretty_midi = None

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:  # pragma: no cover - optional dependency
    PdfReader = None
    PdfWriter = None

try:
    import fitz
except ImportError:  # pragma: no cover - optional dependency
    fitz = None

try:
    from madmom.features.beats import DBNBeatTrackingProcessor, RNNBeatProcessor
    from madmom.features.onsets import OnsetPeakPickingProcessor, RNNOnsetProcessor
except ImportError:  # pragma: no cover - optional dependency
    DBNBeatTrackingProcessor = None
    RNNBeatProcessor = None
    OnsetPeakPickingProcessor = None
    RNNOnsetProcessor = None


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


@dataclass(slots=True)
class SymbolicNote:
    note_id: str
    measure_index: int
    beat_start: float
    beat_duration: float
    midi_pitch: int
    expected_onset: float
    expected_offset: float
    note_position: dict[str, Any] | None = None


@dataclass(slots=True)
class ObservedNote:
    onset: float
    offset: float
    median_frequency: float
    median_midi: float
    confidence: float
    segment_point_count: int
    stable_point_count: int
    pitch_spread_cents: float
    entry_cents: float
    exit_cents: float
    glide_like: bool
    vibrato_like: bool
    trill_like: bool
    pluck_like: bool
    tap_like: bool
    harmonic_like: bool
    vibrato_center_frequency: float
    vibrato_amplitude_cents: float
    glide_run_ms: float
    trill_low_frequency: float
    trill_high_frequency: float
    trill_switch_count: int


def midi_to_frequency(midi_pitch: int) -> float:
    return 440.0 * (2.0 ** ((int(midi_pitch) - 69) / 12.0))


def frequency_to_midi(frequency: float) -> float:
    if frequency <= 0:
        return 0.0
    return 69.0 + 12.0 * math.log2(frequency / 440.0)


def cents_error(frequency: float, midi_pitch: int) -> float:
    expected = midi_to_frequency(midi_pitch)
    if frequency <= 0 or expected <= 0:
        return 0.0
    return 1200.0 * math.log2(frequency / expected)


def cents_between(frequency: float, reference_frequency: float) -> float:
    if frequency <= 0 or reference_frequency <= 0:
        return 0.0
    return 1200.0 * math.log2(frequency / reference_frequency)


def beats_per_measure(meter: str | None) -> float:
    if not meter:
        return 4.0
    try:
        numerator = float(str(meter).split("/", 1)[0])
        return numerator if numerator > 0 else 4.0
    except Exception:
        return 4.0


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
        return numeric if math.isfinite(numeric) else default
    except Exception:
        return default


def trimmed_median(values: list[float], trim_ratio: float = 0.15) -> float:
    cleaned = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not cleaned:
        return 0.0
    if len(cleaned) < 5 or trim_ratio <= 0:
        return float(median(cleaned))
    trim_count = min(len(cleaned) // 3, int(len(cleaned) * trim_ratio))
    if trim_count > 0 and len(cleaned) - (trim_count * 2) >= 3:
        cleaned = cleaned[trim_count : len(cleaned) - trim_count]
    return float(median(cleaned))


def musicxml_pitch_to_midi(step: str, octave: int, alter: int = 0) -> int:
    pitch_class = {
        "C": 0,
        "D": 2,
        "E": 4,
        "F": 5,
        "G": 7,
        "A": 9,
        "B": 11,
    }.get(step.upper(), 0)
    return int((octave + 1) * 12 + pitch_class + alter)


def musicxml_step_to_diatonic(step: str, octave: int) -> int:
    step_index = {
        "C": 0,
        "D": 1,
        "E": 2,
        "F": 3,
        "G": 4,
        "A": 5,
        "B": 6,
    }.get(str(step or "").upper(), 0)
    return (int(octave) * 7) + step_index


def musicxml_clef_reference(sign: str, line: int, octave_change: int = 0) -> tuple[int, int]:
    normalized_sign = str(sign or "G").strip().upper()
    normalized_line = max(1, min(5, int(line or 2)))
    if normalized_sign == "F":
        base_step, base_octave = "F", 3
    elif normalized_sign == "C":
        base_step, base_octave = "C", 4
    else:
        base_step, base_octave = "G", 4
    return musicxml_step_to_diatonic(base_step, base_octave + int(octave_change or 0)), normalized_line


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    if np is not None:
        return float(np.percentile(np.asarray(values, dtype=np.float32), quantile))
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * (quantile / 100.0)))))
    return float(ordered[index])


def lowpass_series(times: list[float], values: list[float], cutoff_hz: float) -> list[float]:
    if not times or not values or cutoff_hz <= 0:
        return list(values)
    rc = 1.0 / (2.0 * math.pi * cutoff_hz)
    filtered = [float(values[0])]
    for index in range(1, min(len(times), len(values))):
        dt = max(1e-4, float(times[index]) - float(times[index - 1]))
        alpha = dt / (rc + dt)
        filtered.append(filtered[-1] + (alpha * (float(values[index]) - filtered[-1])))
    return filtered


def count_sign_changes(values: list[float], threshold: float = 0.0) -> int:
    signs: list[int] = []
    for value in values:
        if abs(value) <= threshold:
            continue
        signs.append(1 if value > 0 else -1)
    if len(signs) < 2:
        return 0
    return sum(1 for left, right in zip(signs, signs[1:], strict=False) if left != right)


def severity_label(value: float, low: float, high: float) -> str:
    if value >= high:
        return "high"
    if value >= low:
        return "medium"
    return "low"


def normalize_part_label(value: str | None) -> str:
    return "".join((value or "").strip().lower().split())


class ErhuAnalyzer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def dependency_report(self) -> dict[str, bool]:
        return {
            "numpy": np is not None,
            "librosa": librosa is not None,
            "soundfile": sf is not None,
            "torch": torch is not None,
            "torchcrepe": torchcrepe is not None,
            "madmom": bool(RNNOnsetProcessor and OnsetPeakPickingProcessor),
            "imageio_ffmpeg": imageio_ffmpeg is not None,
            "pretty_midi": pretty_midi is not None,
            "pypdf": bool(PdfReader and PdfWriter),
            "ffmpeg": bool(self._resolve_ffmpeg_path()),
            "audiveris": bool(self.settings.audiveris_cli and os.path.exists(self.settings.audiveris_cli)),
        }

    def _clip_feature_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "clip-feature-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir

    def _preprocessed_audio_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "preprocessed-audio-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir

    def _omr_render_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "omr-render-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir

    def _omr_page_result_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "omr-page-result-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir

    def _json_hash(self, value: Any) -> str:
        return hashlib.sha1(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()

    def _file_sha1(self, path: Path) -> str:
        digest = hashlib.sha1()
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        return digest.hexdigest()

    def _page_cache_key(self, fingerprint: str, kind: str) -> str:
        return self._json_hash(
            {
                "fingerprint": fingerprint,
                "kind": kind,
                "version": self.settings.omr_page_cache_version,
                "dpi": int(self.settings.omr_render_dpi),
                "minDpi": int(self.settings.omr_render_min_dpi),
                "maxPixels": int(self.settings.omr_page_max_pixels),
            }
        )

    def _page_render_cache_path(self, page_fingerprint: str) -> Path:
        return self._omr_render_cache_dir() / f"{self._page_cache_key(page_fingerprint, 'render')}.png"

    def _page_tile_cache_path(self, page_fingerprint: str, tile_index: int) -> Path:
        return self._omr_render_cache_dir() / f"{self._page_cache_key(page_fingerprint, f'tile-{tile_index:02d}')}.png"

    def _page_result_cache_path(self, page_fingerprint: str) -> Path:
        return self._omr_page_result_cache_dir() / f"{self._page_cache_key(page_fingerprint, 'musicxml')}.musicxml"

    def _ensure_page_preview_image(
        self,
        output_dir: Path,
        page_index: int,
        page_fingerprint: str,
        fitz_page: Any | None = None,
        pdf_path: Path | None = None,
    ) -> tuple[Path | None, str]:
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"page-{page_index:03d}.png"
        if output_path.exists():
            return output_path, "ready"

        render_cache_path = self._page_render_cache_path(page_fingerprint)
        if render_cache_path.exists():
            try:
                shutil.copy2(render_cache_path, output_path)
                return output_path, "cache-hit"
            except Exception:
                return render_cache_path, "cache-hit"

        rendered_path: Path | None = None
        if fitz_page is not None:
            rendered_path = self._render_page_image_from_page(fitz_page, page_index - 1, output_dir)
        elif pdf_path is not None:
            rendered_path = self._render_pdf_page_image(pdf_path, page_index - 1, output_dir)
        if rendered_path is None or not rendered_path.exists():
            return None, "missing"

        try:
            if not render_cache_path.exists():
                shutil.copy2(rendered_path, render_cache_path)
        except Exception:
            pass
        return rendered_path, "rendered"

    def _score_notes_fingerprint(self, score_notes: list[SymbolicNote]) -> str:
        payload = [
            {
                "noteId": note.note_id,
                "measureIndex": note.measure_index,
                "beatStart": round(float(note.beat_start), 6),
                "beatDuration": round(float(note.beat_duration), 6),
                "midiPitch": int(note.midi_pitch),
                "expectedOnset": round(float(note.expected_onset), 6),
                "expectedOffset": round(float(note.expected_offset), 6),
            }
            for note in score_notes
        ]
        return self._json_hash(payload)

    def _calibration_fingerprint(self, section_calibration: dict[str, Any] | None) -> str:
        if not section_calibration:
            return "none"
        normalized = {}
        for key, value in sorted(section_calibration.items()):
            if isinstance(value, (str, int, float, bool)) or value is None:
                normalized[key] = value
        return self._json_hash(normalized)

    def _feature_cache_file(self, cache_key: str, kind: str) -> Path:
        safe_key = self._json_hash({"cacheKey": cache_key, "kind": kind, "version": self.settings.clip_feature_cache_version})
        return self._clip_feature_cache_dir() / f"{safe_key}-{kind}.json"

    def _preprocessed_audio_cache_key(
        self,
        request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest,
        audio: AudioArtifact,
        preprocess_mode: str,
        score_notes: list[SymbolicNote],
        section_calibration: dict[str, Any] | None,
        *,
        scope: str = "exact",
    ) -> str | None:
        audio_hash = str(audio.audio_hash or "").strip().lower()
        if not audio_hash:
            return None
        score_id = str(getattr(request, "scoreId", None) or "").strip()
        piece_id = str(getattr(request, "pieceId", None) or "").strip()
        payload = {
            "version": self.settings.clip_feature_cache_version,
            "scope": scope,
            "audioHash": audio_hash,
            "preprocessMode": preprocess_mode,
            "scoreId": score_id,
            "pieceId": piece_id,
        }
        if scope == "exact":
            payload["scoreNotes"] = self._score_notes_fingerprint(score_notes)
            payload["calibration"] = self._calibration_fingerprint(section_calibration)
        return self._json_hash(payload)

    def _preprocessed_audio_cache_paths(self, cache_key: str) -> dict[str, Path]:
        root = self._preprocessed_audio_cache_dir() / cache_key
        return {
            "root": root,
            "meta": root / "meta.json",
            "enhanced": root / "enhanced.wav",
            "residual": root / "residual.wav",
        }

    def _load_cached_waveform(self, path: Path, sample_rate: int) -> Any | None:
        if not path.exists():
            return None
        try:
            if sf is not None and np is not None:
                samples, loaded_sr = sf.read(str(path), always_2d=False)
                waveform = np.asarray(samples, dtype=np.float32)
                if waveform.ndim > 1:
                    waveform = waveform.mean(axis=1)
                if int(loaded_sr) == int(sample_rate):
                    return waveform
            if librosa is not None and np is not None:
                waveform, loaded_sr = librosa.load(str(path), sr=sample_rate, mono=True)
                if int(loaded_sr) == int(sample_rate):
                    return np.asarray(waveform, dtype=np.float32)
        except Exception:
            return None
        return None

    def _read_cached_preprocessed_audio(
        self,
        request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest,
        audio: AudioArtifact,
        preprocess_mode: str,
        score_notes: list[SymbolicNote],
        section_calibration: dict[str, Any] | None,
    ) -> tuple[dict[str, Any] | None, str | None]:
        if audio.waveform is None or audio.sample_rate is None or np is None:
            return None, None
        scopes = ("exact", "piece")
        for scope in scopes:
            cache_key = self._preprocessed_audio_cache_key(
                request,
                audio,
                preprocess_mode,
                score_notes,
                section_calibration,
                scope=scope,
            )
            if not cache_key:
                continue
            paths = self._preprocessed_audio_cache_paths(cache_key)
            meta_path = paths["meta"]
            if not meta_path.exists() or not paths["enhanced"].exists() or not paths["residual"].exists():
                continue
            try:
                meta = json.loads(meta_path.read_text("utf-8"))
            except Exception:
                continue
            enhanced_waveform = self._load_cached_waveform(paths["enhanced"], audio.sample_rate)
            residual_waveform = self._load_cached_waveform(paths["residual"], audio.sample_rate)
            if enhanced_waveform is None or residual_waveform is None:
                continue
            return (
                {
                    "enhancedWaveform": enhanced_waveform,
                    "residualWaveform": residual_waveform,
                    "separationConfidence": float(meta.get("separationConfidence", 0.0)),
                    "scope": scope,
                    "cacheKey": cache_key,
                },
                cache_key,
            )
        return None, None

    def _write_cached_preprocessed_audio(
        self,
        request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest,
        audio: AudioArtifact,
        preprocess_mode: str,
        score_notes: list[SymbolicNote],
        section_calibration: dict[str, Any] | None,
        enhanced_waveform: Any,
        residual_waveform: Any,
        separation_confidence: float,
    ) -> None:
        if audio.waveform is None or audio.sample_rate is None:
            return
        for scope in ("exact", "piece"):
            cache_key = self._preprocessed_audio_cache_key(
                request,
                audio,
                preprocess_mode,
                score_notes,
                section_calibration,
                scope=scope,
            )
            if not cache_key:
                continue
            paths = self._preprocessed_audio_cache_paths(cache_key)
            try:
                paths["root"].mkdir(parents=True, exist_ok=True)
                self._write_wave_file(paths["enhanced"], enhanced_waveform, audio.sample_rate)
                self._write_wave_file(paths["residual"], residual_waveform, audio.sample_rate)
                paths["meta"].write_text(
                    json.dumps(
                        {
                            "cachedAt": time.time(),
                            "audioHash": audio.audio_hash,
                            "preprocessMode": preprocess_mode,
                            "scope": scope,
                            "separationConfidence": float(separation_confidence),
                        },
                        ensure_ascii=False,
                    ),
                    "utf-8",
                )
            except Exception:
                continue

    def _read_cached_feature(self, audio: AudioArtifact, kind: str) -> tuple[list[dict[str, float]] | None, str | None]:
        if not bool(self.settings.enable_clip_feature_cache) or not audio.cache_key:
            return None, None
        cache_file = self._feature_cache_file(audio.cache_key, kind)
        if not cache_file.exists():
            return None, None
        try:
            payload = json.loads(cache_file.read_text("utf-8"))
            track = payload.get("track")
            source = str(payload.get("source") or "")
            if isinstance(track, list) and source:
                return track, source
        except Exception:
            return None, None
        return None, None

    def _write_cached_feature(self, audio: AudioArtifact, kind: str, track: list[dict[str, float]], source: str) -> None:
        if not bool(self.settings.enable_clip_feature_cache) or not audio.cache_key:
            return
        cache_file = self._feature_cache_file(audio.cache_key, kind)
        payload = {
            "cachedAt": Path(cache_file).name,
            "audioHash": audio.audio_hash,
            "cacheKey": audio.cache_key,
            "kind": kind,
            "source": source,
            "track": track,
        }
        try:
            cache_file.write_text(json.dumps(payload, ensure_ascii=False), "utf-8")
        except Exception:
            return

    def _build_processed_audio_cache_key(
        self,
        audio: AudioArtifact,
        preprocess_mode: str,
        score_notes: list[SymbolicNote],
        section_calibration: dict[str, Any] | None,
    ) -> str:
        base = {
            "version": self.settings.clip_feature_cache_version,
            "audioHash": audio.audio_hash or audio.cache_key or "",
            "preprocessMode": preprocess_mode,
            "scoreNotes": self._score_notes_fingerprint(score_notes),
            "calibration": self._calibration_fingerprint(section_calibration),
        }
        return f"processed-{self._json_hash(base)}"

    def should_retry_analysis(self, request: AnalyzeRequest, result: AnalyzeResult) -> bool:
        if not bool(self.settings.analysis_stability_retry_enabled):
            return False
        section_calibration = self._resolve_section_calibration(request)
        if not (
            bool(section_calibration.get("scoreCoarse"))
            or bool(section_calibration.get("preferScoreBoundaries"))
        ):
            return False
        diagnostics = result.diagnostics or {}
        if float(result.overallPitchScore or 0.0) >= float(self.settings.analysis_stability_pitch_threshold):
            return False
        if float(result.overallRhythmScore or 0.0) < float(self.settings.analysis_stability_min_rhythm_score):
            return False
        if int(diagnostics.get("pitchIssueCount") or 0) > int(self.settings.analysis_stability_max_pitch_issues):
            return False
        if int(diagnostics.get("uncertainPitchCount") or 0) < int(self.settings.analysis_stability_min_uncertain_pitch):
            return False
        return True

    def choose_preferred_analysis(
        self,
        request: AnalyzeRequest,
        primary: AnalyzeResult,
        candidate: AnalyzeResult,
    ) -> AnalyzeResult:
        def preference_tuple(result: AnalyzeResult) -> tuple[float, ...]:
            diagnostics = result.diagnostics or {}
            suspicious = 0 if self.should_retry_analysis(request, result) else 1
            return (
                float(suspicious),
                -float(diagnostics.get("pitchIssueCount") or 0),
                -float(diagnostics.get("uncertainPitchCount") or 0),
                float(result.overallPitchScore or 0.0),
                float(result.studentCombinedScore or 0.0),
                float(result.confidence or 0.0),
            )

        return candidate if preference_tuple(candidate) > preference_tuple(primary) else primary

    def _build_preview_pages(self, pdf_path: Path, job_id: str) -> list[dict[str, Any]]:
        preview_count = max(1, self.settings.omr_preview_pages)
        if PdfReader is not None:
            try:
                preview_count = min(preview_count, max(1, len(PdfReader(str(pdf_path)).pages)))
            except Exception:
                preview_count = max(1, self.settings.omr_preview_pages)

        return [
            {
                "pageNumber": index + 1,
                "type": "pdf",
                "url": f"/data/score-imports/{job_id}/{pdf_path.name}",
            }
            for index in range(preview_count)
        ]

    def _compact_import_warnings(self, warnings: list[str]) -> list[str]:
        compacted: list[str] = []
        seen: set[str] = set()
        for warning in warnings:
            text = str(warning or "").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            compacted.append(text)

        has_direct_pagewise = any(
            "按页识谱" in warning and ("缩短导入等待时间" in warning or "直接按页" in warning)
            for warning in compacted
        )
        if has_direct_pagewise:
            compacted = [warning for warning in compacted if "回退到按页识谱" not in warning]
        return compacted

    def _page_render_dpi(self, page: Any) -> int:
        target_dpi = max(72, int(self.settings.omr_render_dpi))
        max_pixels = max(1_000_000, int(self.settings.omr_page_max_pixels))
        min_dpi = max(96, int(self.settings.omr_render_min_dpi))
        try:
            width_points = float(page.rect.width)
            height_points = float(page.rect.height)
            if width_points <= 0 or height_points <= 0:
                return target_dpi
            max_dpi = math.sqrt((max_pixels * 72.0 * 72.0) / (width_points * height_points))
            bounded_dpi = min(float(target_dpi), float(max_dpi))
            if bounded_dpi < min_dpi:
                return min_dpi
            return max(min_dpi, int(math.floor(bounded_dpi)))
        except Exception:
            return target_dpi

    def _estimate_page_clip_rect(self, page: Any) -> Any | None:
        if fitz is None or np is None:
            return None
        try:
            preview_dpi = 96
            preview = page.get_pixmap(dpi=preview_dpi, alpha=False)
            channels = max(1, int(getattr(preview, "n", 3) or 3))
            pixels = np.frombuffer(preview.samples, dtype=np.uint8)
            if pixels.size != preview.width * preview.height * channels:
                return None
            image = pixels.reshape(preview.height, preview.width, channels)
            gray = image[:, :, : min(channels, 3)].mean(axis=2)
            occupied = gray < 245
            if not occupied.any():
                return None
            rows = np.where(occupied.any(axis=1))[0]
            cols = np.where(occupied.any(axis=0))[0]
            if rows.size == 0 or cols.size == 0:
                return None
            margin = max(10, int(min(preview.height, preview.width) * 0.02))
            top = max(0, int(rows[0]) - margin)
            bottom = min(preview.height - 1, int(rows[-1]) + margin)
            left = max(0, int(cols[0]) - margin)
            right = min(preview.width - 1, int(cols[-1]) + margin)
            if right <= left or bottom <= top:
                return None
            scale_x = float(page.rect.width) / max(1, preview.width)
            scale_y = float(page.rect.height) / max(1, preview.height)
            clip = fitz.Rect(
                float(page.rect.x0) + (left * scale_x),
                float(page.rect.y0) + (top * scale_y),
                float(page.rect.x0) + ((right + 1) * scale_x),
                float(page.rect.y0) + ((bottom + 1) * scale_y),
            )
            if clip.width <= 0 or clip.height <= 0:
                return None
            return clip
        except Exception:
            return None

    def _render_page_image_from_page(self, page: Any, page_index: int, output_dir: Path) -> Path | None:
        if fitz is None:
            return None
        try:
            clip_rect = self._estimate_page_clip_rect(page)
            dpi = self._page_render_dpi(page)
            pixmap = page.get_pixmap(dpi=dpi, alpha=False, clip=clip_rect)
            max_pixels = max(1_000_000, int(self.settings.omr_page_max_pixels))
            if (pixmap.width * pixmap.height) > max_pixels:
                adjusted_dpi = max(
                    int(self.settings.omr_render_min_dpi),
                    int(math.floor(dpi * math.sqrt(max_pixels / float(pixmap.width * pixmap.height)))),
                )
                if adjusted_dpi < dpi:
                    pixmap = page.get_pixmap(dpi=adjusted_dpi, alpha=False, clip=clip_rect)
            output_dir.mkdir(parents=True, exist_ok=True)
            image_path = output_dir / f"page-{page_index + 1:03d}.png"
            pixmap.save(str(image_path))
            return image_path
        except Exception:
            return None

    def _render_page_tile_images_from_page(self, page: Any, page_index: int, output_dir: Path, tile_count: int = 2) -> list[Path]:
        if fitz is None:
            return []
        try:
            base_clip = self._estimate_page_clip_rect(page) or page.rect
            if base_clip.height <= 0 or base_clip.width <= 0:
                return []
            target_dpi = max(220, int(self.settings.omr_render_dpi))
            overlap = max(8.0, float(base_clip.height) * 0.03)
            tile_height = float(base_clip.height) / max(1, int(tile_count))
            max_pixels = max(1_000_000, int(self.settings.omr_page_max_pixels))
            output_dir.mkdir(parents=True, exist_ok=True)
            tile_paths: list[Path] = []
            for tile_index in range(max(1, int(tile_count))):
                top = float(base_clip.y0) + (tile_index * tile_height)
                bottom = float(base_clip.y0) + ((tile_index + 1) * tile_height)
                if tile_index > 0:
                    top -= overlap * 0.5
                if tile_index < (tile_count - 1):
                    bottom += overlap * 0.5
                tile_clip = fitz.Rect(
                    float(base_clip.x0),
                    max(float(base_clip.y0), top),
                    float(base_clip.x1),
                    min(float(base_clip.y1), bottom),
                )
                if tile_clip.width <= 0 or tile_clip.height <= 0:
                    continue
                pixmap = page.get_pixmap(dpi=target_dpi, alpha=False, clip=tile_clip)
                if (pixmap.width * pixmap.height) > max_pixels:
                    adjusted_dpi = max(
                        int(self.settings.omr_render_min_dpi),
                        int(math.floor(target_dpi * math.sqrt(max_pixels / float(pixmap.width * pixmap.height)))),
                    )
                    if adjusted_dpi < target_dpi:
                        pixmap = page.get_pixmap(dpi=adjusted_dpi, alpha=False, clip=tile_clip)
                tile_path = output_dir / f"page-{page_index + 1:03d}-tile-{tile_index + 1:02d}.png"
                pixmap.save(str(tile_path))
                tile_paths.append(tile_path)
            return tile_paths
        except Exception:
            return []

    def _render_pdf_page_image(self, pdf_path: Path, page_index: int, output_dir: Path) -> Path | None:
        if fitz is None:
            return None
        try:
            document = fitz.open(str(pdf_path))
        except Exception:
            return None
        try:
            if page_index < 0 or page_index >= document.page_count:
                return None
            page = document.load_page(page_index)
            return self._render_page_image_from_page(page, page_index, output_dir)
        except Exception:
            return None
        finally:
            try:
                document.close()
            except Exception:
                pass

    def _render_pdf_page_tile_images(self, pdf_path: Path, page_index: int, output_dir: Path, tile_count: int = 2) -> list[Path]:
        if fitz is None:
            return []
        try:
            document = fitz.open(str(pdf_path))
        except Exception:
            return []
        try:
            if page_index < 0 or page_index >= document.page_count:
                return []
            page = document.load_page(page_index)
            return self._render_page_tile_images_from_page(page, page_index, output_dir, tile_count=tile_count)
        except Exception:
            return []
        finally:
            try:
                document.close()
            except Exception:
                pass

    def _run_audiveris_pagewise(self, pdf_path: Path, output_dir: Path) -> tuple[list[str], dict[str, Any]]:
        if PdfReader is None or PdfWriter is None:
            return [], {}
        try:
            reader = PdfReader(str(pdf_path))
        except Exception:
            return [], {}

        output_dir.mkdir(parents=True, exist_ok=True)
        fitz_document = None
        if fitz is not None:
            try:
                fitz_document = fitz.open(str(pdf_path))
            except Exception:
                fitz_document = None

        page_count = len(reader.pages)
        page_result_cache_hits = 0
        page_result_cache_misses = 0
        render_cache_hits = 0
        render_cache_misses = 0
        tile_render_cache_hits = 0
        tile_render_cache_misses = 0
        page_omr_runs = 0
        tile_omr_runs = 0

        try:
            page_tasks: list[dict[str, Any]] = []
            generated_sources_with_order: list[tuple[int, str]] = []
            for page_index, page in enumerate(reader.pages, start=1):
                single_pdf_path = output_dir / f"page-{page_index:03d}.pdf"
                page_output_dir = output_dir / f"page-{page_index:03d}"
                page_bytes: bytes = b""
                page_fingerprint = ""
                try:
                    page_buffer = io.BytesIO()
                    writer = PdfWriter()
                    writer.add_page(page)
                    writer.write(page_buffer)
                    page_bytes = page_buffer.getvalue()
                    page_fingerprint = hashlib.sha1(page_bytes).hexdigest()
                except Exception:
                    page_bytes = b""
                    page_fingerprint = self._json_hash({"pdfPath": str(pdf_path), "pageIndex": page_index})

                page_result_cache_path = self._page_result_cache_path(page_fingerprint)
                if page_result_cache_path.exists():
                    page_result_cache_hits += 1
                    preview_status = "missing"
                    if fitz_document is not None:
                        try:
                            if 0 <= (page_index - 1) < fitz_document.page_count:
                                fitz_page = fitz_document.load_page(page_index - 1)
                                _, preview_status = self._ensure_page_preview_image(
                                    output_dir,
                                    page_index,
                                    page_fingerprint,
                                    fitz_page=fitz_page,
                                )
                        except Exception:
                            preview_status = "missing"
                    else:
                        _, preview_status = self._ensure_page_preview_image(
                            output_dir,
                            page_index,
                            page_fingerprint,
                            pdf_path=pdf_path,
                        )
                    if preview_status == "cache-hit":
                        render_cache_hits += 1
                    elif preview_status == "rendered":
                        render_cache_misses += 1
                    generated_sources_with_order.append((page_index, str(page_result_cache_path)))
                    continue
                page_result_cache_misses += 1

                audiveris_input_path: Path | None = None
                fitz_page = None
                if fitz_document is not None:
                    try:
                        if 0 <= (page_index - 1) < fitz_document.page_count:
                            fitz_page = fitz_document.load_page(page_index - 1)
                            render_cache_path = self._page_render_cache_path(page_fingerprint)
                            if render_cache_path.exists():
                                render_cache_hits += 1
                                audiveris_input_path = render_cache_path
                                try:
                                    preview_path = output_dir / f"page-{page_index:03d}.png"
                                    if not preview_path.exists():
                                        shutil.copy2(render_cache_path, preview_path)
                                except Exception:
                                    pass
                            else:
                                render_cache_misses += 1
                                rendered_page_path = self._render_page_image_from_page(fitz_page, page_index - 1, output_dir)
                                if rendered_page_path is not None:
                                    audiveris_input_path = rendered_page_path
                                    try:
                                        if not render_cache_path.exists():
                                            shutil.copy2(rendered_page_path, render_cache_path)
                                    except Exception:
                                        pass
                    except Exception:
                        fitz_page = None
                        audiveris_input_path = None
                try:
                    if audiveris_input_path is None:
                        if not page_bytes:
                            page_buffer = io.BytesIO()
                            writer = PdfWriter()
                            writer.add_page(page)
                            writer.write(page_buffer)
                            page_bytes = page_buffer.getvalue()
                        with single_pdf_path.open("wb") as handle:
                            handle.write(page_bytes)
                        audiveris_input_path = single_pdf_path
                except Exception:
                    continue

                page_tasks.append(
                    {
                        "pageIndex": page_index,
                        "pageOutputDir": page_output_dir,
                        "audiverisInputPath": audiveris_input_path,
                        "hasFitzPage": fitz_page is not None,
                        "pageFingerprint": page_fingerprint,
                    }
                )

            failed_tasks: list[dict[str, Any]] = []
            max_workers = max(1, min(int(self.settings.omr_pagewise_workers), len(page_tasks) or 1))
            if max_workers <= 1:
                for task in page_tasks:
                    page_omr_runs += 1
                    generated_musicxml = self._run_audiveris(task["audiverisInputPath"], task["pageOutputDir"])
                    if generated_musicxml:
                        cache_path = self._page_result_cache_path(str(task["pageFingerprint"]))
                        try:
                            xml_text = self._read_musicxml_source(Path(generated_musicxml))
                            if xml_text.strip() and not cache_path.exists():
                                cache_path.write_text(xml_text, encoding="utf-8")
                                generated_musicxml = str(cache_path)
                        except Exception:
                            pass
                        generated_sources_with_order.append((int(task["pageIndex"]), generated_musicxml))
                    else:
                        failed_tasks.append(task)
            else:
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_map = {
                        executor.submit(self._run_audiveris, task["audiverisInputPath"], task["pageOutputDir"]): task
                        for task in page_tasks
                    }
                    page_omr_runs += len(future_map)
                    for future in as_completed(future_map):
                        task = future_map[future]
                        try:
                            generated_musicxml = future.result()
                        except Exception:
                            generated_musicxml = None
                        if generated_musicxml:
                            cache_path = self._page_result_cache_path(str(task["pageFingerprint"]))
                            try:
                                xml_text = self._read_musicxml_source(Path(generated_musicxml))
                                if xml_text.strip() and not cache_path.exists():
                                    cache_path.write_text(xml_text, encoding="utf-8")
                                    generated_musicxml = str(cache_path)
                            except Exception:
                                pass
                            generated_sources_with_order.append((int(task["pageIndex"]), generated_musicxml))
                        else:
                            failed_tasks.append(task)

            for task in sorted(failed_tasks, key=lambda item: item["pageIndex"]):
                tile_inputs: list[Path] = []
                if fitz_document is not None and task.get("hasFitzPage"):
                    try:
                        fitz_page = fitz_document.load_page(int(task["pageIndex"]) - 1)
                        page_fingerprint = str(task.get("pageFingerprint") or "")
                        tile_inputs = []
                        missing_tile_indexes: list[int] = []
                        for tile_index in range(1, 3):
                            tile_cache_path = self._page_tile_cache_path(page_fingerprint, tile_index)
                            if tile_cache_path.exists():
                                tile_render_cache_hits += 1
                                tile_inputs.append(tile_cache_path)
                            else:
                                tile_render_cache_misses += 1
                                missing_tile_indexes.append(tile_index)
                        if missing_tile_indexes:
                            rendered_tiles = self._render_page_tile_images_from_page(
                                fitz_page,
                                int(task["pageIndex"]) - 1,
                                output_dir / f"page-{int(task['pageIndex']):03d}-tiles",
                                tile_count=2,
                            )
                            if rendered_tiles:
                                tile_inputs = []
                                for tile_index, tile_path in enumerate(rendered_tiles, start=1):
                                    tile_cache_path = self._page_tile_cache_path(page_fingerprint, tile_index)
                                    try:
                                        if not tile_cache_path.exists():
                                            shutil.copy2(tile_path, tile_cache_path)
                                            tile_inputs.append(tile_cache_path)
                                        else:
                                            tile_inputs.append(tile_cache_path)
                                    except Exception:
                                        tile_inputs.append(tile_path)
                    except Exception:
                        tile_inputs = []
                elif fitz_document is not None:
                    tile_inputs = self._render_pdf_page_tile_images(
                        pdf_path,
                        int(task["pageIndex"]) - 1,
                        output_dir / f"page-{int(task['pageIndex']):03d}-tiles",
                        tile_count=2,
                    )

                for tile_index, tile_input in enumerate(tile_inputs, start=1):
                    tile_output_dir = task["pageOutputDir"] / f"tile-{tile_index:02d}"
                    tile_omr_runs += 1
                    tile_musicxml = self._run_audiveris(tile_input, tile_output_dir)
                    if tile_musicxml:
                        cache_path = self._page_result_cache_path(str(task["pageFingerprint"]))
                        try:
                            xml_text = self._read_musicxml_source(Path(tile_musicxml))
                            if xml_text.strip() and not cache_path.exists():
                                cache_path.write_text(xml_text, encoding="utf-8")
                                tile_musicxml = str(cache_path)
                        except Exception:
                            pass
                        generated_sources_with_order.append((int(task["pageIndex"]), tile_musicxml))
                        break
            generated_sources_with_order.sort(key=lambda item: item[0])
            pagewise_cache_hit_rate = round(page_result_cache_hits / page_count, 4) if page_count else 0.0
            render_cache_hit_rate = round(render_cache_hits / max(1, render_cache_hits + render_cache_misses), 4)
            tile_render_cache_hit_rate = round(tile_render_cache_hits / max(1, tile_render_cache_hits + tile_render_cache_misses), 4)
            stats = {
                "mode": "pagewise",
                "pageCount": page_count,
                "pageResultCacheHits": page_result_cache_hits,
                "pageResultCacheMisses": page_result_cache_misses,
                "pageResultCacheHitRate": pagewise_cache_hit_rate,
                "renderCacheHits": render_cache_hits,
                "renderCacheMisses": render_cache_misses,
                "renderCacheHitRate": render_cache_hit_rate,
                "tileRenderCacheHits": tile_render_cache_hits,
                "tileRenderCacheMisses": tile_render_cache_misses,
                "tileRenderCacheHitRate": tile_render_cache_hit_rate,
                "pageOmrRuns": page_omr_runs,
                "tileOmrRuns": tile_omr_runs,
                "resultCount": len(generated_sources_with_order),
                "workers": max_workers,
            }
            return [source for _, source in generated_sources_with_order], stats
        finally:
            if fitz_document is not None:
                try:
                    fitz_document.close()
                except Exception:
                    pass

    def _parse_musicxml_source_to_section(
        self,
        source_path: Path,
        request: ScoreImportRequest,
        selected_part_hint: str,
        section_id: str,
        section_title: str,
        sequence_index: int,
    ) -> tuple[dict[str, Any] | None, list[str], str]:
        xml_text = self._read_musicxml_source(source_path)
        if not xml_text.strip():
            return None, [], selected_part_hint

        detected_parts = self._extract_musicxml_parts(xml_text)
        resolved_part = self._resolve_selected_part(detected_parts, selected_part_hint)
        temp_request = AnalyzeRequest(
            participantId="score-import",
            pieceId=request.jobId,
            sectionId=section_id,
            piecePack={
                "pieceId": request.jobId,
                "sectionId": section_id,
                "title": request.titleHint or request.originalFilename or request.jobId,
                "meter": "4/4",
                "tempo": 72,
                "notes": [],
                "scoreSource": {"format": "musicxml", "encoding": "utf-8", "data": xml_text},
            },
        )
        parsed_notes = self._parse_musicxml_score(xml_text, temp_request, resolved_part)
        if not parsed_notes:
            return None, detected_parts, resolved_part

        section = {
            "sectionId": section_id,
            "title": section_title,
            "tempo": 72,
            "meter": "4/4",
            "demoAudio": "",
            "sequenceIndex": sequence_index,
            "notes": [
                {
                    "noteId": note.note_id,
                    "measureIndex": note.measure_index,
                    "beatStart": note.beat_start,
                    "beatDuration": note.beat_duration,
                    "midiPitch": note.midi_pitch,
                    "notePosition": dict(note.note_position or {}) if getattr(note, "note_position", None) else None,
                }
                for note in parsed_notes
            ],
        }
        return section, detected_parts, resolved_part

    def _build_piece_pack_from_musicxml_sources(
        self,
        musicxml_sources: list[Path],
        request: ScoreImportRequest,
        selected_part_hint: str,
    ) -> tuple[dict[str, Any] | None, list[str], str]:
        sections: list[dict[str, Any]] = []
        detected_parts: list[str] = []
        resolved_part = selected_part_hint or "erhu"
        multiple_sources = len(musicxml_sources) > 1

        for index, source_path in enumerate(musicxml_sources, start=1):
            section_id = "section-a" if not multiple_sources and index == 1 else f"page-{index:02d}"
            section_title = "自动识谱段落" if not multiple_sources and index == 1 else f"自动识谱第 {index} 页"
            section, parts, next_resolved_part = self._parse_musicxml_source_to_section(
                source_path,
                request,
                resolved_part,
                section_id,
                section_title,
                index,
            )
            for part_name in parts:
                if part_name and part_name not in detected_parts:
                    detected_parts.append(part_name)
            resolved_part = next_resolved_part or resolved_part
            if section:
                page_image_path = ""
                if request.outputDir:
                    candidate_image = Path(request.outputDir) / "pagewise" / f"page-{index:03d}.png"
                    if candidate_image.exists():
                        page_image_path = f"/data/score-imports/{request.jobId}/pagewise/{candidate_image.name}"
                if page_image_path:
                    section["pageImagePath"] = page_image_path
                sections.extend(self._chunk_imported_section(section))

        if not sections:
            return None, detected_parts or [selected_part_hint], resolved_part

        piece_pack = {
            "pieceId": request.jobId,
            "title": request.titleHint or request.originalFilename or request.jobId,
            "composer": "Audiveris OMR",
            "selectedPart": resolved_part,
            "detectedParts": detected_parts or [resolved_part],
            "sections": sections,
        }
        return piece_pack, list(piece_pack["detectedParts"]), resolved_part

    def _chunk_imported_section(self, section: dict[str, Any]) -> list[dict[str, Any]]:
        notes = list(section.get("notes") or [])
        if not notes:
            return [section]
        if len(notes) <= 20:
            return [section]

        measure_beats = beats_per_measure(section.get("meter"))
        ordered_notes = sorted(
            notes,
            key=lambda note: (
                int(note.get("measureIndex", 0)),
                float(note.get("beatStart", 0.0)),
                float(note.get("beatDuration", 0.0)),
                int(note.get("midiPitch", 0)),
            ),
        )
        enriched_notes: list[dict[str, Any]] = []
        measure_groups: dict[int, list[dict[str, Any]]] = {}
        absolute_beat_min = math.inf
        absolute_beat_max = 0.0
        for note in ordered_notes:
            measure_index = max(1, int(note.get("measureIndex", 1)))
            beat_start = float(note.get("beatStart", 0.0))
            beat_duration = max(0.125, float(note.get("beatDuration", 0.0)) or 0.25)
            absolute_start = ((measure_index - 1) * measure_beats) + beat_start
            absolute_end = absolute_start + beat_duration
            enriched_note = {
                **note,
                "_absoluteBeatStart": absolute_start,
                "_absoluteBeatEnd": absolute_end,
            }
            enriched_notes.append(enriched_note)
            measure_groups.setdefault(measure_index, []).append(enriched_note)
            absolute_beat_min = min(absolute_beat_min, absolute_start)
            absolute_beat_max = max(absolute_beat_max, absolute_end)

        total_measure_count = len(measure_groups)
        total_beat_span = max(0.0, absolute_beat_max - (0.0 if math.isinf(absolute_beat_min) else absolute_beat_min))
        note_density = float(len(enriched_notes)) / max(1, total_measure_count)
        if len(enriched_notes) <= 36 and total_measure_count <= 3 and total_beat_span <= 12.0:
            return [section]

        dense_import = len(enriched_notes) >= 100 or note_density >= 10.0 or total_beat_span >= 28.0
        very_dense_import = len(enriched_notes) >= 180 or note_density >= 16.0 or total_beat_span >= 48.0
        target_note_count = 22 if very_dense_import else (30 if dense_import else 40)
        max_note_count = 34 if very_dense_import else (46 if dense_import else 58)
        target_measure_span = 2 if very_dense_import else (3 if dense_import else 4)
        max_measure_span = target_measure_span + 1
        target_beat_span = 8.0 if very_dense_import else (12.0 if dense_import else 16.0)
        hard_beat_span = target_beat_span + 4.0
        gap_trigger_beats = 1.25 if dense_import else 1.75

        chunks: list[dict[str, Any]] = []
        current_notes: list[dict[str, Any]] = []
        current_measures: list[int] = []
        current_beat_start = 0.0
        current_beat_end = 0.0

        def flush_chunk() -> None:
            nonlocal current_notes, current_measures, current_beat_start, current_beat_end
            if not current_notes:
                return
            chunk_index = len(chunks) + 1
            base_sequence = int(section.get("sequenceIndex", 1))
            sanitized_notes = [
                {
                    key: value
                    for key, value in note.items()
                    if not str(key).startswith("_")
                }
                for note in current_notes
            ]
            chunk = {
                **section,
                "sectionId": f"{section.get('sectionId', 'section')}-s{chunk_index:02d}",
                "title": f"{section.get('title', '自动识谱段落')} 片段 {chunk_index}",
                "sequenceIndex": (base_sequence * 100) + chunk_index,
                "notes": sanitized_notes,
                "sourceSectionId": section.get("sectionId", ""),
                "measureRange": [min(current_measures), max(current_measures)] if current_measures else [],
                "chunkBeatRange": [round(current_beat_start, 3), round(current_beat_end, 3)] if current_notes else [],
                "chunkedImported": True,
            }
            chunks.append(chunk)
            current_notes = []
            current_measures = []
            current_beat_start = 0.0
            current_beat_end = 0.0

        measure_items = sorted(measure_groups.items(), key=lambda item: item[0])
        for measure_index, measure_notes in measure_items:
            measure_start = min(float(note.get("_absoluteBeatStart", 0.0)) for note in measure_notes)
            measure_end = max(float(note.get("_absoluteBeatEnd", 0.0)) for note in measure_notes)
            if current_notes and (
                (
                    (measure_start - current_beat_end) > gap_trigger_beats
                    and len(current_notes) >= max(8, target_note_count // 2)
                )
                or ((max(current_measures) - min(current_measures) + 1) >= max_measure_span)
                or ((current_beat_end - current_beat_start) >= hard_beat_span)
                or (len(current_notes) + len(measure_notes) > max_note_count)
                or (
                    len(current_notes) >= target_note_count
                    and (
                        len(current_measures) >= target_measure_span
                        or (current_beat_end - current_beat_start) >= target_beat_span
                    )
                )
            ):
                flush_chunk()
            current_notes.extend(measure_notes)
            current_measures.append(measure_index)
            current_beat_start = measure_start if len(current_notes) == len(measure_notes) else min(current_beat_start, measure_start)
            current_beat_end = max(current_beat_end, measure_end)
        flush_chunk()

        if len(chunks) >= 2 and len(chunks[-1]["notes"]) < 12:
            tail = chunks.pop()
            chunks[-1]["notes"].extend(tail["notes"])
            measure_range = list(chunks[-1].get("measureRange") or [])
            tail_range = list(tail.get("measureRange") or [])
            if measure_range and tail_range:
                chunks[-1]["measureRange"] = [min(measure_range[0], tail_range[0]), max(measure_range[-1], tail_range[-1])]
            beat_range = list(chunks[-1].get("chunkBeatRange") or [])
            tail_beat_range = list(tail.get("chunkBeatRange") or [])
            if beat_range and tail_beat_range:
                chunks[-1]["chunkBeatRange"] = [min(beat_range[0], tail_beat_range[0]), max(beat_range[-1], tail_beat_range[-1])]

        return chunks or [section]

    def import_pdf_score(self, request: ScoreImportRequest) -> ScoreImportJobResult:
        output_dir = Path(request.outputDir or (Path(self.settings.data_root) / "score-imports" / request.jobId))
        output_dir.mkdir(parents=True, exist_ok=True)

        pdf_path = Path(request.pdfPath)
        selected_part = (request.selectedPartHint or "erhu").strip() or "erhu"
        preview_pages = self._build_preview_pages(pdf_path, request.jobId)
        pdf_page_count = 1
        if PdfReader is not None:
            try:
                pdf_page_count = max(1, len(PdfReader(str(pdf_path)).pages))
            except Exception:
                pdf_page_count = 1

        warnings: list[str] = []
        piece_pack = None
        musicxml_path = ""
        omr_confidence = 0.0
        detected_parts: list[str] = [selected_part]
        omr_stats: dict[str, Any] = {"mode": "none", "pageCount": pdf_page_count}

        audiveris_cli = self.settings.audiveris_cli.strip()
        if audiveris_cli and os.path.exists(audiveris_cli):
            musicxml_sources: list[Path] = []
            generated_musicxml = None
            whole_pdf_attempted = False
            if pdf_page_count <= max(1, int(self.settings.omr_whole_pdf_max_pages)):
                whole_pdf_attempted = True
                generated_musicxml = self._run_audiveris(pdf_path, output_dir)
            else:
                warnings.append("多页五线谱已直接按页识谱，以缩短导入等待时间。")
            if generated_musicxml:
                musicxml_sources = [Path(generated_musicxml)]
                musicxml_path = generated_musicxml
                omr_confidence = 0.82
                omr_stats = {
                    "mode": "whole-pdf",
                    "pageCount": pdf_page_count,
                    "resultCount": 1,
                    "wholePdfAttempted": True,
                }
            else:
                pagewise_sources, pagewise_stats = self._run_audiveris_pagewise(pdf_path, output_dir / "pagewise")
                if pagewise_sources:
                    musicxml_sources = [Path(item) for item in pagewise_sources]
                    musicxml_path = str(musicxml_sources[0])
                    omr_confidence = 0.64
                    omr_stats = {
                        **pagewise_stats,
                        "wholePdfAttempted": whole_pdf_attempted,
                        "mode": str(pagewise_stats.get("mode") or "pagewise"),
                    }
                    warnings.append("整份 PDF 自动识谱失败，已回退到按页识谱。")
                else:
                    warnings.append("Audiveris 已调用，但未生成可用 MusicXML。")

            if musicxml_sources and not piece_pack:
                built_piece_pack, detected_parts, resolved_part = self._build_piece_pack_from_musicxml_sources(
                    musicxml_sources,
                    request,
                    selected_part,
                )
                if built_piece_pack:
                    piece_pack = built_piece_pack
                    selected_part = resolved_part
                else:
                    warnings.append("已生成 MusicXML，但当前未能稳定解析为结构化音符。")
        else:
            warnings.append("本机未配置 Audiveris，当前将优先使用已知曲目自动匹配。")

        warnings = self._compact_import_warnings(warnings)

        if not piece_pack:
            return ScoreImportJobResult(
                jobId=request.jobId,
                omrStatus="failed",
                omrConfidence=0.0,
                scoreId=None,
                title=request.titleHint or request.originalFilename or request.jobId,
                sourcePdfPath=request.pdfPath,
                musicxmlPath=musicxml_path or None,
                previewPages=preview_pages,
                detectedParts=[selected_part],
                selectedPart=selected_part,
                selectedPartCandidates=[selected_part],
                piecePack=None,
                omrStats=omr_stats,
                warnings=warnings,
                error="当前 PDF 尚未自动转换为可分析乐谱。请检查 Audiveris 是否正常输出，或导入已知内置曲目。",
            )

        if isinstance(piece_pack, dict):
            piece_pack["selectedPart"] = piece_pack.get("selectedPart") or selected_part
            piece_pack["detectedParts"] = list(piece_pack.get("detectedParts") or detected_parts or [selected_part])
            selected_part = str(piece_pack.get("selectedPart") or selected_part)
            detected_parts = list(piece_pack.get("detectedParts") or [selected_part])

        return ScoreImportJobResult(
            jobId=request.jobId,
            omrStatus="completed",
            omrConfidence=omr_confidence or (0.44 if request.fallbackPieceId else 0.58),
            scoreId=request.jobId,
            title=request.titleHint or request.originalFilename or request.jobId,
            sourcePdfPath=request.pdfPath,
            musicxmlPath=musicxml_path or None,
            previewPages=preview_pages,
            detectedParts=detected_parts,
            selectedPart=selected_part,
            selectedPartCandidates=detected_parts,
            piecePack=piece_pack,
            omrStats=omr_stats,
            warnings=warnings,
            error=None,
        )

    def separate_erhu(self, request: SeparateErhuRequest) -> SeparateErhuResult:
        audio = self._decode_audio(request)
        score_notes, _ = self._resolve_score_notes(request)
        pitch_track, _ = self._estimate_pitch_track(request, audio, score_notes)
        section_calibration = self._resolve_section_calibration(request)
        processed_audio, preprocess_applied, applied_mode, separation_meta = self._preprocess_audio(
            request,
            audio,
            score_notes,
            pitch_track,
            "erhu-focus",
            section_calibration,
        )
        return SeparateErhuResult(
            separationApplied=preprocess_applied,
            separationMode=applied_mode,
            separationConfidence=float(separation_meta.get("separationConfidence", 0.0)),
            inputAudioPath=separation_meta.get("rawAudioPath"),
            erhuEnhancedAudioPath=separation_meta.get("erhuEnhancedAudioPath"),
            accompanimentResidualPath=separation_meta.get("accompanimentResidualPath"),
            warnings=list(separation_meta.get("warnings", [])),
        )

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        audio = self._decode_audio(request)
        score_notes, score_source = self._resolve_score_notes(request)
        preprocess_mode = self._resolve_preprocess_mode(request)
        pitch_track, pitch_source = self._estimate_pitch_track(request, audio, score_notes)
        section_calibration = self._resolve_section_calibration(request)
        analysis_audio, preprocess_applied, applied_preprocess_mode, separation_meta = self._preprocess_audio(
            request,
            audio,
            score_notes,
            pitch_track,
            preprocess_mode,
            section_calibration,
        )
        if preprocess_applied:
            pitch_track, pitch_source = self._estimate_pitch_track(request, analysis_audio, score_notes)
        onset_track, onset_source = self._estimate_onsets(analysis_audio, score_notes)
        beat_track, beat_source = self._estimate_beats(analysis_audio, score_notes)
        aligned_notes, alignment_mode = self._align_to_score(
            request,
            analysis_audio,
            pitch_track,
            onset_track,
            score_notes,
            section_calibration,
            separation_meta,
        )
        return self._build_feedback(
            request=request,
            audio=analysis_audio,
            score_notes=score_notes,
            aligned_notes=aligned_notes,
            pitch_track=pitch_track,
            onset_track=onset_track,
            beat_track=beat_track,
            pitch_source=pitch_source,
            onset_source=onset_source,
            beat_source=beat_source,
            score_source=score_source,
            alignment_mode=alignment_mode,
            preprocess_mode=preprocess_mode,
            preprocess_applied=preprocess_applied,
            applied_preprocess_mode=applied_preprocess_mode,
            section_calibration=section_calibration,
            separation_meta=separation_meta,
        )

    def rank_sections(self, request: RankSectionsRequest) -> list[RankedSectionCandidate]:
        piece_packs = [piece_pack for piece_pack in list(request.piecePacks or []) if piece_pack]
        if not piece_packs:
            return []

        audio = self._decode_audio(request)
        ranking_audio = self._build_detection_audio_for_ranking(audio)
        merged_score_notes = self._merge_candidate_score_notes(piece_packs, request)
        preprocess_mode = self._resolve_preprocess_mode(request)
        base_pitch_track, pitch_source = self._estimate_pitch_track_for_ranking_from_piecepacks(
            request,
            ranking_audio,
            merged_score_notes,
        )
        analysis_audio, preprocess_applied, applied_preprocess_mode, separation_meta = self._preprocess_audio(
            request,
            ranking_audio,
            merged_score_notes,
            base_pitch_track,
            preprocess_mode,
            {"rankingPreprocess": True},
            persist_outputs=False,
        )
        if preprocess_applied:
            pitch_track, pitch_source = self._estimate_pitch_track_for_ranking_from_piecepacks(
                request,
                analysis_audio,
                merged_score_notes,
            )
        else:
            pitch_track = base_pitch_track
        ranking_pitch_track = self._compress_pitch_track_for_ranking(pitch_track)
        if bool(self.settings.ranking_use_score_onsets_only) and merged_score_notes:
            ranking_onset_track: list[dict[str, float]] = []
            onset_source = "score-onset-ranking"
        else:
            onset_track, onset_source = self._estimate_onsets(analysis_audio, merged_score_notes)
            ranking_onset_track = self._compress_onset_track_for_ranking(onset_track)

        ranked_piece_packs = piece_packs
        grouped_piece_packs = self._group_piece_packs_by_source(piece_packs)

        can_use_hierarchical_ranking = (
            len(piece_packs) >= 18
            and len(grouped_piece_packs) >= 4
            and any(len(items) >= 2 for items in grouped_piece_packs.values())
        )

        if can_use_hierarchical_ranking:
            probe_piece_packs = [
                self._build_detection_probe_piece_pack(group_id, items)
                for group_id, items in grouped_piece_packs.items()
            ]
            probe_piece_packs = [piece_pack for piece_pack in probe_piece_packs if piece_pack]
            probe_ranked = self._rank_piece_packs_fast(
                request=request,
                piece_packs=probe_piece_packs,
                analysis_audio=analysis_audio,
                ranking_pitch_track=ranking_pitch_track,
                ranking_onset_track=ranking_onset_track,
                pitch_source=pitch_source,
                onset_source=onset_source,
                preprocess_mode=preprocess_mode,
                preprocess_applied=preprocess_applied,
                applied_preprocess_mode=applied_preprocess_mode,
                separation_meta=separation_meta,
            )
            selected_group_ids = self._pick_probe_group_ids(probe_ranked)
            if selected_group_ids and len(selected_group_ids) < len(grouped_piece_packs):
                ranked_piece_packs = [
                    piece_pack
                    for piece_pack in piece_packs
                    if self._piece_pack_group_id(piece_pack) in selected_group_ids
                ]

        if len(ranked_piece_packs) >= 10:
            grouped_for_sampling = self._group_piece_packs_by_source(ranked_piece_packs)
            coarse_piece_packs: list[Any] = []
            for items in grouped_for_sampling.values():
                target_count = 3 if len(items) >= 10 else 2
                coarse_piece_packs.extend(self._sample_piece_packs_for_detection(items, target_count))
            coarse_ranked = self._rank_piece_packs_fast(
                request=request,
                piece_packs=coarse_piece_packs,
                analysis_audio=analysis_audio,
                ranking_pitch_track=ranking_pitch_track,
                ranking_onset_track=ranking_onset_track,
                pitch_source=pitch_source,
                onset_source=onset_source,
                preprocess_mode=preprocess_mode,
                preprocess_applied=preprocess_applied,
                applied_preprocess_mode=applied_preprocess_mode,
                separation_meta=separation_meta,
            )
            expanded_piece_packs = self._expand_piece_packs_around_candidates(
                coarse_ranked[: min(3, len(coarse_ranked))],
                ranked_piece_packs,
                radius=2 if len(ranked_piece_packs) >= 18 else 1,
            )
            if expanded_piece_packs and len(expanded_piece_packs) < len(ranked_piece_packs):
                ranked_piece_packs = expanded_piece_packs

        return self._rank_piece_packs_fast(
            request=request,
            piece_packs=ranked_piece_packs,
            analysis_audio=analysis_audio,
            ranking_pitch_track=ranking_pitch_track,
            ranking_onset_track=ranking_onset_track,
            pitch_source=pitch_source,
            onset_source=onset_source,
            preprocess_mode=preprocess_mode,
            preprocess_applied=preprocess_applied,
            applied_preprocess_mode=applied_preprocess_mode,
            separation_meta=separation_meta,
        )

    def _build_detection_audio_for_ranking(self, audio: AudioArtifact) -> AudioArtifact:
        if (
            audio.waveform is None
            or audio.sample_rate is None
            or np is None
            or librosa is None
            or audio.sample_rate <= 0
        ):
            return audio
        duration_seconds = float(audio.duration_seconds or (len(audio.waveform) / max(audio.sample_rate, 1)))
        target_sample_rate = int(self.settings.ranking_preprocess_sample_rate)
        if duration_seconds < float(self.settings.ranking_preprocess_min_duration_seconds):
            return audio
        if target_sample_rate <= 0 or audio.sample_rate <= target_sample_rate:
            return audio
        try:
            ranking_waveform = librosa.resample(
                np.asarray(audio.waveform, dtype=np.float32),
                orig_sr=int(audio.sample_rate),
                target_sr=target_sample_rate,
            ).astype(np.float32)
        except Exception:
            return audio
        ranking_hash = self._json_hash(
            {
                "audioHash": audio.audio_hash,
                "mode": "ranking-lite",
                "sampleRate": target_sample_rate,
            }
        )
        return AudioArtifact(
            raw_bytes=audio.raw_bytes,
            duration_seconds=audio.duration_seconds,
            sample_rate=target_sample_rate,
            waveform=ranking_waveform,
            decode_method=f"{audio.decode_method}+ranking-lite" if audio.decode_method else "ranking-lite",
            ffmpeg_path=audio.ffmpeg_path,
            audio_hash=ranking_hash,
            cache_key=f"{audio.cache_key}-ranking-lite-{target_sample_rate}" if audio.cache_key else None,
        )

    def _rank_piece_packs_fast(
        self,
        *,
        request: RankSectionsRequest,
        piece_packs: list[Any],
        analysis_audio: AudioArtifact,
        ranking_pitch_track: list[dict[str, float]],
        ranking_onset_track: list[dict[str, float]],
        pitch_source: str,
        onset_source: str,
        preprocess_mode: str,
        preprocess_applied: bool,
        applied_preprocess_mode: str,
        separation_meta: dict[str, Any],
    ) -> list[RankedSectionCandidate]:
        ranked: list[RankedSectionCandidate] = []
        for piece_pack in piece_packs:
            analyze_request = self._build_analyze_request_for_piecepack(request, piece_pack)
            score_notes, score_source = self._resolve_score_notes(analyze_request)
            if not score_notes:
                continue
            full_score_duration = max((note.expected_offset for note in score_notes), default=0.0)
            ranking_score_notes = self._sample_section_score_notes_for_ranking(score_notes)
            section_calibration = self._resolve_section_calibration(analyze_request)
            aligned_notes, alignment_mode = self._align_to_score(
                analyze_request,
                analysis_audio,
                ranking_pitch_track,
                ranking_onset_track,
                ranking_score_notes,
                section_calibration,
                separation_meta,
            )
            result = self._build_fast_rank_result(
                aligned_notes=aligned_notes,
                pitch_source=pitch_source,
                onset_source=onset_source,
                score_source=score_source,
                alignment_mode=alignment_mode,
                preprocess_mode=preprocess_mode,
                preprocess_applied=preprocess_applied,
                applied_preprocess_mode=applied_preprocess_mode,
                section_calibration=section_calibration,
                separation_meta=separation_meta,
                audio=analysis_audio,
                score_duration=full_score_duration,
                score_note_count=len(score_notes),
            )
            ranked.append(
                RankedSectionCandidate(
                    pieceId=piece_pack.pieceId,
                    sectionId=piece_pack.sectionId or "",
                    sourceSectionId=getattr(piece_pack, "sourceSectionId", None),
                    sectionTitle=piece_pack.title or piece_pack.sectionId or "",
                    sequenceIndex=int(getattr(piece_pack, "sequenceIndex", 0) or 0),
                    score=self._ranked_candidate_score(result),
                    overallPitchScore=int(result.overallPitchScore),
                    overallRhythmScore=int(result.overallRhythmScore),
                    confidence=float(result.confidence),
                    recommendedPracticePath=result.recommendedPracticePath,
                    measureFindingCount=len(result.measureFindings),
                    noteFindingCount=len(result.noteFindings),
                    summaryText=result.summaryText,
                    diagnostics=result.diagnostics,
                )
            )
        ranked.sort(
            key=lambda item: (
                float(item.score),
                float(item.confidence),
                float(item.overallRhythmScore),
                float(item.overallPitchScore),
                -float(item.sequenceIndex),
            ),
            reverse=True,
        )
        return ranked

    def _piece_pack_group_id(self, piece_pack: Any) -> str:
        source_section_id = str(getattr(piece_pack, "sourceSectionId", "") or "").strip()
        if source_section_id:
            return source_section_id
        section_id = str(getattr(piece_pack, "sectionId", "") or "").strip()
        if not section_id:
            return ""
        chunk_match = re.match(r"^(.*)-s\d+$", section_id, flags=re.IGNORECASE)
        return chunk_match.group(1) if chunk_match else section_id

    def _group_piece_packs_by_source(self, piece_packs: list[Any]) -> dict[str, list[Any]]:
        grouped: dict[str, list[Any]] = {}
        ordered_piece_packs = sorted(
            piece_packs,
            key=lambda item: (
                int(getattr(item, "sequenceIndex", 0) or 0),
                str(getattr(item, "sectionId", "") or ""),
            ),
        )
        for piece_pack in ordered_piece_packs:
            group_id = self._piece_pack_group_id(piece_pack)
            grouped.setdefault(group_id, []).append(piece_pack)
        return grouped

    def _piece_pack_note_value(self, note: Any, field_name: str, default: Any = 0) -> Any:
        if isinstance(note, dict):
            return note.get(field_name, default)
        return getattr(note, field_name, default)

    def _build_detection_probe_piece_pack(self, group_id: str, piece_packs: list[Any]) -> PiecePack | None:
        ordered_piece_packs = sorted(
            piece_packs,
            key=lambda item: int(getattr(item, "sequenceIndex", 0) or 0),
        )
        if not ordered_piece_packs:
            return None

        all_notes = sorted(
            [note for piece_pack in ordered_piece_packs for note in list(getattr(piece_pack, "notes", []) or [])],
            key=lambda note: (
                int(self._piece_pack_note_value(note, "measureIndex", 0) or 0),
                float(self._piece_pack_note_value(note, "beatStart", 0.0) or 0.0),
                int(self._piece_pack_note_value(note, "midiPitch", 0) or 0),
            ),
        )
        if not all_notes:
            return None

        if len(all_notes) > 180:
            target_count = 28
        elif len(all_notes) > 96:
            target_count = 24
        else:
            target_count = min(18, len(all_notes))

        used_indexes: set[int] = set()
        sampled_notes: list[NoteEvent] = []
        for sample_index in range(target_count):
            source_index = int(round((sample_index / max(1, target_count - 1)) * max(0, len(all_notes) - 1)))
            if source_index in used_indexes:
                continue
            used_indexes.add(source_index)
            source_note = all_notes[source_index]
            sampled_notes.append(
                NoteEvent(
                    noteId=str(self._piece_pack_note_value(source_note, "noteId", f"{group_id}-probe-{source_index}") or ""),
                    measureIndex=int(self._piece_pack_note_value(source_note, "measureIndex", 1) or 1),
                    beatStart=float(self._piece_pack_note_value(source_note, "beatStart", 0.0) or 0.0),
                    beatDuration=float(self._piece_pack_note_value(source_note, "beatDuration", 1.0) or 1.0),
                    midiPitch=int(self._piece_pack_note_value(source_note, "midiPitch", 60) or 60),
                )
            )

        first_piece_pack = ordered_piece_packs[0]
        last_piece_pack = ordered_piece_packs[-1]
        merged_hints = sorted(
            {
                float(value)
                for piece_pack in ordered_piece_packs
                for value in list(getattr(piece_pack, "researchWindowHints", []) or [])
                if value is not None
            }
        )

        first_range = list(getattr(first_piece_pack, "measureRange", []) or [])
        last_range = list(getattr(last_piece_pack, "measureRange", []) or [])
        measure_range: list[int] = []
        if first_range and last_range:
            try:
                measure_range = [int(min(first_range)), int(max(last_range))]
            except Exception:
                measure_range = []

        return PiecePack(
            pieceId=getattr(first_piece_pack, "pieceId", None),
            sectionId=f"{group_id}--probe",
            title=f"{getattr(first_piece_pack, 'title', group_id) or group_id} Probe",
            meter=getattr(first_piece_pack, "meter", None),
            tempo=int(getattr(first_piece_pack, "tempo", 72) or 72),
            demoAudio=None,
            sequenceIndex=int(getattr(first_piece_pack, "sequenceIndex", 0) or 0),
            sourceSectionId=group_id,
            researchWindowHints=merged_hints,
            measureRange=measure_range,
            calibrationProfile=None,
            notes=sampled_notes,
            scoreSource=None,
        )

    def _sample_piece_packs_for_detection(self, piece_packs: list[Any], target_count: int = 6) -> list[Any]:
        ordered_piece_packs = sorted(
            piece_packs,
            key=lambda item: int(getattr(item, "sequenceIndex", 0) or 0),
        )
        if len(ordered_piece_packs) <= target_count:
            return ordered_piece_packs

        indexes = {0, len(ordered_piece_packs) - 1}
        desired = max(2, int(target_count))
        for sample_index in range(desired):
            source_index = int(round((sample_index / max(1, desired - 1)) * max(0, len(ordered_piece_packs) - 1)))
            indexes.add(source_index)

        return [ordered_piece_packs[index] for index in sorted(indexes)]

    def _expand_piece_packs_around_candidates(
        self,
        ranked_candidates: list[RankedSectionCandidate],
        all_piece_packs: list[Any],
        radius: int = 2,
    ) -> list[Any]:
        ordered_piece_packs = sorted(
            all_piece_packs,
            key=lambda item: int(getattr(item, "sequenceIndex", 0) or 0),
        )
        if not ordered_piece_packs:
            return []

        index_by_section_id = {
            str(getattr(piece_pack, "sectionId", "") or ""): index
            for index, piece_pack in enumerate(ordered_piece_packs)
        }
        selected_indexes: set[int] = set()
        for candidate in ranked_candidates:
            section_id = str(candidate.sectionId or "").strip()
            if not section_id or section_id not in index_by_section_id:
                continue
            base_index = index_by_section_id[section_id]
            for offset in range(-radius, radius + 1):
                target_index = base_index + offset
                if 0 <= target_index < len(ordered_piece_packs):
                    selected_indexes.add(target_index)

        return [ordered_piece_packs[index] for index in sorted(selected_indexes)]

    def _pick_probe_group_ids(self, probe_candidates: list[RankedSectionCandidate]) -> set[str]:
        if not probe_candidates:
            return set()
        if len(probe_candidates) == 1:
            return {self._piece_pack_group_id(probe_candidates[0]) or str(probe_candidates[0].sourceSectionId or "")}

        top = probe_candidates[0]
        second = probe_candidates[1]
        gap = float(top.score) - float(second.score)
        top_confidence = float(top.confidence)
        if gap >= 10 and top_confidence >= 0.8:
            group_count = 1
        elif gap >= 5 and top_confidence >= 0.72:
            group_count = 2
        else:
            group_count = 3

        selected_group_ids: set[str] = set()
        for candidate in probe_candidates[: max(1, min(group_count, len(probe_candidates)))]:
            group_id = str(candidate.sourceSectionId or "").strip()
            if group_id:
                selected_group_ids.add(group_id)
        return selected_group_ids

    def _compress_pitch_track_for_ranking(self, pitch_track: list[dict[str, float]]) -> list[dict[str, float]]:
        if len(pitch_track) <= 1800:
            return pitch_track
        stride = max(2, int(math.ceil(len(pitch_track) / 1800)))
        compressed = [item for index, item in enumerate(pitch_track) if index % stride == 0]
        if pitch_track and compressed[-1] is not pitch_track[-1]:
            compressed.append(pitch_track[-1])
        return compressed

    def _compress_onset_track_for_ranking(self, onset_track: list[dict[str, float]]) -> list[dict[str, float]]:
        if len(onset_track) <= 256:
            return onset_track
        compressed: list[dict[str, float]] = []
        last_time = -999.0
        for item in onset_track:
            time_value = float(item.get("time", 0.0))
            if (time_value - last_time) < 0.03:
                continue
            compressed.append(item)
            last_time = time_value
        return compressed or onset_track

    def _estimate_pitch_track_for_ranking(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        score_notes: list[SymbolicNote],
    ) -> tuple[list[dict[str, float]], str]:
        cached_track, cached_source = self._read_cached_feature(audio, "pitch-ranking")
        if cached_track is not None and cached_source:
            return cached_track, cached_source

        cached_full_track, cached_full_source = self._read_cached_feature(audio, "pitch")
        if cached_full_track is not None and cached_full_source:
            compressed_track = self._compress_pitch_track_for_ranking(cached_full_track)
            self._write_cached_feature(audio, "pitch-ranking", compressed_track, f"{cached_full_source}-ranking-cache")
            return compressed_track, f"{cached_full_source}-ranking-cache"

        if audio.waveform is None or audio.sample_rate is None or np is None:
            track = self._synthetic_pitch_track(score_notes)
            compressed_track = self._compress_pitch_track_for_ranking(track)
            self._write_cached_feature(audio, "pitch-ranking", compressed_track, "synthetic-ranking")
            return compressed_track, "synthetic-ranking"

        waveform = np.asarray(audio.waveform, dtype=np.float32)
        if waveform.size == 0:
            track = self._synthetic_pitch_track(score_notes)
            compressed_track = self._compress_pitch_track_for_ranking(track)
            self._write_cached_feature(audio, "pitch-ranking", compressed_track, "synthetic-ranking")
            return compressed_track, "synthetic-ranking"

        if self.settings.enable_torchcrepe and torch is not None and torchcrepe is not None:
            try:
                ranking_waveform = waveform
                ranking_sample_rate = int(audio.sample_rate)
                target_ranking_sr = int(self.settings.target_sample_rate)
                if (
                    librosa is not None
                    and target_ranking_sr > 0
                    and ranking_sample_rate > target_ranking_sr
                ):
                    ranking_waveform = librosa.resample(
                        ranking_waveform,
                        orig_sr=ranking_sample_rate,
                        target_sr=target_ranking_sr,
                    ).astype(np.float32)
                    ranking_sample_rate = target_ranking_sr

                tensor = torch.tensor(ranking_waveform, dtype=torch.float32).unsqueeze(0)
                duration_seconds = float(audio.duration_seconds or (len(waveform) / max(audio.sample_rate, 1)))
                if duration_seconds >= float(self.settings.ranking_very_long_audio_seconds):
                    ranking_hop_ms = int(self.settings.ranking_very_long_pitch_hop_ms)
                elif duration_seconds >= float(self.settings.ranking_long_audio_seconds):
                    ranking_hop_ms = int(self.settings.ranking_long_pitch_hop_ms)
                else:
                    ranking_hop_ms = int(self.settings.ranking_pitch_hop_ms)
                hop_ms = max(int(self.settings.pitch_hop_ms), ranking_hop_ms)
                hop_length = max(1, int(ranking_sample_rate * (hop_ms / 1000.0)))
                pitch, periodicity = torchcrepe.predict(
                    tensor,
                    ranking_sample_rate,
                    hop_length=hop_length,
                    fmin=120.0,
                    fmax=1400.0,
                    batch_size=512,
                    device="cpu",
                    return_periodicity=True,
                )
                pitch_values = pitch.squeeze(0).detach().cpu().numpy()
                confidence_values = periodicity.squeeze(0).detach().cpu().numpy()
                track = [
                    {
                        "time": index * (hop_length / ranking_sample_rate),
                        "frequency": float(freq),
                        "confidence": float(conf),
                    }
                    for index, (freq, conf) in enumerate(zip(pitch_values, confidence_values, strict=False))
                    if float(freq) > 0 and float(conf) >= self.settings.min_confidence
                ]
                if track:
                    compressed_track = self._compress_pitch_track_for_ranking(track)
                    self._write_cached_feature(audio, "pitch-ranking", compressed_track, "torchcrepe-ranking")
                    return compressed_track, "torchcrepe-ranking"
            except Exception:
                pass

        full_track, full_source = self._estimate_pitch_track(request, audio, score_notes)
        compressed_track = self._compress_pitch_track_for_ranking(full_track)
        self._write_cached_feature(audio, "pitch-ranking", compressed_track, f"{full_source}-ranking")
        return compressed_track, f"{full_source}-ranking"

    def _build_analyze_request_for_piecepack(
        self,
        request: RankSectionsRequest,
        piece_pack: Any,
    ) -> AnalyzeRequest:
        return AnalyzeRequest(
            participantId=request.participantId,
            groupId=request.groupId,
            sessionStage=request.sessionStage,
            scoreId=request.scoreId,
            pieceId=piece_pack.pieceId or request.pieceId,
            sectionId=piece_pack.sectionId,
            preprocessMode=request.preprocessMode,
            separationMode=request.separationMode,
            piecePack=piece_pack,
            audioSubmission=request.audioSubmission,
            audioPath=request.audioPath,
            audioDataUrl=request.audioDataUrl,
        )

    def _sample_score_notes_for_ranking(self, notes: list[SymbolicNote]) -> list[SymbolicNote]:
        max_notes = max(32, int(self.settings.ranking_max_score_notes))
        if len(notes) <= max_notes:
            return notes
        selected_indexes = {
            int(round((sample_index / max(1, max_notes - 1)) * max(0, len(notes) - 1)))
            for sample_index in range(max_notes)
        }
        return [notes[index] for index in sorted(selected_indexes)]

    def _sample_section_score_notes_for_ranking(self, notes: list[SymbolicNote]) -> list[SymbolicNote]:
        dense_threshold = max(24, int(self.settings.ranking_dense_section_note_threshold))
        max_notes = max(24, int(self.settings.ranking_max_section_score_notes))
        if len(notes) <= dense_threshold or len(notes) <= max_notes:
            return notes

        onset_groups: list[list[SymbolicNote]] = []
        current_group: list[SymbolicNote] = []
        current_onset: float | None = None
        for note in sorted(notes, key=lambda item: (item.expected_onset, item.expected_offset, item.midi_pitch, item.note_id)):
            onset_key = round(float(note.expected_onset), 4)
            if current_onset is None or onset_key != current_onset:
                if current_group:
                    onset_groups.append(current_group)
                current_group = [note]
                current_onset = onset_key
            else:
                current_group.append(note)
        if current_group:
            onset_groups.append(current_group)

        if len(onset_groups) <= max_notes:
            return [
                max(group, key=lambda item: (float(item.expected_offset - item.expected_onset), float(item.midi_pitch)))
                for group in onset_groups
            ]

        selected_group_indexes = {
            int(round((sample_index / max(1, max_notes - 1)) * max(0, len(onset_groups) - 1)))
            for sample_index in range(max_notes)
        }
        sampled_notes: list[SymbolicNote] = []
        for group_index in sorted(selected_group_indexes):
            group = onset_groups[group_index]
            sampled_notes.append(
                max(group, key=lambda item: (float(item.expected_offset - item.expected_onset), float(item.midi_pitch)))
            )
        return sampled_notes if sampled_notes else notes

    def _merge_candidate_score_notes(
        self,
        piece_packs: list[Any],
        request: RankSectionsRequest,
    ) -> list[SymbolicNote]:
        merged: list[SymbolicNote] = []
        for piece_pack in piece_packs:
            analyze_request = self._build_analyze_request_for_piecepack(request, piece_pack)
            score_notes, _ = self._resolve_score_notes(analyze_request)
            merged.extend(score_notes)
        if not merged:
            return []
        merged.sort(key=lambda note: (note.expected_onset, note.expected_offset, note.midi_pitch, note.note_id))
        return self._sample_score_notes_for_ranking(merged)

    def _estimate_pitch_track_from_piecepacks(
        self,
        request: RankSectionsRequest,
        audio: AudioArtifact,
        merged_score_notes: list[SymbolicNote],
    ) -> tuple[list[dict[str, float]], str]:
        if not request.piecePacks:
            return self._estimate_pitch_track(
                AnalyzeRequest(
                    participantId=request.participantId,
                    groupId=request.groupId,
                    sessionStage=request.sessionStage,
                    scoreId=request.scoreId,
                    pieceId=request.pieceId,
                    preprocessMode=request.preprocessMode,
                    separationMode=request.separationMode,
                    piecePack={"notes": []},
                    audioSubmission=request.audioSubmission,
                    audioPath=request.audioPath,
                    audioDataUrl=request.audioDataUrl,
                ),
                audio,
                merged_score_notes,
            )
        analyze_request = self._build_analyze_request_for_piecepack(request, request.piecePacks[0])
        return self._estimate_pitch_track(analyze_request, audio, merged_score_notes)

    def _estimate_pitch_track_for_ranking_from_piecepacks(
        self,
        request: RankSectionsRequest,
        audio: AudioArtifact,
        merged_score_notes: list[SymbolicNote],
    ) -> tuple[list[dict[str, float]], str]:
        if not request.piecePacks:
            fallback_request = AnalyzeRequest(
                participantId=request.participantId,
                groupId=request.groupId,
                sessionStage=request.sessionStage,
                scoreId=request.scoreId,
                pieceId=request.pieceId,
                preprocessMode=request.preprocessMode,
                separationMode=request.separationMode,
                piecePack={"notes": []},
                audioSubmission=request.audioSubmission,
                audioPath=request.audioPath,
                audioDataUrl=request.audioDataUrl,
            )
            return self._estimate_pitch_track_for_ranking(fallback_request, audio, merged_score_notes)

        analyze_request = self._build_analyze_request_for_piecepack(request, request.piecePacks[0])
        return self._estimate_pitch_track_for_ranking(analyze_request, audio, merged_score_notes)

    def _ranked_candidate_score(self, result: AnalyzeResult) -> float:
        measure_penalty = len(result.measureFindings) * 0.8
        note_penalty = len(result.noteFindings) * 0.4
        sparse_section_penalty = float((result.diagnostics or {}).get("sparseSectionPenalty", 0.0) or 0.0)
        score = (
            float(result.overallPitchScore) * 0.45
            + float(result.overallRhythmScore) * 0.45
            + float(result.confidence) * 10.0
            - measure_penalty
            - note_penalty
            - sparse_section_penalty
        )
        return round(score, 2)

    def _estimate_detected_window(
        self,
        aligned_notes: list[dict[str, Any]],
        audio_duration: float | None,
        score_duration: float,
    ) -> tuple[float, float, int] | None:
        if not aligned_notes:
            return None

        matched_notes = [
            note
            for note in aligned_notes
            if int(note.get("matchedObservedIndex", -1)) >= 0
            and float(note.get("estimatedOffset", 0.0)) > float(note.get("estimatedOnset", 0.0))
        ]
        if not matched_notes:
            matched_notes = [
                note
                for note in aligned_notes
                if float(note.get("estimatedConfidence", 0.0)) >= max(0.2, float(self.settings.min_confidence) * 0.5)
                and float(note.get("estimatedOffset", 0.0)) > float(note.get("estimatedOnset", 0.0))
            ]
        if not matched_notes:
            return None

        observed_start = min(float(note.get("estimatedOnset", 0.0)) for note in matched_notes)
        observed_end = max(float(note.get("estimatedOffset", 0.0)) for note in matched_notes)
        if not math.isfinite(observed_start) or not math.isfinite(observed_end) or observed_end <= observed_start:
            return None

        observed_start = max(0.0, observed_start - float(self.settings.detection_window_start_padding_seconds))
        observed_end = observed_end + float(self.settings.detection_window_end_padding_seconds)
        window_duration = observed_end - observed_start
        min_duration = max(
            float(self.settings.detection_window_min_duration_seconds),
            max(0.0, float(score_duration)) * float(self.settings.detection_window_score_duration_ratio),
        )
        max_duration = float(self.settings.detection_window_max_duration_seconds)

        if window_duration < min_duration:
            center = (observed_start + observed_end) / 2.0
            half_span = min_duration / 2.0
            observed_start = max(0.0, center - half_span)
            observed_end = observed_start + min_duration

        if window_duration > max_duration:
            center = (observed_start + observed_end) / 2.0
            half_span = max_duration / 2.0
            observed_start = max(0.0, center - half_span)
            observed_end = observed_start + max_duration

        if audio_duration and math.isfinite(audio_duration) and audio_duration > 0:
            if observed_end > float(audio_duration):
                overflow = observed_end - float(audio_duration)
                observed_end = float(audio_duration)
                observed_start = max(0.0, observed_start - overflow)
            observed_end = min(observed_end, float(audio_duration))

        if observed_end <= observed_start:
            return None

        return round(observed_start, 3), round(observed_end, 3), len(matched_notes)

    def _build_fast_rank_result(
        self,
        aligned_notes: list[dict[str, Any]],
        pitch_source: str,
        onset_source: str,
        score_source: str,
        alignment_mode: str,
        preprocess_mode: str,
        preprocess_applied: bool,
        applied_preprocess_mode: str,
        section_calibration: dict[str, Any],
        separation_meta: dict[str, Any],
        audio: AudioArtifact,
        score_duration: float,
        score_note_count: int,
    ) -> AnalyzeResult:
        if not aligned_notes:
            return AnalyzeResult(
                overallPitchScore=0,
                overallRhythmScore=0,
                measureFindings=[],
                noteFindings=[],
                demoSegments=[],
                confidence=0.0,
                analysisMode="external",
                diagnostics={
                    "decodeMethod": audio.decode_method,
                    "ffmpegPath": audio.ffmpeg_path,
                    "scoreSource": score_source,
                    "pitchSource": pitch_source,
                    "onsetSource": onset_source,
                    "alignmentMode": alignment_mode,
                    "requestedPreprocessMode": preprocess_mode,
                    "preprocessApplied": preprocess_applied,
                    "appliedPreprocessMode": applied_preprocess_mode,
                    **separation_meta,
                },
            )

        pitch_issue_count = 0
        rhythm_issue_count = 0
        uncertain_pitch_count = 0
        measure_review_count = 0

        for note in aligned_notes:
            pitch_uncertain = bool(note.get("pitchUncertain"))
            pitch_issue = (not pitch_uncertain) and float(note.get("pitchExcessCents", 0.0)) > 0.0
            rhythm_issue = float(note.get("rhythmExcessMs", 0.0)) > 0.0
            note["pitchIssue"] = pitch_issue
            note["rhythmIssue"] = rhythm_issue
            if pitch_uncertain:
                uncertain_pitch_count += 1
            if pitch_issue:
                pitch_issue_count += 1
            if rhythm_issue:
                rhythm_issue_count += 1

        measure_groups: dict[int, list[dict[str, Any]]] = {}
        for note in aligned_notes:
            measure_groups.setdefault(int(note["measureIndex"]), []).append(note)

        for _, notes in sorted(measure_groups.items()):
            pitch_errors = [float(item.get("pitchExcessCents", 0.0)) for item in notes if not bool(item.get("pitchUncertain"))]
            onset_errors = [float(item.get("rhythmExcessMs", 0.0)) for item in notes]
            duration_errors = [self._note_scoring_duration_error_ms(item) for item in notes]
            pitch_median = median(pitch_errors or [0.0])
            onset_median = median(onset_errors or [0.0])
            duration_median = median(duration_errors or [0.0])
            trend_threshold = self._measure_trend_tolerance_ms(notes)
            if pitch_median < 4 and onset_median < 8 and abs(duration_median) < trend_threshold:
                continue
            measure_review_count += 1

        pitch_excess_values = [float(note.get("pitchExcessCents", 0.0)) for note in aligned_notes if not bool(note.get("pitchUncertain"))]
        rhythm_excess_values = [float(note.get("rhythmExcessMs", 0.0)) for note in aligned_notes]
        pitch_issue_weight = float(self.settings.pitch_penalty_issue_weight) * float(section_calibration.get("pitchIssuePenaltyScale", 1.0))
        pitch_uncertain_weight = float(self.settings.pitch_penalty_uncertain_weight) * float(section_calibration.get("uncertainPenaltyScale", 1.0))
        rhythm_issue_weight = float(self.settings.rhythm_penalty_issue_weight) * float(section_calibration.get("rhythmIssuePenaltyScale", 1.0))
        measure_penalty_weight = float(self.settings.rhythm_penalty_measure_weight) * float(section_calibration.get("measureFindingPenaltyScale", 1.0))

        pitch_penalty = min(
            50.0,
            median(pitch_excess_values or [0.0]) * float(self.settings.pitch_penalty_median_weight)
            + pitch_issue_count * pitch_issue_weight
            + uncertain_pitch_count * pitch_uncertain_weight,
        )
        rhythm_penalty = min(
            50.0,
            median(rhythm_excess_values or [0.0]) * float(self.settings.rhythm_penalty_median_weight)
            + rhythm_issue_count * rhythm_issue_weight
            + measure_review_count * measure_penalty_weight,
        )
        overall_pitch_score = max(40, min(98, round(96 - pitch_penalty)))
        overall_rhythm_score = max(40, min(98, round(94 - rhythm_penalty)))

        confidence_values = [float(note["estimatedConfidence"]) for note in aligned_notes if float(note["estimatedConfidence"]) > 0]
        confidence = median(confidence_values) if confidence_values else self.settings.min_confidence
        confidence = max(0.45, min(0.95, float(confidence)))
        student_pitch_score = self._student_display_score(overall_pitch_score, confidence)
        student_rhythm_score = self._student_display_score(overall_rhythm_score, confidence)
        student_combined_score = self._student_display_combined_score(student_pitch_score, student_rhythm_score, confidence)

        if uncertain_pitch_count >= max(4, pitch_issue_count + rhythm_issue_count):
            recommended_practice_path = "review-first"
        elif overall_rhythm_score + 2 < overall_pitch_score:
            recommended_practice_path = "rhythm-first"
        elif overall_pitch_score + 2 < overall_rhythm_score:
            recommended_practice_path = "pitch-first"
        else:
            recommended_practice_path = "review-first"

        detected_window = self._estimate_detected_window(aligned_notes, audio.duration_seconds, score_duration)
        detected_window_start = detected_window[0] if detected_window else None
        detected_window_end = detected_window[1] if detected_window else None
        detected_window_match_count = detected_window[2] if detected_window else 0
        sparse_section_penalty = 0.0
        long_audio_duration = float(audio.duration_seconds or 0.0)
        if long_audio_duration >= 90.0:
            if score_note_count <= 1:
                sparse_section_penalty += 24.0
            elif score_note_count <= 3:
                sparse_section_penalty += 14.0
            elif score_note_count <= 6:
                sparse_section_penalty += 7.0
            if score_duration <= min(12.0, long_audio_duration * 0.08):
                sparse_section_penalty += 4.0
            if detected_window_match_count <= max(1, min(2, score_note_count)) and score_note_count <= 3:
                sparse_section_penalty += 6.0

        return AnalyzeResult(
            overallPitchScore=overall_pitch_score,
            overallRhythmScore=overall_rhythm_score,
            studentPitchScore=student_pitch_score,
            studentRhythmScore=student_rhythm_score,
            studentCombinedScore=student_combined_score,
            measureFindings=[],
            noteFindings=[],
            demoSegments=[],
            confidence=confidence,
            summaryText="fast-rank",
            recommendedPracticePath=recommended_practice_path,
            analysisMode="external",
            diagnostics={
                "decodeMethod": audio.decode_method,
                "ffmpegPath": audio.ffmpeg_path,
                "scoreSource": score_source,
                "pitchSource": pitch_source,
                "onsetSource": onset_source,
                "alignmentMode": alignment_mode,
                "requestedPreprocessMode": preprocess_mode,
                "preprocessApplied": preprocess_applied,
                "appliedPreprocessMode": applied_preprocess_mode,
                "pitchIssueCount": pitch_issue_count,
                "rhythmIssueCount": rhythm_issue_count,
                "uncertainPitchCount": uncertain_pitch_count,
                "measureReviewCount": measure_review_count,
                "detectedWindowStartSeconds": detected_window_start,
                "detectedWindowEndSeconds": detected_window_end,
                "detectedWindowDurationSeconds": round(detected_window_end - detected_window_start, 3)
                if detected_window_start is not None and detected_window_end is not None
                else None,
                "detectedWindowMatchedNoteCount": detected_window_match_count,
                "scoreExpectedDurationSeconds": round(float(score_duration), 3),
                "scoreNoteCount": int(score_note_count),
                "sparseSectionPenalty": round(float(sparse_section_penalty), 2),
                **separation_meta,
            },
        )

    def _resolve_ffmpeg_path(self) -> str | None:
        if self.settings.ffmpeg_path and os.path.exists(self.settings.ffmpeg_path):
            return self.settings.ffmpeg_path

        candidates = [
            shutil.which("ffmpeg"),
            os.path.join(
                os.environ.get("LOCALAPPDATA", ""),
                "Microsoft",
                "WinGet",
                "Packages",
                "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
                "ffmpeg-8.1-full_build",
                "bin",
                "ffmpeg.exe",
            ),
        ]

        if imageio_ffmpeg is not None:
            try:
                candidates.append(imageio_ffmpeg.get_ffmpeg_exe())
            except Exception:
                pass

        for candidate in candidates:
            if candidate and os.path.exists(candidate):
                return candidate
        return None

    def _decode_audio(self, request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest) -> AudioArtifact:
        audio_path = str(getattr(request, "audioPath", None) or "").strip()
        data_url = getattr(request, "audioDataUrl", None) or ""
        requested_window = self._requested_audio_window(request)
        raw_bytes = b""
        audio_hash = ""
        if audio_path and os.path.exists(audio_path) and requested_window is None:
            try:
                raw_bytes = Path(audio_path).read_bytes()
                audio_hash = Path(audio_path).stem.strip().lower()
                if not audio_hash or len(audio_hash) != 40 or not all(character in "0123456789abcdef" for character in audio_hash):
                    audio_hash = hashlib.sha1(raw_bytes).hexdigest() if raw_bytes else ""
            except Exception:
                raw_bytes = b""
        elif "," in data_url:
            try:
                raw_bytes = base64.b64decode(data_url.split(",", 1)[1])
                audio_hash = hashlib.sha1(raw_bytes).hexdigest() if raw_bytes else ""
            except Exception:
                raw_bytes = b""

        duration = request.audioSubmission.duration if request.audioSubmission else None
        waveform = None
        sample_rate = None
        decode_method = "none"
        ffmpeg_path = self._resolve_ffmpeg_path()

        if requested_window is not None and audio_path and os.path.exists(audio_path) and librosa is not None and ffmpeg_path:
            window_start, window_end = requested_window
            suffix = Path(audio_path).suffix.strip().lower() or self._infer_suffix(request)
            clip_hash_seed = f"{Path(audio_path).stem.strip().lower()}:{window_start:.3f}:{window_end:.3f}"
            with tempfile.TemporaryDirectory(prefix="ai-erhu-audio-clip-") as temp_dir:
                output_path = os.path.join(temp_dir, f"clip{suffix if suffix == '.wav' else '.wav'}")
                subprocess.run(
                    [
                        ffmpeg_path,
                        "-y",
                        "-ss",
                        f"{window_start:.3f}",
                        "-i",
                        audio_path,
                        "-t",
                        f"{max(0.01, window_end - window_start):.3f}",
                        "-ac",
                        "1",
                        "-ar",
                        str(self.settings.target_sample_rate),
                        output_path,
                    ],
                    check=True,
                    capture_output=True,
                )
                loaded_waveform, loaded_sr = librosa.load(output_path, sr=self.settings.target_sample_rate, mono=True)
                if np is not None:
                    waveform = np.asarray(loaded_waveform, dtype=np.float32)
                else:
                    waveform = loaded_waveform
                sample_rate = int(loaded_sr)
                decode_method = "ffmpeg-librosa-file-window"
                audio_hash = hashlib.sha1(clip_hash_seed.encode("utf-8")).hexdigest()
                duration = float(len(waveform) / sample_rate) if sample_rate else duration

        if waveform is None and audio_path and os.path.exists(audio_path) and sf is not None and np is not None:
            try:
                samples, sample_rate = sf.read(audio_path, always_2d=False)
                waveform = np.asarray(samples, dtype=np.float32)
                if waveform.ndim > 1:
                    waveform = waveform.mean(axis=1)
                decode_method = "soundfile-file"
            except Exception:
                waveform = None
                sample_rate = None

        if raw_bytes and waveform is None and sf is not None and np is not None:
            try:
                samples, sample_rate = sf.read(io.BytesIO(raw_bytes), always_2d=False)
                waveform = np.asarray(samples, dtype=np.float32)
                if waveform.ndim > 1:
                    waveform = waveform.mean(axis=1)
                decode_method = "soundfile"
            except Exception:
                waveform = None
                sample_rate = None

        if (raw_bytes or (audio_path and os.path.exists(audio_path))) and waveform is None and librosa is not None and ffmpeg_path:
            suffix = self._infer_suffix(request)
            with tempfile.TemporaryDirectory(prefix="ai-erhu-audio-") as temp_dir:
                input_path = audio_path or os.path.join(temp_dir, f"input{suffix}")
                output_path = os.path.join(temp_dir, "decoded.wav")
                if not audio_path:
                    with open(input_path, "wb") as handle:
                        handle.write(raw_bytes)

                subprocess.run(
                    [
                        ffmpeg_path,
                        "-y",
                        "-i",
                        input_path,
                        "-ac",
                        "1",
                        "-ar",
                        str(self.settings.target_sample_rate),
                        output_path,
                    ],
                    check=True,
                    capture_output=True,
                )
                loaded_waveform, loaded_sr = librosa.load(output_path, sr=self.settings.target_sample_rate, mono=True)
                if np is not None:
                    waveform = np.asarray(loaded_waveform, dtype=np.float32)
                else:
                    waveform = loaded_waveform
                sample_rate = int(loaded_sr)
                decode_method = "ffmpeg-librosa-file" if audio_path else "ffmpeg-librosa"

        if waveform is not None and duration is None and sample_rate:
            duration = float(len(waveform) / sample_rate)

        return AudioArtifact(
            raw_bytes=raw_bytes,
            duration_seconds=duration,
            sample_rate=sample_rate,
            waveform=waveform,
            decode_method=decode_method,
            ffmpeg_path=ffmpeg_path,
            audio_hash=audio_hash,
            cache_key=f"raw-{self.settings.clip_feature_cache_version}-{audio_hash}" if audio_hash else None,
        )

    def _requested_audio_window(
        self,
        request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest,
    ) -> tuple[float, float] | None:
        window_start = safe_float(getattr(request, "windowStartSeconds", None), float("nan"))
        window_end = safe_float(getattr(request, "windowEndSeconds", None), float("nan"))
        if not math.isfinite(window_start) or not math.isfinite(window_end):
            return None
        if window_end <= window_start:
            return None
        return max(0.0, window_start), max(0.0, window_end)

    def _infer_suffix(self, request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest) -> str:
        audio_path = str(getattr(request, "audioPath", None) or "").strip()
        if audio_path:
            suffix = Path(audio_path).suffix.strip().lower()
            if suffix:
                return suffix
        mime_type = (request.audioSubmission.mimeType if request.audioSubmission else "") or ""
        if "mp4" in mime_type or "m4a" in mime_type:
            return ".m4a"
        if "ogg" in mime_type:
            return ".ogg"
        if "wav" in mime_type:
            return ".wav"
        if "webm" in mime_type:
            return ".webm"
        return ".bin"

    def _resolve_score_notes(self, request: AnalyzeRequest) -> tuple[list[SymbolicNote], str]:
        score_source = request.piecePack.scoreSource
        if score_source and score_source.data and score_source.format:
            fmt = str(score_source.format).strip().lower()
            if fmt in {"musicxml", "xml"}:
                score_text = self._decode_symbolic_text(score_source.data, score_source.encoding)
                parsed_notes = self._parse_musicxml_score(score_text, request)
                if parsed_notes:
                    return parsed_notes, "musicxml"
            if fmt in {"midi", "mid"}:
                score_bytes = self._decode_symbolic_bytes(score_source.data, score_source.encoding)
                parsed_notes = self._parse_midi_score(score_bytes, request)
                if parsed_notes:
                    return parsed_notes, "midi"
        return self._hydrate_piece_notes(request.piecePack.notes, request), "piecepack-notes"

    def _resolve_preprocess_mode(self, request: AnalyzeRequest) -> str:
        mode = str(getattr(request, "separationMode", None) or request.preprocessMode or "off").strip().lower()
        if mode == "melody-focus":
            return "erhu-focus"
        return mode if mode in {"off", "auto", "erhu-focus"} else "off"

    def _resolve_section_calibration(self, request: AnalyzeRequest | SeparateErhuRequest) -> dict[str, Any]:
        defaults: dict[str, Any] = {
            "scoreCoarse": False,
            "importedScoreProfile": False,
            "denseImportedScoreProfile": False,
            "preferScoreBoundaries": False,
            "extraPitchToleranceCents": 0.0,
            "extraRhythmToleranceMs": 0.0,
            "lowSeparationExtraRhythmToleranceMs": 0.0,
            "extraDurationToleranceRatio": 0.0,
            "measureTrendToleranceMs": 0.0,
            "measureInstabilityToleranceMs": 0.0,
            "rhythmMissingConfidenceThreshold": 0.0,
            "coarseRhythmReviewThresholdMs": 0.0,
            "lowConfidenceRhythmReviewThresholdMs": 0.0,
            "pitchIssuePenaltyScale": 1.0,
            "uncertainPenaltyScale": 1.0,
            "rhythmIssuePenaltyScale": 1.0,
            "measureFindingPenaltyScale": 1.0,
            "lowSeparationThreshold": 0.0,
            "lowSeparationExtraToleranceCents": 0.0,
            "octaveFlexMaxSteps": 0,
            "coarseScoreReviewThresholdCents": 0.0,
            "isolatedPitchReviewThresholdCents": 0.0,
            "scoreGuideGain": 0.0,
            "scoreGuideBandwidthCents": 38.0,
            "scoreGuideConfidenceFloor": 0.7,
        }
        piece_id = str(getattr(request, "pieceId", None) or request.piecePack.pieceId or "").strip()
        section_id = str(getattr(request, "sectionId", None) or request.piecePack.sectionId or "").strip()
        score_id = str(getattr(request, "scoreId", None) or "").strip()
        note_count = len(getattr(request.piecePack, "notes", []) or [])
        max_measure_index = max((int(note.measureIndex) for note in (getattr(request.piecePack, "notes", []) or [])), default=1)
        note_density = float(note_count) / max(1, max_measure_index)
        is_imported_piece = piece_id.startswith("scorejob-") or score_id.startswith("score-")
        generic_imported: dict[str, Any] = {}
        if is_imported_piece:
            dense_import = note_count >= 120 or note_density >= 10.0
            very_dense_import = note_count >= 220 or note_density >= 16.0
            generic_imported = {
                "scoreCoarse": True,
                "importedScoreProfile": True,
                "denseImportedScoreProfile": dense_import,
                "preferScoreBoundaries": True,
                "extraPitchToleranceCents": 8.0 if dense_import else 6.0,
                "extraRhythmToleranceMs": 14.0 if dense_import else 10.0,
                "lowSeparationThreshold": 0.78 if dense_import else 0.72,
                "lowSeparationExtraToleranceCents": 14.0 if dense_import else 10.0,
                "lowSeparationExtraRhythmToleranceMs": 18.0 if dense_import else 12.0,
                "extraDurationToleranceRatio": 0.10 if dense_import else 0.06,
                "measureTrendToleranceMs": 140.0 if dense_import else 96.0,
                "measureInstabilityToleranceMs": 48.0 if dense_import else 40.0,
                "rhythmMissingConfidenceThreshold": 0.10 if dense_import else 0.08,
                "coarseRhythmReviewThresholdMs": 1600.0 if dense_import else 900.0,
                "lowConfidenceRhythmReviewThresholdMs": 2600.0 if dense_import else 1600.0,
                "pitchIssuePenaltyScale": 0.55 if very_dense_import else (0.68 if dense_import else 0.78),
                "uncertainPenaltyScale": 0.0,
                "rhythmIssuePenaltyScale": 0.70 if dense_import else 0.82,
                "measureFindingPenaltyScale": 0.60 if dense_import else 0.75,
                "octaveFlexMaxSteps": 4 if very_dense_import else (3 if dense_import else 2),
                "coarseScoreReviewThresholdCents": 2200.0 if very_dense_import else (1600.0 if dense_import else 1100.0),
                "isolatedPitchReviewThresholdCents": 360.0 if dense_import else 260.0,
                "scoreGuideGain": 0.56 if dense_import else 0.46,
                "scoreGuideBandwidthCents": 46.0 if dense_import else 42.0,
                "scoreGuideConfidenceFloor": 0.62 if dense_import else 0.66,
            }
        built_in: dict[str, Any] = {}
        if piece_id == "taohuawu-test-fragment":
            built_in_map: dict[str, dict[str, Any]] = {
                "martial-pulse": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 6.0,
                    "extraRhythmToleranceMs": 14.0,
                    "lowSeparationThreshold": 0.58,
                    "lowSeparationExtraToleranceCents": 8.0,
                    "lowSeparationExtraRhythmToleranceMs": 16.0,
                    "extraDurationToleranceRatio": 0.08,
                    "measureTrendToleranceMs": 84.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1800.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 820.0,
                    "isolatedPitchReviewThresholdCents": 320.0,
                    "uncertainPenaltyScale": 0.0,
                    "rhythmIssuePenaltyScale": 0.55,
                    "measureFindingPenaltyScale": 0.45,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 38.0,
                    "scoreGuideConfidenceFloor": 0.7,
                },
                "lyrical-return-b": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "lowSeparationThreshold": 0.58,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 540.0,
                    "scoreGuideGain": 0.42,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "rustic-turn": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 4.0,
                    "extraRhythmToleranceMs": 24.0,
                    "lowSeparationThreshold": 0.62,
                    "lowSeparationExtraToleranceCents": 6.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.14,
                    "measureTrendToleranceMs": 1200.0,
                    "measureInstabilityToleranceMs": 64.0,
                    "coarseRhythmReviewThresholdMs": 1800.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2800.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 540.0,
                    "uncertainPenaltyScale": 0.35,
                    "rhythmIssuePenaltyScale": 0.45,
                    "measureFindingPenaltyScale": 0.4,
                    "scoreGuideGain": 0.28,
                    "scoreGuideBandwidthCents": 40.0,
                    "scoreGuideConfidenceFloor": 0.68,
                },
                "stacked-fanfare-hits": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "lowSeparationThreshold": 0.6,
                    "lowSeparationExtraToleranceCents": 12.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 700.0,
                    "scoreGuideGain": 0.52,
                    "scoreGuideBandwidthCents": 32.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "coda-release": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "lowSeparationThreshold": 0.6,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 520.0,
                    "scoreGuideGain": 0.4,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "bridge-rise": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 6.0,
                    "lowSeparationThreshold": 0.62,
                    "lowSeparationExtraToleranceCents": 8.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 500.0,
                    "scoreGuideGain": 0.24,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.7,
                },
                "entry-head": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 14.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.74,
                    "lowSeparationExtraToleranceCents": 18.0,
                    "lowSeparationExtraRhythmToleranceMs": 14.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 82.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 2800.0,
                    "isolatedPitchReviewThresholdCents": 2200.0,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "entry-phrase": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 14.0,
                    "extraRhythmToleranceMs": 22.0,
                    "lowSeparationThreshold": 0.8,
                    "lowSeparationExtraToleranceCents": 18.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.16,
                    "measureTrendToleranceMs": 88.0,
                    "measureInstabilityToleranceMs": 60.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1400.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2600.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 3400.0,
                    "isolatedPitchReviewThresholdCents": 3400.0,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "entry-tail": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 22.0,
                    "lowSeparationThreshold": 0.82,
                    "lowSeparationExtraToleranceCents": 14.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.16,
                    "measureTrendToleranceMs": 90.0,
                    "measureInstabilityToleranceMs": 60.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1500.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2600.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 1100.0,
                    "isolatedPitchReviewThresholdCents": 900.0,
                    "scoreGuideGain": 0.32,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "answer-phrase": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 12.0,
                    "extraRhythmToleranceMs": 22.0,
                    "lowSeparationThreshold": 0.8,
                    "lowSeparationExtraToleranceCents": 18.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.16,
                    "measureTrendToleranceMs": 90.0,
                    "measureInstabilityToleranceMs": 60.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1400.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2600.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 1500.0,
                    "isolatedPitchReviewThresholdCents": 1500.0,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "answer-resolution": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.8,
                    "lowSeparationExtraToleranceCents": 16.0,
                    "lowSeparationExtraRhythmToleranceMs": 14.0,
                    "extraDurationToleranceRatio": 0.14,
                    "measureTrendToleranceMs": 84.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 1200.0,
                    "isolatedPitchReviewThresholdCents": 900.0,
                    "scoreGuideGain": 0.32,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "bridge-call": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 12.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.74,
                    "lowSeparationExtraToleranceCents": 18.0,
                    "lowSeparationExtraRhythmToleranceMs": 14.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 82.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 2200.0,
                    "isolatedPitchReviewThresholdCents": 1600.0,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "sustain-trill": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 42.0,
                    "lowSeparationThreshold": 0.72,
                    "lowSeparationExtraToleranceCents": 12.0,
                    "lowSeparationExtraRhythmToleranceMs": 28.0,
                    "extraDurationToleranceRatio": 0.24,
                    "measureTrendToleranceMs": 2800.0,
                    "measureInstabilityToleranceMs": 96.0,
                    "rhythmMissingConfidenceThreshold": 0.05,
                    "coarseRhythmReviewThresholdMs": 3200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 4200.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 2600.0,
                    "isolatedPitchReviewThresholdCents": 2600.0,
                    "scoreGuideGain": 0.36,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "held-trill-return": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 16.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.8,
                    "lowSeparationExtraToleranceCents": 24.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.14,
                    "measureTrendToleranceMs": 84.0,
                    "measureInstabilityToleranceMs": 58.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 4,
                    "coarseScoreReviewThresholdCents": 3400.0,
                    "isolatedPitchReviewThresholdCents": 3400.0,
                    "scoreGuideGain": 0.4,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "lyrical-turn-a": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 14.0,
                    "extraRhythmToleranceMs": 24.0,
                    "lowSeparationThreshold": 0.78,
                    "lowSeparationExtraToleranceCents": 20.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.16,
                    "measureTrendToleranceMs": 96.0,
                    "measureInstabilityToleranceMs": 64.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1400.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2800.0,
                    "octaveFlexMaxSteps": 4,
                    "coarseScoreReviewThresholdCents": 3400.0,
                    "isolatedPitchReviewThresholdCents": 3400.0,
                    "scoreGuideGain": 0.36,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "middle-sequence": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 20.0,
                    "lowSeparationThreshold": 0.68,
                    "lowSeparationExtraToleranceCents": 14.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.14,
                    "measureTrendToleranceMs": 90.0,
                    "measureInstabilityToleranceMs": 60.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1100.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2400.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 1200.0,
                    "isolatedPitchReviewThresholdCents": 900.0,
                    "scoreGuideGain": 0.32,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "rubato-cadenza": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.7,
                    "lowSeparationExtraToleranceCents": 12.0,
                    "lowSeparationExtraRhythmToleranceMs": 14.0,
                    "extraDurationToleranceRatio": 0.14,
                    "measureTrendToleranceMs": 90.0,
                    "measureInstabilityToleranceMs": 60.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1800.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2600.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 700.0,
                    "isolatedPitchReviewThresholdCents": 260.0,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "run-up-gliss": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 16.0,
                    "extraRhythmToleranceMs": 26.0,
                    "lowSeparationThreshold": 0.7,
                    "lowSeparationExtraToleranceCents": 18.0,
                    "lowSeparationExtraRhythmToleranceMs": 20.0,
                    "extraDurationToleranceRatio": 0.18,
                    "measureTrendToleranceMs": 110.0,
                    "measureInstabilityToleranceMs": 72.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1800.0,
                    "lowConfidenceRhythmReviewThresholdMs": 3200.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 2200.0,
                    "isolatedPitchReviewThresholdCents": 2200.0,
                    "scoreGuideGain": 0.22,
                    "scoreGuideBandwidthCents": 44.0,
                    "scoreGuideConfidenceFloor": 0.7,
                },
                "modulation-call": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 16.0,
                    "extraRhythmToleranceMs": 16.0,
                    "lowSeparationThreshold": 0.8,
                    "lowSeparationExtraToleranceCents": 24.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 84.0,
                    "measureInstabilityToleranceMs": 58.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 4,
                    "coarseScoreReviewThresholdCents": 3400.0,
                    "isolatedPitchReviewThresholdCents": 3400.0,
                    "uncertainPenaltyScale": 0.0,
                    "scoreGuideGain": 0.4,
                    "scoreGuideBandwidthCents": 32.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "recap-call": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 6.0,
                    "lowSeparationThreshold": 0.6,
                    "lowSeparationExtraToleranceCents": 8.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 500.0,
                    "scoreGuideGain": 0.22,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.7,
                },
                "triplet-dialogue": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.64,
                    "lowSeparationExtraToleranceCents": 8.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 100.0,
                    "measureInstabilityToleranceMs": 64.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1400.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2600.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 520.0,
                    "isolatedPitchReviewThresholdCents": 280.0,
                    "uncertainPenaltyScale": 0.0,
                    "rhythmIssuePenaltyScale": 0.5,
                    "measureFindingPenaltyScale": 0.4,
                    "scoreGuideGain": 0.28,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "accented-unison": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 16.0,
                    "extraRhythmToleranceMs": 12.0,
                    "lowSeparationThreshold": 0.8,
                    "lowSeparationExtraToleranceCents": 24.0,
                    "lowSeparationExtraRhythmToleranceMs": 16.0,
                    "extraDurationToleranceRatio": 0.1,
                    "measureTrendToleranceMs": 76.0,
                    "measureInstabilityToleranceMs": 52.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1800.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 2600.0,
                    "isolatedPitchReviewThresholdCents": 2600.0,
                    "uncertainPenaltyScale": 0.0,
                    "scoreGuideGain": 0.38,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "pedal-leap-sequence": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "extraRhythmToleranceMs": 20.0,
                    "lowSeparationThreshold": 0.72,
                    "lowSeparationExtraToleranceCents": 8.0,
                    "lowSeparationExtraRhythmToleranceMs": 12.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 78.0,
                    "measureInstabilityToleranceMs": 54.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1800.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 560.0,
                    "isolatedPitchReviewThresholdCents": 220.0,
                    "scoreGuideGain": 0.3,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "tremolo-surge": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 12.0,
                    "extraRhythmToleranceMs": 24.0,
                    "lowSeparationThreshold": 0.72,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "lowSeparationExtraRhythmToleranceMs": 10.0,
                    "extraDurationToleranceRatio": 0.1,
                    "measureTrendToleranceMs": 1200.0,
                    "measureInstabilityToleranceMs": 52.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 2000.0,
                    "lowConfidenceRhythmReviewThresholdMs": 3200.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 760.0,
                    "isolatedPitchReviewThresholdCents": 260.0,
                    "uncertainPenaltyScale": 0.35,
                    "rhythmIssuePenaltyScale": 0.4,
                    "measureFindingPenaltyScale": 0.35,
                    "scoreGuideGain": 0.4,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "answer-loop": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 22.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.14,
                    "measureTrendToleranceMs": 82.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 3400.0,
                    "lowSeparationThreshold": 0.78,
                    "lowSeparationExtraToleranceCents": 12.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 620.0,
                    "isolatedPitchReviewThresholdCents": 220.0,
                    "scoreGuideGain": 0.36,
                    "scoreGuideBandwidthCents": 32.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "bright-recap-fanfare": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.68,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "lowSeparationExtraRhythmToleranceMs": 12.0,
                    "extraDurationToleranceRatio": 0.1,
                    "measureTrendToleranceMs": 72.0,
                    "measureInstabilityToleranceMs": 52.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1600.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 600.0,
                    "isolatedPitchReviewThresholdCents": 220.0,
                    "scoreGuideGain": 0.32,
                    "scoreGuideBandwidthCents": 32.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "con-brio-entry": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 16.0,
                    "lowSeparationExtraRhythmToleranceMs": 12.0,
                    "extraDurationToleranceRatio": 0.1,
                    "measureTrendToleranceMs": 72.0,
                    "measureInstabilityToleranceMs": 50.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 850.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1600.0,
                    "lowSeparationThreshold": 0.62,
                    "lowSeparationExtraToleranceCents": 12.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 620.0,
                    "isolatedPitchReviewThresholdCents": 240.0,
                    "scoreGuideGain": 0.38,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "ostinato-dialogue": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 12.0,
                    "extraRhythmToleranceMs": 12.0,
                    "lowSeparationThreshold": 0.74,
                    "lowSeparationExtraToleranceCents": 16.0,
                    "lowSeparationExtraRhythmToleranceMs": 16.0,
                    "extraDurationToleranceRatio": 0.08,
                    "measureTrendToleranceMs": 70.0,
                    "measureInstabilityToleranceMs": 52.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1800.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 680.0,
                    "isolatedPitchReviewThresholdCents": 260.0,
                    "uncertainPenaltyScale": 0.0,
                    "rhythmIssuePenaltyScale": 0.5,
                    "measureFindingPenaltyScale": 0.4,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.7,
                },
                "folk-dance-answer": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "lowSeparationThreshold": 0.78,
                    "lowSeparationExtraToleranceCents": 8.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 600.0,
                    "isolatedPitchReviewThresholdCents": 220.0,
                    "scoreGuideGain": 0.30,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "descending-beacon": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 16.0,
                    "lowSeparationExtraRhythmToleranceMs": 10.0,
                    "extraDurationToleranceRatio": 0.1,
                    "measureTrendToleranceMs": 70.0,
                    "measureInstabilityToleranceMs": 48.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 800.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1600.0,
                    "lowSeparationThreshold": 0.72,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 620.0,
                    "isolatedPitchReviewThresholdCents": 220.0,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "sharp-mode-climax": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 14.0,
                    "extraRhythmToleranceMs": 14.0,
                    "lowSeparationThreshold": 0.78,
                    "lowSeparationExtraToleranceCents": 20.0,
                    "lowSeparationExtraRhythmToleranceMs": 16.0,
                    "extraDurationToleranceRatio": 0.1,
                    "measureTrendToleranceMs": 80.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1800.0,
                    "octaveFlexMaxSteps": 4,
                    "coarseScoreReviewThresholdCents": 3400.0,
                    "isolatedPitchReviewThresholdCents": 3400.0,
                    "uncertainPenaltyScale": 0.0,
                    "scoreGuideGain": 0.36,
                    "scoreGuideBandwidthCents": 28.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "pedal-tension-loop": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 22.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 80.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 900.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2400.0,
                    "lowSeparationThreshold": 0.64,
                    "lowSeparationExtraToleranceCents": 12.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 640.0,
                    "isolatedPitchReviewThresholdCents": 240.0,
                    "scoreGuideGain": 0.38,
                    "scoreGuideBandwidthCents": 32.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "accelerando-banner": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 12.0,
                    "extraRhythmToleranceMs": 20.0,
                    "lowSeparationThreshold": 0.74,
                    "lowSeparationExtraToleranceCents": 16.0,
                    "lowSeparationExtraRhythmToleranceMs": 16.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 90.0,
                    "measureInstabilityToleranceMs": 60.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2000.0,
                    "octaveFlexMaxSteps": 3,
                    "coarseScoreReviewThresholdCents": 2000.0,
                    "isolatedPitchReviewThresholdCents": 1800.0,
                    "scoreGuideGain": 0.36,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "drone-climb-finale": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "extraRhythmToleranceMs": 24.0,
                    "lowSeparationThreshold": 0.72,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "lowSeparationExtraRhythmToleranceMs": 16.0,
                    "extraDurationToleranceRatio": 0.16,
                    "measureTrendToleranceMs": 84.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1400.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 520.0,
                    "isolatedPitchReviewThresholdCents": 340.0,
                    "scoreGuideGain": 0.3,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "closing-climb": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "extraRhythmToleranceMs": 30.0,
                    "lowSeparationThreshold": 0.72,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.22,
                    "measureTrendToleranceMs": 120.0,
                    "measureInstabilityToleranceMs": 80.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 2200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 3600.0,
                    "octaveFlexMaxSteps": 1,
                    "coarseScoreReviewThresholdCents": 520.0,
                    "isolatedPitchReviewThresholdCents": 320.0,
                    "scoreGuideGain": 0.28,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "vivace-accent-grid": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 12.0,
                    "lowSeparationThreshold": 0.82,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "lowSeparationExtraRhythmToleranceMs": 10.0,
                    "extraDurationToleranceRatio": 0.08,
                    "measureTrendToleranceMs": 72.0,
                    "measureInstabilityToleranceMs": 48.0,
                    "rhythmMissingConfidenceThreshold": 0.08,
                    "coarseRhythmReviewThresholdMs": 850.0,
                    "lowConfidenceRhythmReviewThresholdMs": 1400.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 1400.0,
                    "isolatedPitchReviewThresholdCents": 260.0,
                    "scoreGuideGain": 0.42,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.76,
                },
                "development-launch": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 22.0,
                    "lowSeparationThreshold": 0.72,
                    "lowSeparationExtraToleranceCents": 14.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.14,
                    "measureTrendToleranceMs": 90.0,
                    "measureInstabilityToleranceMs": 60.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2600.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 1800.0,
                    "isolatedPitchReviewThresholdCents": 1600.0,
                    "scoreGuideGain": 0.34,
                    "scoreGuideBandwidthCents": 34.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
                "crest-ostinato-rise": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 16.0,
                    "lowSeparationThreshold": 0.66,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.1,
                    "measureTrendToleranceMs": 86.0,
                    "measureInstabilityToleranceMs": 58.0,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 560.0,
                    "isolatedPitchReviewThresholdCents": 320.0,
                    "uncertainPenaltyScale": 0.0,
                    "rhythmIssuePenaltyScale": 0.55,
                    "measureFindingPenaltyScale": 0.45,
                    "scoreGuideGain": 0.36,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "final-ostinato-rally": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 16.0,
                    "extraRhythmToleranceMs": 14.0,
                    "lowSeparationThreshold": 0.9,
                    "lowSeparationExtraToleranceCents": 28.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.12,
                    "measureTrendToleranceMs": 82.0,
                    "measureInstabilityToleranceMs": 56.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1000.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2200.0,
                    "octaveFlexMaxSteps": 4,
                    "coarseScoreReviewThresholdCents": 3600.0,
                    "isolatedPitchReviewThresholdCents": 3600.0,
                    "uncertainPenaltyScale": 0.0,
                    "rhythmIssuePenaltyScale": 0.55,
                    "measureFindingPenaltyScale": 0.45,
                    "scoreGuideGain": 0.44,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.78,
                },
                "open-string-sprint": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 8.0,
                    "lowSeparationThreshold": 0.68,
                    "lowSeparationExtraToleranceCents": 10.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 520.0,
                    "isolatedPitchReviewThresholdCents": 220.0,
                    "scoreGuideGain": 0.3,
                    "scoreGuideBandwidthCents": 30.0,
                    "scoreGuideConfidenceFloor": 0.74,
                },
                "rubato-breakturn": {
                    "scoreCoarse": True,
                    "preferScoreBoundaries": True,
                    "extraPitchToleranceCents": 10.0,
                    "extraRhythmToleranceMs": 18.0,
                    "lowSeparationThreshold": 0.65,
                    "lowSeparationExtraToleranceCents": 14.0,
                    "lowSeparationExtraRhythmToleranceMs": 18.0,
                    "extraDurationToleranceRatio": 0.16,
                    "measureTrendToleranceMs": 96.0,
                    "measureInstabilityToleranceMs": 64.0,
                    "rhythmMissingConfidenceThreshold": 0.06,
                    "coarseRhythmReviewThresholdMs": 1200.0,
                    "lowConfidenceRhythmReviewThresholdMs": 2400.0,
                    "octaveFlexMaxSteps": 2,
                    "coarseScoreReviewThresholdCents": 760.0,
                    "isolatedPitchReviewThresholdCents": 280.0,
                    "uncertainPenaltyScale": 0.0,
                    "scoreGuideGain": 0.28,
                    "scoreGuideBandwidthCents": 36.0,
                    "scoreGuideConfidenceFloor": 0.72,
                },
            }
            built_in = built_in_map.get(section_id, {})
        profile = request.piecePack.calibrationProfile if isinstance(request.piecePack.calibrationProfile, dict) else {}
        merged = {**defaults, **generic_imported, **built_in, **profile}
        if built_in:
            for key in (
                "extraPitchToleranceCents",
                "extraRhythmToleranceMs",
                "lowSeparationExtraRhythmToleranceMs",
                "extraDurationToleranceRatio",
                "measureTrendToleranceMs",
                "measureInstabilityToleranceMs",
                "coarseRhythmReviewThresholdMs",
                "lowConfidenceRhythmReviewThresholdMs",
                "lowSeparationThreshold",
                "lowSeparationExtraToleranceCents",
                "octaveFlexMaxSteps",
                "coarseScoreReviewThresholdCents",
                "isolatedPitchReviewThresholdCents",
                "scoreGuideGain",
                "scoreGuideBandwidthCents",
                "scoreGuideConfidenceFloor",
            ):
                if key in built_in:
                    profile_value = profile.get(key)
                    built_in_value = built_in.get(key)
                    if isinstance(built_in_value, (int, float)):
                        merged[key] = max(float(built_in_value), float(profile_value if isinstance(profile_value, (int, float)) else built_in_value))
                    elif built_in_value:
                        merged[key] = built_in_value
            if "rhythmMissingConfidenceThreshold" in built_in:
                profile_value = profile.get("rhythmMissingConfidenceThreshold")
                built_in_value = built_in.get("rhythmMissingConfidenceThreshold")
                if isinstance(profile_value, (int, float)) and float(profile_value) > 0.0:
                    merged["rhythmMissingConfidenceThreshold"] = min(float(built_in_value or 0.0), float(profile_value))
                elif isinstance(built_in_value, (int, float)) and float(built_in_value) > 0.0:
                    merged["rhythmMissingConfidenceThreshold"] = float(built_in_value)
        if generic_imported:
            for key in (
                "extraPitchToleranceCents",
                "extraRhythmToleranceMs",
                "lowSeparationExtraRhythmToleranceMs",
                "extraDurationToleranceRatio",
                "measureTrendToleranceMs",
                "measureInstabilityToleranceMs",
                "coarseRhythmReviewThresholdMs",
                "lowConfidenceRhythmReviewThresholdMs",
                "lowSeparationThreshold",
                "lowSeparationExtraToleranceCents",
                "octaveFlexMaxSteps",
                "coarseScoreReviewThresholdCents",
                "isolatedPitchReviewThresholdCents",
                "scoreGuideGain",
                "scoreGuideBandwidthCents",
                "scoreGuideConfidenceFloor",
            ):
                if key in built_in:
                    continue
                imported_value = generic_imported.get(key)
                profile_value = profile.get(key)
                if isinstance(imported_value, (int, float)):
                    merged[key] = max(float(imported_value), float(profile_value if isinstance(profile_value, (int, float)) else imported_value))
                elif imported_value:
                    merged[key] = imported_value
            if "rhythmMissingConfidenceThreshold" in generic_imported and "rhythmMissingConfidenceThreshold" not in built_in:
                profile_value = profile.get("rhythmMissingConfidenceThreshold")
                imported_value = generic_imported.get("rhythmMissingConfidenceThreshold")
                if isinstance(profile_value, (int, float)) and float(profile_value) > 0.0:
                    merged["rhythmMissingConfidenceThreshold"] = min(float(imported_value or 0.0), float(profile_value))
                elif isinstance(imported_value, (int, float)) and float(imported_value) > 0.0:
                    merged["rhythmMissingConfidenceThreshold"] = float(imported_value)
        return merged

    def _score_frequency_at_time(
        self,
        time_value: float,
        score_notes: list[SymbolicNote],
        performance_duration: float,
    ) -> float:
        if not score_notes:
            return 0.0
        score_duration = max((note.expected_offset for note in score_notes), default=0.0)
        if score_duration <= 0:
            return 0.0
        tempo_ratio = performance_duration / score_duration if performance_duration > 0 else 1.0
        for note in score_notes:
            note_start = note.expected_onset * tempo_ratio
            note_end = note.expected_offset * tempo_ratio
            if note_start <= time_value <= note_end:
                return float(midi_to_frequency(note.midi_pitch))
        return 0.0

    def _preprocess_audio(
        self,
        request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest,
        audio: AudioArtifact,
        score_notes: list[SymbolicNote],
        pitch_track: list[dict[str, float]],
        preprocess_mode: str,
        section_calibration: dict[str, Any] | None = None,
        persist_outputs: bool = True,
    ) -> tuple[AudioArtifact, bool, str, dict[str, Any]]:
        separation_meta = {
            "separationApplied": False,
            "separationMode": "off",
            "separationConfidence": 0.0,
            "rawAudioPath": None,
            "erhuEnhancedAudioPath": None,
            "accompanimentResidualPath": None,
            "warnings": [],
        }
        if preprocess_mode == "off":
            return audio, False, "off", separation_meta
        if audio.waveform is None or audio.sample_rate is None or np is None or librosa is None:
            separation_meta["warnings"].append("音频尚未解码为可处理波形，已回退原音分析。")
            return audio, False, "off", separation_meta

        section_calibration = section_calibration or {}
        base_waveform = np.asarray(audio.waveform, dtype=np.float32)
        cached_preprocessed_audio, processed_cache_key = self._read_cached_preprocessed_audio(
            request,
            audio,
            preprocess_mode,
            score_notes,
            section_calibration,
        )

        if cached_preprocessed_audio:
            enhanced_waveform = np.asarray(cached_preprocessed_audio["enhancedWaveform"], dtype=np.float32)
            residual_waveform = np.asarray(cached_preprocessed_audio["residualWaveform"], dtype=np.float32)
            separation_confidence = float(cached_preprocessed_audio.get("separationConfidence", 0.0))
            separation_meta["warnings"].append(
                f"preprocessed-audio-cache:{cached_preprocessed_audio.get('scope', 'unknown')}"
            )
        else:
            enhanced_waveform = self._apply_melody_focus_mask(audio, score_notes, pitch_track, section_calibration)
            if enhanced_waveform is None:
                separation_meta["warnings"].append("二胡增强分离未生成有效波形，已回退原音分析。")
                return audio, False, "off", separation_meta
            residual_waveform = np.asarray(base_waveform - enhanced_waveform, dtype=np.float32)
            separation_confidence = self._estimate_separation_confidence(
                score_notes,
                pitch_track,
                base_waveform,
                enhanced_waveform,
            )
            self._write_cached_preprocessed_audio(
                request,
                audio,
                preprocess_mode,
                score_notes,
                section_calibration,
                enhanced_waveform,
                residual_waveform,
                separation_confidence,
            )

        media_paths = (
            self._persist_audio_variants(base_waveform, enhanced_waveform, residual_waveform, audio.sample_rate)
            if persist_outputs
            else {
                "rawAudioPath": None,
                "erhuEnhancedAudioPath": None,
                "accompanimentResidualPath": None,
            }
        )
        separation_meta.update(
            {
                "separationMode": "erhu-focus",
                "separationConfidence": round(float(separation_confidence), 3),
                "rawAudioPath": media_paths.get("rawAudioPath"),
                "erhuEnhancedAudioPath": media_paths.get("erhuEnhancedAudioPath"),
                "accompanimentResidualPath": media_paths.get("accompanimentResidualPath"),
            }
        )
        if preprocess_mode == "auto" and separation_confidence < float(self.settings.separation_auto_confidence_threshold):
            separation_meta["warnings"].append("自动判断分离置信度偏低，已回退到原音频分析。")
            return audio, False, "off", separation_meta

        processed_audio = AudioArtifact(
            raw_bytes=audio.raw_bytes,
            duration_seconds=audio.duration_seconds,
            sample_rate=audio.sample_rate,
            waveform=np.asarray(enhanced_waveform, dtype=np.float32),
            decode_method=f"{audio.decode_method}+erhu-focus" if audio.decode_method else "erhu-focus",
            ffmpeg_path=audio.ffmpeg_path,
            audio_hash=audio.audio_hash,
            cache_key=processed_cache_key or self._build_processed_audio_cache_key(
                audio,
                "erhu-focus",
                score_notes,
                section_calibration,
            ),
        )
        separation_meta["separationApplied"] = True
        return processed_audio, True, "erhu-focus", separation_meta

    def _apply_melody_focus_mask(
        self,
        audio: AudioArtifact,
        score_notes: list[SymbolicNote],
        pitch_track: list[dict[str, float]],
        section_calibration: dict[str, Any] | None = None,
    ) -> Any | None:
        if audio.waveform is None or audio.sample_rate is None or np is None or librosa is None:
            return None

        waveform = np.asarray(audio.waveform, dtype=np.float32)
        if waveform.size == 0:
            return None

        ranking_preprocess = bool((section_calibration or {}).get("rankingPreprocess"))
        n_fft = int(self.settings.ranking_preprocess_n_fft) if ranking_preprocess else 2048
        hop_length = max(128, self.settings.onset_hop_length * (1 if ranking_preprocess else 2))
        try:
            stft = librosa.stft(waveform, n_fft=n_fft, hop_length=hop_length)
            harmonic, _ = librosa.decompose.hpss(stft)
        except Exception:
            return None

        freqs = librosa.fft_frequencies(sr=audio.sample_rate, n_fft=n_fft)
        frame_times = librosa.frames_to_time(np.arange(harmonic.shape[1]), sr=audio.sample_rate, hop_length=hop_length)
        performance_duration = audio.duration_seconds or (len(waveform) / max(audio.sample_rate, 1))

        score_min_frequency = min((midi_to_frequency(note.midi_pitch) for note in score_notes), default=160.0)
        score_max_frequency = max((midi_to_frequency(note.midi_pitch) for note in score_notes), default=900.0)
        low_cut = max(80.0, score_min_frequency * 0.75)
        high_cut = min(freqs[-1], score_max_frequency * 6.0)
        band_mask = ((freqs >= low_cut) & (freqs <= high_cut)).astype(np.float32)

        pitch_times = np.asarray([float(item.get("time", 0.0)) for item in pitch_track], dtype=np.float32)
        pitch_freqs = np.asarray([float(item.get("frequency", 0.0)) for item in pitch_track], dtype=np.float32)
        pitch_confidences = np.asarray([float(item.get("confidence", 0.0)) for item in pitch_track], dtype=np.float32)

        section_calibration = section_calibration or {}
        residual_mix = float(self.settings.separation_residual_mix)
        bandwidth_ratio = (2.0 ** (float(self.settings.separation_bandwidth_cents) / 1200.0)) - 1.0
        guide_bandwidth_ratio = (
            2.0 ** (float(section_calibration.get("scoreGuideBandwidthCents", 38.0)) / 1200.0)
        ) - 1.0
        harmonic_count = (
            max(1, min(int(self.settings.separation_harmonics), int(self.settings.ranking_preprocess_harmonics)))
            if ranking_preprocess
            else max(1, int(self.settings.separation_harmonics))
        )
        confidence_threshold = float(self.settings.separation_pitch_confidence)
        guide_gain = max(0.0, min(0.95, float(section_calibration.get("scoreGuideGain", 0.0))))
        guide_confidence_floor = float(section_calibration.get("scoreGuideConfidenceFloor", confidence_threshold))
        octave_flex_steps = max(0, int(section_calibration.get("octaveFlexMaxSteps", 0)))
        mask = np.full(np.abs(harmonic).shape, residual_mix, dtype=np.float32)

        # Vectorized harmonic masking — replaces per-frame Python loop with bulk NumPy ops.
        n_frames = harmonic.shape[1]

        # Nearest detected pitch for every frame at once (searchsorted vs argmin per frame).
        if pitch_times.size > 0:
            ins = np.searchsorted(pitch_times, frame_times, side="left")
            ins_hi = np.clip(ins, 0, len(pitch_times) - 1)
            ins_lo = np.clip(ins - 1, 0, len(pitch_times) - 1)
            d_hi = np.abs(pitch_times[ins_hi] - frame_times)
            d_lo = np.abs(pitch_times[ins_lo] - frame_times)
            best = np.where(d_hi <= d_lo, ins_hi, ins_lo)
            within = np.minimum(d_hi, d_lo) <= 0.12
            det_freqs = np.where(within, pitch_freqs[best], 0.0).astype(np.float32)
            det_confs = np.where(within, pitch_confidences[best], 0.0).astype(np.float32)
        else:
            det_freqs = np.zeros(n_frames, dtype=np.float32)
            det_confs = np.zeros(n_frames, dtype=np.float32)

        # Score guide frequency for every frame (vectorized interval lookup).
        if score_notes:
            _sdur = max((n.expected_offset for n in score_notes), default=0.0)
            _tr = performance_duration / _sdur if performance_duration > 0 and _sdur > 0 else 1.0
            _srt = sorted(score_notes, key=lambda n: n.expected_onset)
            _ns = np.array([n.expected_onset * _tr for n in _srt], dtype=np.float32)
            _ne = np.array([n.expected_offset * _tr for n in _srt], dtype=np.float32)
            _nf = np.array([float(midi_to_frequency(n.midi_pitch)) for n in _srt], dtype=np.float32)
            _si = np.clip(np.searchsorted(_ns, frame_times, side="right") - 1, 0, len(_srt) - 1)
            _in_note = (frame_times >= _ns[_si]) & (frame_times <= _ne[_si])
            scr_freqs = np.where(_in_note, _nf[_si], 0.0).astype(np.float32)
        else:
            scr_freqs = np.zeros(n_frames, dtype=np.float32)

        # Effective frequency: fall back to score guide when detection is uncertain.
        low_conf = (det_freqs <= 0) | (det_confs < confidence_threshold)
        eff_freqs = np.where(low_conf, scr_freqs, det_freqs)

        def _add_bands(base_f: "np.ndarray", weights: "np.ndarray", bw_ratio: float) -> None:
            """Apply Gaussian harmonic bands for all frames in a single bulk pass."""
            for h in range(1, harmonic_count + 1):
                centers = base_f * h
                active = (base_f > 0) & (centers <= freqs[-1])
                if not np.any(active):
                    break
                iv = np.where(active)[0]
                c = centers[iv]
                w = weights[iv]
                bw = np.maximum(20.0, c * bw_ratio)
                diff = freqs[:, None] - c[None, :]
                gauss = np.exp(-0.5 * (diff / bw[None, :]) ** 2).astype(np.float32)
                mask[:, iv] = np.maximum(mask[:, iv], gauss * band_mask[:, None] * w[None, :])

        _add_bands(eff_freqs, np.where(eff_freqs > 0, 1.0, 0.0).astype(np.float32), bandwidth_ratio)

        if guide_gain > 0.0 and np.any(scr_freqs > 0):
            score_coarse = bool(section_calibration.get("scoreCoarse"))
            coarse_w = 0.34 if score_coarse else 0.2
            low_guide = (det_freqs <= 0) | (det_confs < guide_confidence_floor)
            guide_w = np.where(
                scr_freqs > 0,
                np.where(low_guide, np.maximum(guide_gain, coarse_w), guide_gain),
                0.0,
            ).astype(np.float32)
            _add_bands(scr_freqs, guide_w, guide_bandwidth_ratio)
            for octave_step in range(1, octave_flex_steps + 1):
                lo_f = np.where(scr_freqs > 0, scr_freqs / (2.0 ** octave_step), 0.0)
                hi_f = np.where(scr_freqs > 0, scr_freqs * (2.0 ** octave_step), 0.0)
                lo_mult = 0.72 if octave_step == 1 else 0.45
                hi_mult = 0.28 if octave_step == 1 else 0.18
                if np.any(lo_f >= low_cut * 0.8):
                    _add_bands(np.where(lo_f >= low_cut * 0.8, lo_f, 0.0), guide_w * lo_mult, guide_bandwidth_ratio)
                if np.any(hi_f <= high_cut * 1.05):
                    _add_bands(np.where(hi_f <= high_cut * 1.05, hi_f, 0.0), guide_w * hi_mult, guide_bandwidth_ratio)

        # Piano co-frequency suppression: piano attacks decay naturally while erhu sustains;
        # briefly attenuating the mask at onset frames removes most co-frequency bleed.
        suppression_strength = float(self.settings.piano_onset_suppression_strength)
        if suppression_strength > 0.0:
            try:
                onset_env = librosa.onset.onset_strength(
                    y=waveform, sr=audio.sample_rate, hop_length=hop_length
                )
                onset_peak = float(np.percentile(onset_env, 97)) + 1e-6
                onset_norm = np.clip(onset_env / onset_peak, 0.0, 1.0).astype(np.float32)
                decay_frames = max(1, int(float(self.settings.piano_onset_decay_ms) / 1000.0 * audio.sample_rate / hop_length))
                temporal_suppression = np.zeros(n_frames, dtype=np.float32)
                for pi in np.where(onset_norm[:n_frames] > 0.5)[0]:
                    end = min(int(pi) + decay_frames, n_frames)
                    j_arr = np.arange(end - int(pi), dtype=np.float32)
                    fade = float(onset_norm[pi]) * (1.0 - j_arr / decay_frames) * suppression_strength
                    temporal_suppression[pi:end] = np.maximum(temporal_suppression[pi:end], fade)
                mask *= (1.0 - temporal_suppression)[np.newaxis, :]
            except Exception:
                pass

        try:
            enhanced_stft = harmonic * mask
            enhanced_waveform = librosa.istft(enhanced_stft, hop_length=hop_length, length=len(waveform))
        except Exception:
            return None

        enhanced_waveform = np.asarray(enhanced_waveform, dtype=np.float32)
        blend = min(1.0, max(0.0, float(self.settings.separation_output_blend)))
        enhanced_waveform = (enhanced_waveform * blend) + (waveform * (1.0 - blend))
        peak = float(np.max(np.abs(enhanced_waveform))) if enhanced_waveform.size else 0.0
        if peak > 1.0:
            enhanced_waveform = enhanced_waveform / peak
        return enhanced_waveform.astype(np.float32)

    def _estimate_separation_confidence(
        self,
        score_notes: list[SymbolicNote],
        pitch_track: list[dict[str, float]],
        base_waveform: Any,
        enhanced_waveform: Any,
    ) -> float:
        if np is None:
            return 0.0
        base_energy = float(np.mean(np.abs(base_waveform))) if len(base_waveform) else 0.0
        enhanced_energy = float(np.mean(np.abs(enhanced_waveform))) if len(enhanced_waveform) else 0.0
        energy_ratio = min(1.0, enhanced_energy / max(base_energy, 1e-6))

        score_min = min((note.midi_pitch for note in score_notes), default=55)
        score_max = max((note.midi_pitch for note in score_notes), default=88)
        score_band_hits = 0
        confident_points = 0
        for item in pitch_track:
            confidence = float(item.get("confidence", 0.0))
            if confidence < self.settings.separation_pitch_confidence:
                continue
            confident_points += 1
            midi_value = frequency_to_midi(float(item.get("frequency", 0.0)))
            if score_min - 4 <= midi_value <= score_max + 4:
                score_band_hits += 1
        band_ratio = (score_band_hits / confident_points) if confident_points else 0.0
        confidence = (energy_ratio * 0.52) + (band_ratio * 0.36) + float(self.settings.separation_auto_score_band_bonus)
        return max(0.0, min(0.98, confidence))

    def _persist_audio_variants(
        self,
        raw_waveform: Any,
        enhanced_waveform: Any,
        residual_waveform: Any,
        sample_rate: int,
    ) -> dict[str, str | None]:
        output_root = Path(self.settings.data_root) / "generated-audio" / f"sep-{uuid.uuid4().hex[:10]}"
        output_root.mkdir(parents=True, exist_ok=True)
        raw_path = output_root / "raw.wav"
        enhanced_path = output_root / "erhu-enhanced.wav"
        residual_path = output_root / "accompaniment-residual.wav"
        self._write_wave_file(raw_path, raw_waveform, sample_rate)
        self._write_wave_file(enhanced_path, enhanced_waveform, sample_rate)
        self._write_wave_file(residual_path, residual_waveform, sample_rate)
        relative_root = output_root.relative_to(Path(self.settings.data_root))
        web_root = f"/data/{str(relative_root).replace(os.sep, '/')}"
        return {
            "rawAudioPath": f"{web_root}/raw.wav",
            "erhuEnhancedAudioPath": f"{web_root}/erhu-enhanced.wav",
            "accompanimentResidualPath": f"{web_root}/accompaniment-residual.wav",
        }

    def _write_wave_file(self, path: Path, waveform: Any, sample_rate: int) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if sf is not None and np is not None:
            sf.write(str(path), np.asarray(waveform, dtype=np.float32), sample_rate)
            return

        if np is not None:
            pcm = np.asarray(waveform, dtype=np.float32)
            pcm = np.clip(pcm, -1.0, 1.0)
            pcm = (pcm * 32767).astype(np.int16)
            pcm_bytes = pcm.tobytes()
        else:
            pcm_bytes = b""
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(pcm_bytes)

    def _create_madmom_temp_wav(self, audio: AudioArtifact, prefix: str) -> Path:
        if audio.waveform is None or audio.sample_rate is None:
            raise RuntimeError("decoded waveform is required for madmom processing")
        descriptor, wav_path = tempfile.mkstemp(prefix=prefix, suffix=".wav")
        os.close(descriptor)
        path = Path(wav_path)
        self._write_wave_file(path, audio.waveform, audio.sample_rate)
        return path

    def _cleanup_temp_path(self, path: Path | None) -> None:
        if path is None:
            return
        for _ in range(5):
            try:
                if path.exists():
                    path.unlink()
                return
            except PermissionError:
                gc.collect()
                time.sleep(0.15)
            except Exception:
                return

    def _run_audiveris(self, pdf_path: Path, output_dir: Path) -> str | None:
        audiveris_cli = self.settings.audiveris_cli.strip()
        if not audiveris_cli or not os.path.exists(audiveris_cli):
            return None
        page_count = 1
        if PdfReader is not None:
            try:
                page_count = max(1, len(PdfReader(str(pdf_path)).pages))
            except Exception:
                page_count = 1
        try:
            subprocess.run(
                [audiveris_cli, "-batch", "-transcribe", "-export", "-output", str(output_dir), str(pdf_path)],
                check=False,
                capture_output=True,
                timeout=self.settings.audiveris_timeout_seconds,
            )
        except Exception:
            return None

        candidates = self._collect_musicxml_candidates(output_dir)
        if not candidates:
            return None
        for candidate in candidates:
            xml_text = self._read_musicxml_source(candidate)
            if not xml_text.strip():
                continue
            if self._extract_musicxml_parts(xml_text):
                return None if page_count > 1 else str(candidate)
            if "<score-partwise" in xml_text or "<score-timewise" in xml_text:
                return None if page_count > 1 else str(candidate)
        return None

    def _collect_musicxml_candidates(self, root_dir: Path) -> list[Path]:
        if not root_dir.exists():
            return []

        def priority(path: Path) -> tuple[int, str]:
            suffix = path.suffix.lower()
            if suffix == ".mxl":
                rank = 0
            elif suffix == ".musicxml":
                rank = 1
            else:
                rank = 2
            return (rank, str(path))

        candidates = [
            path
            for path in root_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in {".mxl", ".musicxml", ".xml"}
        ]
        return sorted(candidates, key=priority)

    def _read_musicxml_source(self, source_path: Path) -> str:
        if not source_path.exists():
            return ""
        if source_path.suffix.lower() == ".mxl":
            try:
                with zipfile.ZipFile(source_path) as archive:
                    root_name = ""
                    if "META-INF/container.xml" in archive.namelist():
                        container = ET.fromstring(archive.read("META-INF/container.xml"))
                        rootfile = next((element for element in container.iter() if element.tag.rsplit("}", 1)[-1] == "rootfile"), None)
                        root_name = rootfile.attrib.get("full-path", "") if rootfile is not None else ""
                    if not root_name:
                        root_name = next(
                            (name for name in archive.namelist() if name.lower().endswith((".musicxml", ".xml")) and not name.startswith("META-INF/")),
                            "",
                        )
                    if root_name:
                        return archive.read(root_name).decode("utf-8", errors="ignore")
            except Exception:
                return ""
        try:
            return source_path.read_text("utf-8")
        except UnicodeDecodeError:
            return source_path.read_text("utf-8", errors="ignore")
        except Exception:
            return ""

    def _extract_musicxml_parts(self, xml_text: str) -> list[str]:
        if not xml_text.strip():
            return []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return []

        detected: list[str] = []
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] != "score-part":
                continue
            part_name = ""
            for child in list(element):
                local_tag = child.tag.rsplit("}", 1)[-1]
                if local_tag == "part-name" and child.text:
                    part_name = child.text.strip()
                    break
            part_id = element.attrib.get("id", "").strip()
            candidate = part_name or part_id
            if candidate and candidate not in detected:
                detected.append(candidate)
        return detected

    def _resolve_selected_part(self, detected_parts: list[str], selected_hint: str | None) -> str:
        if not detected_parts:
            return (selected_hint or "erhu").strip() or "erhu"
        normalized_hint = normalize_part_label(selected_hint)
        if normalized_hint:
            for candidate in detected_parts:
                normalized_candidate = normalize_part_label(candidate)
                if normalized_hint in normalized_candidate or normalized_candidate in normalized_hint:
                    return candidate
        preferred_terms = ("二胡", "erhu")
        for candidate in detected_parts:
            normalized_candidate = normalize_part_label(candidate)
            if any(term in candidate.lower() or normalize_part_label(term) in normalized_candidate for term in preferred_terms):
                return candidate
        return detected_parts[0]

    def _decode_symbolic_text(self, data: str, encoding: str | None) -> str:
        if not data:
            return ""
        if (encoding or "").lower() == "base64":
            try:
                return base64.b64decode(data).decode("utf-8")
            except Exception:
                return ""
        return data

    def _decode_symbolic_bytes(self, data: str, encoding: str | None) -> bytes:
        if not data:
            return b""
        if (encoding or "").lower() == "base64":
            try:
                return base64.b64decode(data)
            except Exception:
                return b""
        return data.encode("utf-8")

    def _hydrate_piece_notes(self, notes: list[NoteEvent], request: AnalyzeRequest) -> list[SymbolicNote]:
        measure_beats = beats_per_measure(request.piecePack.meter)
        seconds_per_beat = 60.0 / max(request.piecePack.tempo, 30)
        hydrated: list[SymbolicNote] = []
        for index, note in enumerate(notes, start=1):
            absolute_beat = ((int(note.measureIndex) - 1) * measure_beats) + float(note.beatStart)
            onset = absolute_beat * seconds_per_beat
            duration_seconds = max(0.05, float(note.beatDuration) * seconds_per_beat)
            hydrated.append(
                SymbolicNote(
                    note_id=note.noteId or f"note-{index}",
                    measure_index=int(note.measureIndex),
                    beat_start=float(note.beatStart),
                    beat_duration=float(note.beatDuration),
                    midi_pitch=int(note.midiPitch),
                    expected_onset=onset,
                    expected_offset=onset + duration_seconds,
                    note_position=dict(note.notePosition or {}) if getattr(note, "notePosition", None) else None,
                )
            )
        return hydrated

    def _parse_musicxml_score(self, xml_text: str, request: AnalyzeRequest, selected_part_hint: str | None = None) -> list[SymbolicNote]:
        if not xml_text.strip():
            return []
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            return []

        def child(node: ET.Element, tag: str) -> ET.Element | None:
            for element in list(node):
                if element.tag.rsplit("}", 1)[-1] == tag:
                    return element
            return None

        def children(node: ET.Element, tag: str) -> list[ET.Element]:
            return [element for element in list(node) if element.tag.rsplit("}", 1)[-1] == tag]

        part_names: dict[str, str] = {}
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1] != "score-part":
                continue
            part_id = element.attrib.get("id", "").strip()
            part_name = ""
            for node in list(element):
                if node.tag.rsplit("}", 1)[-1] == "part-name" and node.text:
                    part_name = node.text.strip()
                    break
            if part_id:
                part_names[part_id] = part_name or part_id

        part_candidates = [element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "part"]
        if not part_candidates:
            return []
        preferred_part_label = self._resolve_selected_part(list(part_names.values()), selected_part_hint)
        preferred_part_id = next(
            (part_id for part_id, part_name in part_names.items() if part_name == preferred_part_label),
            "",
        )
        part = next(
            (
                element
                for element in part_candidates
                if element.attrib.get("id", "").strip() == preferred_part_id
            ),
            None,
        ) or part_candidates[0]

        defaults_node = child(root, "defaults")
        page_layout = child(defaults_node, "page-layout") if defaults_node is not None else None
        page_width = max(1.0, safe_float(child(page_layout, "page-width").text if page_layout is not None and child(page_layout, "page-width") is not None else 0.0, 1000.0))
        page_height = max(1.0, safe_float(child(page_layout, "page-height").text if page_layout is not None and child(page_layout, "page-height") is not None else 0.0, 1400.0))
        page_left_margin = 0.0
        page_top_margin = 0.0
        if page_layout is not None:
            page_margins = children(page_layout, "page-margins")
            selected_margins = page_margins[0] if page_margins else None
            if selected_margins is not None:
                page_left_margin = safe_float(child(selected_margins, "left-margin").text if child(selected_margins, "left-margin") is not None else 0.0, 0.0)
                page_top_margin = safe_float(child(selected_margins, "top-margin").text if child(selected_margins, "top-margin") is not None else 0.0, 0.0)

        note_events: list[NoteEvent] = []
        divisions = 1.0
        last_note_start = 0.0
        current_clef_sign = "G"
        current_clef_line = 2
        current_clef_octave_change = 0
        current_system_index = 0
        current_system_top_line = page_top_margin + 140.0
        current_system_left = page_left_margin
        current_measure_offset = 0.0
        current_staff_distance = 70.0
        last_system_top_line: float | None = None
        staff_height = 40.0
        page_number_match = re.search(r"page[-\s]?0*(\d+)", str(getattr(request, "sectionId", "") or getattr(request.piecePack, "sectionId", "") or ""), flags=re.IGNORECASE)
        page_number = int(page_number_match.group(1)) if page_number_match else 1

        for measure_position, measure in enumerate(children(part, "measure"), start=1):
            print_node = child(measure, "print")
            new_system = measure_position == 1
            system_layout = child(print_node, "system-layout") if print_node is not None else None
            if print_node is not None and str(print_node.attrib.get("new-system", "")).strip().lower() == "yes":
                new_system = True
            if system_layout is not None:
                new_system = True
            if new_system:
                current_system_index += 1
                left_margin = safe_float(child(child(system_layout, "system-margins"), "left-margin").text if system_layout is not None and child(system_layout, "system-margins") is not None and child(child(system_layout, "system-margins"), "left-margin") is not None else 0.0, 0.0)
                if last_system_top_line is None:
                    top_distance = safe_float(child(system_layout, "top-system-distance").text if system_layout is not None and child(system_layout, "top-system-distance") is not None else 0.0, 0.0)
                    current_system_top_line = page_top_margin + (top_distance if top_distance > 0 else 140.0)
                else:
                    system_distance = safe_float(child(system_layout, "system-distance").text if system_layout is not None and child(system_layout, "system-distance") is not None else 0.0, 0.0)
                    top_distance = safe_float(child(system_layout, "top-system-distance").text if system_layout is not None and child(system_layout, "top-system-distance") is not None else 0.0, 0.0)
                    next_gap = system_distance if system_distance > 0 else (top_distance if top_distance > 0 else 180.0)
                    current_system_top_line = last_system_top_line + staff_height + max(60.0, next_gap)
                current_system_left = page_left_margin + max(0.0, left_margin)
                current_measure_offset = 0.0
                last_system_top_line = current_system_top_line

            attributes = child(measure, "attributes")
            if attributes is not None:
                divisions_node = child(attributes, "divisions")
                if divisions_node is not None and divisions_node.text:
                    divisions = max(1.0, safe_float(divisions_node.text, 1.0))
                staves_node = child(attributes, "staves")
                if staves_node is not None and staves_node.text:
                    staves_count = max(1, int(safe_float(staves_node.text, 1)))
                    current_staff_distance = 70.0 if staves_count <= 1 else 90.0
                clef_nodes = children(attributes, "clef")
                if clef_nodes:
                    clef_node = clef_nodes[0]
                    sign_node = child(clef_node, "sign")
                    line_node = child(clef_node, "line")
                    octave_change_node = child(clef_node, "clef-octave-change")
                    if sign_node is not None and sign_node.text:
                        current_clef_sign = sign_node.text.strip() or current_clef_sign
                    if line_node is not None and line_node.text:
                        current_clef_line = max(1, min(5, int(safe_float(line_node.text, current_clef_line))))
                    current_clef_octave_change = int(safe_float(octave_change_node.text if octave_change_node is not None else 0, 0))

            current_beat = 0.0
            measure_index = int(measure.attrib.get("number", measure_position) or measure_position)
            clef_reference_diatonic, clef_reference_line = musicxml_clef_reference(
                current_clef_sign,
                current_clef_line,
                current_clef_octave_change,
            )
            top_line_diatonic = clef_reference_diatonic + ((5 - clef_reference_line) * 2)
            for note_index, note in enumerate(children(measure, "note"), start=1):
                is_rest = child(note, "rest") is not None
                is_chord = child(note, "chord") is not None
                duration_node = child(note, "duration")
                duration_beats = safe_float(duration_node.text if duration_node is not None else 0.0) / divisions
                if not is_chord:
                    last_note_start = current_beat
                beat_start = last_note_start if is_chord else current_beat

                if not is_rest:
                    pitch = child(note, "pitch")
                    if pitch is not None:
                        step_node = child(pitch, "step")
                        alter_node = child(pitch, "alter")
                        octave_node = child(pitch, "octave")
                        if step_node is not None and octave_node is not None and step_node.text and octave_node.text:
                            step_text = step_node.text.strip()
                            octave_value = int(safe_float(octave_node.text, 4))
                            alter_value = int(safe_float(alter_node.text if alter_node is not None else 0, 0))
                            midi_pitch = musicxml_pitch_to_midi(
                                step_text,
                                octave_value,
                                alter_value,
                            )
                            default_x = safe_float(note.attrib.get("default-x"), 0.0, )
                            staff_node = child(note, "staff")
                            staff_index = max(1, int(safe_float(staff_node.text if staff_node is not None else 1, 1)))
                            note_diatonic = musicxml_step_to_diatonic(step_text, octave_value)
                            staff_offset = float(staff_index - 1) * current_staff_distance
                            absolute_x = current_system_left + current_measure_offset + max(0.0, default_x)
                            absolute_y = current_system_top_line + staff_offset + ((top_line_diatonic - note_diatonic) * 5.0)
                            normalized_x = max(0.0, min(1.0, absolute_x / page_width))
                            normalized_y = max(0.0, min(1.0, absolute_y / page_height))
                            note_events.append(
                                NoteEvent(
                                    noteId=f"xml-m{measure_index}-n{note_index}",
                                    measureIndex=measure_index,
                                    beatStart=beat_start,
                                    beatDuration=max(duration_beats, 0.25),
                                    midiPitch=midi_pitch,
                                    notePosition={
                                        "pageNumber": page_number,
                                        "systemIndex": current_system_index or 1,
                                        "staffIndex": staff_index,
                                        "normalizedX": round(float(normalized_x), 6),
                                        "normalizedY": round(float(normalized_y), 6),
                                        "pageWidth": round(float(page_width), 3),
                                        "pageHeight": round(float(page_height), 3),
                                        "source": "musicxml-layout",
                                    },
                                )
                            )
                if not is_chord:
                    current_beat += max(duration_beats, 0.0)
            current_measure_offset += max(0.0, safe_float(measure.attrib.get("width"), 0.0))

        note_events = self._collapse_erhu_melody_events(note_events)
        return self._hydrate_piece_notes(note_events, request)

    def _collapse_erhu_melody_events(self, note_events: list[NoteEvent]) -> list[NoteEvent]:
        if len(note_events) <= 1:
            return note_events

        ordered = sorted(
            note_events,
            key=lambda item: (int(item.measureIndex), round(float(item.beatStart), 4), -float(item.beatDuration), int(item.midiPitch)),
        )

        groups: list[list[NoteEvent]] = []
        current_group: list[NoteEvent] = []
        current_key: tuple[int, float] | None = None
        for note in ordered:
            group_key = (int(note.measureIndex), round(float(note.beatStart), 4))
            if current_key != group_key:
                if current_group:
                    groups.append(current_group)
                current_group = [note]
                current_key = group_key
            else:
                current_group.append(note)
        if current_group:
            groups.append(current_group)

        collapsed: list[NoteEvent] = []
        previous_pitch: int | None = None
        erhu_min_pitch = 52
        erhu_max_pitch = 96

        for group in groups:
            deduped_by_pitch: dict[int, NoteEvent] = {}
            for note in group:
                midi_pitch = int(note.midiPitch)
                existing = deduped_by_pitch.get(midi_pitch)
                if existing is None or float(note.beatDuration) > float(existing.beatDuration):
                    deduped_by_pitch[midi_pitch] = note

            candidates = list(deduped_by_pitch.values())
            in_range = [note for note in candidates if erhu_min_pitch <= int(note.midiPitch) <= erhu_max_pitch]
            working = in_range or candidates

            if previous_pitch is None:
                chosen = max(working, key=lambda item: (float(item.beatDuration), int(item.midiPitch)))
            else:
                chosen = min(
                    working,
                    key=lambda item: (
                        abs(int(item.midiPitch) - previous_pitch),
                        -float(item.beatDuration),
                        -int(item.midiPitch),
                    ),
                )
                close_candidates = [
                    note for note in working if abs(int(note.midiPitch) - previous_pitch) <= 7
                ]
                if close_candidates:
                    chosen = max(close_candidates, key=lambda item: (float(item.beatDuration), -abs(int(item.midiPitch) - previous_pitch)))

            previous_pitch = int(chosen.midiPitch)
            collapsed.append(chosen)

        normalized: list[NoteEvent] = []
        for index, note in enumerate(collapsed, start=1):
            normalized.append(
                NoteEvent(
                    noteId=note.noteId or f"xml-note-{index}",
                    measureIndex=int(note.measureIndex),
                    beatStart=float(note.beatStart),
                    beatDuration=max(float(note.beatDuration), 0.25),
                    midiPitch=int(note.midiPitch),
                    notePosition=dict(note.notePosition or {}) if getattr(note, "notePosition", None) else None,
                )
            )
        return normalized

    def _parse_midi_score(self, midi_bytes: bytes, request: AnalyzeRequest) -> list[SymbolicNote]:
        if not midi_bytes or pretty_midi is None:
            return []
        with tempfile.TemporaryDirectory(prefix="ai-erhu-midi-") as temp_dir:
            midi_path = os.path.join(temp_dir, "score.mid")
            with open(midi_path, "wb") as handle:
                handle.write(midi_bytes)
            try:
                midi_file = pretty_midi.PrettyMIDI(midi_path)
            except Exception:
                return []

        instruments = [instrument for instrument in midi_file.instruments if not instrument.is_drum and instrument.notes]
        if not instruments:
            instruments = [instrument for instrument in midi_file.instruments if instrument.notes]
        if not instruments:
            return []

        instrument = max(instruments, key=lambda item: len(item.notes))
        tempo_changes, tempi = midi_file.get_tempo_changes()
        seconds_per_beat = 60.0 / max(request.piecePack.tempo, 30)
        if len(tempi):
            seconds_per_beat = 60.0 / max(float(tempi[0]), 30.0)
        measure_beats = beats_per_measure(request.piecePack.meter)

        note_events: list[NoteEvent] = []
        for index, note in enumerate(sorted(instrument.notes, key=lambda item: item.start), start=1):
            absolute_beats = note.start / seconds_per_beat if seconds_per_beat > 0 else 0.0
            beat_duration = max(0.25, (note.end - note.start) / seconds_per_beat if seconds_per_beat > 0 else 0.25)
            measure_index = int(absolute_beats // measure_beats) + 1
            beat_start = absolute_beats - ((measure_index - 1) * measure_beats)
            note_events.append(
                NoteEvent(
                    noteId=f"midi-n{index}",
                    measureIndex=measure_index,
                    beatStart=beat_start,
                    beatDuration=beat_duration,
                    midiPitch=int(note.pitch),
                )
            )

        return self._hydrate_piece_notes(note_events, request)

    def _estimate_pitch_track(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        score_notes: list[SymbolicNote],
    ) -> tuple[list[dict[str, float]], str]:
        cached_track, cached_source = self._read_cached_feature(audio, "pitch")
        if cached_track is not None and cached_source:
            return cached_track, cached_source
        if audio.waveform is None or audio.sample_rate is None or np is None:
            track = self._synthetic_pitch_track(score_notes)
            self._write_cached_feature(audio, "pitch", track, "synthetic")
            return track, "synthetic"

        waveform = np.asarray(audio.waveform, dtype=np.float32)
        if waveform.size == 0:
            track = self._synthetic_pitch_track(score_notes)
            self._write_cached_feature(audio, "pitch", track, "synthetic")
            return track, "synthetic"

        if self.settings.enable_torchcrepe and torch is not None and torchcrepe is not None:
            try:
                tensor = torch.tensor(waveform, dtype=torch.float32).unsqueeze(0)
                hop_length = max(1, int(audio.sample_rate * (self.settings.pitch_hop_ms / 1000.0)))
                pitch, periodicity = torchcrepe.predict(
                    tensor,
                    audio.sample_rate,
                    hop_length=hop_length,
                    fmin=120.0,
                    fmax=1400.0,
                    batch_size=256,
                    device="cpu",
                    return_periodicity=True,
                )
                pitch_values = pitch.squeeze(0).detach().cpu().numpy()
                confidence_values = periodicity.squeeze(0).detach().cpu().numpy()
                track = [
                    {
                        "time": index * (hop_length / audio.sample_rate),
                        "frequency": float(freq),
                        "confidence": float(conf),
                    }
                    for index, (freq, conf) in enumerate(zip(pitch_values, confidence_values, strict=False))
                    if float(freq) > 0 and float(conf) >= self.settings.min_confidence
                ]
                if track:
                    self._write_cached_feature(audio, "pitch", track, "torchcrepe")
                    return track, "torchcrepe"
            except Exception:
                pass

        if librosa is not None:
            try:
                f0, voiced_flag, voiced_prob = librosa.pyin(
                    waveform,
                    fmin=librosa.note_to_hz("G2"),
                    fmax=librosa.note_to_hz("E7"),
                    sr=audio.sample_rate,
                    hop_length=max(64, self.settings.onset_hop_length),
                )
                times = librosa.times_like(f0, sr=audio.sample_rate, hop_length=max(64, self.settings.onset_hop_length))
                track = []
                for time_value, freq, confidence in zip(times, f0, voiced_prob, strict=False):
                    if freq is None or np.isnan(freq) or confidence is None or np.isnan(confidence):
                        continue
                    if float(confidence) < self.settings.min_confidence:
                        continue
                    track.append(
                        {
                            "time": float(time_value),
                            "frequency": float(freq),
                            "confidence": float(confidence),
                        }
                    )
                if track:
                    self._write_cached_feature(audio, "pitch", track, "librosa-pyin")
                    return track, "librosa-pyin"
            except Exception:
                pass

        track = self._synthetic_pitch_track(score_notes)
        self._write_cached_feature(audio, "pitch", track, "synthetic")
        return track, "synthetic"

    def _synthetic_pitch_track(self, score_notes: list[SymbolicNote]) -> list[dict[str, float]]:
        track = []
        for note in score_notes:
            seconds = max(0.15, note.expected_offset - note.expected_onset)
            time_offsets = [0.08, 0.34, 0.58, 0.82] if seconds > 0.18 else [0.12, 0.52, 0.84]
            for ratio in time_offsets:
                track.append(
                    {
                        "time": note.expected_onset + (seconds * ratio),
                        "frequency": float(midi_to_frequency(note.midi_pitch)),
                        "confidence": 0.68,
                    }
                )
        return track

    def _minimum_reasonable_onset_count(self, score_notes: list[SymbolicNote]) -> int:
        unique_score_onsets = sorted({round(float(note.expected_onset), 3) for note in score_notes})
        if not unique_score_onsets:
            return 2
        ratio = max(0.05, float(self.settings.madmom_relaxed_onset_min_count_ratio))
        return max(2, min(12, int(math.ceil(len(unique_score_onsets) * ratio))))

    def _extract_relaxed_madmom_onsets(
        self,
        activations: Any,
        score_notes: list[SymbolicNote],
    ) -> list[dict[str, float]]:
        if np is None:
            return []
        values = np.asarray(activations, dtype=float).reshape(-1)
        if values.size < 3:
            return []

        finite_values = values[np.isfinite(values)]
        if finite_values.size < 3:
            return []

        quantile_value = float(np.quantile(finite_values, self.settings.madmom_relaxed_onset_quantile))
        base_threshold = max(
            float(self.settings.madmom_relaxed_onset_min_threshold),
            quantile_value * float(self.settings.madmom_relaxed_onset_scale),
            float(finite_values.mean() + (finite_values.std() * 0.25)),
        )
        min_spacing_frames = max(
            1,
            int(round((float(self.settings.madmom_relaxed_onset_min_spacing_ms) / 1000.0) * float(self.settings.madmom_fps))),
        )
        minimum_count = self._minimum_reasonable_onset_count(score_notes)

        def pick_with_threshold(threshold: float) -> list[int]:
            candidate_indices = [
                index
                for index in range(1, len(values) - 1)
                if (
                    math.isfinite(float(values[index]))
                    and float(values[index]) >= threshold
                    and float(values[index]) >= float(values[index - 1])
                    and float(values[index]) >= float(values[index + 1])
                )
            ]
            if not candidate_indices:
                return []
            ranked = sorted(candidate_indices, key=lambda index: float(values[index]), reverse=True)
            selected: list[int] = []
            for index in ranked:
                if any(abs(index - existing) < min_spacing_frames for existing in selected):
                    continue
                selected.append(index)
            return sorted(selected)

        thresholds = [
            base_threshold,
            max(float(self.settings.madmom_relaxed_onset_min_threshold), base_threshold * 0.82),
            float(self.settings.madmom_relaxed_onset_min_threshold),
        ]
        selected_indices: list[int] = []
        for threshold in thresholds:
            selected_indices = pick_with_threshold(threshold)
            if len(selected_indices) >= minimum_count:
                break
        if not selected_indices:
            return []
        return [{"time": float(index / float(self.settings.madmom_fps))} for index in selected_indices]

    def _build_madmom_beat_grid_from_onsets(
        self,
        onset_track: list[dict[str, float]],
        score_notes: list[SymbolicNote],
    ) -> list[dict[str, float]]:
        if np is None or not onset_track or not score_notes:
            return []

        onset_times = sorted({round(float(item.get("time", 0.0)), 4) for item in onset_track if item.get("time") is not None})
        score_times = sorted({round(float(note.expected_onset), 4) for note in score_notes})
        if len(onset_times) < 2 or len(score_times) < 2:
            return [{"time": value} for value in onset_times]

        sample_count = min(len(onset_times), len(score_times), 12)
        if sample_count < 2:
            return [{"time": value} for value in onset_times]

        def proportional_indexes(length: int, count: int) -> list[int]:
            if count <= 1:
                return [0]
            return sorted(
                {
                    int(round((index * max(0, length - 1)) / max(1, count - 1)))
                    for index in range(count)
                }
            )

        score_indexes = proportional_indexes(len(score_times), sample_count)
        onset_indexes = proportional_indexes(len(onset_times), sample_count)
        pair_count = min(len(score_indexes), len(onset_indexes))
        if pair_count < 2:
            return [{"time": value} for value in onset_times]

        score_sample = np.asarray([score_times[index] for index in score_indexes[:pair_count]], dtype=float)
        onset_sample = np.asarray([onset_times[index] for index in onset_indexes[:pair_count]], dtype=float)
        try:
            slope, intercept = np.polyfit(score_sample, onset_sample, 1)
        except Exception:
            score_duration = max(1e-6, score_sample[-1] - score_sample[0])
            onset_duration = max(1e-6, onset_sample[-1] - onset_sample[0])
            slope = onset_duration / score_duration
            intercept = onset_sample[0] - (score_sample[0] * slope)

        if not math.isfinite(float(slope)) or float(slope) <= 0:
            score_duration = max(1e-6, score_sample[-1] - score_sample[0])
            onset_duration = max(1e-6, onset_sample[-1] - onset_sample[0])
            slope = onset_duration / score_duration
        slope = max(0.35, min(3.0, float(slope)))
        intercept = float(intercept) if math.isfinite(float(intercept)) else 0.0

        warped_score_times = sorted({round((float(score_time) * slope) + intercept, 4) for score_time in score_times})
        return [{"time": value} for value in warped_score_times if value >= 0.0]

    def _estimate_onsets(self, audio: AudioArtifact, score_notes: list[SymbolicNote]) -> tuple[list[dict[str, float]], str]:
        cached_track, cached_source = self._read_cached_feature(audio, "onset")
        if cached_track is not None and cached_source:
            return cached_track, cached_source
        if (
            audio.waveform is not None
            and audio.sample_rate
            and np is not None
            and self.settings.enable_madmom
            and RNNOnsetProcessor is not None
            and OnsetPeakPickingProcessor is not None
        ):
            wav_path: Path | None = None
            try:
                wav_path = self._create_madmom_temp_wav(audio, "ai-erhu-madmom-onset-")
                onset_processor = RNNOnsetProcessor()
                activations = onset_processor(str(wav_path))
                peak_picker = OnsetPeakPickingProcessor(fps=self.settings.madmom_fps)
                onset_times = peak_picker(activations)
                onset_list = [{"time": float(value)} for value in onset_times]
                if len(onset_list) >= self._minimum_reasonable_onset_count(score_notes):
                    self._write_cached_feature(audio, "onset", onset_list, "madmom-rnn-onset")
                    return onset_list, "madmom-rnn-onset"
                relaxed_onsets = self._extract_relaxed_madmom_onsets(activations, score_notes)
                if relaxed_onsets:
                    self._write_cached_feature(audio, "onset", relaxed_onsets, "madmom-rnn-onset-relaxed")
                    return relaxed_onsets, "madmom-rnn-onset-relaxed"
            except Exception:
                pass
            finally:
                gc.collect()
                self._cleanup_temp_path(wav_path)
        if audio.waveform is not None and audio.sample_rate and librosa is not None:
            try:
                hop_length = max(64, self.settings.onset_hop_length)
                onset_frames = librosa.onset.onset_detect(
                    y=audio.waveform,
                    sr=audio.sample_rate,
                    hop_length=hop_length,
                    units="frames",
                    backtrack=False,
                    pre_max=20,
                    post_max=20,
                    pre_avg=100,
                    post_avg=100,
                    delta=0.2,
                    wait=2,
                )
                onset_times = librosa.frames_to_time(onset_frames, sr=audio.sample_rate, hop_length=hop_length)
                onset_list = [{"time": float(value)} for value in onset_times]
                self._write_cached_feature(audio, "onset", onset_list, "librosa-onset")
                return onset_list, "librosa-onset"
            except Exception:
                pass
        onset_list = [{"time": float(note.expected_onset)} for note in score_notes]
        self._write_cached_feature(audio, "onset", onset_list, "score-fallback")
        return onset_list, "score-fallback"

    def _estimate_beats(self, audio: AudioArtifact, score_notes: list[SymbolicNote]) -> tuple[list[dict[str, float]], str]:
        cached_track, cached_source = self._read_cached_feature(audio, "beat")
        if cached_track is not None and cached_source:
            return cached_track, cached_source
        if (
            audio.waveform is not None
            and audio.sample_rate
            and np is not None
            and self.settings.enable_madmom
            and RNNBeatProcessor is not None
            and DBNBeatTrackingProcessor is not None
        ):
            wav_path: Path | None = None
            try:
                wav_path = self._create_madmom_temp_wav(audio, "ai-erhu-madmom-beat-")
                beat_processor = RNNBeatProcessor()
                activations = beat_processor(str(wav_path))
                tracker = DBNBeatTrackingProcessor(fps=self.settings.madmom_fps)
                beat_times = tracker(activations)
                beat_list = [{"time": float(value)} for value in beat_times]
                if len(beat_list) >= max(2, self._minimum_reasonable_onset_count(score_notes) - 1):
                    self._write_cached_feature(audio, "beat", beat_list, "madmom-rnn-beat")
                    return beat_list, "madmom-rnn-beat"
            except Exception:
                pass
            finally:
                gc.collect()
                self._cleanup_temp_path(wav_path)

        onset_track, onset_source = self._estimate_onsets(audio, score_notes)
        if onset_track and onset_source.startswith("madmom"):
            beat_list = self._build_madmom_beat_grid_from_onsets(onset_track, score_notes)
            if beat_list:
                self._write_cached_feature(audio, "beat", beat_list, "madmom-onset-beat-grid")
                return beat_list, "madmom-onset-beat-grid"

        if score_notes:
            estimated_beats = sorted({float(note.expected_onset) for note in score_notes})
            beat_list = [{"time": value} for value in estimated_beats]
            self._write_cached_feature(audio, "beat", beat_list, "score-beat-fallback")
            return beat_list, "score-beat-fallback"
        self._write_cached_feature(audio, "beat", [], "beat-unavailable")
        return [], "beat-unavailable"

    def _detect_glide_run(
        self,
        times: list[float],
        cents_values: list[float],
    ) -> tuple[list[bool], float]:
        mask = [False] * len(times)
        if len(times) < 4 or len(cents_values) < 4:
            return mask, 0.0

        threshold = float(self.settings.glide_derivative_threshold_cents_per_ms)
        min_duration_ms = float(self.settings.glide_min_duration_ms)
        run_start: int | None = None
        run_sign = 0
        best_duration_ms = 0.0

        def finalize_run(end_index: int) -> None:
            nonlocal run_start, run_sign, best_duration_ms
            if run_start is None or end_index <= run_start:
                run_start = None
                run_sign = 0
                return
            duration_ms = max(0.0, (float(times[end_index]) - float(times[run_start])) * 1000.0)
            if duration_ms >= min_duration_ms:
                for idx in range(run_start, end_index + 1):
                    mask[idx] = True
                best_duration_ms = max(best_duration_ms, duration_ms)
            run_start = None
            run_sign = 0

        for index in range(1, min(len(times), len(cents_values))):
            dt_ms = max(1e-3, (float(times[index]) - float(times[index - 1])) * 1000.0)
            delta_cents = float(cents_values[index]) - float(cents_values[index - 1])
            slope = delta_cents / dt_ms
            sign = 1 if slope > 0 else -1 if slope < 0 else 0
            qualifies = abs(slope) >= threshold and sign != 0
            if qualifies and (run_start is None or sign == run_sign):
                if run_start is None:
                    run_start = index - 1
                run_sign = sign
                continue
            finalize_run(index - 1)
            if qualifies:
                run_start = index - 1
                run_sign = sign

        finalize_run(min(len(times), len(cents_values)) - 1)
        return mask, best_duration_ms

    def _detect_vibrato_profile(
        self,
        times: list[float],
        frequencies: list[float],
        reference_frequency: float,
    ) -> tuple[bool, float, float]:
        if len(times) < 5 or len(frequencies) < 5 or reference_frequency <= 0:
            return False, reference_frequency, 0.0

        cents_values = [cents_between(value, reference_frequency) for value in frequencies]
        centerline_cents = lowpass_series(times, cents_values, float(self.settings.vibrato_lowpass_cutoff_hz))
        deviations = [value - center for value, center in zip(cents_values, centerline_cents, strict=False)]
        amplitude = percentile([abs(value) for value in deviations], 90)
        zero_crossings = count_sign_changes(deviations, float(self.settings.vibrato_min_amplitude_cents) * 0.25)
        if (
            amplitude < float(self.settings.vibrato_min_amplitude_cents)
            or amplitude > float(self.settings.vibrato_max_amplitude_cents)
            or zero_crossings < int(self.settings.vibrato_min_zero_crossings)
        ):
            return False, reference_frequency, float(amplitude)

        center_frequency = trimmed_median(
            [
                reference_frequency * (2.0 ** (center_cents / 1200.0))
                for center_cents in centerline_cents
            ],
            0.1,
        )
        if center_frequency <= 0:
            center_frequency = reference_frequency
        return True, center_frequency, float(amplitude)

    def _detect_trill_profile(
        self,
        frequencies: list[float],
    ) -> tuple[bool, float, float, int]:
        if len(frequencies) < 6:
            return False, 0.0, 0.0, 0

        midi_values = [frequency_to_midi(value) for value in frequencies if value > 0]
        if len(midi_values) < 6:
            return False, 0.0, 0.0, 0

        pivot = trimmed_median(midi_values, 0.1)
        low_cluster = [value for value in midi_values if value <= pivot]
        high_cluster = [value for value in midi_values if value > pivot]
        if len(low_cluster) < 2 or len(high_cluster) < 2:
            return False, 0.0, 0.0, 0

        low_center = trimmed_median(low_cluster, 0.1)
        high_center = trimmed_median(high_cluster, 0.1)
        gap_cents = abs(high_center - low_center) * 100.0
        if gap_cents < float(self.settings.trill_jump_threshold_cents):
            return False, 0.0, 0.0, 0

        low_spread = percentile([abs((value - low_center) * 100.0) for value in low_cluster], 80)
        high_spread = percentile([abs((value - high_center) * 100.0) for value in high_cluster], 80)
        if max(low_spread, high_spread) > float(self.settings.trill_cluster_spread_cents):
            return False, 0.0, 0.0, 0

        labels: list[str] = []
        for value in midi_values:
            low_distance = abs((value - low_center) * 100.0)
            high_distance = abs((value - high_center) * 100.0)
            labels.append("low" if low_distance <= high_distance else "high")
        switch_count = sum(1 for left, right in zip(labels, labels[1:], strict=False) if left != right)
        if switch_count < int(self.settings.trill_min_switch_count):
            return False, 0.0, 0.0, switch_count

        low_frequency = 440.0 * (2.0 ** ((low_center - 69.0) / 12.0))
        high_frequency = 440.0 * (2.0 ** ((high_center - 69.0) / 12.0))
        return True, low_frequency, high_frequency, switch_count

    def _build_observed_notes(
        self,
        audio: AudioArtifact,
        pitch_track: list[dict[str, float]],
        onset_track: list[dict[str, float]],
        score_notes: list[SymbolicNote],
        section_calibration: dict[str, Any] | None = None,
    ) -> list[ObservedNote]:
        if not pitch_track:
            return []

        section_calibration = section_calibration or {}
        performance_duration = audio.duration_seconds or max((float(item["time"]) for item in pitch_track), default=0.0)
        score_duration = max((note.expected_offset for note in score_notes), default=performance_duration or 1.0)
        detected_onset_times = sorted({round(float(item["time"]), 4) for item in onset_track if "time" in item})
        score_based_onsets: list[float] = []
        if score_notes:
            ratio = (performance_duration / score_duration) if score_duration > 0 and performance_duration > 0 else 1.0
            score_based_onsets = [round(float(note.expected_onset) * ratio, 4) for note in score_notes]
        if bool(section_calibration.get("preferScoreBoundaries")) and score_based_onsets:
            onset_times = score_based_onsets
        else:
            onset_times = detected_onset_times or score_based_onsets

        cleaned_onsets: list[float] = []
        for value in onset_times:
            if not cleaned_onsets or abs(value - cleaned_onsets[-1]) >= 0.06:
                cleaned_onsets.append(value)
        if not cleaned_onsets:
            cleaned_onsets = [0.0]
        if cleaned_onsets[0] > 0.08:
            cleaned_onsets.insert(0, 0.0)

        track_end = max((float(item["time"]) for item in pitch_track), default=performance_duration)
        segment_end = max(performance_duration or 0.0, track_end + 0.08)
        boundaries = cleaned_onsets + [segment_end]

        observed: list[ObservedNote] = []
        for start, end in zip(boundaries, boundaries[1:], strict=False):
            if end <= start:
                continue
            segment_duration = max(0.03, end - start)
            segment_points = [
                item
                for item in pitch_track
                if start <= float(item["time"]) <= end and float(item["frequency"]) > 0
            ]
            if not segment_points:
                continue

            segment_times = [float(item["time"]) for item in segment_points]
            segment_frequencies = [float(item["frequency"]) for item in segment_points]
            rough_frequency = trimmed_median(segment_frequencies, 0.1)
            if rough_frequency <= 0:
                continue
            segment_cents = [cents_between(freq, rough_frequency) for freq in segment_frequencies]
            glide_mask, glide_run_ms = self._detect_glide_run(segment_times, segment_cents)
            scoreable_points = [
                point for point, masked in zip(segment_points, glide_mask, strict=False) if not masked
            ]
            if not scoreable_points:
                scoreable_points = segment_points

            stable_start = start + (segment_duration * self.settings.stable_region_start_ratio)
            stable_end = start + (segment_duration * self.settings.stable_region_end_ratio)
            stable_end = max(stable_start + 0.03, stable_end)
            stable_points = [
                item
                for item in scoreable_points
                if stable_start <= float(item["time"]) <= stable_end and float(item["frequency"]) > 0
            ]
            if not stable_points:
                stable_points = segment_points
            if not stable_points:
                continue

            core_start = start + (segment_duration * self.settings.expressive_core_start_ratio)
            core_end = start + (segment_duration * self.settings.expressive_core_end_ratio)
            if core_end <= core_start + 0.03:
                core_start = stable_start
                core_end = stable_end
            core_points = [
                item
                for item in scoreable_points
                if core_start <= float(item["time"]) <= core_end and float(item["frequency"]) > 0
            ]
            estimation_points = core_points if len(core_points) >= max(3, min(5, len(stable_points))) else stable_points
            if not estimation_points:
                estimation_points = segment_points
            if not estimation_points:
                continue

            estimation_points = [item for item in estimation_points if float(item["frequency"]) > 0]
            if len(estimation_points) >= 5 and rough_frequency > 0:
                ranked_pairs = sorted(
                    (
                        abs(cents_between(float(item["frequency"]), rough_frequency)),
                        index,
                    )
                    for index, item in enumerate(estimation_points)
                )
                keep_count = max(3, int(len(ranked_pairs) * 0.8))
                keep_indices = sorted(index for _, index in ranked_pairs[:keep_count])
                estimation_points = [estimation_points[index] for index in keep_indices]
            frequencies = [float(item["frequency"]) for item in estimation_points]
            estimation_times = [float(item["time"]) for item in estimation_points]
            vibrato_like, vibrato_center_frequency, vibrato_amplitude_cents = self._detect_vibrato_profile(
                estimation_times,
                frequencies,
                trimmed_median(frequencies, 0.1) or rough_frequency,
            )
            trill_like, trill_low_frequency, trill_high_frequency, trill_switch_count = self._detect_trill_profile(
                frequencies
            )

            confidence_values = [float(item.get("confidence", 0.0)) for item in estimation_points]
            median_frequency = vibrato_center_frequency if vibrato_like else trimmed_median(frequencies, 0.1)
            start_window_end = start + (segment_duration * 0.24)
            end_window_start = end - (segment_duration * 0.24)
            entry_points = [
                float(item["frequency"])
                for item in pitch_track
                if start <= float(item["time"]) <= start_window_end and float(item["frequency"]) > 0
            ]
            exit_points = [
                float(item["frequency"])
                for item in pitch_track
                if end_window_start <= float(item["time"]) <= end and float(item["frequency"]) > 0
            ]
            entry_frequency = trimmed_median(entry_points, 0.1) if entry_points else median_frequency
            exit_frequency = trimmed_median(exit_points, 0.1) if exit_points else median_frequency
            center_cents = [cents_between(freq, median_frequency) for freq in frequencies]
            pitch_spread_cents = abs(percentile(center_cents, 90) - percentile(center_cents, 10))
            entry_cents = cents_between(entry_frequency, median_frequency)
            exit_cents = cents_between(exit_frequency, median_frequency)
            glide_like = (
                glide_run_ms >= float(self.settings.glide_min_duration_ms)
                or abs(entry_cents) >= self.settings.glide_entry_threshold_cents
                or abs(exit_cents) >= self.settings.glide_entry_threshold_cents
            )
            if not vibrato_like:
                vibrato_like = pitch_spread_cents >= self.settings.vibrato_spread_threshold_cents

            early_points = [
                float(item["frequency"])
                for item in segment_points
                if start <= float(item["time"]) <= start + (segment_duration * 0.18) and float(item["frequency"]) > 0
            ]
            early_frequency = trimmed_median(early_points, 0.1) if early_points else median_frequency
            early_cents = cents_between(early_frequency, median_frequency)
            pluck_like = (
                abs(early_cents) >= float(self.settings.pluck_entry_threshold_cents)
                and pitch_spread_cents <= float(self.settings.vibrato_spread_threshold_cents) + 10.0
            )
            # 打音 (tap/grace): very brief ornamental note — short duration, moderate pitch
            # deviation, settles quickly; distinct from pluck (which has higher entry threshold)
            tap_like = (
                segment_duration * 1000.0 <= 80.0
                and not trill_like
                and not pluck_like
                and not vibrato_like
                and pitch_spread_cents <= 32.0
            )
            # 泛音 (harmonics): very stable, pure sustained tone with weak fundamental;
            # detected acoustically by near-zero spread without other technique markers
            harmonic_like_obs = (
                not vibrato_like
                and not glide_like
                and not trill_like
                and not pluck_like
                and not tap_like
                and pitch_spread_cents <= 12.0
                and len(frequencies) >= 4
                and segment_duration >= 0.08
            )
            observed.append(
                ObservedNote(
                    onset=float(start),
                    offset=float(end),
                    median_frequency=median_frequency,
                    median_midi=float(frequency_to_midi(median_frequency)),
                    confidence=float(median(confidence_values)) if confidence_values else 0.0,
                    segment_point_count=len(segment_points),
                    stable_point_count=len(frequencies),
                    pitch_spread_cents=float(pitch_spread_cents),
                    entry_cents=float(entry_cents),
                    exit_cents=float(exit_cents),
                    glide_like=glide_like,
                    vibrato_like=vibrato_like,
                    trill_like=trill_like,
                    pluck_like=pluck_like,
                    tap_like=tap_like,
                    harmonic_like=harmonic_like_obs,
                    vibrato_center_frequency=float(vibrato_center_frequency if vibrato_center_frequency > 0 else median_frequency),
                    vibrato_amplitude_cents=float(vibrato_amplitude_cents),
                    glide_run_ms=float(glide_run_ms),
                    trill_low_frequency=float(trill_low_frequency),
                    trill_high_frequency=float(trill_high_frequency),
                    trill_switch_count=int(trill_switch_count),
                )
            )
        return observed

    def _note_match_cost(
        self,
        score_note: SymbolicNote,
        observed_note: ObservedNote,
        score_duration: float,
        performance_duration: float,
    ) -> float:
        pitch_distance = abs(observed_note.median_midi - float(score_note.midi_pitch))
        # Harmonics sound an octave (or more) above the fingered note; collapse the octave
        # component of the matching cost so harmonic notes are not mismatched to wrong score notes.
        if observed_note.harmonic_like and pitch_distance >= 10.0:
            octave_remainder = abs(pitch_distance - round(pitch_distance / 12.0) * 12.0)
            if octave_remainder <= 1.5:
                pitch_distance = octave_remainder + 1.5
        score_norm = score_note.expected_onset / max(score_duration, 1e-6)
        observed_norm = observed_note.onset / max(performance_duration, 1e-6)
        time_distance = abs(score_norm - observed_norm) * 12.0
        score_note_norm = (score_note.expected_offset - score_note.expected_onset) / max(score_duration, 1e-6)
        observed_note_norm = (observed_note.offset - observed_note.onset) / max(performance_duration, 1e-6)
        duration_distance = abs(score_note_norm - observed_note_norm) * 8.0
        confidence_penalty = max(0.0, self.settings.min_confidence - observed_note.confidence) * 6.0
        return pitch_distance + time_distance + duration_distance + confidence_penalty

    def _calibrated_cents_error(
        self,
        estimated_frequency: float,
        expected_midi: int,
        section_calibration: dict[str, Any] | None = None,
    ) -> tuple[float, float, int]:
        raw_cents = float(cents_error(estimated_frequency, expected_midi))
        if estimated_frequency <= 0.0:
            return raw_cents, raw_cents, 0
        section_calibration = section_calibration or {}
        max_steps = max(0, int(section_calibration.get("octaveFlexMaxSteps", 0)))
        if max_steps <= 0:
            return raw_cents, raw_cents, 0
        best_cents = raw_cents
        best_shift = 0
        for octave_step in range(1, max_steps + 1):
            for direction in (-1, 1):
                candidate_midi = expected_midi + (12 * octave_step * direction)
                if not 21 <= candidate_midi <= 108:
                    continue
                candidate_cents = float(cents_error(estimated_frequency, candidate_midi))
                candidate_cost = abs(candidate_cents) + (6.0 * octave_step)
                best_cost = abs(best_cents) + (6.0 * max(0, abs(best_shift) // 12))
                if candidate_cost + 1e-6 < best_cost:
                    best_cents = candidate_cents
                    best_shift = 12 * octave_step * direction
        return best_cents, raw_cents, best_shift

    def _nearest_octave_miss_distance(self, raw_cents_value: float) -> float:
        raw_abs = abs(float(raw_cents_value))
        if raw_abs <= 0.0:
            return 0.0
        nearest = max(1.0, round(raw_abs / 1200.0)) * 1200.0
        lower = max(1200.0, math.floor(raw_abs / 1200.0) * 1200.0)
        upper = max(1200.0, math.ceil(raw_abs / 1200.0) * 1200.0)
        return min(abs(raw_abs - nearest), abs(raw_abs - lower), abs(raw_abs - upper))

    def _pitch_tolerance_for_note(self, note: dict[str, Any]) -> float:
        tolerance = float(self.settings.base_pitch_tolerance_cents)
        tolerance += float(note.get("sectionExtraPitchToleranceCents", 0.0))
        if bool(note.get("vibratoLike")):
            tolerance += float(self.settings.vibrato_tolerance_bonus_cents)
        if bool(note.get("glideLike")):
            tolerance += float(self.settings.glide_tolerance_bonus_cents)
        if bool(note.get("trillLike")):
            tolerance += 8.0
        if bool(note.get("pluckLike")):
            tolerance += 4.0
        if bool(note.get("tapLike")):
            tolerance += 8.0
        if bool(note.get("harmonicLike")):
            tolerance += 10.0
        spread_bonus = min(6.0, max(0.0, float(note.get("pitchSpreadCents", 0.0)) - 12.0) * 0.08)
        tolerance += spread_bonus
        low_separation_threshold = float(note.get("lowSeparationThreshold", 0.0))
        section_separation_confidence = float(note.get("sectionSeparationConfidence", 1.0))
        if low_separation_threshold > 0.0 and section_separation_confidence < low_separation_threshold:
            tolerance += float(note.get("lowSeparationExtraToleranceCents", 0.0))
        return min(float(self.settings.max_pitch_tolerance_cents), tolerance)

    def _is_pitch_uncertain(self, note: dict[str, Any]) -> bool:
        confidence = float(note.get("estimatedConfidence", 0.0))
        stable_point_count = int(note.get("stablePointCount", 0))
        cents_value = abs(float(note.get("centsError", 0.0)))
        raw_cents_value = abs(float(note.get("rawCentsError", note.get("centsError", 0.0))))
        if confidence < float(self.settings.uncertain_confidence) or stable_point_count < int(self.settings.stable_note_min_frames):
            return True
        if bool(note.get("scoreCoarse")):
            imported_score_profile = bool(note.get("importedScoreProfile"))
            octave_flex_semitones = abs(int(note.get("octaveFlexSemitones", 0)))
            low_separation_threshold = float(note.get("lowSeparationThreshold", 0.0))
            section_separation_confidence = float(note.get("sectionSeparationConfidence", 1.0))
            coarse_score_review_threshold = float(note.get("coarseScoreReviewThresholdCents", 0.0))
            isolated_review_threshold = float(note.get("isolatedPitchReviewThresholdCents", 0.0))
            octave_miss_distance = self._nearest_octave_miss_distance(raw_cents_value)
            if octave_flex_semitones >= 12 and raw_cents_value >= 900.0 and cents_value <= 320.0:
                return True
            if imported_score_profile and raw_cents_value >= 900.0 and octave_miss_distance <= 240.0:
                return True
            if imported_score_profile and raw_cents_value >= 1500.0 and cents_value <= max(coarse_score_review_threshold, 420.0):
                return True
            if low_separation_threshold > 0.0 and section_separation_confidence < low_separation_threshold and cents_value <= 260.0:
                return True
            if coarse_score_review_threshold > 0.0 and cents_value <= coarse_score_review_threshold and (
                octave_flex_semitones >= 12
                or (low_separation_threshold > 0.0 and section_separation_confidence < low_separation_threshold)
                or bool(note.get("glideLike"))
                or bool(note.get("vibratoLike"))
            ):
                return True
            if coarse_score_review_threshold > 0.0 and cents_value <= coarse_score_review_threshold and (
                stable_point_count <= int(self.settings.stable_note_min_frames) + 3
                or confidence <= float(self.settings.technique_uncertain_confidence) + 0.08
                or int(note.get("segmentPointCount", 0)) <= stable_point_count + 2
            ):
                return True
            if isolated_review_threshold > 0.0 and cents_value <= isolated_review_threshold:
                return True
        if bool(note.get("glideLike")) and stable_point_count < int(self.settings.stable_note_min_frames) + 2:
            return True
        if bool(note.get("glideLike")) and float(note.get("glideRunMs", 0.0)) >= float(self.settings.glide_min_duration_ms):
            return True
        if (
            bool(note.get("vibratoLike"))
            and float(note.get("pitchSpreadCents", 0.0)) >= float(self.settings.technique_uncertain_spread_cents)
            and confidence < float(self.settings.technique_uncertain_confidence)
        ):
            return True
        if bool(note.get("trillLike")) and int(note.get("trillSwitchCount", 0)) >= int(self.settings.trill_min_switch_count):
            return True
        if bool(note.get("tapLike")):
            return True
        if bool(note.get("pluckLike")) and stable_point_count < int(self.settings.stable_note_min_frames) + 2:
            return True
        if bool(note.get("harmonicLike")):
            return True
        return False

    def _pitch_excess_for_note(self, note: dict[str, Any], tolerance: float) -> tuple[float, float, float]:
        raw_excess = max(0.0, abs(float(note.get("centsError", 0.0))) - tolerance)
        technique_relief = 0.0
        if bool(note.get("glideLike")):
            glide_magnitude = max(abs(float(note.get("entryCents", 0.0))), abs(float(note.get("exitCents", 0.0))))
            technique_relief += min(
                float(self.settings.glide_relief_max_cents),
                max(0.0, glide_magnitude - (float(self.settings.glide_entry_threshold_cents) * 0.4)) * 0.18,
            )
        if bool(note.get("vibratoLike")):
            spread_magnitude = max(
                0.0,
                float(note.get("pitchSpreadCents", 0.0)) - float(self.settings.vibrato_spread_threshold_cents),
            )
            technique_relief += min(
                float(self.settings.vibrato_relief_max_cents),
                2.0 + (spread_magnitude * 0.10),
            )
        if bool(note.get("trillLike")):
            technique_relief += 6.0
        if bool(note.get("pluckLike")):
            technique_relief += float(self.settings.pluck_relief_max_cents)
        if bool(note.get("tapLike")):
            technique_relief += 5.0
        if bool(note.get("harmonicLike")):
            technique_relief += 8.0
        if bool(note.get("scoreCoarse")):
            raw_cents_value = abs(float(note.get("rawCentsError", note.get("centsError", 0.0))))
            adjusted_cents_value = abs(float(note.get("centsError", 0.0)))
            octave_flex_semitones = abs(int(note.get("octaveFlexSemitones", 0)))
            if octave_flex_semitones >= 12:
                technique_relief += min(16.0, max(0.0, raw_cents_value - adjusted_cents_value) * 0.012)
            low_separation_threshold = float(note.get("lowSeparationThreshold", 0.0))
            section_separation_confidence = float(note.get("sectionSeparationConfidence", 1.0))
            if low_separation_threshold > 0.0 and section_separation_confidence < low_separation_threshold:
                technique_relief += 6.0
        return max(0.0, raw_excess - technique_relief), raw_excess, technique_relief

    def _should_review_expressive_pitch(
        self,
        note: dict[str, Any],
        tolerance: float,
        raw_excess: float,
        technique_relief: float,
    ) -> bool:
        cents_value = abs(float(note.get("centsError", 0.0)))
        raw_cents_value = abs(float(note.get("rawCentsError", note.get("centsError", 0.0))))
        if bool(note.get("scoreCoarse")):
            imported_score_profile = bool(note.get("importedScoreProfile"))
            octave_flex_semitones = abs(int(note.get("octaveFlexSemitones", 0)))
            low_separation_threshold = float(note.get("lowSeparationThreshold", 0.0))
            section_separation_confidence = float(note.get("sectionSeparationConfidence", 1.0))
            octave_miss_distance = self._nearest_octave_miss_distance(raw_cents_value)
            if octave_flex_semitones >= 12 and raw_cents_value >= 700.0 and cents_value <= max(tolerance + 40.0, 320.0):
                return True
            if imported_score_profile and raw_cents_value >= 900.0 and octave_miss_distance <= 240.0 and cents_value <= max(tolerance + 48.0, 360.0):
                return True
            if imported_score_profile and raw_cents_value >= 1500.0 and cents_value <= max(tolerance + 64.0, 480.0):
                return True
            if low_separation_threshold > 0.0 and section_separation_confidence < low_separation_threshold and cents_value <= max(tolerance + 30.0, 260.0):
                return True
        if not (bool(note.get("glideLike")) or bool(note.get("vibratoLike")) or bool(note.get("tapLike")) or bool(note.get("pluckLike"))):
            return False
        if raw_excess <= 0.0:
            return False
        if technique_relief >= 2.0 and raw_excess <= technique_relief + 8.0:
            return True
        if bool(note.get("glideLike")):
            glide_magnitude = max(abs(float(note.get("entryCents", 0.0))), abs(float(note.get("exitCents", 0.0))))
            if glide_magnitude >= float(self.settings.glide_entry_threshold_cents) and cents_value <= tolerance + 8.0:
                return True
        if bool(note.get("vibratoLike")):
            spread_value = float(note.get("pitchSpreadCents", 0.0))
            if spread_value >= float(self.settings.vibrato_spread_threshold_cents) and cents_value <= tolerance + 10.0:
                return True
        if bool(note.get("scoreCoarse")) and cents_value <= float(note.get("coarseScoreReviewThresholdCents", 0.0)) and (
            int(note.get("stablePointCount", 0)) <= int(self.settings.stable_note_min_frames) + 3
            or float(note.get("estimatedConfidence", 0.0)) <= float(self.settings.technique_uncertain_confidence) + 0.08
            or int(note.get("segmentPointCount", 0)) <= int(note.get("stablePointCount", 0)) + 2
        ):
            return True
        if bool(note.get("scoreCoarse")) and cents_value <= float(note.get("isolatedPitchReviewThresholdCents", 0.0)):
            return True
        if bool(note.get("trillLike")) and cents_value <= tolerance + 12.0:
            return True
        if bool(note.get("pluckLike")) and cents_value <= tolerance + 8.0:
            return True
        if bool(note.get("tapLike")) and cents_value <= tolerance + 10.0:
            return True
        if bool(note.get("harmonicLike")) and raw_cents_value >= 600.0 and cents_value <= tolerance + 20.0:
            return True
        return False

    def _onset_tolerance_ms(self, note: dict[str, Any]) -> float:
        tolerance = float(self.settings.base_rhythm_tolerance_ms) + float(note.get("sectionExtraRhythmToleranceMs", 0.0))
        low_separation_threshold = float(note.get("lowSeparationThreshold", 0.0))
        section_separation_confidence = float(note.get("sectionSeparationConfidence", 1.0))
        if low_separation_threshold > 0.0 and section_separation_confidence < low_separation_threshold:
            tolerance += float(note.get("lowSeparationExtraRhythmToleranceMs", 0.0))
        return max(float(self.settings.base_rhythm_tolerance_ms), tolerance)

    def _duration_tolerance_ms(self, note: dict[str, Any]) -> float:
        expected_duration_ms = max(1.0, float(note.get("expectedDurationMs", 0.0)))
        duration_ratio_tolerance = float(self.settings.rhythm_duration_ratio_tolerance) + float(
            note.get("sectionExtraDurationToleranceRatio", 0.0)
        )
        return max(
            self._onset_tolerance_ms(note),
            expected_duration_ms * duration_ratio_tolerance,
        )

    def _measure_trend_tolerance_ms(self, notes: list[dict[str, Any]]) -> float:
        return max(
            float(self.settings.rhythm_measure_trend_ms),
            max((float(item.get("sectionMeasureTrendToleranceMs", 0.0)) for item in notes), default=0.0),
        )

    def _measure_instability_tolerance_ms(self, notes: list[dict[str, Any]]) -> float:
        return max(
            float(self.settings.rhythm_measure_instability_ms),
            max((float(item.get("sectionMeasureInstabilityToleranceMs", 0.0)) for item in notes), default=0.0),
        )

    def _note_scoring_onset_error_ms(self, note: dict[str, Any]) -> float:
        return float(note.get("rhythmScoringOnsetErrorMs", note.get("onsetErrorMs", 0.0)))

    def _note_scoring_duration_error_ms(self, note: dict[str, Any]) -> float:
        return float(note.get("rhythmScoringDurationErrorMs", note.get("durationErrorMs", 0.0)))

    def _should_review_coarse_rhythm(self, note: dict[str, Any]) -> bool:
        if not bool(note.get("scoreCoarse")):
            return False
        max_raw_error = max(abs(float(note.get("onsetErrorMs", 0.0))), abs(float(note.get("durationErrorMs", 0.0))))
        coarse_threshold = float(note.get("coarseRhythmReviewThresholdMs", 0.0))
        low_conf_threshold = float(note.get("lowConfidenceRhythmReviewThresholdMs", 0.0))
        estimated_confidence = float(note.get("estimatedConfidence", 0.0))
        low_confidence_floor = float(note.get("scoreGuideConfidenceFloor", self.settings.uncertain_confidence))
        if bool(note.get("denseImportedScoreProfile")) and (
            bool(note.get("pitchUncertain")) or estimated_confidence < (low_confidence_floor + 0.08)
        ):
            imported_threshold = max(low_conf_threshold, coarse_threshold)
            if imported_threshold > 0.0 and max_raw_error <= imported_threshold * 1.25:
                return True
        if low_conf_threshold > 0.0 and (
            bool(note.get("pitchUncertain")) or estimated_confidence < low_confidence_floor or bool(note.get("rhythmReview"))
        ):
            return max_raw_error <= low_conf_threshold
        return coarse_threshold > 0.0 and max_raw_error <= coarse_threshold

    def _rhythm_type_label(self, rhythm_type: str) -> str:
        label_map = {
            "rhythm-ok": "节奏基本正确",
            "rhythm-rush": "节奏抢拍",
            "rhythm-drag": "节奏拖拍",
            "rhythm-duration-short": "时值偏短",
            "rhythm-duration-long": "时值偏长",
            "rhythm-rush-short": "抢拍且时值偏短",
            "rhythm-drag-long": "拖拍且时值偏长",
            "rhythm-missing": "疑似漏音或起拍未捕获",
            "rhythm-unstable": "节奏不稳",
            "rhythm-measure-rush": "小节整体偏快",
            "rhythm-measure-drag": "小节整体偏慢",
            "rhythm-measure-short": "小节时值普遍偏短",
            "rhythm-measure-long": "小节时值普遍偏长",
            "pitch-unstable": "音准不稳",
        }
        return label_map.get(rhythm_type, rhythm_type)

    def _classify_note_rhythm(self, note: dict[str, Any]) -> tuple[str, str]:
        onset_error_ms = self._note_scoring_onset_error_ms(note)
        duration_error_ms = self._note_scoring_duration_error_ms(note)
        onset_tolerance_ms = self._onset_tolerance_ms(note)
        duration_tolerance_ms = self._duration_tolerance_ms(note)
        missing_confidence_threshold = float(
            note.get("sectionRhythmMissingConfidenceThreshold", self.settings.rhythm_missing_confidence)
        )
        missing_attack = int(note.get("matchedObservedIndex", -1)) < 0 and float(
            note.get("estimatedConfidence", 0.0)
        ) <= missing_confidence_threshold

        onset_issue = abs(onset_error_ms) >= onset_tolerance_ms
        duration_issue = abs(duration_error_ms) >= duration_tolerance_ms

        if missing_attack:
            return "rhythm-missing", self._rhythm_type_label("rhythm-missing")
        if onset_issue and duration_issue:
            if onset_error_ms <= -onset_tolerance_ms and duration_error_ms <= -duration_tolerance_ms:
                return "rhythm-rush-short", self._rhythm_type_label("rhythm-rush-short")
            if onset_error_ms >= onset_tolerance_ms and duration_error_ms >= duration_tolerance_ms:
                return "rhythm-drag-long", self._rhythm_type_label("rhythm-drag-long")
            if abs(onset_error_ms) >= abs(duration_error_ms):
                rhythm_type = "rhythm-rush" if onset_error_ms < 0 else "rhythm-drag"
                return rhythm_type, self._rhythm_type_label(rhythm_type)
            rhythm_type = "rhythm-duration-short" if duration_error_ms < 0 else "rhythm-duration-long"
            return rhythm_type, self._rhythm_type_label(rhythm_type)
        if onset_issue:
            rhythm_type = "rhythm-rush" if onset_error_ms < 0 else "rhythm-drag"
            return rhythm_type, self._rhythm_type_label(rhythm_type)
        if duration_issue:
            rhythm_type = "rhythm-duration-short" if duration_error_ms < 0 else "rhythm-duration-long"
            return rhythm_type, self._rhythm_type_label(rhythm_type)
        return "rhythm-ok", self._rhythm_type_label("rhythm-ok")

    def _classify_measure_issue(
        self,
        notes: list[dict[str, Any]],
        pitch_median: float,
        onset_median: float,
    ) -> tuple[str, str]:
        onset_errors = [self._note_scoring_onset_error_ms(item) for item in notes]
        duration_errors = [self._note_scoring_duration_error_ms(item) for item in notes]
        onset_spread = percentile(onset_errors, 75) - percentile(onset_errors, 25)
        duration_median = median(duration_errors or [0.0])
        trend_threshold = self._measure_trend_tolerance_ms(notes)
        instability_threshold = self._measure_instability_tolerance_ms(notes)
        rhythm_types = [str(item.get("rhythmType", "rhythm-ok")) for item in notes]

        rush_count = sum(1 for item in rhythm_types if item in {"rhythm-rush", "rhythm-rush-short"})
        drag_count = sum(1 for item in rhythm_types if item in {"rhythm-drag", "rhythm-drag-long"})
        short_count = sum(1 for item in rhythm_types if item in {"rhythm-duration-short", "rhythm-rush-short"})
        long_count = sum(1 for item in rhythm_types if item in {"rhythm-duration-long", "rhythm-drag-long"})

        if onset_median >= pitch_median:
            if rush_count >= 2 and median(onset_errors or [0.0]) <= -trend_threshold:
                return "rhythm-measure-rush", self._rhythm_type_label("rhythm-measure-rush")
            if drag_count >= 2 and median(onset_errors or [0.0]) >= trend_threshold:
                return "rhythm-measure-drag", self._rhythm_type_label("rhythm-measure-drag")
            if short_count >= 2 and duration_median <= -trend_threshold:
                return "rhythm-measure-short", self._rhythm_type_label("rhythm-measure-short")
            if long_count >= 2 and duration_median >= trend_threshold:
                return "rhythm-measure-long", self._rhythm_type_label("rhythm-measure-long")
            if onset_spread >= instability_threshold or onset_median >= 8.0:
                return "rhythm-unstable", self._rhythm_type_label("rhythm-unstable")
        return "pitch-unstable", self._rhythm_type_label("pitch-unstable")

    def _build_note_reason(self, note: dict[str, Any], pitch_label: str, rhythm_type: str) -> str:
        reasons: list[str] = []
        if pitch_label == "pitch-flat":
            reasons.append(f"稳定段音高比目标低 {int(round(abs(float(note['centsError']))))} cents")
        elif pitch_label == "pitch-sharp":
            reasons.append(f"稳定段音高比目标高 {int(round(abs(float(note['centsError']))))} cents")
        elif pitch_label == "pitch-review":
            reasons.append("该音的稳定段证据偏弱，系统建议结合示范和人工听辨复核")

        if rhythm_type in {"rhythm-rush", "rhythm-rush-short"}:
            reasons.append(f"起拍比参考提前 {int(round(abs(float(note['onsetErrorMs']))))} ms")
        elif rhythm_type in {"rhythm-drag", "rhythm-drag-long"}:
            reasons.append(f"起拍比参考延后 {int(round(abs(float(note['onsetErrorMs']))))} ms")
        if rhythm_type in {"rhythm-duration-short", "rhythm-rush-short"}:
            reasons.append(f"该音实际时值比参考缩短 {int(round(abs(float(note.get('durationErrorMs', 0.0)))))} ms")
        elif rhythm_type in {"rhythm-duration-long", "rhythm-drag-long"}:
            reasons.append(f"该音实际时值比参考拉长 {int(round(abs(float(note.get('durationErrorMs', 0.0)))))} ms")
        elif rhythm_type == "rhythm-missing":
            reasons.append("系统未稳定捕获这一拍的起音，疑似漏音或起拍过弱")

        if bool(note.get("glideLike")):
            reasons.append("检测到明显滑音进入，已自动放宽音准容忍")
        if bool(note.get("vibratoLike")):
            reasons.append("检测到揉弦样波动，已自动放宽音准容忍")
        return "；".join(reasons) if reasons else "该音偏差接近阈值，建议优先结合示范回放复核。"

    def _build_note_action(self, pitch_label: str, rhythm_type: str, note: dict[str, Any]) -> str:
        if pitch_label == "pitch-review":
            return "先听示范并慢速重复该音，确认落点后再决定是否调整指位。"
        if pitch_label == "pitch-flat":
            return "先单独拉长该音，略提前准备左手落点，再回到原速连接前后音。"
        if pitch_label == "pitch-sharp":
            return "保持弓速不变，减小左手按弦高度或回收指位后再重复该音。"
        if rhythm_type in {"rhythm-rush", "rhythm-rush-short"}:
            return "先跟拍器慢速重练，把该音放到拍点后再逐步恢复原速。"
        if rhythm_type in {"rhythm-drag", "rhythm-drag-long"}:
            return "把前一音收短一些，提前准备弓段和左手，避免该音落后。"
        if rhythm_type == "rhythm-duration-short":
            return "先把该音拉满时值，再和前后音做两拍一组的局部循环。"
        if rhythm_type == "rhythm-duration-long":
            return "保持拍点不变，提前准备换音，避免这一音占掉后面的拍子。"
        if rhythm_type == "rhythm-missing":
            return "先单独确认这一拍是否真正演奏到位，再结合示范和教师复核。"
        if bool(note.get("glideLike")):
            return "保持滑音表达，但把落点后的稳定段拉得更清楚。"
        return "先保留当前速度，针对该音做 3 到 5 次局部循环练习。"

    def _build_measure_coaching(self, issue_type: str) -> str:
        if issue_type == "rhythm-measure-rush":
            return "先用节拍器把每拍的起点放稳，再回到整小节连奏。"
        if issue_type == "rhythm-measure-drag":
            return "先把前一拍的结束收干净，再练这一小节的进入时机。"
        if issue_type == "rhythm-measure-short":
            return "先按拍把每个音拉满，再恢复原速检查时值是否够长。"
        if issue_type == "rhythm-measure-long":
            return "先缩短占拍过长的音，再确认下一拍的进入位置。"
        if issue_type == "rhythm-unstable":
            return "先拆成拍点练习，再跟示范或节拍器做小节循环。"
        if issue_type == "pitch-unstable":
            return "先分离问题音，确认每个落点稳定后再恢复整小节演奏。"
        return "先放慢速度，定位最不稳的两个音后再重练。"

    def _practice_path_for_note(self, note: NoteFinding) -> tuple[str, str]:
        if note.isUncertain or note.pitchLabel == "pitch-review":
            return "review-first", "该音证据偏弱，应先复核再决定是否调整手型或节拍。"
        if note.rhythmType == "rhythm-missing":
            return "review-first", "该音疑似漏音或起拍未被稳定捕获，建议先复核演奏与示范。"
        if note.rhythmType in {"rhythm-rush", "rhythm-drag", "rhythm-duration-short", "rhythm-duration-long", "rhythm-rush-short", "rhythm-drag-long"} and note.pitchLabel == "pitch-ok":
            return "rhythm-first", "该音主要是起拍位置问题，应先修节奏。"
        if note.pitchLabel in {"pitch-flat", "pitch-sharp"} and note.rhythmType == "rhythm-ok":
            return "pitch-first", "该音主要是落点问题，应先修音准。"
        if note.rhythmType in {"rhythm-rush", "rhythm-drag", "rhythm-duration-short", "rhythm-duration-long", "rhythm-rush-short", "rhythm-drag-long"} and note.pitchLabel in {"pitch-flat", "pitch-sharp"}:
            rhythm_magnitude = max(abs(note.onsetErrorMs), abs(note.durationErrorMs or 0))
            if rhythm_magnitude >= abs(note.centsError):
                return "rhythm-first", "该音节奏偏差更突出，先把起拍放准更有效。"
            return "pitch-first", "该音音高偏差更突出，先把落点稳定下来更有效。"
        return "review-first", "该音接近阈值，建议先复核示范与教师判断。"

    def _practice_path_for_measure(self, measure: MeasureFinding) -> tuple[str, str]:
        if measure.issueType in {"rhythm-measure-rush", "rhythm-measure-drag", "rhythm-measure-short", "rhythm-measure-long", "rhythm-unstable"}:
            return "rhythm-first", "该小节的主要问题是拍点和时值稳定性。"
        if measure.issueType == "pitch-unstable":
            return "pitch-first", "该小节的主要问题是音高落点与连续稳定性。"
        return "review-first", "该小节问题类型混合，建议先复核后再决定练习顺序。"

    def _summarize_practice_path(self, practice_targets: list[PracticeTarget], note_findings: list[NoteFinding]) -> str | None:
        if practice_targets:
            return practice_targets[0].practicePath
        if any(item.isUncertain for item in note_findings):
            return "review-first"
        return None

    def _build_explanation_layer(
        self,
        note_findings: list[NoteFinding],
        measure_findings: list[MeasureFinding],
        overall_pitch_score: int,
        overall_rhythm_score: int,
        uncertain_pitch_count: int,
    ) -> tuple[str, str, str | None, list[PracticeTarget]]:
        if not note_findings and not measure_findings:
            summary_text = "本次录音整体较稳定，当前没有定位到明显的优先修正点。"
            teacher_comment = "建议保持当前速度，再做一遍整段录音确认稳定性。"
            return summary_text, teacher_comment, None, []

        dominant_dimension = "节奏" if overall_rhythm_score < overall_pitch_score else "音准"
        summary_parts = [
            f"本次录音优先需要处理的是{dominant_dimension}问题。",
            f"系统共定位到 {len(note_findings)} 个问题音和 {len(measure_findings)} 个问题小节。",
        ]
        if uncertain_pitch_count:
            summary_parts.append(f"其中有 {uncertain_pitch_count} 个音的证据偏弱，建议结合示范和教师判断复核。")
        summary_text = "".join(summary_parts)

        teacher_comment = (
            "建议先修优先级最高的 1 到 2 个点，不要同时改整段。"
            if note_findings or measure_findings
            else "建议继续保持当前练习方式。"
        )

        practice_targets: list[PracticeTarget] = []
        priority = 1
        for note in note_findings[:3]:
            practice_path, path_reason = self._practice_path_for_note(note)
            practice_targets.append(
                PracticeTarget(
                    priority=priority,
                    targetType="note",
                    targetId=note.noteId,
                    measureIndex=note.measureIndex,
                    title=f"先处理 {note.noteId} 的落点与起拍",
                    why=note.why or "该音是当前偏差最集中的位置。",
                    action=note.action or "针对该音做局部循环练习。",
                    severity=note.severity,
                    evidenceLabel=note.evidenceLabel,
                    practicePath=practice_path,
                    pathReason=path_reason,
                )
            )
            priority += 1
        for measure in measure_findings[:2]:
            practice_path, path_reason = self._practice_path_for_measure(measure)
            practice_targets.append(
                PracticeTarget(
                    priority=priority,
                    targetType="measure",
                    targetId=f"measure-{measure.measureIndex}",
                    measureIndex=measure.measureIndex,
                    title=f"重练第 {measure.measureIndex} 小节",
                    why=measure.detail or "该小节内部偏差较集中。",
                    action=measure.coachingTip or "先拆分拍点，再回到整小节练习。",
                    severity=measure.severity,
                    evidenceLabel=measure.issueLabel,
                    practicePath=practice_path,
                    pathReason=path_reason,
                )
            )
            priority += 1

        if practice_targets:
            highest = practice_targets[0]
            teacher_comment = f"建议先按“{highest.practicePath or 'review-first'}”路径处理“{highest.title}”，完成后再回到整段复录。"

        return summary_text, teacher_comment, self._summarize_practice_path(practice_targets, note_findings), practice_targets

    def _student_display_score(self, strict_score: int, confidence: float) -> int:
        scaled = (
            float(strict_score) * float(self.settings.student_display_score_scale)
            + float(self.settings.student_display_score_bias)
            + float(confidence) * float(self.settings.student_display_score_confidence_weight)
        )
        return max(int(strict_score), min(100, int(round(scaled))))

    def _student_display_combined_score(self, pitch_score: int, rhythm_score: int, confidence: float) -> int:
        strict_combined = round((float(pitch_score) + float(rhythm_score)) / 2.0)
        return self._student_display_score(strict_combined, confidence)

    def _dtw_align_notes(
        self,
        score_notes: list[SymbolicNote],
        observed_notes: list[ObservedNote],
    ) -> dict[int, int]:
        if not score_notes or not observed_notes:
            return {}

        score_duration = max((note.expected_offset for note in score_notes), default=1.0)
        performance_duration = max((note.offset for note in observed_notes), default=1.0)
        gap_penalty = 5.0
        rows = len(score_notes)
        cols = len(observed_notes)
        dp = [[float("inf")] * (cols + 1) for _ in range(rows + 1)]
        back: list[list[tuple[int, int] | None]] = [[None] * (cols + 1) for _ in range(rows + 1)]
        dp[0][0] = 0.0

        for row in range(1, rows + 1):
            dp[row][0] = dp[row - 1][0] + gap_penalty
            back[row][0] = (row - 1, 0)
        for col in range(1, cols + 1):
            dp[0][col] = dp[0][col - 1] + gap_penalty
            back[0][col] = (0, col - 1)

        for row in range(1, rows + 1):
            for col in range(1, cols + 1):
                match_cost = self._note_match_cost(
                    score_notes[row - 1],
                    observed_notes[col - 1],
                    score_duration,
                    performance_duration,
                )
                candidates = [
                    (dp[row - 1][col - 1] + match_cost, (row - 1, col - 1)),
                    (dp[row - 1][col] + gap_penalty, (row - 1, col)),
                    (dp[row][col - 1] + gap_penalty, (row, col - 1)),
                ]
                best_cost, best_prev = min(candidates, key=lambda item: item[0])
                dp[row][col] = best_cost
                back[row][col] = best_prev

        matches: dict[int, int] = {}
        row = rows
        col = cols
        while row > 0 or col > 0:
            prev = back[row][col]
            if prev is None:
                break
            prev_row, prev_col = prev
            if prev_row == row - 1 and prev_col == col - 1 and row > 0 and col > 0:
                matches[row - 1] = col - 1
            row, col = prev_row, prev_col
        return matches

    def _align_to_score(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        pitch_track: list[dict[str, float]],
        onset_track: list[dict[str, float]],
        score_notes: list[SymbolicNote],
        section_calibration: dict[str, Any] | None = None,
        separation_meta: dict[str, Any] | None = None,
    ) -> tuple[list[dict[str, Any]], str]:
        if not score_notes:
            return [], "no-score"

        section_calibration = section_calibration or {}
        separation_meta = separation_meta or {}
        observed_notes = self._build_observed_notes(audio, pitch_track, onset_track, score_notes, section_calibration)
        if not observed_notes:
            observed_notes = self._build_observed_notes(
                audio,
                self._synthetic_pitch_track(score_notes),
                [{"time": note.expected_onset} for note in score_notes],
                score_notes,
                section_calibration,
            )

        matches = self._dtw_align_notes(score_notes, observed_notes)
        score_duration = max((note.expected_offset for note in score_notes), default=1.0)
        performance_duration = max(
            audio.duration_seconds or 0.0,
            max((note.offset for note in observed_notes), default=0.0),
            score_duration,
        )
        tempo_ratio = performance_duration / score_duration if score_duration > 0 else 1.0

        aligned_notes: list[dict[str, Any]] = []
        for index, score_note in enumerate(score_notes):
            matched_index = matches.get(index)
            observed = observed_notes[matched_index] if matched_index is not None and matched_index < len(observed_notes) else None

            estimated_frequency = observed.median_frequency if observed is not None else 0.0
            estimated_confidence = observed.confidence if observed is not None else 0.0
            estimated_onset = observed.onset if observed is not None else score_note.expected_onset * tempo_ratio
            estimated_offset = observed.offset if observed is not None else score_note.expected_offset * tempo_ratio
            stable_point_count = observed.stable_point_count if observed is not None else 0
            segment_point_count = observed.segment_point_count if observed is not None else 0
            pitch_spread_cents = observed.pitch_spread_cents if observed is not None else 0.0
            entry_cents = observed.entry_cents if observed is not None else 0.0
            exit_cents = observed.exit_cents if observed is not None else 0.0
            glide_like = observed.glide_like if observed is not None else False
            vibrato_like = observed.vibrato_like if observed is not None else False
            trill_like = observed.trill_like if observed is not None else False
            pluck_like = observed.pluck_like if observed is not None else False
            tap_like = observed.tap_like if observed is not None else False
            vibrato_center_frequency = observed.vibrato_center_frequency if observed is not None else 0.0
            vibrato_amplitude_cents = observed.vibrato_amplitude_cents if observed is not None else 0.0
            glide_run_ms = observed.glide_run_ms if observed is not None else 0.0
            trill_low_frequency = observed.trill_low_frequency if observed is not None else 0.0
            trill_high_frequency = observed.trill_high_frequency if observed is not None else 0.0
            trill_switch_count = observed.trill_switch_count if observed is not None else 0

            if observed is None and pitch_track:
                window_center = score_note.expected_onset * tempo_ratio
                window_radius = max(0.08, (score_note.expected_offset - score_note.expected_onset) * tempo_ratio * 0.35)
                segment_points = [
                    item
                    for item in pitch_track
                    if abs(float(item["time"]) - window_center) <= window_radius and float(item["frequency"]) > 0
                ]
                if segment_points:
                    estimated_frequency = float(median([float(item["frequency"]) for item in segment_points]))
                    estimated_confidence = float(median([float(item.get("confidence", 0.0)) for item in segment_points]))
                    stable_point_count = len(segment_points)
                    segment_point_count = len(segment_points)

            if vibrato_like and vibrato_center_frequency > 0.0:
                estimated_frequency = float(vibrato_center_frequency)

            if trill_like and trill_low_frequency > 0.0 and trill_high_frequency > 0.0:
                low_cents, _, low_shift = self._calibrated_cents_error(
                    trill_low_frequency,
                    score_note.midi_pitch,
                    section_calibration,
                )
                high_cents, _, high_shift = self._calibrated_cents_error(
                    trill_high_frequency,
                    score_note.midi_pitch,
                    section_calibration,
                )
                low_cost = abs(low_cents) + (0.2 * abs(low_shift))
                high_cost = abs(high_cents) + (0.2 * abs(high_shift))
                estimated_frequency = float(trill_low_frequency if low_cost <= high_cost else trill_high_frequency)

            cents_value, raw_cents_value, octave_flex_semitones = self._calibrated_cents_error(
                estimated_frequency,
                score_note.midi_pitch,
                section_calibration,
            )
            harmonic_like = (
                abs(octave_flex_semitones) >= 12
                and estimated_confidence >= 0.7
                and pitch_spread_cents <= float(self.settings.vibrato_spread_threshold_cents) + 8.0
            )
            aligned_notes.append(
                {
                    "noteId": score_note.note_id,
                    "measureIndex": score_note.measure_index,
                    "expectedMidi": score_note.midi_pitch,
                    "expectedBeatStart": score_note.beat_start,
                    "expectedOnset": score_note.expected_onset * tempo_ratio,
                    "expectedOffset": score_note.expected_offset * tempo_ratio,
                    "estimatedFrequency": estimated_frequency,
                    "estimatedConfidence": estimated_confidence,
                    "estimatedOnset": estimated_onset,
                    "estimatedOffset": estimated_offset,
                    "centsError": cents_value,
                    "rawCentsError": raw_cents_value,
                    "octaveFlexSemitones": octave_flex_semitones,
                    "onsetErrorMs": float((estimated_onset - (score_note.expected_onset * tempo_ratio)) * 1000.0),
                    "expectedDurationMs": float(((score_note.expected_offset - score_note.expected_onset) * tempo_ratio) * 1000.0),
                    "observedDurationMs": float(max(0.0, estimated_offset - estimated_onset) * 1000.0),
                    "matchedObservedIndex": matched_index if matched_index is not None else -1,
                    "stablePointCount": stable_point_count,
                    "segmentPointCount": segment_point_count,
                    "pitchSpreadCents": pitch_spread_cents,
                    "entryCents": entry_cents,
                    "exitCents": exit_cents,
                    "glideLike": glide_like,
                    "vibratoLike": vibrato_like,
                    "trillLike": trill_like,
                    "pluckLike": pluck_like,
                    "tapLike": tap_like,
                    "harmonicLike": harmonic_like,
                    "vibratoCenterFrequency": vibrato_center_frequency,
                    "vibratoAmplitudeCents": vibrato_amplitude_cents,
                    "glideRunMs": glide_run_ms,
                    "trillLowFrequency": trill_low_frequency,
                    "trillHighFrequency": trill_high_frequency,
                    "trillSwitchCount": trill_switch_count,
                    "scoreCoarse": bool(section_calibration.get("scoreCoarse")),
                    "importedScoreProfile": bool(section_calibration.get("importedScoreProfile")),
                    "denseImportedScoreProfile": bool(section_calibration.get("denseImportedScoreProfile")),
                    "sectionExtraPitchToleranceCents": float(section_calibration.get("extraPitchToleranceCents", 0.0)),
                    "sectionExtraRhythmToleranceMs": float(section_calibration.get("extraRhythmToleranceMs", 0.0)),
                    "lowSeparationExtraRhythmToleranceMs": float(
                        section_calibration.get("lowSeparationExtraRhythmToleranceMs", 0.0)
                    ),
                    "sectionExtraDurationToleranceRatio": float(
                        section_calibration.get("extraDurationToleranceRatio", 0.0)
                    ),
                    "sectionMeasureTrendToleranceMs": float(section_calibration.get("measureTrendToleranceMs", 0.0)),
                    "sectionMeasureInstabilityToleranceMs": float(
                        section_calibration.get("measureInstabilityToleranceMs", 0.0)
                    ),
                    "sectionRhythmMissingConfidenceThreshold": float(
                        section_calibration.get("rhythmMissingConfidenceThreshold", self.settings.rhythm_missing_confidence)
                    ),
                    "coarseRhythmReviewThresholdMs": float(section_calibration.get("coarseRhythmReviewThresholdMs", 0.0)),
                    "lowConfidenceRhythmReviewThresholdMs": float(
                        section_calibration.get("lowConfidenceRhythmReviewThresholdMs", 0.0)
                    ),
                    "lowSeparationThreshold": float(section_calibration.get("lowSeparationThreshold", 0.0)),
                    "lowSeparationExtraToleranceCents": float(section_calibration.get("lowSeparationExtraToleranceCents", 0.0)),
                    "coarseScoreReviewThresholdCents": float(section_calibration.get("coarseScoreReviewThresholdCents", 0.0)),
                    "isolatedPitchReviewThresholdCents": float(section_calibration.get("isolatedPitchReviewThresholdCents", 0.0)),
                    "sectionSeparationConfidence": float(separation_meta.get("separationConfidence", 1.0)),
                }
            )

        for note in aligned_notes:
            tolerance = self._pitch_tolerance_for_note(note)
            note["pitchToleranceCents"] = tolerance
            note["pitchUncertain"] = self._is_pitch_uncertain(note)
            pitch_excess_cents, raw_pitch_excess_cents, pitch_relief_cents = self._pitch_excess_for_note(note, tolerance)
            note["pitchRawExcessCents"] = raw_pitch_excess_cents
            note["pitchTechniqueReliefCents"] = pitch_relief_cents
            if self._should_review_expressive_pitch(note, tolerance, raw_pitch_excess_cents, pitch_relief_cents):
                note["pitchUncertain"] = True
            note["pitchExcessCents"] = 0.0 if bool(note["pitchUncertain"]) else pitch_excess_cents
            note["durationErrorMs"] = float(note.get("observedDurationMs", 0.0)) - float(note.get("expectedDurationMs", 0.0))
            note["rhythmReview"] = self._should_review_coarse_rhythm(note)
            note["rhythmScoringOnsetErrorMs"] = 0.0 if bool(note["rhythmReview"]) else float(note.get("onsetErrorMs", 0.0))
            note["rhythmScoringDurationErrorMs"] = 0.0 if bool(note["rhythmReview"]) else float(note.get("durationErrorMs", 0.0))
            note["rhythmExcessMs"] = max(
                0.0,
                abs(self._note_scoring_onset_error_ms(note)) - self._onset_tolerance_ms(note),
                abs(self._note_scoring_duration_error_ms(note)) - self._duration_tolerance_ms(note),
            )
            rhythm_type, rhythm_label = self._classify_note_rhythm(note)
            note["rhythmType"] = rhythm_type
            note["rhythmLabel"] = rhythm_label

        return aligned_notes, "score-dtw"

    def _build_feedback(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        score_notes: list[SymbolicNote],
        aligned_notes: list[dict[str, Any]],
        pitch_track: list[dict[str, float]],
        onset_track: list[dict[str, float]],
        beat_track: list[dict[str, float]],
        pitch_source: str,
        onset_source: str,
        beat_source: str,
        score_source: str,
        alignment_mode: str,
        preprocess_mode: str,
        preprocess_applied: bool,
        applied_preprocess_mode: str,
        section_calibration: dict[str, Any],
        separation_meta: dict[str, Any],
    ) -> AnalyzeResult:
        measure_findings: list[MeasureFinding] = []
        note_findings: list[NoteFinding] = []
        if not aligned_notes:
            return AnalyzeResult(
                overallPitchScore=0,
                overallRhythmScore=0,
                measureFindings=[],
                noteFindings=[],
                demoSegments=[],
                confidence=0.0,
                analysisMode="external",
                diagnostics={
                    "dependencyReport": self.dependency_report(),
                    "decodeMethod": audio.decode_method,
                    "ffmpegPath": audio.ffmpeg_path,
                    "scoreSource": score_source,
                    "pitchSource": pitch_source,
                    "onsetSource": onset_source,
                    "beatSource": beat_source,
                    "alignmentMode": alignment_mode,
                    "requestedPreprocessMode": preprocess_mode,
                    "preprocessApplied": preprocess_applied,
                    "appliedPreprocessMode": applied_preprocess_mode,
                    **separation_meta,
                    "beatCount": len(beat_track),
                },
            )

        pitch_issue_count = 0
        rhythm_issue_count = 0
        uncertain_pitch_count = 0
        glide_like_count = 0
        vibrato_like_count = 0
        trill_like_count = 0
        pluck_like_count = 0
        tap_like_count = 0
        harmonic_like_count = 0
        technique_relief_count = 0
        octave_flex_count = 0
        rhythm_type_counts: dict[str, int] = {}
        flagged_notes: list[dict[str, Any]] = []

        for note in aligned_notes:
            pitch_uncertain = bool(note.get("pitchUncertain"))
            pitch_issue = not pitch_uncertain and float(note.get("pitchExcessCents", 0.0)) > 0.0
            rhythm_issue = float(note.get("rhythmExcessMs", 0.0)) > 0.0
            note["pitchIssue"] = pitch_issue
            note["rhythmIssue"] = rhythm_issue

            if pitch_uncertain:
                uncertain_pitch_count += 1
            if bool(note.get("glideLike")):
                glide_like_count += 1
            if bool(note.get("vibratoLike")):
                vibrato_like_count += 1
            if bool(note.get("trillLike")):
                trill_like_count += 1
            if bool(note.get("pluckLike")):
                pluck_like_count += 1
            if bool(note.get("tapLike")):
                tap_like_count += 1
            if bool(note.get("harmonicLike")):
                harmonic_like_count += 1
            if float(note.get("pitchTechniqueReliefCents", 0.0)) > 0.0:
                technique_relief_count += 1
            if abs(int(note.get("octaveFlexSemitones", 0))) >= 12:
                octave_flex_count += 1
            if pitch_issue:
                pitch_issue_count += 1
            if rhythm_issue:
                rhythm_issue_count += 1
            rhythm_type = str(note.get("rhythmType", "rhythm-ok"))
            rhythm_type_counts[rhythm_type] = rhythm_type_counts.get(rhythm_type, 0) + 1
            if pitch_issue or rhythm_issue:
                flagged_notes.append(note)

        for note in flagged_notes[: self.settings.fallback_issue_limit]:
            tolerance = float(note.get("pitchToleranceCents", self.settings.base_pitch_tolerance_cents))
            excess_value = max(float(note.get("pitchExcessCents", 0.0)), float(note.get("rhythmExcessMs", 0.0)) / 2.0)
            severity = severity_label(excess_value, 10.0, 22.0)
            pitch_issue_flag = bool(note.get("pitchIssue"))
            pitch_label = (
                "pitch-review"
                if bool(note.get("pitchUncertain"))
                else "pitch-flat"
                if pitch_issue_flag and float(note["centsError"]) < 0
                else "pitch-sharp"
                if pitch_issue_flag and float(note["centsError"]) > 0
                else "pitch-ok"
            )
            rhythm_type = str(note.get("rhythmType", "rhythm-ok"))
            rhythm_label = str(note.get("rhythmLabel", self._rhythm_type_label(rhythm_type)))
            evidence_parts = []
            if bool(note.get("glideLike")):
                evidence_parts.append("glide-tolerant")
            if bool(note.get("vibratoLike")):
                evidence_parts.append("vibrato-tolerant")
            if bool(note.get("trillLike")):
                evidence_parts.append("trill-split")
            if bool(note.get("pluckLike")):
                evidence_parts.append("attack-transient")
            if bool(note.get("harmonicLike")):
                evidence_parts.append("harmonic-review")
            if bool(note.get("pitchUncertain")):
                evidence_parts.append("low-confidence")
            if float(note.get("pitchTechniqueReliefCents", 0.0)) >= 1.0:
                evidence_parts.append("technique-relief")
            if abs(int(note.get("octaveFlexSemitones", 0))) >= 12:
                evidence_parts.append("octave-flex")
            if bool(note.get("scoreCoarse")) and (
                abs(int(note.get("octaveFlexSemitones", 0))) >= 12
                or float(note.get("sectionSeparationConfidence", 1.0)) < float(note.get("lowSeparationThreshold", 0.0))
            ):
                evidence_parts.append("coarse-score-calibrated")
            if bool(note.get("rhythmReview")):
                evidence_parts.append("coarse-rhythm-review")
            if not evidence_parts:
                evidence_parts.append("stable-segment")
            why_text = self._build_note_reason(note, pitch_label, rhythm_type)
            action_text = self._build_note_action(pitch_label, rhythm_type, note)
            note_findings.append(
                NoteFinding(
                    noteId=note["noteId"],
                    measureIndex=int(note["measureIndex"]),
                    expectedMidi=int(note["expectedMidi"]),
                    centsError=int(round(float(note["centsError"]))),
                    rawCentsError=int(round(float(note.get("rawCentsError", note["centsError"])))),
                    octaveFlexSemitones=int(note.get("octaveFlexSemitones", 0)),
                    onsetErrorMs=int(round(float(note["onsetErrorMs"]))),
                    pitchLabel=pitch_label,
                    rhythmLabel=rhythm_label,
                    rhythmType=rhythm_type,
                    rhythmTypeLabel=rhythm_label,
                    expectedDurationMs=int(round(float(note.get("expectedDurationMs", 0.0)))),
                    observedDurationMs=int(round(float(note.get("observedDurationMs", 0.0)))),
                    durationErrorMs=int(round(float(note.get("durationErrorMs", 0.0)))),
                    pitchToleranceCents=int(round(tolerance)),
                    confidence=round(float(note.get("estimatedConfidence", 0.0)), 3),
                    isUncertain=bool(note.get("pitchUncertain")),
                    evidenceLabel=", ".join(evidence_parts),
                    severity=severity,
                    why=why_text,
                    action=action_text,
                )
            )

        measure_groups: dict[int, list[dict[str, Any]]] = {}
        for note in aligned_notes:
            measure_groups.setdefault(int(note["measureIndex"]), []).append(note)

        for measure_index, notes in sorted(measure_groups.items()):
            pitch_errors = [float(item.get("pitchExcessCents", 0.0)) for item in notes if not bool(item.get("pitchUncertain"))]
            onset_errors = [float(item.get("rhythmExcessMs", 0.0)) for item in notes]
            duration_errors = [self._note_scoring_duration_error_ms(item) for item in notes]
            pitch_median = median(pitch_errors or [0.0])
            onset_median = median(onset_errors or [0.0])
            duration_median = median(duration_errors or [0.0])
            uncertain_count = sum(1 for item in notes if bool(item.get("pitchUncertain")))
            measure_trend_threshold = self._measure_trend_tolerance_ms(notes)
            if (
                pitch_median < 4
                and onset_median < 8
                and abs(duration_median) < measure_trend_threshold
            ):
                continue
            issue_type, issue_label = self._classify_measure_issue(notes, pitch_median, onset_median)
            detail = (
                f"excess pitch={int(round(pitch_median))} cents, "
                f"excess onset={int(round(onset_median))}ms, "
                f"duration drift={int(round(duration_median))}ms, "
                f"uncertainNotes={uncertain_count}"
            )
            measure_findings.append(
                MeasureFinding(
                    measureIndex=measure_index,
                    issueType=issue_type,
                    issueLabel=issue_label,
                    detail=detail,
                    rhythmType=issue_type if issue_type.startswith("rhythm-") else None,
                    severity=severity_label(max(pitch_median, onset_median / 2.0, abs(duration_median) / 2.0), 8.0, 18.0),
                    coachingTip=self._build_measure_coaching(issue_type),
                )
            )

        pitch_excess_values = [float(note.get("pitchExcessCents", 0.0)) for note in aligned_notes if not bool(note.get("pitchUncertain"))]
        rhythm_excess_values = [float(note.get("rhythmExcessMs", 0.0)) for note in aligned_notes]
        pitch_issue_weight = float(self.settings.pitch_penalty_issue_weight) * float(section_calibration.get("pitchIssuePenaltyScale", 1.0))
        pitch_uncertain_weight = float(self.settings.pitch_penalty_uncertain_weight) * float(section_calibration.get("uncertainPenaltyScale", 1.0))
        rhythm_issue_weight = float(self.settings.rhythm_penalty_issue_weight) * float(section_calibration.get("rhythmIssuePenaltyScale", 1.0))
        measure_penalty_weight = float(self.settings.rhythm_penalty_measure_weight) * float(section_calibration.get("measureFindingPenaltyScale", 1.0))

        pitch_penalty = min(
            50.0,
            median(pitch_excess_values or [0.0]) * float(self.settings.pitch_penalty_median_weight)
            + pitch_issue_count * pitch_issue_weight
            + uncertain_pitch_count * pitch_uncertain_weight,
        )
        rhythm_penalty = min(
            50.0,
            median(rhythm_excess_values or [0.0]) * float(self.settings.rhythm_penalty_median_weight)
            + rhythm_issue_count * rhythm_issue_weight
            + len(measure_findings) * measure_penalty_weight,
        )
        overall_pitch_score = max(40, min(98, round(96 - pitch_penalty)))
        overall_rhythm_score = max(40, min(98, round(94 - rhythm_penalty)))

        confidence_values = [float(note["estimatedConfidence"]) for note in aligned_notes if float(note["estimatedConfidence"]) > 0]
        confidence = median(confidence_values) if confidence_values else self.settings.min_confidence
        confidence = max(0.45, min(0.95, float(confidence)))
        student_pitch_score = self._student_display_score(overall_pitch_score, confidence)
        student_rhythm_score = self._student_display_score(overall_rhythm_score, confidence)
        student_combined_score = self._student_display_combined_score(student_pitch_score, student_rhythm_score, confidence)
        summary_text, teacher_comment, recommended_practice_path, practice_targets = self._build_explanation_layer(
            note_findings,
            measure_findings,
            overall_pitch_score,
            overall_rhythm_score,
            uncertain_pitch_count,
        )
        if not recommended_practice_path and uncertain_pitch_count and not note_findings and not measure_findings:
            recommended_practice_path = "review-first"
            summary_text = "本次录音没有定位到需要立刻修正的硬性错音，但当前段落存在较多需复核的音高证据。建议先听示范并复录一次，再决定是否调整手型或把位。"
            teacher_comment = "建议先按“review-first”路径处理：先复核示范、分离后音轨和当前录音，再决定是否进入细练。"
            practice_targets = [
                PracticeTarget(
                    priority=1,
                    targetType="review",
                    targetId="review-pass",
                    measureIndex=None,
                    title="先复核当前段落",
                    why=f"当前共有 {uncertain_pitch_count} 个音被标记为需复核，硬性错音证据不足。",
                    action="先试听二胡增强轨和示范音，再完整复录一次，确认问题是否稳定出现。",
                    severity="medium",
                    evidenceLabel="review-first",
                    practicePath="review-first",
                    pathReason="当前段落以复核证据为主，暂不建议直接按错音处理。",
                )
            ]

        demo_segments = [
            DemoSegment(
                measureIndex=item.measureIndex,
                demoAudio=request.piecePack.demoAudio,
                label=f"reference-demo-measure-{item.measureIndex}",
            )
            for item in measure_findings[:3]
        ]

        return AnalyzeResult(
            overallPitchScore=overall_pitch_score,
            overallRhythmScore=overall_rhythm_score,
            studentPitchScore=student_pitch_score,
            studentRhythmScore=student_rhythm_score,
            studentCombinedScore=student_combined_score,
            separationApplied=bool(separation_meta.get("separationApplied", preprocess_applied)),
            separationMode=str(separation_meta.get("separationMode", applied_preprocess_mode or preprocess_mode or "off")),
            separationConfidence=float(separation_meta.get("separationConfidence", 0.0)),
            rawAudioPath=separation_meta.get("rawAudioPath"),
            erhuEnhancedAudioPath=separation_meta.get("erhuEnhancedAudioPath"),
            accompanimentResidualPath=separation_meta.get("accompanimentResidualPath"),
            measureFindings=measure_findings,
            noteFindings=note_findings,
            demoSegments=demo_segments,
            confidence=round(confidence, 3),
            summaryText=summary_text,
            teacherComment=teacher_comment,
            recommendedPracticePath=recommended_practice_path,
            practiceTargets=practice_targets,
            analysisMode="external",
            diagnostics={
                "dependencyReport": self.dependency_report(),
                "decodeMethod": audio.decode_method,
                "ffmpegPath": audio.ffmpeg_path,
                "durationSeconds": audio.duration_seconds,
                "sampleRate": audio.sample_rate,
                "scoreSource": score_source,
                "scoreNoteCount": len(score_notes),
                "pitchSource": pitch_source,
                "onsetSource": onset_source,
                "beatSource": beat_source,
                "alignmentMode": alignment_mode,
                "requestedPreprocessMode": preprocess_mode,
                "preprocessApplied": preprocess_applied,
                "appliedPreprocessMode": applied_preprocess_mode,
                **separation_meta,
                "pitchTrackCount": len(pitch_track),
                "onsetCount": len(onset_track),
                "beatCount": len(beat_track),
                "alignedNoteCount": len(aligned_notes),
                "pitchIssueCount": pitch_issue_count,
                "rhythmIssueCount": rhythm_issue_count,
                "rhythmTypeCounts": rhythm_type_counts,
                "uncertainPitchCount": uncertain_pitch_count,
                "glideLikeCount": glide_like_count,
                "vibratoLikeCount": vibrato_like_count,
                "trillLikeCount": trill_like_count,
                "pluckLikeCount": pluck_like_count,
                "tapLikeCount": tap_like_count,
                "harmonicLikeCount": harmonic_like_count,
                "techniqueReliefCount": technique_relief_count,
                "octaveFlexCount": octave_flex_count,
                "scoreCalibration": {
                    "pitchMedianWeight": float(self.settings.pitch_penalty_median_weight),
                    "pitchIssueWeight": pitch_issue_weight,
                    "pitchUncertainWeight": pitch_uncertain_weight,
                    "rhythmMedianWeight": float(self.settings.rhythm_penalty_median_weight),
                    "rhythmIssueWeight": rhythm_issue_weight,
                    "rhythmMeasureWeight": measure_penalty_weight,
                },
                "studentScores": {
                    "pitch": student_pitch_score,
                    "rhythm": student_rhythm_score,
                    "combined": student_combined_score,
                },
            },
        )
