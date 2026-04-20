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
from xml.etree import ElementTree as ET

from config import Settings
from schemas import AnalyzeRequest, AnalyzeResult, DemoSegment, MeasureFinding, NoteEvent, NoteFinding

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

try:
    import pretty_midi
except ImportError:  # pragma: no cover - optional dependency
    pretty_midi = None


@dataclass(slots=True)
class AudioArtifact:
    raw_bytes: bytes
    duration_seconds: float | None
    sample_rate: int | None = None
    waveform: Any = None
    decode_method: str = "none"
    ffmpeg_path: str | None = None


@dataclass(slots=True)
class SymbolicNote:
    note_id: str
    measure_index: int
    beat_start: float
    beat_duration: float
    midi_pitch: int
    expected_onset: float
    expected_offset: float


@dataclass(slots=True)
class ObservedNote:
    onset: float
    offset: float
    median_frequency: float
    median_midi: float
    confidence: float


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


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        numeric = float(value)
        return numeric if math.isfinite(numeric) else default
    except Exception:
        return default


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
            "pretty_midi": pretty_midi is not None,
            "ffmpeg": bool(self._resolve_ffmpeg_path()),
        }

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        audio = self._decode_audio(request)
        score_notes, score_source = self._resolve_score_notes(request)
        pitch_track, pitch_source = self._estimate_pitch_track(request, audio, score_notes)
        onset_track, onset_source = self._estimate_onsets(audio, score_notes)
        aligned_notes, alignment_mode = self._align_to_score(request, audio, pitch_track, onset_track, score_notes)
        return self._build_feedback(
            request=request,
            audio=audio,
            score_notes=score_notes,
            aligned_notes=aligned_notes,
            pitch_track=pitch_track,
            onset_track=onset_track,
            pitch_source=pitch_source,
            onset_source=onset_source,
            score_source=score_source,
            alignment_mode=alignment_mode,
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
                )
            )
        return hydrated

    def _parse_musicxml_score(self, xml_text: str, request: AnalyzeRequest) -> list[SymbolicNote]:
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

        part = next((element for element in root.iter() if element.tag.rsplit("}", 1)[-1] == "part"), None)
        if part is None:
            return []

        note_events: list[NoteEvent] = []
        divisions = 1.0
        last_note_start = 0.0
        for measure_position, measure in enumerate(children(part, "measure"), start=1):
            attributes = child(measure, "attributes")
            if attributes is not None:
                divisions_node = child(attributes, "divisions")
                if divisions_node is not None and divisions_node.text:
                    divisions = max(1.0, safe_float(divisions_node.text, 1.0))

            current_beat = 0.0
            measure_index = int(measure.attrib.get("number", measure_position) or measure_position)
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
                            midi_pitch = musicxml_pitch_to_midi(
                                step_node.text,
                                int(safe_float(octave_node.text, 4)),
                                int(safe_float(alter_node.text if alter_node is not None else 0, 0)),
                            )
                            note_events.append(
                                NoteEvent(
                                    noteId=f"xml-m{measure_index}-n{note_index}",
                                    measureIndex=measure_index,
                                    beatStart=beat_start,
                                    beatDuration=max(duration_beats, 0.25),
                                    midiPitch=midi_pitch,
                                )
                            )
                if not is_chord:
                    current_beat += max(duration_beats, 0.0)

        return self._hydrate_piece_notes(note_events, request)

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
        if audio.waveform is None or audio.sample_rate is None or np is None:
            return self._synthetic_pitch_track(score_notes), "synthetic"

        waveform = np.asarray(audio.waveform, dtype=np.float32)
        if waveform.size == 0:
            return self._synthetic_pitch_track(score_notes), "synthetic"

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

        return self._synthetic_pitch_track(score_notes), "synthetic"

    def _synthetic_pitch_track(self, score_notes: list[SymbolicNote]) -> list[dict[str, float]]:
        track = []
        for note in score_notes:
            seconds = max(0.15, note.expected_offset - note.expected_onset)
            track.append(
                {
                    "time": note.expected_onset,
                    "frequency": float(midi_to_frequency(note.midi_pitch)),
                    "confidence": 0.65,
                }
            )
            if seconds > 0.18:
                track.append(
                    {
                        "time": note.expected_onset + (seconds * 0.55),
                        "frequency": float(midi_to_frequency(note.midi_pitch)),
                        "confidence": 0.64,
                    }
                )
        return track

    def _estimate_onsets(self, audio: AudioArtifact, score_notes: list[SymbolicNote]) -> tuple[list[dict[str, float]], str]:
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
        return [{"time": float(note.expected_onset)} for note in score_notes], "score-fallback"

    def _build_observed_notes(
        self,
        audio: AudioArtifact,
        pitch_track: list[dict[str, float]],
        onset_track: list[dict[str, float]],
        score_notes: list[SymbolicNote],
    ) -> list[ObservedNote]:
        if not pitch_track:
            return []

        performance_duration = audio.duration_seconds or max((float(item["time"]) for item in pitch_track), default=0.0)
        score_duration = max((note.expected_offset for note in score_notes), default=performance_duration or 1.0)
        onset_times = sorted({round(float(item["time"]), 4) for item in onset_track if "time" in item})
        if not onset_times:
            ratio = (performance_duration / score_duration) if score_duration > 0 and performance_duration > 0 else 1.0
            onset_times = [round(float(note.expected_onset) * ratio, 4) for note in score_notes]

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
            stable_start = start + ((end - start) * 0.12)
            stable_end = max(stable_start + 0.03, end - ((end - start) * 0.08))
            segment_points = [
                item
                for item in pitch_track
                if stable_start <= float(item["time"]) <= stable_end and float(item["frequency"]) > 0
            ]
            if not segment_points:
                segment_points = [
                    item
                    for item in pitch_track
                    if start <= float(item["time"]) <= end and float(item["frequency"]) > 0
                ]
            if not segment_points:
                continue

            frequencies = [float(item["frequency"]) for item in segment_points if float(item["frequency"]) > 0]
            confidence_values = [float(item.get("confidence", 0.0)) for item in segment_points]
            median_frequency = float(median(frequencies))
            observed.append(
                ObservedNote(
                    onset=float(start),
                    offset=float(end),
                    median_frequency=median_frequency,
                    median_midi=float(frequency_to_midi(median_frequency)),
                    confidence=float(median(confidence_values)) if confidence_values else 0.0,
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
        score_norm = score_note.expected_onset / max(score_duration, 1e-6)
        observed_norm = observed_note.onset / max(performance_duration, 1e-6)
        time_distance = abs(score_norm - observed_norm) * 12.0
        score_note_norm = (score_note.expected_offset - score_note.expected_onset) / max(score_duration, 1e-6)
        observed_note_norm = (observed_note.offset - observed_note.onset) / max(performance_duration, 1e-6)
        duration_distance = abs(score_note_norm - observed_note_norm) * 8.0
        confidence_penalty = max(0.0, self.settings.min_confidence - observed_note.confidence) * 6.0
        return pitch_distance + time_distance + duration_distance + confidence_penalty

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
    ) -> tuple[list[dict[str, Any]], str]:
        if not score_notes:
            return [], "no-score"

        observed_notes = self._build_observed_notes(audio, pitch_track, onset_track, score_notes)
        if not observed_notes:
            observed_notes = self._build_observed_notes(
                audio,
                self._synthetic_pitch_track(score_notes),
                [{"time": note.expected_onset} for note in score_notes],
                score_notes,
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
                    "centsError": float(cents_error(estimated_frequency, score_note.midi_pitch)),
                    "onsetErrorMs": float((estimated_onset - (score_note.expected_onset * tempo_ratio)) * 1000.0),
                    "matchedObservedIndex": matched_index if matched_index is not None else -1,
                }
            )

        return aligned_notes, "score-dtw"

    def _build_feedback(
        self,
        request: AnalyzeRequest,
        audio: AudioArtifact,
        score_notes: list[SymbolicNote],
        aligned_notes: list[dict[str, Any]],
        pitch_track: list[dict[str, float]],
        onset_track: list[dict[str, float]],
        pitch_source: str,
        onset_source: str,
        score_source: str,
        alignment_mode: str,
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
                    "alignmentMode": alignment_mode,
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
                "scoreSource": score_source,
                "scoreNoteCount": len(score_notes),
                "pitchSource": pitch_source,
                "onsetSource": onset_source,
                "alignmentMode": alignment_mode,
                "pitchTrackCount": len(pitch_track),
                "onsetCount": len(onset_track),
                "alignedNoteCount": len(aligned_notes),
            },
        )
