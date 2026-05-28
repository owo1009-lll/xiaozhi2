# -*- coding: utf-8 -*-
from __future__ import annotations

import threading

from config import Settings
from schemas import AnalyzeRequest, AnalyzeResult
from analyzer_audio import DecodedAudioCacheItem
from analyzer_models import SymbolicNote
from analyzer_utils import midi_to_frequency
from analyzer_runtime import RuntimeMixin
from analyzer_omr import OmrMixin
from analyzer_symbolic import SymbolicScoreMixin
from analyzer_score_import import ScoreImportMixin
from analyzer_ranking import RankingMixin
from analyzer_calibration import CalibrationMixin
from analyzer_separation import SeparationMixin
from analyzer_tracking import TrackingMixin
from analyzer_scoring import ScoringMixin


class ErhuAnalyzer(
    RuntimeMixin,
    OmrMixin,
    SymbolicScoreMixin,
    ScoreImportMixin,
    RankingMixin,
    CalibrationMixin,
    SeparationMixin,
    TrackingMixin,
    ScoringMixin,
):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._configure_cpu_threads()
        self._decoded_audio_cache: dict[str, DecodedAudioCacheItem] = {}
        self._decoded_audio_cache_lock = threading.Lock()
        self._feature_cache: dict[str, tuple[list[dict[str, float]], str]] = {}
        self._feature_cache_lock = threading.Lock()
        self._madmom_processor_lock = threading.Lock()
        self._madmom_onset_processor = None
        self._madmom_peak_picker = None
        self._madmom_beat_processor = None
        self._madmom_beat_tracker = None

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
            persist_outputs=bool(getattr(request, "persistAudioVariants", True)),
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
