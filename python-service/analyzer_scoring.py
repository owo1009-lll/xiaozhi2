# -*- coding: utf-8 -*-
from __future__ import annotations

from analyzer_common import *


class ScoringMixin:
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
            if imported_score_profile and raw_cents_value >= 1200.0:
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
        if bool(note.get("importedScoreProfile")) and max_raw_error >= 2400.0:
            return True
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
            return "先单独确认这一拍是否真正演奏到位，再结合示范回放复核。"
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
        return "review-first", "该音接近阈值，建议先复核示范回放与当前录音。"


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
            summary_parts.append(f"其中有 {uncertain_pitch_count} 个音的证据偏弱，建议结合示范回放复核。")
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
                    "expectedBeatDuration": score_note.beat_duration,
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
                **analysis_separation_result_fields(
                    separation_meta,
                    preprocess_applied,
                    applied_preprocess_mode or preprocess_mode or "off",
                ),
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
                    beatStart=round(float(note.get("expectedBeatStart", note.get("beatStart", 0.0))), 4),
                    beatDuration=round(float(note.get("expectedBeatDuration", note.get("beatDuration", 0.0))), 4),
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
            **analysis_separation_result_fields(
                separation_meta,
                preprocess_applied,
                applied_preprocess_mode or preprocess_mode or "off",
            ),
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
