# -*- coding: utf-8 -*-
from __future__ import annotations

from analyzer_common import *


class RankingMixin:
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
                    device=self._torchcrepe_device(),
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
            **analysis_separation_result_fields(
                separation_meta,
                preprocess_applied,
                applied_preprocess_mode or preprocess_mode or "off",
            ),
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
