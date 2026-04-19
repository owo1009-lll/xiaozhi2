from __future__ import annotations

import base64
import io
import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from statistics import median
from typing import Any

from config import Settings
from schemas import AnalyzeRequest, AnalyzeResult, DemoSegment, MeasureFinding, NoteFinding

try:
    import numpy as np
except ImportError:  # pragma: no cover - optional dependency
    np = None

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


@dataclass(slots=True)
class AudioArtifact:
    raw_bytes: bytes
    duration_seconds: float | None
    sample_rate: int | None = None
    waveform: Any = None
    decode_method: str = "none"
    ffmpeg_path: str | None = None


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


def beats_per_measure(meter: str | None) -> float:
    if not meter:
        return 4.0
    try:
        numerator = float(str(meter).split("/", 1)[0])
        return numerator if numerator > 0 else 4.0
    except Exception:
        return 4.0


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
            "imageio_ffmpeg": imageio_ffmpeg is not None,
            "ffmpeg": bool(self._resolve_ffmpeg_path()),
        }

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        audio = self._decode_audio(request)
        pitch_track, pitch_source = self._estimate_pitch_track(request, audio)
        onset_track, onset_source = self._estimate_onsets(audio)
        aligned_notes = self._align_to_score(request, audio, pitch_track, onset_track)
        return self._build_feedback(
            request=request,
            audio=audio,
            aligned_notes=aligned_notes,
            pitch_track=pitch_track,
            onset_track=onset_track,
            pitch_source=pitch_source,
            onset_source=onset_source,
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

    def _decode_audio(self, request: AnalyzeRequest) -> AudioArtifact:
        data_url = request.audioDataUrl or ""
        raw_bytes = b""
        if "," in data_url:
            try:
                raw_bytes = base64.b64decode(data_url.split(",", 1)[1])
            except Exception:
                raw_bytes = b""

        duration = request.audioSubmission.duration if request.audioSubmission else None
        waveform = None
        sample_rate = None
        decode_method = "none"
        ffmpeg_path = self._resolve_ffmpeg_path()

        if raw_bytes and sf is not None and np is not None:
            try:
                samples, sample_rate = sf.read(io.BytesIO(raw_bytes), always_2d=False)
                waveform = np.asarray(samples, dtype=np.float32)
                if waveform.ndim > 1:
                    waveform = waveform.mean(axis=1)
                decode_method = "soundfile"
            except Exception:
                waveform = None
                sample_rate = None

        if raw_bytes and waveform is None and librosa is not None and ffmpeg_path:
            suffix = self._infer_suffix(request)
            with tempfile.TemporaryDirectory(prefix="ai-erhu-audio-") as temp_dir:
                input_path = os.path.join(temp_dir, f"input{suffix}")
                output_path = os.path.join(temp_dir, "decoded.wav")
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
                decode_method = "ffmpeg-librosa"

        if waveform is not None and duration is None and sample_rate:
            duration = float(len(waveform) / sample_rate)

        return AudioArtifact(
            raw_bytes=raw_bytes,
            duration_seconds=duration,
            sample_rate=sample_rate,
            waveform=waveform,
            decode_method=decode_method,
            ffmpeg_path=ffmpeg_path,
        )

    def _infer_suffix(self, request: AnalyzeRequest) -> str:
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

    def _estimate_pitch_track(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
    ) -> tuple[list[dict[str, float]], str]:
        if audio.waveform is None or audio.sample_rate is None or np is None:
            return self._synthetic_pitch_track(request), "synthetic"

        waveform = np.asarray(audio.waveform, dtype=np.float32)
        if waveform.size == 0:
            return self._synthetic_pitch_track(request), "synthetic"

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
                    return track, "librosa-pyin"
            except Exception:
                pass

        return self._synthetic_pitch_track(request), "synthetic"

    def _synthetic_pitch_track(self, request: AnalyzeRequest) -> list[dict[str, float]]:
        track = []
        elapsed = 0.0
        for note in request.piecePack.notes:
            seconds = max(0.15, note.beatDuration * (60.0 / max(request.piecePack.tempo, 30)))
            track.append(
                {
                    "time": elapsed,
                    "frequency": float(midi_to_frequency(note.midiPitch)),
                    "confidence": 0.65,
                }
            )
            elapsed += seconds
        return track

    def _estimate_onsets(self, audio: AudioArtifact) -> tuple[list[dict[str, float]], str]:
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
                return [{"time": float(value)} for value in onset_times], "librosa-onset"
            except Exception:
                pass
        return [], "score-fallback"

    def _align_to_score(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        pitch_track: list[dict[str, float]],
        onset_track: list[dict[str, float]],
    ) -> list[dict[str, Any]]:
        notes = request.piecePack.notes
        if not notes:
            return []

        tempo_seconds_per_beat = 60.0 / max(request.piecePack.tempo, 30)
        measure_beats = beats_per_measure(request.piecePack.meter)
        expected_duration = max(
            (
                (((note.measureIndex - 1) * measure_beats) + note.beatStart + note.beatDuration) * tempo_seconds_per_beat
                for note in notes
            ),
            default=0.0,
        )
        performance_duration = audio.duration_seconds or expected_duration or 1.0
        tempo_ratio = performance_duration / expected_duration if expected_duration > 0 else 1.0
        observed_onsets = [float(item["time"]) for item in onset_track if "time" in item]

        aligned_notes = []
        onset_cursor = 0

        for index, note in enumerate(notes):
            global_beat_start = ((note.measureIndex - 1) * measure_beats) + note.beatStart
            expected_start = global_beat_start * tempo_seconds_per_beat * tempo_ratio
            expected_end = (global_beat_start + note.beatDuration) * tempo_seconds_per_beat * tempo_ratio
            note_duration = max(0.12, expected_end - expected_start)
            tolerance = max(0.08, min(0.4, note_duration * 0.55))

            observed_start = expected_start
            best_index = None
            best_distance = None
            for candidate_index in range(onset_cursor, min(len(observed_onsets), onset_cursor + 6)):
                candidate = observed_onsets[candidate_index]
                distance = abs(candidate - expected_start)
                if best_distance is None or distance < best_distance:
                    best_distance = distance
                    best_index = candidate_index

            if best_index is not None and best_distance is not None and best_distance <= tolerance:
                observed_start = observed_onsets[best_index]
                onset_cursor = best_index

            segment_start = max(0.0, observed_start + note_duration * 0.15)
            segment_end = max(segment_start + 0.04, expected_end - note_duration * 0.12)
            segment_points = [
                item
                for item in pitch_track
                if segment_start <= float(item["time"]) <= segment_end and float(item.get("confidence", 0.0)) >= self.settings.min_confidence
            ]
            if not segment_points:
                fallback_center = expected_start + note_duration / 2.0
                segment_points = [
                    item
                    for item in pitch_track
                    if abs(float(item["time"]) - fallback_center) <= note_duration * 0.4
                ]

            if segment_points:
                median_frequency = float(median([float(item["frequency"]) for item in segment_points if float(item["frequency"]) > 0]))
                median_confidence = float(median([float(item.get("confidence", 0.0)) for item in segment_points]))
            else:
                median_frequency = 0.0
                median_confidence = 0.0

            aligned_notes.append(
                {
                    "noteId": note.noteId,
                    "measureIndex": note.measureIndex,
                    "expectedMidi": note.midiPitch,
                    "expectedBeatStart": note.beatStart,
                    "expectedOnset": expected_start,
                    "expectedOffset": expected_end,
                    "estimatedFrequency": median_frequency,
                    "estimatedConfidence": median_confidence,
                    "estimatedOnset": observed_start,
                    "centsError": float(cents_error(median_frequency, note.midiPitch)),
                    "onsetErrorMs": float((observed_start - expected_start) * 1000.0),
                }
            )

        return aligned_notes

    def _build_feedback(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        aligned_notes: list[dict[str, Any]],
        pitch_track: list[dict[str, float]],
        onset_track: list[dict[str, float]],
        pitch_source: str,
        onset_source: str,
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
                    "pitchSource": pitch_source,
                    "onsetSource": onset_source,
                },
            )

        flagged_notes = [
            note
            for note in aligned_notes
            if abs(float(note["centsError"])) >= 20 or abs(float(note["onsetErrorMs"])) >= 50
        ][: self.settings.fallback_issue_limit]

        for note in flagged_notes:
            pitch_label = (
                "pitch-flat"
                if note["centsError"] <= -20
                else "pitch-sharp"
                if note["centsError"] >= 20
                else "pitch-ok"
            )
            rhythm_label = (
                "rhythm-early"
                if note["onsetErrorMs"] <= -50
                else "rhythm-late"
                if note["onsetErrorMs"] >= 50
                else "rhythm-ok"
            )
            note_findings.append(
                NoteFinding(
                    noteId=note["noteId"],
                    measureIndex=int(note["measureIndex"]),
                    expectedMidi=int(note["expectedMidi"]),
                    centsError=int(round(float(note["centsError"]))),
                    onsetErrorMs=int(round(float(note["onsetErrorMs"]))),
                    pitchLabel=pitch_label,
                    rhythmLabel=rhythm_label,
                )
            )

        measure_groups: dict[int, list[dict[str, Any]]] = {}
        for note in aligned_notes:
            measure_groups.setdefault(int(note["measureIndex"]), []).append(note)

        for measure_index, notes in sorted(measure_groups.items()):
            pitch_errors = [abs(float(item["centsError"])) for item in notes]
            onset_errors = [abs(float(item["onsetErrorMs"])) for item in notes]
            pitch_median = median(pitch_errors or [0.0])
            onset_median = median(onset_errors or [0.0])
            if pitch_median < 15 and onset_median < 40:
                continue
            issue_label = "rhythm-unstable" if onset_median >= pitch_median else "pitch-unstable"
            measure_findings.append(
                MeasureFinding(
                    measureIndex=measure_index,
                    issueType="unstable",
                    issueLabel=issue_label,
                    detail=f"median cents={int(round(pitch_median))}, median onset={int(round(onset_median))}ms",
                )
            )

        absolute_cents = [abs(float(note["centsError"])) for note in aligned_notes]
        absolute_onsets = [abs(float(note["onsetErrorMs"])) for note in aligned_notes]
        pitch_penalty = min(50.0, median(absolute_cents or [0.0]) * 1.2 + len(note_findings) * 2.5)
        rhythm_penalty = min(50.0, median(absolute_onsets or [0.0]) * 0.55 + len(measure_findings) * 3.0)
        overall_pitch_score = max(40, min(98, round(96 - pitch_penalty)))
        overall_rhythm_score = max(40, min(98, round(94 - rhythm_penalty)))

        confidence_values = [float(note["estimatedConfidence"]) for note in aligned_notes if float(note["estimatedConfidence"]) > 0]
        confidence = median(confidence_values) if confidence_values else self.settings.min_confidence
        confidence = max(0.45, min(0.95, float(confidence)))

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
            measureFindings=measure_findings,
            noteFindings=note_findings,
            demoSegments=demo_segments,
            confidence=round(confidence, 3),
            analysisMode="external",
            diagnostics={
                "dependencyReport": self.dependency_report(),
                "decodeMethod": audio.decode_method,
                "ffmpegPath": audio.ffmpeg_path,
                "durationSeconds": audio.duration_seconds,
                "sampleRate": audio.sample_rate,
                "pitchSource": pitch_source,
                "onsetSource": onset_source,
                "pitchTrackCount": len(pitch_track),
                "onsetCount": len(onset_track),
                "alignedNoteCount": len(aligned_notes),
            },
        )
