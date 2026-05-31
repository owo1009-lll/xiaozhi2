# -*- coding: utf-8 -*-
"""
Phase 0 pitch/rhythm accuracy audit.

The script synthesizes short ground-truth audio from the analyzer's own
SymbolicNote timing, then measures tracking accuracy and diagnosis behavior.
It does not change analyzer logic. Run it with:
    npm run test:pitch-rhythm-accuracy   # smoke, 1 repeat (fast)
    npm run audit:pitch-rhythm-accuracy  # full, 5 repeats with CIs

Tracking and diagnosis are repeated REPEATS times. Each repeat re-synthesizes
the audio with a fresh noise floor and randomized harmonic phase (seeded by the
repeat index, so the audit itself stays reproducible) and the clip feature cache
is disabled, so the reported mean +/- 95% CI captures real run-to-run variation
from madmom and detection noise instead of a single point that could be luck.
The CI uses the t distribution (df = n-1), which is the correct multiplier for
the small repeat counts here; the normal 1.96 understates it by ~40% at n=5.
Repeat count: --repeats N or --smoke (1) on the CLI, else ERHU_AUDIT_REPEATS.
Noise floor: ERHU_AUDIT_NOISE_SNR_DB (default 40dB).
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
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
# Inject clearly above the 22c base pitch tolerance plus the analyzer's own
# measurement error (~10c) and the noise wobble, so recall measures real
# detection capability rather than flapping on the tolerance boundary.
PITCH_PERTURB_CENTS = 50.0
ONSET_PERTURB_MS = 70.0
def _resolve_repeats() -> int:
    """Repeat count: --repeats N (or --smoke for 1) overrides ERHU_AUDIT_REPEATS."""
    argv = sys.argv[1:]
    if "--smoke" in argv:
        return 1
    if "--repeats" in argv:
        index = argv.index("--repeats")
        if index + 1 < len(argv):
            try:
                return max(1, int(argv[index + 1]))
            except ValueError:
                pass
    return max(1, int(os.getenv("ERHU_AUDIT_REPEATS", "5")))


REPEATS = _resolve_repeats()
NOISE_SNR_DB = float(os.getenv("ERHU_AUDIT_NOISE_SNR_DB", "40"))

# Include a high-position note so the audit catches octave folding above the old cap.
NOTE_MIDIS = [62, 64, 66, 69, 74, 81, 86, 93]


def cents_between(estimated: float, reference: float) -> float:
    if estimated <= 0 or reference <= 0:
        return 0.0
    return 1200.0 * math.log2(estimated / reference)


# Two-sided 95% t critical values by degrees of freedom (n-1). With the small
# repeat counts this audit uses, the normal 1.96 understates the CI by ~40% at
# n=5; the t value (2.776 at df=4) is the correct multiplier. df>=30 -> 1.96.
_T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
        8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 15: 2.131, 20: 2.086, 25: 2.060}


def _t95(df: int) -> float:
    if df <= 0:
        return float("nan")
    if df in _T95:
        return _T95[df]
    if df >= 30:
        return 1.96
    # Nearest tabulated df below the requested one (conservative: larger t).
    below = max(k for k in _T95 if k <= df)
    return _T95[below]


def summarize(values: list[float]) -> dict:
    """Mean, sample std, and 95% CI half-width using the t distribution.

    The t multiplier (not the normal 1.96) is required because the audit
    aggregates only a handful of repeats; with df = n-1 the half-width is
    t95(df) * std / sqrt(n).
    """
    clean = [float(v) for v in values if v is not None]
    n = len(clean)
    if n == 0:
        return {"n": 0, "mean": None, "std": None, "ci95": None, "min": None, "max": None}
    mean = sum(clean) / n
    if n == 1:
        return {"n": 1, "mean": round(mean, 3), "std": 0.0, "ci95": None,
                "min": round(mean, 3), "max": round(mean, 3)}
    variance = sum((v - mean) ** 2 for v in clean) / (n - 1)
    std = math.sqrt(variance)
    return {
        "n": n,
        "mean": round(mean, 3),
        "std": round(std, 3),
        "ci95": round(_t95(n - 1) * std / math.sqrt(n), 3),
        "ciMethod": "t",
        "min": round(min(clean), 3),
        "max": round(max(clean), 3),
    }


def audit_settings() -> Settings:
    """Disable the clip feature cache so each repeat recomputes pitch/onset."""
    return Settings(enable_clip_feature_cache=False, enable_full_audio_feature_reuse=False)


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
    seed: int | None = None,
) -> bytes:
    """Synthesize harmonic tones with a small ADSR envelope.

    When seed is set, each harmonic gets a random phase and a white-noise floor
    at NOISE_SNR_DB is added, so repeated calls produce distinct-but-realistic
    audio for variance estimation. seed=None reproduces the clean reference.
    """
    cents_offsets = cents_offsets or {}
    onset_offsets_ms = onset_offsets_ms or {}
    rng = np.random.default_rng(seed) if seed is not None else None
    total_duration = max(note.expected_offset for note in symbolic_notes) + 0.3
    samples = np.zeros(int(total_duration * SAMPLE_RATE), dtype=np.float32)
    harmonic_gains = [1.0, 0.5, 0.28, 0.16, 0.08]
    for index, note in enumerate(symbolic_notes):
        offset_seconds = onset_offsets_ms.get(index, 0.0) / 1000.0
        # Delay the attack within the note's own slot rather than shifting the
        # whole waveform: a late onset shortens the note but never overlaps the
        # next one, so the neighbor's segmentation stays clean. An early onset
        # (negative) does shift the end earlier too, which is harmless.
        start = max(0.0, note.expected_onset + offset_seconds)
        end = note.expected_offset + min(0.0, offset_seconds)
        cents = cents_offsets.get(index, 0.0)
        frequency = midi_to_frequency(note.midi_pitch) * (2.0 ** (cents / 1200.0))
        start_sample = int(start * SAMPLE_RATE)
        end_sample = min(len(samples), int(end * SAMPLE_RATE))
        if end_sample <= start_sample:
            continue
        t = np.arange(end_sample - start_sample, dtype=np.float32) / SAMPLE_RATE
        tone = np.zeros_like(t)
        for harmonic_index, gain in enumerate(harmonic_gains, start=1):
            phase = float(rng.uniform(0.0, 2.0 * math.pi)) if rng is not None else 0.0
            tone += gain * np.sin(2.0 * math.pi * frequency * harmonic_index * t + phase)
        envelope = np.ones_like(t)
        attack = max(1, int(0.01 * SAMPLE_RATE))
        release = max(1, int(0.04 * SAMPLE_RATE))
        envelope[:attack] = np.linspace(0.0, 1.0, attack)
        envelope[-release:] = np.linspace(1.0, 0.0, release)
        samples[start_sample:end_sample] += 0.3 * tone * envelope
    if rng is not None:
        signal_rms = float(np.sqrt(np.mean(samples ** 2))) if samples.size else 0.0
        if signal_rms > 0:
            noise_rms = signal_rms / (10.0 ** (NOISE_SNR_DB / 20.0))
            samples = samples + rng.normal(0.0, noise_rms, samples.shape).astype(np.float32)
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


def measure_tracking(analyzer: ErhuAnalyzer, events: list[NoteEvent], symbolic_notes, seed: int | None) -> dict:
    """Measure tracking pitch error and onset F1 against synthetic truth."""
    wav_bytes = synthesize(symbolic_notes, seed=seed)
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


def measure_diagnosis(analyzer: ErhuAnalyzer, events: list[NoteEvent], symbolic_notes, seed: int | None) -> dict:
    """Inject known pitch/onset errors and measure diagnosis recall and false positives.

    The onset target is the last note so its (clamped) late attack has no later
    neighbor whose segmentation it could disturb, isolating onset error from the
    pitch-recall and false-positive measurements.
    """
    pitch_targets = {1: PITCH_PERTURB_CENTS, 5: -PITCH_PERTURB_CENTS}
    onset_targets = {len(symbolic_notes) - 1: ONSET_PERTURB_MS}
    wav_bytes = synthesize(symbolic_notes, cents_offsets=pitch_targets, onset_offsets_ms=onset_targets, seed=seed)
    result = analyzer.analyze(make_request(events, wav_bytes))

    flagged_by_id = {finding.noteId: finding for finding in result.noteFindings}
    injected_ids = {symbolic_notes[index].note_id for index in pitch_targets}
    clean_ids = ({note.note_id for note in symbolic_notes}
                 - injected_ids
                 - {symbolic_notes[index].note_id for index in onset_targets})

    detected_ids = sorted(note_id for note_id in injected_ids if note_id in flagged_by_id)
    missed_ids = sorted(note_id for note_id in injected_ids if note_id not in flagged_by_id)
    false_positive_ids = sorted(note_id for note_id in clean_ids if note_id in flagged_by_id)
    detected_injected = len(detected_ids)
    false_positives = len(false_positive_ids)

    # Why was each clean note flagged? Capture the finding fields needed to tell
    # a pitch issue from a rhythm issue without rerunning -- this is the data the
    # next root-cause step needs to decide whether to touch rhythm scoring.
    def fp_detail(note_id: str) -> dict:
        f = flagged_by_id[note_id]
        is_pitch = f.pitchLabel in {"pitch-flat", "pitch-sharp"}
        is_rhythm = f.rhythmType not in {"rhythm-ok", ""}
        kind = "pitch" if (is_pitch and not is_rhythm) else "rhythm" if (is_rhythm and not is_pitch) else (
            "pitch+rhythm" if (is_pitch and is_rhythm) else "review" if f.isUncertain else "other")
        return {
            "noteId": note_id,
            "kind": kind,
            "pitchLabel": f.pitchLabel,
            "rhythmType": f.rhythmType,
            "centsError": int(f.centsError),
            "pitchToleranceCents": int(f.pitchToleranceCents),
            "onsetErrorMs": int(f.onsetErrorMs),
            "durationErrorMs": int(f.durationErrorMs),
            "confidence": round(float(f.confidence), 3),
            "isUncertain": bool(f.isUncertain),
            "evidenceLabel": f.evidenceLabel,
        }

    false_positive_detail = [fp_detail(note_id) for note_id in false_positive_ids]
    cents_report_errors: list[float] = []
    for index, injected_cents in pitch_targets.items():
        finding = flagged_by_id.get(symbolic_notes[index].note_id)
        if finding is not None:
            cents_report_errors.append(abs(float(finding.centsError) - injected_cents))

    recall = detected_injected / len(injected_ids) if injected_ids else 0.0
    fp_rate = false_positives / len(clean_ids) if clean_ids else 0.0
    return {
        "seed": seed,
        "injectedPitchNotes": sorted(injected_ids),
        "injectedPitchCents": PITCH_PERTURB_CENTS,
        "detectedInjectedCount": detected_injected,
        "detectedInjectedIds": detected_ids,
        "missedInjectedIds": missed_ids,
        "falsePositiveIds": false_positive_ids,
        "injectedRecall": round(recall, 3),
        "cleanFalsePositiveCount": false_positives,
        "cleanFalsePositiveRate": round(fp_rate, 3),
        "falsePositiveDetail": false_positive_detail,
        "reportedCentsMae": round(sum(cents_report_errors) / len(cents_report_errors), 2) if cents_report_errors else None,
        "totalFlagged": len(result.noteFindings),
    }


def _segment_under_single_onset(analyzer: ErhuAnalyzer, wav: bytes, symbolic_notes) -> int:
    """Run _build_observed_notes with only the first onset and return the
    observed-note count (how many segments the pitch-jump split produced)."""
    events = [
        NoteEvent(noteId=note.note_id, measureIndex=note.measure_index, beatStart=note.beat_start,
                  beatDuration=note.beat_duration, midiPitch=note.midi_pitch)
        for note in symbolic_notes
    ]
    request = make_request(events, wav)
    audio = analyzer._decode_audio(request)
    pitch_track, _ = analyzer._estimate_pitch_track(request, audio, symbolic_notes)
    deficient_onsets = [{"time": float(symbolic_notes[0].expected_onset)}]
    observed = analyzer._build_observed_notes(audio, pitch_track, deficient_onsets, symbolic_notes)
    return observed, pitch_track


def _expressive_wave(symbolic_notes, mode: str) -> bytes:
    """Synthesize a single sustained note whose pitch is expressive (glide or
    vibrato) rather than a step. These must NOT be split by the pitch-jump rule."""
    note = symbolic_notes[0]
    base = midi_to_frequency(note.midi_pitch)
    duration = note.expected_offset - note.expected_onset
    n = int(duration * SAMPLE_RATE)
    t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
    if mode == "glide":
        # Continuous +4 semitone sweep across the whole note (portamento).
        cents = np.linspace(0.0, 400.0, n, dtype=np.float32)
    elif mode == "vibrato":
        # 5.5 Hz, +/-45 cent oscillation around the center pitch.
        cents = 45.0 * np.sin(2.0 * math.pi * 5.5 * t).astype(np.float32)
    else:
        cents = np.zeros(n, dtype=np.float32)
    freqs = base * (2.0 ** (cents / 1200.0))
    phase = 2.0 * math.pi * np.cumsum(freqs) / SAMPLE_RATE
    tone = np.sin(phase).astype(np.float32) + 0.4 * np.sin(2.0 * phase).astype(np.float32)
    envelope = np.ones(n, dtype=np.float32)
    attack = max(1, int(0.01 * SAMPLE_RATE))
    release = max(1, int(0.04 * SAMPLE_RATE))
    envelope[:attack] = np.linspace(0.0, 1.0, attack)
    envelope[-release:] = np.linspace(1.0, 0.0, release)
    samples = np.zeros(int((note.expected_offset + 0.3) * SAMPLE_RATE), dtype=np.float32)
    start = int(note.expected_onset * SAMPLE_RATE)
    samples[start:start + n] += 0.3 * tone * envelope
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())
    return buffer.getvalue()


def measure_segmentation(analyzer: ErhuAnalyzer) -> dict:
    """Probe the pitch-jump onset split with one positive and two negative cases.

    Positive: two distinct notes 7 semitones apart sharing one onset (a dropped
    onset in mixed audio) must split into two observed notes.
    Negative: a single sustained note with a continuous glide, and one with
    vibrato, must NOT be split -- they are one expressive note, and splitting
    them would manufacture false rhythm/pitch findings. The negatives are the
    real regression risk of the Tier 2 logic.
    """
    # --- Positive case: genuine two-note step under one onset ---
    low_midi, high_midi = 62, 69
    pos_events = [
        NoteEvent(noteId="seg-low", measureIndex=1, beatStart=0.0, beatDuration=1.0, midiPitch=low_midi),
        NoteEvent(noteId="seg-high", measureIndex=1, beatStart=1.0, beatDuration=1.0, midiPitch=high_midi),
    ]
    pos_notes, _ = analyzer._resolve_score_notes(make_request(pos_events))
    pos_observed, _ = _segment_under_single_onset(analyzer, synthesize(pos_notes), pos_notes)
    pos_midis = sorted(round(float(o.median_midi)) for o in pos_observed)
    captured_low = any(abs(float(o.median_midi) - low_midi) <= 1.0 for o in pos_observed)
    captured_high = any(abs(float(o.median_midi) - high_midi) <= 1.0 for o in pos_observed)

    # --- Negative cases: single expressive note must stay one segment ---
    negatives: dict[str, dict] = {}
    for mode in ("glide", "vibrato"):
        neg_events = [NoteEvent(noteId=f"expr-{mode}", measureIndex=1, beatStart=0.0,
                                beatDuration=2.0, midiPitch=67)]
        neg_notes, _ = analyzer._resolve_score_notes(make_request(neg_events))
        neg_observed, _ = _segment_under_single_onset(analyzer, _expressive_wave(neg_notes, mode), neg_notes)
        negatives[mode] = {
            "observedNoteCount": len(neg_observed),
            "notOverSplit": len(neg_observed) <= 1,
        }

    return {
        "positive": {
            "scoreNotes": [low_midi, high_midi],
            "droppedOnsetForNote": "seg-high",
            "observedNoteCount": len(pos_observed),
            "observedMidis": pos_midis,
            "capturedBothPitches": bool(captured_low and captured_high),
        },
        "negatives": negatives,
        "ok": bool(captured_low and captured_high)
              and all(item["notOverSplit"] for item in negatives.values()),
    }


def trace_observed_segments(analyzer: ErhuAnalyzer, events: list[NoteEvent], symbolic_notes) -> dict:
    """Record the score onsets vs the observed segments the analyzer builds, so
    the 'a long gap stretches the previous note's segment' effect is provable
    from the audit artifact alone instead of an external trace.

    Built on the clean (noise-free) signal so it is fully deterministic.
    """
    wav = synthesize(symbolic_notes)
    request = make_request(events, wav)
    audio = analyzer._decode_audio(request)
    pitch_track, _ = analyzer._estimate_pitch_track(request, audio, symbolic_notes)
    onset_track, onset_source = analyzer._estimate_onsets(audio, symbolic_notes)
    observed = analyzer._build_observed_notes(audio, pitch_track, onset_track, symbolic_notes)

    score = [{"noteId": n.note_id, "onset": round(n.expected_onset, 3),
              "offset": round(n.expected_offset, 3),
              "durMs": round((n.expected_offset - n.expected_onset) * 1000.0)}
             for n in symbolic_notes]
    obs = [{"onset": round(o.onset, 3), "offset": round(o.offset, 3),
            "spanMs": round((o.offset - o.onset) * 1000.0), "midi": round(float(o.median_midi), 1)}
           for o in observed]
    # Flag observed segments whose span exceeds the longest score note by >50% --
    # these are the gap-stretched segments that drive duration-long false positives.
    longest_score_ms = max((s["durMs"] for s in score), default=0)
    stretched = [o for o in obs if o["spanMs"] > longest_score_ms * 1.5]
    return {
        "onsetSource": onset_source,
        "scoreNotes": score,
        "observedSegments": obs,
        "longestScoreNoteMs": longest_score_ms,
        "stretchedSegments": stretched,
        "hasStretchedSegment": bool(stretched),
    }


def aggregate(runs: list[dict], metric_keys: list[str]) -> dict:
    """Summarize each scalar metric across repeated runs as mean +/- 95% CI."""
    return {key: summarize([run.get(key) for run in runs]) for key in metric_keys}


def main() -> int:
    if np is None:
        print(json.dumps({"ok": False, "error": "numpy unavailable"}))
        return 1
    analyzer = ErhuAnalyzer(audit_settings())
    events = build_note_events()
    # Use the analyzer's own score parser so the audit isolates audio/diagnosis behavior.
    symbolic_notes, _ = analyzer._resolve_score_notes(make_request(events))

    # A clean noise-free reference (seed=None) plus REPEATS noisy runs at a fixed SNR.
    # The aggregate is computed over the noisy runs only, so the noise condition is held
    # constant and the CI is a valid basis for "did this change help" comparisons.
    clean_tracking = measure_tracking(analyzer, events, symbolic_notes, None)
    clean_diagnosis = measure_diagnosis(analyzer, events, symbolic_notes, None)
    tracking_runs: list[dict] = []
    diagnosis_runs: list[dict] = []
    for repeat in range(REPEATS):
        seed = repeat + 1
        tracking_runs.append(measure_tracking(analyzer, events, symbolic_notes, seed))
        diagnosis_runs.append(measure_diagnosis(analyzer, events, symbolic_notes, seed))

    tracking_metrics = ["pitchMaeCents", "pitchMaxCents", "onsetPrecision", "onsetRecall", "onsetF1", "trackedNoteCount"]
    diagnosis_metrics = ["injectedRecall", "cleanFalsePositiveCount", "cleanFalsePositiveRate", "reportedCentsMae", "totalFlagged"]

    report = {
        "schemaVersion": 2,
        "repeats": REPEATS,
        "noiseSnrDb": NOISE_SNR_DB,
        "sampleRate": SAMPLE_RATE,
        "onsetToleranceMs": ONSET_TOLERANCE_MS,
        "noteRangeMidi": [NOTE_MIDIS[0], NOTE_MIDIS[-1]],
        "highestNoteHz": round(midi_to_frequency(NOTE_MIDIS[-1]), 2),
        "tracking": {
            "pitchSource": clean_tracking["pitchSource"],
            "onsetSource": clean_tracking["onsetSource"],
            "totalNoteCount": clean_tracking["totalNoteCount"],
            "perNoteCleanRun": clean_tracking["perNote"],
            "cleanRun": {key: clean_tracking[key] for key in tracking_metrics},
            "noisyAggregate": aggregate(tracking_runs, tracking_metrics),
        },
        "diagnosis": {
            "injectedPitchNotes": clean_diagnosis["injectedPitchNotes"],
            "injectedPitchCents": PITCH_PERTURB_CENTS,
            "cleanRun": {key: clean_diagnosis[key] for key in diagnosis_metrics},
            "cleanRunFalsePositiveDetail": clean_diagnosis["falsePositiveDetail"],
            "noisyAggregate": aggregate(diagnosis_runs, diagnosis_metrics),
            "perRepeat": [
                {key: run[key] for key in (
                    "seed", "injectedRecall", "detectedInjectedIds", "missedInjectedIds",
                    "falsePositiveIds", "falsePositiveDetail", "cleanFalsePositiveCount",
                    "reportedCentsMae")}
                for run in diagnosis_runs
            ],
        },
        "segmentation": measure_segmentation(analyzer),
        "segmentTrace": trace_observed_segments(analyzer, events, symbolic_notes),
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
