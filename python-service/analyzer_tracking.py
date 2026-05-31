# -*- coding: utf-8 -*-
from __future__ import annotations

from analyzer_common import *


class TrackingMixin:
    def _estimate_pitch_track(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        score_notes: list[SymbolicNote],
    ) -> tuple[list[dict[str, float]], str]:
        cached_track, cached_source = self._read_cached_feature(audio, "pitch")
        if cached_track is not None and cached_source:
            return cached_track, cached_source
        reused = estimate_window_feature_from_full_audio(self, request, audio, "pitch")
        if reused is not None:
            return reused
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
                pitch_hop_ms = max(1.0, safe_float(getattr(audio, "pitch_hop_ms", None), self.settings.pitch_hop_ms))
                hop_length = max(1, int(audio.sample_rate * (pitch_hop_ms / 1000.0)))
                pitch, periodicity = torchcrepe.predict(
                    tensor,
                    audio.sample_rate,
                    hop_length=hop_length,
                    fmin=float(self.settings.crepe_fmin),
                    fmax=float(self.settings.crepe_fmax),
                    batch_size=256,
                    device=self._torchcrepe_device(),
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
                    source = "torchcrepe" if abs(pitch_hop_ms - float(self.settings.pitch_hop_ms)) < 0.001 else f"torchcrepe-hop-{int(round(pitch_hop_ms))}ms"
                    self._write_cached_feature(audio, "pitch", track, source)
                    return track, source
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
        reused = estimate_window_feature_from_full_audio(self, None, audio, "onset")
        if reused is not None:
            return reused
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
                processors = self._get_madmom_onset_processors()
                if processors is None:
                    raise RuntimeError("madmom onset processors unavailable")
                onset_processor, peak_picker = processors
                with self._madmom_processor_lock:
                    activations = onset_processor(str(wav_path))
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
        reused = estimate_window_feature_from_full_audio(self, None, audio, "beat")
        if reused is not None:
            return reused
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
                processors = self._get_madmom_beat_processors()
                if processors is None:
                    raise RuntimeError("madmom beat processors unavailable")
                beat_processor, tracker = processors
                with self._madmom_processor_lock:
                    activations = beat_processor(str(wav_path))
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
