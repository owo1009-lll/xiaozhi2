from __future__ import annotations

import math
import re
from statistics import median
from typing import Any

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


def optional_float(value: Any) -> float | None:
    try:
        numeric = float(value)
        return numeric if math.isfinite(numeric) else None
    except Exception:
        return None


def optional_ratio(value: Any) -> float | None:
    numeric = optional_float(value)
    return max(0.0, min(1.0, numeric)) if numeric is not None else None


def optional_count(value: Any) -> int | None:
    numeric = optional_float(value)
    return max(0, int(round(numeric))) if numeric is not None else None


def analysis_separation_result_fields(
    separation_meta: dict[str, Any] | None,
    preprocess_applied: bool = False,
    applied_preprocess_mode: str = "off",
) -> dict[str, Any]:
    meta = separation_meta or {}
    return {
        "separationApplied": bool(meta.get("separationApplied", preprocess_applied)),
        "separationMode": str(meta.get("separationMode", applied_preprocess_mode or "off")),
        "separationConfidence": optional_ratio(meta.get("separationConfidence")) or 0.0,
        "separationEnergyRatio": optional_ratio(meta.get("separationEnergyRatio")),
        "separationScoreBandRatio": optional_ratio(meta.get("separationScoreBandRatio")),
        "separationConfidentPitchCount": optional_count(meta.get("separationConfidentPitchCount")),
        "separationScoreBandHitCount": optional_count(meta.get("separationScoreBandHitCount")),
        "rawAudioPath": meta.get("rawAudioPath"),
        "erhuEnhancedAudioPath": meta.get("erhuEnhancedAudioPath"),
        "accompanimentResidualPath": meta.get("accompanimentResidualPath"),
    }


def parse_musicxml_measure_index(value: Any, fallback: int) -> int:
    text = str(value or "").strip()
    fallback_index = int(safe_float(fallback, 1))
    if not text:
        return fallback_index
    try:
        return int(text)
    except Exception:
        pass
    match = re.search(r"-?\d+", text)
    if match:
        return int(match.group(0))
    return fallback_index


def normalize_musicxml_measure_indices(values: list[Any]) -> list[int]:
    """Use document order when MusicXML measure labels repeat or go backwards."""
    parsed = [parse_musicxml_measure_index(value, index) for index, value in enumerate(values, start=1)]
    if len(set(parsed)) != len(parsed) or any(current <= previous for previous, current in zip(parsed, parsed[1:])):
        return list(range(1, len(parsed) + 1))
    return parsed


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
