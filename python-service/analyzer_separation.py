# -*- coding: utf-8 -*-
from __future__ import annotations

from analyzer_common import *


class SeparationMixin:
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
            separationEnergyRatio=safe_float(separation_meta.get("separationEnergyRatio"), None),
            separationScoreBandRatio=safe_float(separation_meta.get("separationScoreBandRatio"), None),
            separationConfidentPitchCount=int(safe_float(separation_meta.get("separationConfidentPitchCount"), 0)),
            separationScoreBandHitCount=int(safe_float(separation_meta.get("separationScoreBandHitCount"), 0)),
            inputAudioPath=separation_meta.get("rawAudioPath"),
            erhuEnhancedAudioPath=separation_meta.get("erhuEnhancedAudioPath"),
            accompanimentResidualPath=separation_meta.get("accompanimentResidualPath"),
            warnings=list(separation_meta.get("warnings", [])),
        )


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
        if preprocess_mode == "auto":
            clean_solo_quality = self._clean_solo_pitch_quality(request, score_notes, pitch_track)
            if self._should_skip_auto_separation_for_clean_solo(request, clean_solo_quality):
                separation_meta.update(
                    {
                        "separationConfidence": round(
                            safe_float(clean_solo_quality.get("cleanSoloScoreBandRatio"), 0.0),
                            3,
                        ),
                        "separationScoreBandRatio": round(
                            safe_float(clean_solo_quality.get("cleanSoloScoreBandRatio"), 0.0),
                            3,
                        ),
                        "separationConfidentPitchCount": int(
                            safe_float(clean_solo_quality.get("cleanSoloConfidentPitchCount"), 0)
                        ),
                        "separationScoreBandHitCount": int(
                            safe_float(clean_solo_quality.get("cleanSoloScoreBandHitCount"), 0)
                        ),
                    }
                )
                separation_meta["warnings"].append("auto-separation-clean-solo-skipped")
                return audio, False, "off", separation_meta

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
            separation_quality = self._measure_separation_quality(
                score_notes,
                pitch_track,
                base_waveform,
                enhanced_waveform,
            )
            separation_confidence = float(separation_quality.get("separationConfidence", 0.0))
            self._write_cached_preprocessed_audio(
                request,
                audio,
                preprocess_mode,
                score_notes,
                section_calibration,
                enhanced_waveform,
                residual_waveform,
                separation_confidence,
                separation_quality,
            )
            separation_meta["warnings"].append(
                f"preprocessed-audio-cache:{cached_preprocessed_audio.get('scope', 'unknown')}"
            )
        else:
            enhanced_waveform = self._apply_melody_focus_mask(audio, score_notes, pitch_track, section_calibration)
            if enhanced_waveform is None:
                separation_meta["warnings"].append("二胡增强分离未生成有效波形，已回退原音分析。")
                return audio, False, "off", separation_meta
            residual_waveform = np.asarray(base_waveform - enhanced_waveform, dtype=np.float32)
            separation_quality = self._measure_separation_quality(
                score_notes,
                pitch_track,
                base_waveform,
                enhanced_waveform,
            )
            separation_confidence = float(separation_quality.get("separationConfidence", 0.0))
            self._write_cached_preprocessed_audio(
                request,
                audio,
                preprocess_mode,
                score_notes,
                section_calibration,
                enhanced_waveform,
                residual_waveform,
                separation_confidence,
                separation_quality,
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
                "separationEnergyRatio": round(safe_float(separation_quality.get("separationEnergyRatio"), 0.0), 3),
                "separationScoreBandRatio": round(safe_float(separation_quality.get("separationScoreBandRatio"), 0.0), 3),
                "separationConfidentPitchCount": int(safe_float(separation_quality.get("separationConfidentPitchCount"), 0)),
                "separationScoreBandHitCount": int(safe_float(separation_quality.get("separationScoreBandHitCount"), 0)),
                "rawAudioPath": media_paths.get("rawAudioPath"),
                "erhuEnhancedAudioPath": media_paths.get("erhuEnhancedAudioPath"),
                "accompanimentResidualPath": media_paths.get("accompanimentResidualPath"),
            }
        )
        if preprocess_mode == "auto" and separation_confidence < float(self.settings.separation_auto_confidence_threshold):
            separation_meta["warnings"].append("自动判断分离置信度偏低，已回退到原音频分析。")
            separation_meta["separationApplied"] = False
            separation_meta["separationMode"] = "off"
            return audio, False, "off", separation_meta
        if preprocess_mode == "auto" and self._should_reject_auto_separation_for_score_band(separation_quality):
            separation_meta["warnings"].append("自动判断分离音高与谱面音域匹配度偏低，已回退到原音频分析。")
            separation_meta["separationApplied"] = False
            separation_meta["separationMode"] = "off"
            return audio, False, "off", separation_meta

        if preprocess_mode == "auto" and self._should_reject_borderline_auto_separation(separation_quality):
            separation_meta["warnings"].append("auto-separation-borderline-score-band-rejected")
            separation_meta["separationApplied"] = False
            separation_meta["separationMode"] = "off"
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
            pitch_hop_ms=audio.pitch_hop_ms,
        )
        separation_meta["separationApplied"] = True
        return processed_audio, True, "erhu-focus", separation_meta


    def _should_reject_auto_separation_for_score_band(self, separation_quality: dict[str, Any]) -> bool:
        min_score_band_ratio = max(0.0, min(1.0, float(self.settings.separation_auto_min_score_band_ratio)))
        if min_score_band_ratio <= 0.0:
            return False
        min_points = max(0, int(self.settings.separation_auto_min_score_band_points))
        confident_points = int(safe_float(separation_quality.get("separationConfidentPitchCount"), 0))
        if confident_points < min_points:
            return False
        score_band_ratio = max(0.0, min(1.0, safe_float(separation_quality.get("separationScoreBandRatio"), 0.0)))
        return score_band_ratio < min_score_band_ratio


    def _should_reject_borderline_auto_separation(self, separation_quality: dict[str, Any]) -> bool:
        confidence_threshold = max(0.0, min(1.0, float(self.settings.separation_auto_borderline_confidence_threshold)))
        score_band_threshold = max(0.0, min(1.0, float(self.settings.separation_auto_borderline_min_score_band_ratio)))
        if confidence_threshold <= 0.0 or score_band_threshold <= 0.0:
            return False
        confidence = max(0.0, min(1.0, safe_float(separation_quality.get("separationConfidence"), 0.0)))
        if confidence >= confidence_threshold:
            return False
        min_points = max(0, int(self.settings.separation_auto_min_score_band_points))
        confident_points = int(safe_float(separation_quality.get("separationConfidentPitchCount"), 0))
        if confident_points < min_points:
            return False
        score_band_ratio = max(0.0, min(1.0, safe_float(separation_quality.get("separationScoreBandRatio"), 0.0)))
        return score_band_ratio < score_band_threshold


    def _clean_solo_pitch_quality(
        self,
        request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest,
        score_notes: list[SymbolicNote],
        pitch_track: list[dict[str, float]],
    ) -> dict[str, Any]:
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
        return {
            "cleanSoloScoreBandRatio": max(0.0, min(1.0, band_ratio)),
            "cleanSoloConfidentPitchCount": int(confident_points),
            "cleanSoloScoreBandHitCount": int(score_band_hits),
            "explicitSoloScore": self._has_explicit_solo_score_context(request),
        }


    def _has_explicit_solo_score_context(self, request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest) -> bool:
        piece_pack = getattr(request, "piecePack", None)
        if piece_pack is None and isinstance(getattr(request, "piecePacks", None), list):
            packs = [item for item in getattr(request, "piecePacks", []) if item is not None]
            if len(packs) != 1:
                return False
            piece_pack = packs[0]
        if piece_pack is None:
            return False

        score_line_stats = getattr(piece_pack, "scoreLineStats", None) or {}
        if isinstance(score_line_stats, dict) and score_line_stats:
            if safe_float(score_line_stats.get("accompanimentNoteCount"), 0.0) > 0:
                return False
            if bool(score_line_stats.get("splitApplied")):
                return False
            if safe_float(score_line_stats.get("erhuNoteCount"), 0.0) > 0:
                return True

        part_candidates = getattr(piece_pack, "partCandidates", None) or []
        if not isinstance(part_candidates, list) or not part_candidates:
            return False

        safe_candidates = 0
        for candidate in part_candidates:
            if not isinstance(candidate, dict):
                continue
            label = " ".join(
                str(candidate.get(key) or "")
                for key in ("name", "label", "qualifiedLabel", "selectionKey", "id")
            ).lower()
            if (
                bool(candidate.get("isLikelyPiano"))
                or bool(candidate.get("isLikelyAccompanimentSplit"))
                or "piano" in label
                or "pno" in label
                or "accompaniment" in label
                or "钢琴" in label
                or "鋼琴" in label
                or "伴奏" in label
                or safe_float(candidate.get("staffCount"), 1.0) >= 2
                or safe_float(candidate.get("chordRatio"), 0.0) >= 0.18
            ):
                return False
            if (
                safe_float(candidate.get("staffCount"), 1.0) <= 1
                and safe_float(candidate.get("chordRatio"), 0.0) < 0.12
                and safe_float(candidate.get("erhuRangeRatio"), 1.0) >= 0.72
            ):
                safe_candidates += 1
        return safe_candidates > 0


    def _should_skip_auto_separation_for_clean_solo(
        self,
        request: AnalyzeRequest | SeparateErhuRequest | RankSectionsRequest,
        clean_solo_quality: dict[str, Any],
    ) -> bool:
        if not bool(clean_solo_quality.get("explicitSoloScore")):
            return False
        min_points = max(0, int(self.settings.separation_auto_min_score_band_points))
        confident_points = int(safe_float(clean_solo_quality.get("cleanSoloConfidentPitchCount"), 0))
        if confident_points < min_points:
            return False
        threshold = max(
            0.0,
            min(1.0, float(self.settings.separation_auto_clean_solo_min_score_band_ratio)),
        )
        score_band_ratio = max(
            0.0,
            min(1.0, safe_float(clean_solo_quality.get("cleanSoloScoreBandRatio"), 0.0)),
        )
        return score_band_ratio >= threshold


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


    def _measure_separation_quality(
        self,
        score_notes: list[SymbolicNote],
        pitch_track: list[dict[str, float]],
        base_waveform: Any,
        enhanced_waveform: Any,
    ) -> dict[str, Any]:
        if np is None:
            return {
                "separationConfidence": 0.0,
                "separationEnergyRatio": 0.0,
                "separationScoreBandRatio": 0.0,
                "separationConfidentPitchCount": 0,
                "separationScoreBandHitCount": 0,
            }
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
        return {
            "separationConfidence": max(0.0, min(0.98, confidence)),
            "separationEnergyRatio": max(0.0, min(1.0, energy_ratio)),
            "separationScoreBandRatio": max(0.0, min(1.0, band_ratio)),
            "separationConfidentPitchCount": int(confident_points),
            "separationScoreBandHitCount": int(score_band_hits),
        }


    def _estimate_separation_confidence(
        self,
        score_notes: list[SymbolicNote],
        pitch_track: list[dict[str, float]],
        base_waveform: Any,
        enhanced_waveform: Any,
    ) -> float:
        return float(
            self._measure_separation_quality(
                score_notes,
                pitch_track,
                base_waveform,
                enhanced_waveform,
            ).get("separationConfidence", 0.0)
        )


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
