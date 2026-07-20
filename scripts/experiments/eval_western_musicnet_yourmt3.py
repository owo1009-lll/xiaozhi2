#!/usr/bin/env python3
"""Evaluate an instrument-aware YourMT3+ challenger on MusicNet mixtures.

The Hugging Face Space is an unstable research distribution with unresolved
weight licensing.  Results from this script are diagnostic only and cannot
authorize student-facing or production use.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[2]
EXPERIMENTS = REPO / "scripts" / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from eval_western_bach_violin_basic_pitch_transcription import (  # noqa: E402
    evaluate_tolerance,
    filter_events,
    metrics_from_counts,
)
from eval_western_musicnet_accompanied_violin import (  # noqa: E402
    GATE,
    ONSET_TOLERANCES,
    SAMPLES,
    gate_checks,
    load_violin_reference_rows,
    sha256_file,
)


DEFAULT_SOURCE = REPO / "data" / "external" / "yourmt3-plus-space" / "source"
DEFAULT_CHECKPOINT = (
    DEFAULT_SOURCE / "amt" / "logs" / "2024"
    / "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops"
    / "checkpoints" / "last.ckpt"
)
DEFAULT_MUSICNET = (
    REPO / "data" / "experiments" / "western-strings-musicnet-accompanied-violin"
)
DEFAULT_OUTPUT = (
    REPO / "data" / "experiments" / "western-strings-musicnet-yourmt3"
)
CHECKPOINT_SHA256 = "ae38e415c79efd5592dcb9b658cdb99ddb11d4c4e1eaa364cab04a052473fc25"
PROGRAM_GROUPS = {
    "violin-only": frozenset({40}),
    "bowed-strings": frozenset(range(40, 44)),
    "all-strings": frozenset(range(40, 52)),
}
MIN_DURATIONS = (0.0, 0.01, 0.02, 0.03, 0.05, 0.07, 0.09, 0.12)
TIME_SHIFTS = tuple(value / 100.0 for value in range(-8, 9))
MODEL_ARGS = [
    "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt",
    "-p", "2024",
    "-tk", "mc13_full_plus_256",
    "-dec", "multi-t5",
    "-nl", "26",
    "-enc", "perceiver-tf",
    "-sqr", "1",
    "-ff", "moe",
    "-wf", "4",
    "-nmoe", "8",
    "-kmoe", "2",
    "-act", "silu",
    "-epe", "rope",
    "-rp", "1",
    "-ac", "spec",
    "-hop", "300",
    "-atc", "1",
    "-pr", "16",
]


def require_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise SystemExit(f"{label} not found: {path}")


def load_model(source: Path):
    sys.path.insert(0, str(source / "amt" / "src"))
    sys.path.insert(0, str(source))
    from model_helper import load_model_checkpoint  # noqa: PLC0415

    previous = Path.cwd()
    os.chdir(source)
    try:
        model = load_model_checkpoint(args=MODEL_ARGS, device="cpu")
    finally:
        os.chdir(previous)
    import torch  # noqa: PLC0415

    if not torch.cuda.is_available():
        raise RuntimeError("yourmt3-cuda-required")
    return model.to("cuda").eval()


def transcribe(model, audio_path: Path, maximum_seconds: float | None) -> list[dict[str, Any]]:
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415
    import torch  # noqa: PLC0415
    import torchaudio  # noqa: PLC0415
    from utils.audio import slice_padded_array  # noqa: PLC0415
    from utils.event2note import (  # noqa: PLC0415
        merge_zipped_note_events_and_ties_to_notes,
    )
    from utils.note2event import mix_notes  # noqa: PLC0415

    samples, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
    audio = torch.from_numpy(np.mean(samples, axis=1)).unsqueeze(0)
    audio = torchaudio.functional.resample(
        audio, sample_rate, model.audio_cfg["sample_rate"]
    )
    if maximum_seconds is not None:
        audio = audio[:, :round(maximum_seconds * model.audio_cfg["sample_rate"])]
    segments = slice_padded_array(
        audio, model.audio_cfg["input_frames"], model.audio_cfg["input_frames"]
    )
    segments = torch.from_numpy(segments.astype("float32")).unsqueeze(1)
    with torch.inference_mode():
        predicted_tokens, _ = model.inference_file(bsz=2, audio_segments=segments)
    starts = [
        model.audio_cfg["input_frames"] * index / model.audio_cfg["sample_rate"]
        for index in range(len(segments))
    ]
    notes_by_channel = []
    errors = Counter()
    for channel in range(model.task_manager.num_decoding_channels):
        channel_tokens = [array[:, channel, :] for array in predicted_tokens]
        bundles, _, decode_errors = model.task_manager.detokenize_list_batches(
            channel_tokens, starts, return_events=True
        )
        notes, note_errors = merge_zipped_note_events_and_ties_to_notes(bundles)
        notes_by_channel.append(notes)
        errors += decode_errors
        errors += note_errors
    notes = mix_notes(notes_by_channel)
    events = []
    for note in notes:
        if note.is_drum:
            continue
        program = model.midi_output_inverse_vocab.get(
            note.program, [note.program]
        )[0]
        events.append({
            "start": float(note.onset),
            "end": float(note.offset),
            "midi": int(note.pitch),
            "program": int(program),
            "confidence": 1.0,
        })
    return events


def read_cached_transcription(
    cache_path: Path,
    audio_sha256: str,
    maximum_seconds: float | None,
) -> list[dict[str, Any]] | None:
    expected = {
        "audioSha256": audio_sha256,
        "checkpointSha256": CHECKPOINT_SHA256,
        "maximumSeconds": maximum_seconds,
    }
    if cache_path.is_file():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        if all(cached.get(key) == value for key, value in expected.items()):
            return list(cached.get("events") or [])
    return None


def write_cached_transcription(
    cache_path: Path,
    audio_sha256: str,
    maximum_seconds: float | None,
    events: list[dict[str, Any]],
) -> None:
    expected = {
        "audioSha256": audio_sha256,
        "checkpointSha256": CHECKPOINT_SHA256,
        "maximumSeconds": maximum_seconds,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps({**expected, "events": events}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def cached_transcription(
    model,
    audio_path: Path,
    audio_sha256: str,
    maximum_seconds: float | None,
    cache_path: Path,
) -> list[dict[str, Any]]:
    cached = read_cached_transcription(cache_path, audio_sha256, maximum_seconds)
    if cached is not None:
        return cached
    if model is None:
        raise RuntimeError("yourmt3-model-required-for-cache-miss")
    events = transcribe(model, audio_path, maximum_seconds)
    write_cached_transcription(
        cache_path, audio_sha256, maximum_seconds, events
    )
    return events


def trim_reference(rows: list[dict[str, str]], maximum_seconds: float | None):
    if maximum_seconds is None:
        return rows
    return [row for row in rows if float(row["goldTime"]) < maximum_seconds]


def summarize(reference: list[dict[str, str]], events: list[dict[str, Any]]):
    return {
        f"{round(tolerance * 1000)}ms": evaluate_tolerance(
            reference, events, tolerance
        )
        for tolerance in ONSET_TOLERANCES
    }


def candidate_key(candidate: dict[str, Any]) -> tuple[float, ...]:
    checks = gate_checks(candidate["metrics"])
    metrics = candidate["metrics"]["aggregate"]["100ms"]
    return (
        float(sum(checks.values())),
        float(metrics.get("f1") or 0.0),
        float(metrics.get("recall") or 0.0),
        float(metrics.get("precision") or 0.0),
        -float(candidate["minimumDurationSeconds"]),
    )


def wrap_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    return {"aggregate": metrics}


def evaluate_candidates(reference, raw_events):
    candidates = []
    for group_name, programs in PROGRAM_GROUPS.items():
        projected = [event for event in raw_events if event["program"] in programs]
        for minimum_duration in MIN_DURATIONS:
            filtered = filter_events(projected, 1.0, minimum_duration)
            for time_shift in TIME_SHIFTS:
                shifted = shift_events(filtered, time_shift)
                candidates.append({
                    "programGroup": group_name,
                    "programs": sorted(programs),
                    "minimumDurationSeconds": minimum_duration,
                    "timeShiftSeconds": time_shift,
                    "metrics": wrap_metrics(summarize(reference, shifted)),
                })
    return candidates


def apply_candidate(reference, raw_events, candidate):
    programs = set(candidate["programs"])
    projected = [event for event in raw_events if event["program"] in programs]
    filtered = filter_events(
        projected, 1.0, float(candidate["minimumDurationSeconds"])
    )
    return wrap_metrics(summarize(
        reference, shift_events(filtered, float(candidate["timeShiftSeconds"]))
    ))


def shift_events(events: list[dict[str, Any]], seconds: float):
    return [
        {
            **event,
            "start": max(0.0, float(event["start"]) + seconds),
            "end": max(0.01, float(event["end"]) + seconds),
        }
        for event in events
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--musicnet", type=Path, default=DEFAULT_MUSICNET)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--maximum-seconds", type=float, default=60.0)
    args = parser.parse_args(argv)
    maximum_seconds = args.maximum_seconds if args.maximum_seconds > 0 else None

    require_file(args.source / "model_helper.py", "YourMT3+ source")
    require_file(args.checkpoint, "YourMT3+ checkpoint")
    if sha256_file(args.checkpoint) != CHECKPOINT_SHA256:
        raise SystemExit("yourmt3-checkpoint-sha256-mismatch")
    sample_inputs = []
    for sample in SAMPLES:
        sample_id = str(sample["id"])
        audio = args.musicnet / "raw" / f"{sample_id}.wav"
        labels = args.musicnet / "raw" / f"{sample_id}.csv"
        require_file(audio, f"MusicNet {sample_id} audio")
        require_file(labels, f"MusicNet {sample_id} labels")
        if sha256_file(audio) != sample["audioSha256"]:
            raise SystemExit(f"musicnet-audio-sha256-mismatch:{sample_id}")
        if sha256_file(labels) != sample["labelsSha256"]:
            raise SystemExit(f"musicnet-labels-sha256-mismatch:{sample_id}")
        sample_inputs.append((sample, audio, labels))

    model = None
    results = {}
    raw_program_counts = {}
    for sample, audio, labels in sample_inputs:
        sample_id = str(sample["id"])
        seconds_key = "full" if maximum_seconds is None else f"{maximum_seconds:g}s"
        cache_path = (
            args.output / "cache"
            / f"{sample_id}-{seconds_key}-{CHECKPOINT_SHA256[:12]}.events.json"
        )
        cached = read_cached_transcription(
            cache_path, str(sample["audioSha256"]), maximum_seconds
        )
        if cached is None and model is None:
            model = load_model(args.source)
        events = cached if cached is not None else cached_transcription(
            model, audio, str(sample["audioSha256"]), maximum_seconds, cache_path
        )
        reference = trim_reference(load_violin_reference_rows(labels), maximum_seconds)
        results[sample_id] = {"events": events, "reference": reference}
        counts = Counter(event["program"] for event in events)
        raw_program_counts[sample_id] = dict(sorted(counts.items()))

    development_id = str(next(row["id"] for row in SAMPLES if row["split"] == "development"))
    holdout_id = str(next(row["id"] for row in SAMPLES if row["split"] == "holdout-unseen-performer"))
    candidates = evaluate_candidates(
        results[development_id]["reference"], results[development_id]["events"]
    )
    # A per-recording time shift can look excellent on one performer and invert
    # on the next.  Keep zero shift as the deployment candidate; report the
    # wider timing sweep as a rejected stability probe.
    stable_candidates = [
        candidate for candidate in candidates
        if float(candidate["timeShiftSeconds"]) == 0.0
    ]
    selected = max(stable_candidates, key=candidate_key)
    timing_probe = max(candidates, key=candidate_key)
    holdout = apply_candidate(
        results[holdout_id]["reference"],
        results[holdout_id]["events"],
        selected,
    )
    timing_probe_holdout = apply_candidate(
        results[holdout_id]["reference"],
        results[holdout_id]["events"],
        timing_probe,
    )
    checks = gate_checks(holdout)
    recognition_ready = all(checks.values())
    source_commit = subprocess.check_output(
        ["git", "-C", str(args.source), "rev-parse", "HEAD"], text=True
    ).strip()
    report = {
        "schemaVersion": "western-musicnet-yourmt3-instrument-aware-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "evidenceRole": "public-professional-diagnostic-challenger",
        "maximumSecondsPerRecording": maximum_seconds,
        "selectionDiscipline": (
            "select program projection and duration on MusicNet 2330; freeze before "
            "evaluating MusicNet 2334"
        ),
        "source": {
            "space": "https://huggingface.co/spaces/mimbres/YourMT3",
            "commit": source_commit,
            "stableRelease": False,
            "spaceLicenseDeclared": False,
            "upstreamGithubLicense": "GPL-3.0",
        },
        "model": {
            "checkpoint": args.checkpoint.name,
            "checkpointSha256": CHECKPOINT_SHA256,
            "checkpointLicenseDeclared": False,
        },
        "datasetOverlapRisk": (
            "MusicNet is among YourMT3 training/evaluation sources; these two rows are "
            "architecture diagnostics, not independent release evidence."
        ),
        "gate": GATE,
        "candidateCount": len(candidates),
        "stableCandidateCount": len(stable_candidates),
        "selectedCandidate": {
            key: selected[key]
            for key in (
                "programGroup", "programs", "minimumDurationSeconds", "timeShiftSeconds"
            )
        },
        "development": selected["metrics"],
        "holdout": holdout,
        "timingCalibrationProbe": {
            "selectedOnDevelopment": {
                key: timing_probe[key]
                for key in (
                    "programGroup", "programs", "minimumDurationSeconds", "timeShiftSeconds"
                )
            },
            "development": timing_probe["metrics"],
            "holdout": timing_probe_holdout,
            "accepted": False,
            "reason": "single-recording-global-time-shift-did-not-generalize",
        },
        "holdoutGateChecks": checks,
        "rawProgramCounts": raw_program_counts,
        "accompaniedViolinRecognitionReady": recognition_ready,
        "productionAdoptionReady": False,
        "studentReleaseEligible": False,
        "blockingReasons": [
            *([] if recognition_ready else ["yourmt3-accompanied-violin-gate-failed"]),
            "yourmt3-space-and-checkpoint-license-unresolved",
            "yourmt3-musicnet-training-overlap-risk",
            "student-domain-evidence-not-covered",
        ],
    }
    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.output / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "report": str(report_path.relative_to(REPO)).replace("\\", "/"),
        "selectedCandidate": report["selectedCandidate"],
        "holdout": holdout,
        "ready": recognition_ready,
        "blockingReasons": report["blockingReasons"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
