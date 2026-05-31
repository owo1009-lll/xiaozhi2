# -*- coding: utf-8 -*-
"""
Phase 0 pitch/rhythm accuracy audit.

The script synthesizes short ground-truth audio from the analyzer's own
SymbolicNote timing, then measures tracking accuracy and diagnosis behavior.
It does not change analyzer logic. Run it with:
    npm run test:pitch-rhythm-accuracy
"""
from __future__ import annotations

import base64
import io
import json
import math
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))

from analyzer import ErhuAnalyzer, midi_to_frequency  # noqa: E402
from config import Settings  # noqa: E402
from schemas import AnalyzeRequest, NoteEvent, PiecePack  # noqa: E402

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None

SAMPLE_RATE = 22050
TEMPO = 100  # seconds_per_beat = 0.6
ONSET_TOLERANCE_MS = 50.0
PITCH_PERTURB_CENTS = 35.0
ONSET_PERTURB_MS = 70.0

# Include a high-position note so the audit catches octave folding above the old cap.
NOTE_MIDIS = [62, 64, 66, 69, 74, 81, 86, 93]


def cents_between(estimated: float, reference: float) -> float:
    if estimated <= 0 or reference <= 0:
        return 0.0
    return 1200.0 * math.log2(estimated / reference)


def build_note_events() -> list[NoteEvent]:
    events: list[NoteEvent] = []
    for index, midi_pitch in enumerate(NOTE_MIDIS):
        events.append(
            NoteEvent(
                noteId=f"n{index + 1}",
                measureIndex=(index // 4) + 1,
                beatStart=float(index),
                beatDuration=1.0,
                midiPitch=midi_pitch,
            )
        )
    return events


def synthesize(
    symbolic_notes,
    cents_offsets: dict[int, float] | None = None,
    onset_offsets_ms: dict[int, float] | None = None,
) -> bytes:
    """Synthesize harmonic tones with a small ADSR envelope."""
    cents_offsets = cents_offsets or {}
    onset_offsets_ms = onset_offsets_ms or {}
    total_duration = max(note.expected_offset for note in symbolic_notes) + 0.3
    samples = np.zeros(int(total_duration * SAMPLE_RATE), dtype=np.float32)
    harmonic_gains = [1.0, 0.5, 0.28, 0.16, 0.08]
    for index, note in enumerate(symbolic_notes):
        offset_seconds = onset_offsets_ms.get(index, 0.0) / 1000.0
        start = max(0.0, note.expected_onset + offset_seconds)
        end = note.expected_offset + offset_seconds
        cents = cents_offsets.get(index, 0.0)
        frequency = midi_to_frequency(note.midi_pitch) * (2.0 ** (cents / 1200.0))
        start_sample = int(start * SAMPLE_RATE)
        end_sample = min(len(samples), int(end * SAMPLE_RATE))
        if end_sample <= start_sample:
            continue
        t = np.arange(end_sample - start_sample, dtype=np.float32) / SAMPLE_RATE
        tone = np.zeros_like(t)
        for harmonic_index, gain in enumerate(harmonic_gains, start=1):
            tone += gain * np.sin(2.0 * math.pi * frequency * harmonic_index * t)
        envelope = np.ones_like(t)
        attack = max(1, int(0.01 * SAMPLE_RATE))
        release = max(1, int(0.04 * SAMPLE_RATE))
        envelope[:attack] = np.linspace(0.0, 1.0, attack)
        envelope[-release:] = np.linspace(1.0, 0.0, release)
        samples[start_sample:end_sample] += 0.3 * tone * envelope
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 1.0:
        samples /= peak
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())
    return buffer.getvalue()


def make_request(events: list[NoteEvent], wav_bytes: bytes | None = None) -> AnalyzeRequest:
    audio_url = (
        "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode("ascii")
        if wav_bytes is not None
        else None
    )
    return AnalyzeRequest(
        participantId="phase0-accuracy",
        piecePack=PiecePack(notes=events, tempo=TEMPO),
        audioDataUrl=audio_url,
        preprocessMode="off",
    )


def measure_tracking(analyzer: ErhuAnalyzer, events: list[NoteEvent], symbolic_notes, wav_bytes: bytes) -> dict:
    """Measure tracking pitch error and onset F1 against synthetic truth."""
    request = make_request(events, wav_bytes)
    audio = analyzer._decode_audio(request)
    pitch_track, pitch_source = analyzer._estimate_pitch_track(request, audio, symbolic_notes)
    onset_track, onset_source = analyzer._estimate_onsets(audio, symbolic_notes)

    cents_errors: list[float] = []
    per_note: list[dict] = []
    for note in symbolic_notes:
        window = [
            float(item["frequency"])
            for item in pitch_track
            if note.expected_onset <= float(item["time"]) <= note.expected_offset
            and float(item["frequency"]) > 0
        ]
        true_frequency = midi_to_frequency(note.midi_pitch)
        if window:
            detected = float(np.median(window))
            error = cents_between(detected, true_frequency)
            cents_errors.append(abs(error))
            per_note.append({"noteId": note.note_id, "midi": note.midi_pitch, "trueHz": round(true_frequency, 2),
                             "detectedHz": round(detected, 2), "centsError": round(error, 1)})
        else:
            per_note.append({"noteId": note.note_id, "midi": note.midi_pitch, "trueHz": round(true_frequency, 2),
                             "detectedHz": None, "centsError": None})

    true_onsets = [note.expected_onset for note in symbolic_notes]
    detected_onsets = sorted(float(item["time"]) for item in onset_track if "time" in item)
    matched = 0
    used: set[int] = set()
    for true_onset in true_onsets:
        for detected_index, detected_onset in enumerate(detected_onsets):
            if detected_index in used:
                continue
            if abs(detected_onset - true_onset) * 1000.0 <= ONSET_TOLERANCE_MS:
                matched += 1
                used.add(detected_index)
                break
    precision = matched / len(detected_onsets) if detected_onsets else 0.0
    recall = matched / len(true_onsets) if true_onsets else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

    tracked_notes = sum(1 for item in per_note if item["centsError"] is not None)
    return {
        "pitchSource": pitch_source,
        "onsetSource": onset_source,
        "trackedNoteCount": tracked_notes,
        "totalNoteCount": len(symbolic_notes),
        "pitchMaeCents": round(sum(cents_errors) / len(cents_errors), 2) if cents_errors else None,
        "pitchMaxCents": round(max(cents_errors), 2) if cents_errors else None,
        "onsetPrecision": round(precision, 3),
        "onsetRecall": round(recall, 3),
        "onsetF1": round(f1, 3),
        "perNote": per_note,
    }


def measure_diagnosis(analyzer: ErhuAnalyzer, events: list[NoteEvent], symbolic_notes) -> dict:
    """Inject known pitch/onset errors and measure diagnosis recall and false positives."""
    pitch_targets = {1: PITCH_PERTURB_CENTS, 5: -PITCH_PERTURB_CENTS}
    onset_targets = {3: ONSET_PERTURB_MS}
    wav_bytes = synthesize(symbolic_notes, cents_offsets=pitch_targets, onset_offsets_ms=onset_targets)
    result = analyzer.analyze(make_request(events, wav_bytes))

    flagged_by_id = {finding.noteId: finding for finding in result.noteFindings}
    injected_ids = {symbolic_notes[index].note_id for index in pitch_targets}
    clean_ids = ({note.note_id for note in symbolic_notes}
                 - injected_ids
                 - {symbolic_notes[index].note_id for index in onset_targets})

    detected_injected = sum(1 for note_id in injected_ids if note_id in flagged_by_id)
    false_positives = sum(1 for note_id in clean_ids if note_id in flagged_by_id)
    cents_report_errors: list[float] = []
    for index, injected_cents in pitch_targets.items():
        finding = flagged_by_id.get(symbolic_notes[index].note_id)
        if finding is not None:
            cents_report_errors.append(abs(float(finding.centsError) - injected_cents))

    recall = detected_injected / len(injected_ids) if injected_ids else 0.0
    fp_rate = false_positives / len(clean_ids) if clean_ids else 0.0
    return {
        "injectedPitchNotes": sorted(injected_ids),
        "injectedPitchCents": PITCH_PERTURB_CENTS,
        "detectedInjectedCount": detected_injected,
        "injectedRecall": round(recall, 3),
        "cleanFalsePositiveCount": false_positives,
        "cleanFalsePositiveRate": round(fp_rate, 3),
        "reportedCentsMae": round(sum(cents_report_errors) / len(cents_report_errors), 2) if cents_report_errors else None,
        "totalFlagged": len(result.noteFindings),
    }


def main() -> int:
    if np is None:
        print(json.dumps({"ok": False, "error": "numpy unavailable"}))
        return 1
    analyzer = ErhuAnalyzer(Settings())
    events = build_note_events()
    # Use the analyzer's own score parser so the audit isolates audio/diagnosis behavior.
    symbolic_notes, _ = analyzer._resolve_score_notes(make_request(events))
    clean_wav = synthesize(symbolic_notes)

    report = {
        "schemaVersion": 1,
        "sampleRate": SAMPLE_RATE,
        "onsetToleranceMs": ONSET_TOLERANCE_MS,
        "noteRangeMidi": [NOTE_MIDIS[0], NOTE_MIDIS[-1]],
        "highestNoteHz": round(midi_to_frequency(NOTE_MIDIS[-1]), 2),
        "tracking": measure_tracking(analyzer, events, symbolic_notes, clean_wav),
        "diagnosis": measure_diagnosis(analyzer, events, symbolic_notes),
    }

    output_dir = ROOT / "data" / "real-tests" / "pitch-rhythm-accuracy"
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "latest-pitch-rhythm-accuracy.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
