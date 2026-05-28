# -*- coding: utf-8 -*-
from __future__ import annotations

from analyzer_common import *


class RuntimeMixin:
    def _configure_cpu_threads(self) -> None:
        if torch is None or self._torchcrepe_device() != "cpu":
            return
        limit = max(1, int(getattr(self.settings, "cpu_thread_limit", 1) or 1))
        try:
            torch.set_num_threads(limit)
        except Exception:
            pass


    def dependency_report(self) -> dict[str, bool]:
        report = {
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
            "homr": bool(self.settings.homr_cli and os.path.exists(self.settings.homr_cli)),
        }
        if torch is not None:
            report["torchCuda"] = bool(torch.cuda.is_available())
            report["torchCudaEnabled"] = self._torchcrepe_device() == "cuda"
        return report


    def _torchcrepe_device(self) -> str:
        requested_device = (self.settings.torch_device or "cpu").strip().lower()
        if requested_device == "cuda" and torch is not None and torch.cuda.is_available():
            return "cuda"
        if requested_device == "auto" and torch is not None and torch.cuda.is_available():
            return "cuda"
        return "cpu"


    def runtime_report(self) -> dict[str, Any]:
        torch_version = ""
        cuda_version = ""
        torch_device = "none"
        cuda_device_name = ""
        if torch is not None:
            torch_version = str(getattr(torch, "__version__", ""))
            cuda_version = str(getattr(torch.version, "cuda", "") or "")
            if torch.cuda.is_available():
                try:
                    cuda_device_name = str(torch.cuda.get_device_name(0))
                except Exception:
                    cuda_device_name = "cuda"
            else:
                cuda_device_name = ""
            torch_device = self._torchcrepe_device()
        return {
            "torchVersion": torch_version,
            "torchCudaVersion": cuda_version,
            "torchConfiguredDevice": self.settings.torch_device,
            "torchDevice": torch_device,
            "cudaDeviceName": cuda_device_name,
            "cpuThreadLimit": int(getattr(self.settings, "cpu_thread_limit", 1) or 1),
            "torchNumThreads": int(torch.get_num_threads()) if torch is not None else 0,
        }


    def _clip_feature_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "clip-feature-cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir


    def _preprocessed_audio_cache_dir(self) -> Path:
        cache_dir = Path(self.settings.data_root) / "preprocessed-audio-cache"
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


    def _feature_memory_cache_key(self, cache_key: str, kind: str) -> str:
        return self._json_hash({"cacheKey": cache_key, "kind": kind, "version": self.settings.clip_feature_cache_version})


    def _remember_feature_cache(self, memory_key: str, track: list[dict[str, float]], source: str) -> None:
        max_entries = max(0, int(getattr(self.settings, "clip_feature_memory_cache_entries", 0) or 0))
        if max_entries <= 0:
            return
        with self._feature_cache_lock:
            if memory_key in self._feature_cache:
                self._feature_cache.pop(memory_key, None)
            self._feature_cache[memory_key] = (track, source)
            while len(self._feature_cache) > max_entries:
                self._feature_cache.pop(next(iter(self._feature_cache)), None)


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
            "pitchHopMs": round(float(audio.pitch_hop_ms or self.settings.pitch_hop_ms), 3),
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


    def _get_madmom_onset_processors(self) -> tuple[Any, Any] | None:
        if RNNOnsetProcessor is None or OnsetPeakPickingProcessor is None:
            return None
        with self._madmom_processor_lock:
            if self._madmom_onset_processor is None:
                self._madmom_onset_processor = RNNOnsetProcessor()
            if self._madmom_peak_picker is None:
                self._madmom_peak_picker = OnsetPeakPickingProcessor(fps=self.settings.madmom_fps)
            return self._madmom_onset_processor, self._madmom_peak_picker


    def _get_madmom_beat_processors(self) -> tuple[Any, Any] | None:
        if RNNBeatProcessor is None or DBNBeatTrackingProcessor is None:
            return None
        with self._madmom_processor_lock:
            if self._madmom_beat_processor is None:
                self._madmom_beat_processor = RNNBeatProcessor()
            if self._madmom_beat_tracker is None:
                self._madmom_beat_tracker = DBNBeatTrackingProcessor(fps=self.settings.madmom_fps)
            return self._madmom_beat_processor, self._madmom_beat_tracker


    def _audio_file_cache_identity(self, audio_path: str) -> dict[str, Any] | None:
        return audio_file_cache_identity(audio_path, int(self.settings.target_sample_rate))


    def _decode_full_audio_file_for_cache(
        self,
        audio_path: str,
        ffmpeg_path: str | None,
        cache_key: str,
    ) -> DecodedAudioCacheItem | None:
        if np is None:
            return None
        target_sample_rate = int(self.settings.target_sample_rate)
        waveform = None
        sample_rate = None
        decode_method = ""

        if sf is not None:
            try:
                samples, loaded_sr = sf.read(audio_path, always_2d=False)
                loaded_waveform = mono_float32(samples, np)
                sample_rate = int(loaded_sr)
                if sample_rate != target_sample_rate and librosa is not None:
                    loaded_waveform = librosa.resample(
                        loaded_waveform,
                        orig_sr=sample_rate,
                        target_sr=target_sample_rate,
                    ).astype(np.float32)
                    sample_rate = target_sample_rate
                waveform = loaded_waveform
                decode_method = "soundfile-file-memory-cache"
            except Exception:
                waveform = None
                sample_rate = None

        if waveform is None and librosa is not None and ffmpeg_path:
            try:
                with tempfile.TemporaryDirectory(prefix="ai-erhu-audio-full-cache-") as temp_dir:
                    output_path = os.path.join(temp_dir, "decoded.wav")
                    subprocess.run(
                        [
                            ffmpeg_path,
                            "-y",
                            "-i",
                            audio_path,
                            "-ac",
                            "1",
                            "-ar",
                            str(target_sample_rate),
                            output_path,
                        ],
                        check=True,
                        capture_output=True,
                    )
                    loaded_waveform, loaded_sr = librosa.load(output_path, sr=target_sample_rate, mono=True)
                    waveform = np.asarray(loaded_waveform, dtype=np.float32)
                    sample_rate = int(loaded_sr)
                    decode_method = "ffmpeg-librosa-file-memory-cache"
            except Exception:
                return None

        if waveform is None or not sample_rate:
            return None
        return decoded_cache_item(cache_key, waveform, int(sample_rate), decode_method)


    def _load_decoded_audio_memory_cache(self, audio_path: str, ffmpeg_path: str | None) -> DecodedAudioCacheItem | None:
        if not bool(self.settings.enable_decoded_audio_memory_cache):
            return None
        if np is None or not audio_path or not os.path.exists(audio_path):
            return None
        identity = self._audio_file_cache_identity(audio_path)
        if not identity:
            return None
        cache_key = self._json_hash(identity)
        with self._decoded_audio_cache_lock:
            cached = self._decoded_audio_cache.get(cache_key)
            if cached is not None:
                cached.last_access = time.time()
                return cached
            decoded = self._decode_full_audio_file_for_cache(audio_path, ffmpeg_path, cache_key)
            if decoded is None:
                return None
            max_seconds = float(self.settings.decoded_audio_memory_cache_max_seconds)
            max_entries = max(0, int(self.settings.decoded_audio_memory_cache_entries))
            if max_entries > 0 and decoded.duration_seconds <= max_seconds:
                self._decoded_audio_cache[cache_key] = decoded
                while len(self._decoded_audio_cache) > max_entries:
                    oldest_key = min(
                        self._decoded_audio_cache,
                        key=lambda item_key: self._decoded_audio_cache[item_key].last_access,
                    )
                    self._decoded_audio_cache.pop(oldest_key, None)
            return decoded


    def _slice_decoded_audio_window(
        self,
        decoded: DecodedAudioCacheItem,
        audio_path: str,
        window_start: float,
        window_end: float,
        pitch_hop_ms: float | None = None,
    ) -> AudioArtifact | None:
        if np is None or decoded.waveform is None or decoded.sample_rate <= 0:
            return None
        sample_rate = int(decoded.sample_rate)
        start_sample = max(0, int(round(float(window_start) * sample_rate)))
        end_sample = max(start_sample + 1, int(round(float(window_end) * sample_rate)))
        end_sample = min(end_sample, len(decoded.waveform))
        if end_sample <= start_sample:
            return None
        waveform = np.asarray(decoded.waveform[start_sample:end_sample], dtype=np.float32).copy()
        window_hash = self._json_hash(
            {
                "source": decoded.cache_key,
                "path": str(Path(audio_path).resolve()).lower(),
                "windowStart": round(float(window_start), 3),
                "windowEnd": round(float(window_end), 3),
                "sampleRate": sample_rate,
                "pitchHopMs": round(float(pitch_hop_ms or self.settings.pitch_hop_ms), 3),
                "version": "decoded-audio-window-v1",
            }
        )
        duration = float(len(waveform) / sample_rate)
        return AudioArtifact(
            raw_bytes=b"",
            duration_seconds=duration,
            sample_rate=sample_rate,
            waveform=waveform,
            decode_method=f"{decoded.decode_method}+memory-window",
            ffmpeg_path=self._resolve_ffmpeg_path(),
            audio_hash=window_hash,
            cache_key=f"raw-{self.settings.clip_feature_cache_version}-{window_hash}",
            source_cache_key=(
                f"raw-{self.settings.clip_feature_cache_version}-"
                f"full-hop{int(getattr(self.settings, 'full_audio_feature_pitch_hop_ms', 10) or 10)}-{decoded.cache_key}"
            ),
            source_waveform=decoded.waveform,
            source_sample_rate=sample_rate,
            source_duration_seconds=decoded.duration_seconds,
            window_start_seconds=float(window_start),
            window_end_seconds=float(window_end),
            pitch_hop_ms=pitch_hop_ms,
        )


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
                    "separationQuality": meta.get("separationQuality") if isinstance(meta.get("separationQuality"), dict) else {},
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
        separation_quality: dict[str, Any] | None = None,
    ) -> None:
        if audio.waveform is None or audio.sample_rate is None:
            return
        quality_meta = {
            key: value
            for key, value in (separation_quality or {}).items()
            if key != "separationConfidence" and isinstance(value, (int, float)) and math.isfinite(float(value))
        }
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
                            "pitchHopMs": round(float(audio.pitch_hop_ms or self.settings.pitch_hop_ms), 3),
                            "preprocessMode": preprocess_mode,
                            "scope": scope,
                            "separationConfidence": float(separation_confidence),
                            "separationQuality": quality_meta,
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
        memory_key = self._feature_memory_cache_key(audio.cache_key, kind)
        with self._feature_cache_lock:
            cached_feature = self._feature_cache.pop(memory_key, None)
            if cached_feature is not None:
                self._feature_cache[memory_key] = cached_feature
                return cached_feature
        cache_file = self._feature_cache_file(audio.cache_key, kind)
        if not cache_file.exists():
            return None, None
        try:
            payload = json.loads(cache_file.read_text("utf-8"))
            track = payload.get("track")
            source = str(payload.get("source") or "")
            if isinstance(track, list) and source:
                self._remember_feature_cache(memory_key, track, source)
                return track, source
        except Exception:
            return None, None
        return None, None


    def _write_cached_feature(self, audio: AudioArtifact, kind: str, track: list[dict[str, float]], source: str) -> None:
        if not bool(self.settings.enable_clip_feature_cache) or not audio.cache_key:
            return
        self._remember_feature_cache(self._feature_memory_cache_key(audio.cache_key, kind), track, source)
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
            "pitchHopMs": round(float(audio.pitch_hop_ms or self.settings.pitch_hop_ms), 3),
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
                if not is_sha1_hex(audio_hash):
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
        pitch_hop_ms = None
        if requested_window is not None and str(getattr(request, "groupId", "") or "").strip().lower() == "piece-pass":
            pitch_hop_ms = float(max(1, int(getattr(self.settings, "piece_pass_pitch_hop_ms", self.settings.pitch_hop_ms))))

        if requested_window is not None and audio_path and os.path.exists(audio_path):
            window_start, window_end = requested_window
            decoded_full_audio = self._load_decoded_audio_memory_cache(audio_path, ffmpeg_path)
            if decoded_full_audio is not None:
                window_audio = self._slice_decoded_audio_window(
                    decoded_full_audio,
                    audio_path,
                    window_start,
                    window_end,
                    pitch_hop_ms,
                )
                if window_audio is not None:
                    return window_audio

        if requested_window is not None and audio_path and os.path.exists(audio_path) and librosa is not None and ffmpeg_path:
            window_start, window_end = requested_window
            suffix = Path(audio_path).suffix.strip().lower() or self._infer_suffix(request)
            clip_hash_seed = f"{Path(audio_path).stem.strip().lower()}:{window_start:.3f}:{window_end:.3f}:hop{pitch_hop_ms or self.settings.pitch_hop_ms}"
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
                waveform = mono_float32(samples, np)
                decode_method = "soundfile-file"
            except Exception:
                waveform = None
                sample_rate = None

        if raw_bytes and waveform is None and sf is not None and np is not None:
            try:
                samples, sample_rate = sf.read(io.BytesIO(raw_bytes), always_2d=False)
                waveform = mono_float32(samples, np)
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
            pitch_hop_ms=pitch_hop_ms,
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
