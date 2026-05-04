import argparse
import json
import math
import os
import struct
import sys
import time
import wave
from pathlib import Path

os.environ.setdefault("ERHU_PREFER_CUDA_PYTHON", "false")
os.environ.setdefault("ERHU_TORCH_DEVICE", "cpu")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

REPO_ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = REPO_ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))

from analyzer import ErhuAnalyzer  # noqa: E402
from config import Settings  # noqa: E402
from schemas import AnalyzeRequest, NoteEvent, PiecePack  # noqa: E402


def write_synthetic_wav(path: Path, notes: list[NoteEvent], sample_rate: int = 16000, nonce: int = 0) -> None:
    duration_seconds = max((note.beatStart + note.beatDuration for note in notes), default=1.0) + 0.15
    total_samples = max(1, int(duration_seconds * sample_rate))
    by_sample: list[bytes] = []
    for index in range(total_samples):
        t = index / sample_rate
        active_note = next((note for note in notes if note.beatStart <= t < note.beatStart + note.beatDuration), None)
        if active_note is None:
            value = 0.0
        else:
            frequency = 440.0 * (2.0 ** ((active_note.midiPitch - 69) / 12.0))
            envelope = min(1.0, max(0.0, (t - active_note.beatStart) / 0.04))
            release = min(1.0, max(0.0, (active_note.beatStart + active_note.beatDuration - t) / 0.04))
            value = 0.32 * min(envelope, release) * math.sin(2.0 * math.pi * frequency * t)
        if nonce and index == total_samples - 1:
            value = ((nonce % 17) - 8) / 32767.0
        by_sample.append(struct.pack("<h", int(max(-1.0, min(1.0, value)) * 32767)))

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(b"".join(by_sample))


def timed(phases: list[dict[str, object]], name: str, fn):
    started = time.perf_counter()
    result = fn()
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    phases.append({"name": name, "elapsedMs": elapsed_ms})
    return result


def run_profile(analyzer: ErhuAnalyzer, request: AnalyzeRequest, label: str) -> dict[str, object]:
    phases: list[dict[str, object]] = []
    audio = timed(phases, "decode-audio", lambda: analyzer._decode_audio(request))
    score_notes, score_source = timed(phases, "resolve-score-notes", lambda: analyzer._resolve_score_notes(request))
    preprocess_mode = timed(phases, "resolve-preprocess-mode", lambda: analyzer._resolve_preprocess_mode(request))
    pitch_track, pitch_source = timed(phases, "pitch-track", lambda: analyzer._estimate_pitch_track(request, audio, score_notes))
    section_calibration = timed(phases, "section-calibration", lambda: analyzer._resolve_section_calibration(request))
    analysis_audio, preprocess_applied, applied_preprocess_mode, separation_meta = timed(
        phases,
        "preprocess-audio",
        lambda: analyzer._preprocess_audio(
            request,
            audio,
            score_notes,
            pitch_track,
            preprocess_mode,
            section_calibration,
            persist_outputs=False,
        ),
    )
    if preprocess_applied:
        pitch_track, pitch_source = timed(
            phases,
            "pitch-track-after-preprocess",
            lambda: analyzer._estimate_pitch_track(request, analysis_audio, score_notes),
        )
    onset_track, onset_source = timed(phases, "onset-track", lambda: analyzer._estimate_onsets(analysis_audio, score_notes))
    beat_track, beat_source = timed(phases, "beat-track", lambda: analyzer._estimate_beats(analysis_audio, score_notes))
    aligned_notes, alignment_mode = timed(
        phases,
        "dtw-align",
        lambda: analyzer._align_to_score(
            request,
            analysis_audio,
            pitch_track,
            onset_track,
            score_notes,
            section_calibration,
            separation_meta,
        ),
    )
    result = timed(
        phases,
        "build-feedback",
        lambda: analyzer._build_feedback(
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
        ),
    )

    total_elapsed_ms = round(sum(float(item["elapsedMs"]) for item in phases), 2)
    slowest_phase = max(phases, key=lambda item: float(item["elapsedMs"]), default={"name": "", "elapsedMs": 0})
    return {
        "label": label,
        "audio": {
            "durationSeconds": audio.duration_seconds,
            "sampleRate": audio.sample_rate,
            "decodeMethod": audio.decode_method,
        },
        "sources": {
            "score": score_source,
            "pitch": pitch_source,
            "onset": onset_source,
            "beat": beat_source,
            "alignment": alignment_mode,
        },
        "counts": {
            "scoreNotes": len(score_notes),
            "pitchPoints": len(pitch_track),
            "onsets": len(onset_track),
            "beats": len(beat_track),
            "alignedNotes": len(aligned_notes),
            "noteFindings": len(result.noteFindings),
        },
        "phases": phases,
        "slowestPhase": slowest_phase,
        "totalElapsedMs": total_elapsed_ms,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="CPU-only analyzer phase diagnostic for short synthetic audio.")
    parser.add_argument("--notes", type=int, default=5, help="Number of synthetic notes to analyze.")
    parser.add_argument("--duration", type=float, default=0.32, help="Seconds per synthetic note.")
    parser.add_argument("--repeat", type=int, default=2, help="Run count against the same audio to expose cold and warm cache timing.")
    args = parser.parse_args()

    notes = [
        NoteEvent(
            noteId=f"cpu-phase-note-{index + 1}",
            measureIndex=(index // 4) + 1,
            beatStart=round(index * args.duration, 4),
            beatDuration=args.duration,
            midiPitch=62 + (index % 5),
        )
        for index in range(max(1, args.notes))
    ]
    nonce = int(time.time() * 1000000)
    wav_path = REPO_ROOT / "data" / "diagnostics" / f"cpu-phase-{nonce}.wav"
    write_synthetic_wav(wav_path, notes, nonce=nonce)

    settings = Settings()
    settings.torch_device = "cpu"
    analyzer = ErhuAnalyzer(settings)
    runtime = analyzer.runtime_report()
    dependencies = analyzer.dependency_report()
    if runtime.get("torchDevice") != "cpu":
        raise SystemExit(f"analyzer is not CPU-only: {runtime}")

    request = AnalyzeRequest(
        participantId="cpu-phase-diagnostic",
        pieceId="cpu-phase-piece",
        sectionId="cpu-phase-section",
        preprocessMode="off",
        persistAudioVariants=False,
        audioPath=str(wav_path),
        piecePack=PiecePack(
            pieceId="cpu-phase-piece",
            sectionId="cpu-phase-section",
            title="CPU phase diagnostic",
            tempo=120,
            meter="4/4",
            notes=notes,
        ),
    )

    runs = [run_profile(analyzer, request, f"run-{index + 1}") for index in range(max(1, args.repeat))]
    cold_run = runs[0]
    warm_run = runs[1] if len(runs) > 1 else None
    cold_total = float(cold_run["totalElapsedMs"])
    warm_total = float(warm_run["totalElapsedMs"]) if warm_run else 0.0
    print(
        json.dumps(
            {
                "ok": True,
                "cpuOnly": True,
                "runtime": runtime,
                "dependencies": dependencies,
                "audioPath": str(wav_path),
                "featureMemoryCacheEntries": len(getattr(analyzer, "_feature_cache", {})),
                "coldRun": cold_run,
                "warmRun": warm_run,
                "warmSpeedupRatio": round(cold_total / warm_total, 2) if warm_total > 0 else None,
                "audio": {
                    "path": str(wav_path),
                    **dict(cold_run["audio"]),
                },
                "sources": cold_run["sources"],
                "counts": cold_run["counts"],
                "phases": cold_run["phases"],
                "slowestPhase": cold_run["slowestPhase"],
                "totalElapsedMs": cold_run["totalElapsedMs"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
