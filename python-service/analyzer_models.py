# -*- coding: utf-8 -*-
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


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
    articulations: list[str] | None = None
    notations: list[str] | None = None
    techniques: list[str] | None = None
    active_tempo: int | None = None
    active_dynamic: str | None = None
    dynamic_value: float | None = None


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
