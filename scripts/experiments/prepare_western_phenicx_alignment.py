from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from audit_western_phenicx_dataset import (  # noqa: E402
    DEFAULT_ROOT,
    EXPECTED_PIECES,
    build_audit,
    natural_track_number,
    parse_annotation,
)


DEFAULT_AUDIT = REPO_ROOT / "data" / "experiments" / "western-strings-phenicx-dataset-audit.json"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "data" / "experiments" / "western-strings-phenicx-adapter"
DEVELOPMENT_PIECES = ("mozart", "beethoven")
HOLDOUT_PIECES = ("mahler", "bruckner")
TARGET_PEAK = 0.95
ZERO_DURATION_REPAIR_SECONDS = 0.05


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_score_timeline(
    score_rows: list[dict[str, Any]],
    gold_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if len(score_rows) != len(gold_rows):
        raise ValueError("score-gold-note-count-mismatch")
    if [row["midi"] for row in score_rows] != [row["midi"] for row in gold_rows]:
        raise ValueError("score-gold-pitch-sequence-mismatch")

    normalized_onsets: list[float] = []
    previous_onset = 0.0
    backward_adjustments = 0
    for index, row in enumerate(score_rows):
        original_onset = float(row["onset"])
        normalized_onset = original_onset if index == 0 else max(previous_onset, original_onset)
        if normalized_onset != original_onset:
            backward_adjustments += 1
        normalized_onsets.append(normalized_onset)
        previous_onset = normalized_onset

    zero_duration_repairs = 0
    chord_sizes = Counter(float(row["onset"]) for row in gold_rows)
    output = []
    for index, (score, gold) in enumerate(zip(score_rows, gold_rows)):
        normalized_onset = normalized_onsets[index]
        original_duration = max(0.0, float(score["offset"]) - float(score["onset"]))
        if original_duration > 0.0:
            normalized_duration = original_duration
        else:
            zero_duration_repairs += 1
            next_onset = next(
                (
                    onset
                    for onset in normalized_onsets[index + 1 :]
                    if onset > normalized_onset
                ),
                None,
            )
            normalized_duration = (
                ZERO_DURATION_REPAIR_SECONDS
                if next_onset is None
                else min(ZERO_DURATION_REPAIR_SECONDS, next_onset - normalized_onset)
            )
            normalized_duration = max(0.001, normalized_duration)
        normalized_offset = normalized_onset + normalized_duration
        output.append(
            {
                "rowIndex": index,
                "midi": int(score["midi"]),
                "noteName": str(score["noteName"]),
                "originalScoreOnset": float(score["onset"]),
                "originalScoreOffset": float(score["offset"]),
                "normalizedScoreOnset": normalized_onset,
                "normalizedScoreOffset": normalized_offset,
                "goldOnset": float(gold["onset"]),
                "goldOffset": float(gold["offset"]),
                "goldChordSize": int(chord_sizes[float(gold["onset"])]),
                "scoreTimeAdjusted": (
                    normalized_onset != float(score["onset"])
                    or original_duration == 0.0
                ),
            }
        )
    return output, {
        "noteCount": len(output),
        "backwardOnsetAdjustmentCount": backward_adjustments,
        "zeroDurationRepairCount": zero_duration_repairs,
        "adjustedNoteCount": sum(row["scoreTimeAdjusted"] for row in output),
        "pitchSequencePreserved": True,
        "rowOrderPreserved": True,
    }


def mix_violin_tracks(
    source_paths: list[Path],
    output_path: Path,
    target_peak: float = TARGET_PEAK,
) -> dict[str, Any]:
    if not source_paths:
        raise ValueError("no-violin-source-tracks")
    accumulator: np.ndarray | None = None
    sample_rate: int | None = None
    frames: int | None = None
    source_rows = []
    for path in source_paths:
        waveform, current_sample_rate = sf.read(path, dtype="float32", always_2d=False)
        if waveform.ndim != 1:
            raise ValueError(f"source-track-not-mono:{path}")
        if not np.isfinite(waveform).all():
            raise ValueError(f"source-track-nonfinite:{path}")
        if sample_rate is None:
            sample_rate = int(current_sample_rate)
            frames = len(waveform)
            accumulator = np.zeros(frames, dtype=np.float64)
        if int(current_sample_rate) != sample_rate or len(waveform) != frames:
            raise ValueError(f"source-track-format-mismatch:{path}")
        assert accumulator is not None
        accumulator += waveform.astype(np.float64)
        source_rows.append(
            {
                "path": str(path),
                "sha256": sha256_file(path),
                "peak": float(np.max(np.abs(waveform))) if len(waveform) else 0.0,
            }
        )
    assert accumulator is not None and sample_rate is not None and frames is not None
    raw_peak = float(np.max(np.abs(accumulator))) if frames else 0.0
    if raw_peak <= 0.0:
        raise ValueError("mixed-violin-audio-is-silent")
    gain = float(target_peak) / raw_peak
    mixed = (accumulator * gain).astype(np.float32)
    if not np.isfinite(mixed).all():
        raise ValueError("mixed-violin-audio-nonfinite")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, mixed, sample_rate, subtype="PCM_16")
    rendered, rendered_sample_rate = sf.read(output_path, dtype="float32", always_2d=False)
    rendered_peak = float(np.max(np.abs(rendered))) if len(rendered) else 0.0
    return {
        "outputPath": str(output_path),
        "outputSha256": sha256_file(output_path),
        "sourceTrackCount": len(source_paths),
        "sourceTracks": source_rows,
        "sampleRate": int(rendered_sample_rate),
        "frames": len(rendered),
        "durationSeconds": len(rendered) / rendered_sample_rate,
        "rawSummedPeak": raw_peak,
        "normalizationGain": gain,
        "targetPeak": float(target_peak),
        "renderedPeak": rendered_peak,
        "finite": bool(np.isfinite(rendered).all()),
        "clippingSampleCount": int(np.sum(np.abs(rendered) >= 0.999)),
    }


def prepare_piece(root: Path, output_dir: Path, piece: str) -> dict[str, Any]:
    source_paths = sorted(
        (root / "audio" / piece).glob("violin*.wav"),
        key=natural_track_number,
    )
    mix_path = output_dir / "audio" / f"{piece}-violin-section-mix.wav"
    audio = mix_violin_tracks(source_paths, mix_path)
    score = parse_annotation(
        root / "annotations" / piece / "violin_o.txt",
        allow_zero_duration=True,
        require_monotonic=False,
    )
    gold = parse_annotation(root / "annotations" / piece / "violin.txt")
    notes, normalization = normalize_score_timeline(score, gold)
    notes_path = output_dir / "notes" / f"{piece}-score-gold.json"
    notes_path.parent.mkdir(parents=True, exist_ok=True)
    notes_path.write_text(json.dumps(notes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    issues = []
    if audio["finite"] is not True:
        issues.append("mixed-audio-nonfinite")
    if audio["clippingSampleCount"] != 0:
        issues.append("mixed-audio-clipping")
    if not (0.90 <= float(audio["renderedPeak"]) <= TARGET_PEAK + 0.001):
        issues.append("mixed-audio-peak-out-of-range")
    if len(notes) != len(gold):
        issues.append("normalized-note-count-mismatch")
    if [row["midi"] for row in notes] != [row["midi"] for row in gold]:
        issues.append("normalized-pitch-sequence-mismatch")
    if any(
        current["normalizedScoreOnset"] < previous["normalizedScoreOnset"]
        for previous, current in zip(notes, notes[1:])
    ):
        issues.append("normalized-score-time-not-monotonic")
    return {
        "piece": piece,
        "split": "development" if piece in DEVELOPMENT_PIECES else "holdout",
        "audio": audio,
        "notesPath": str(notes_path),
        "notesSha256": sha256_file(notes_path),
        "normalization": normalization,
        "issues": issues,
        "ready": not issues,
    }


def build_manifest(root: Path, output_dir: Path) -> dict[str, Any]:
    dataset_audit = build_audit(root, root.parent / "PHENICX-Anechoic_1.zip")
    if dataset_audit["readyForAlignmentBenchmark"] is not True:
        raise RuntimeError("phenicx-dataset-audit-not-ready")
    pieces = [prepare_piece(root, output_dir, piece) for piece in EXPECTED_PIECES]
    issues = [
        f"{piece['piece']}:{issue}"
        for piece in pieces
        for issue in piece["issues"]
    ]
    split_counts = Counter(piece["split"] for piece in pieces if piece["ready"])
    ready = not issues and len(pieces) == 4 and split_counts == {"development": 2, "holdout": 2}
    return {
        "ok": True,
        "dataset": "PHENICX-Anechoic",
        "source": "https://doi.org/10.5281/zenodo.1289821",
        "licenseScope": "local-noncommercial-no-redistribution",
        "mixPolicy": "equal-sum-all-synchronized-violin-tracks-then-peak-normalize",
        "scoreTimePolicy": "preserve-source-row-order-and-pitch-mapping; cumulative-max backward onsets; repair zero durations to <=50ms",
        "splitPolicy": {
            "development": list(DEVELOPMENT_PIECES),
            "holdout": list(HOLDOUT_PIECES),
        },
        "pieces": pieces,
        "counts": {
            "pieceCount": len(pieces),
            "readyPieceCount": sum(piece["ready"] for piece in pieces),
            "developmentPieceCount": split_counts["development"],
            "holdoutPieceCount": split_counts["holdout"],
            "noteCount": sum(piece["normalization"]["noteCount"] for piece in pieces),
            "sourceTrackCount": sum(piece["audio"]["sourceTrackCount"] for piece in pieces),
            "adjustedScoreNoteCount": sum(piece["normalization"]["adjustedNoteCount"] for piece in pieces),
        },
        "adapterReady": ready,
        "issues": issues,
    }


def render_markdown(manifest: dict[str, Any]) -> str:
    lines = [
        "# PHENICX Violin Alignment Adapter",
        "",
        f"- adapterReady: {str(manifest['adapterReady']).lower()}",
        f"- counts: {manifest['counts']}",
        f"- splitPolicy: {manifest['splitPolicy']}",
        f"- issues: {manifest['issues']}",
        "",
        "| Piece | Split | Tracks | Notes | Adjusted score notes | Peak | Clipping | Ready |",
        "|---|---|---:|---:|---:|---:|---:|---|",
    ]
    for piece in manifest["pieces"]:
        lines.append(
            "| {piece} | {split} | {tracks} | {notes} | {adjusted} | {peak:.6f} | {clipping} | {ready} |".format(
                piece=piece["piece"],
                split=piece["split"],
                tracks=piece["audio"]["sourceTrackCount"],
                notes=piece["normalization"]["noteCount"],
                adjusted=piece["normalization"]["adjustedNoteCount"],
                peak=piece["audio"]["renderedPeak"],
                clipping=piece["audio"]["clippingSampleCount"],
                ready=str(piece["ready"]).lower(),
            )
        )
    lines.append("")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build deterministic PHENICX violin-section mixes and score/gold mappings.")
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = build_manifest(root, output_dir)
    manifest_path = output_dir / "manifest.json"
    markdown_path = output_dir / "manifest.md"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(manifest), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0 if manifest["adapterReady"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
