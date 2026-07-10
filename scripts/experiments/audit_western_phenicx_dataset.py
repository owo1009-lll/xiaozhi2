from __future__ import annotations

import argparse
import hashlib
import json
import re
import wave
from collections import Counter
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO_ROOT / "data" / "external" / "phenicx-anechoic" / "PHENICX-Anechoic"
DEFAULT_ARCHIVE = DEFAULT_ROOT.parent / "PHENICX-Anechoic_1.zip"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-phenicx-dataset-audit.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-phenicx-dataset-audit.md"
EXPECTED_PIECES = ("mozart", "beethoven", "mahler", "bruckner")
EXPECTED_ARCHIVE_BYTES = 736_199_301
EXPECTED_ARCHIVE_MD5 = "9ba83a1beef6cb44ec7c7b96853263a9"
NOTE_RE = re.compile(r"^([A-Ga-g])([#b]?)(-?\d+)$")
SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def note_name_to_midi(note_name: str) -> int:
    match = NOTE_RE.fullmatch(note_name.strip())
    if not match:
        raise ValueError(f"invalid-note-name:{note_name}")
    step, accidental, octave_text = match.groups()
    semitone = SEMITONES[step.upper()]
    if accidental == "#":
        semitone += 1
    elif accidental == "b":
        semitone -= 1
    return (int(octave_text) + 1) * 12 + semitone


def parse_annotation(
    path: Path,
    *,
    allow_zero_duration: bool = False,
    require_monotonic: bool = True,
) -> list[dict[str, Any]]:
    rows = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 3:
            raise ValueError(f"invalid-annotation-row:{path}:{line_number}")
        onset = float(fields[0])
        offset = float(fields[1])
        if onset < 0 or offset < onset or (offset == onset and not allow_zero_duration):
            raise ValueError(f"invalid-annotation-time:{path}:{line_number}")
        rows.append(
            {
                "onset": onset,
                "offset": offset,
                "noteName": fields[2],
                "midi": note_name_to_midi(fields[2]),
            }
        )
    if not rows:
        raise ValueError(f"empty-annotation:{path}")
    if require_monotonic and any(
        current["onset"] < previous["onset"]
        for previous, current in zip(rows, rows[1:])
    ):
        raise ValueError(f"non-monotonic-annotation:{path}")
    return rows


def natural_track_number(path: Path) -> int:
    match = re.search(r"(\d+)$", path.stem)
    return int(match.group(1)) if match else 0


def inspect_wav(path: Path) -> dict[str, Any]:
    with wave.open(str(path), "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        frames = handle.getnframes()
    return {
        "path": str(path),
        "sampleRate": sample_rate,
        "channels": channels,
        "sampleWidthBytes": sample_width,
        "frames": frames,
        "durationSeconds": frames / sample_rate if sample_rate else 0.0,
    }


def file_md5(path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 - checksum is fixed by the data publisher
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_piece(root: Path, piece: str) -> dict[str, Any]:
    annotation_dir = root / "annotations" / piece
    audio_dir = root / "audio" / piece
    aligned_path = annotation_dir / "violin.txt"
    score_path = annotation_dir / "violin_o.txt"
    issues = []
    if not aligned_path.is_file():
        issues.append("aligned-violin-annotation-missing")
    if not score_path.is_file():
        issues.append("unaligned-violin-score-missing")
    audio_paths = sorted(audio_dir.glob("violin*.wav"), key=natural_track_number)
    if not audio_paths:
        issues.append("violin-audio-tracks-missing")
    if issues:
        return {"piece": piece, "issues": issues, "ready": False}

    aligned = parse_annotation(aligned_path)
    score = parse_annotation(
        score_path,
        allow_zero_duration=True,
        require_monotonic=False,
    )
    audio = [inspect_wav(path) for path in audio_paths]
    pitch_sequence_equal = [row["midi"] for row in aligned] == [row["midi"] for row in score]
    if len(aligned) != len(score):
        issues.append("score-gold-note-count-mismatch")
    if not pitch_sequence_equal:
        issues.append("score-gold-pitch-sequence-mismatch")
    formats = {
        (row["sampleRate"], row["channels"], row["sampleWidthBytes"])
        for row in audio
    }
    durations = [row["durationSeconds"] for row in audio]
    if len(formats) != 1:
        issues.append("violin-track-format-mismatch")
    if max(durations) - min(durations) > 0.001:
        issues.append("violin-track-duration-mismatch")
    gold_end = max(row["offset"] for row in aligned)
    if gold_end > min(durations) + 0.001:
        issues.append("gold-exceeds-audio-duration")
    onset_counts = Counter(row["onset"] for row in aligned)
    backward_score_steps = [
        previous["onset"] - current["onset"]
        for previous, current in zip(score, score[1:])
        if current["onset"] < previous["onset"]
    ]
    return {
        "piece": piece,
        "audioTrackCount": len(audio),
        "audioTracks": audio,
        "noteCount": len(aligned),
        "scoreNoteCount": len(score),
        "zeroDurationScoreNoteCount": sum(row["offset"] == row["onset"] for row in score),
        "backwardScoreOnsetCount": len(backward_score_steps),
        "maxBackwardScoreOnsetSeconds": max(backward_score_steps, default=0.0),
        "scoreTimelineNormalizationRequired": bool(backward_score_steps),
        "pitchSequenceEqual": pitch_sequence_equal,
        "uniqueOnsetCount": len(onset_counts),
        "maxPolyphony": max(onset_counts.values()),
        "midiMin": min(row["midi"] for row in aligned),
        "midiMax": max(row["midi"] for row in aligned),
        "goldEndSeconds": gold_end,
        "audioDurationSeconds": min(durations),
        "issues": issues,
        "ready": not issues,
    }


def build_audit(root: Path, archive_path: Path | None = None) -> dict[str, Any]:
    root = root.resolve()
    readme_path = root / "Readme.txt"
    readme_text = readme_path.read_text(encoding="utf-8-sig") if readme_path.is_file() else ""
    license_ok = (
        "non-commercial use only" in readme_text
        and "You can not redistribute them nor modify them" in readme_text
    )
    archive = None
    if archive_path is not None:
        archive_path = archive_path.resolve()
        if archive_path.is_file():
            archive_md5 = file_md5(archive_path)
            archive = {
                "path": str(archive_path),
                "bytes": archive_path.stat().st_size,
                "md5": archive_md5,
                "expectedBytes": EXPECTED_ARCHIVE_BYTES,
                "expectedMd5": EXPECTED_ARCHIVE_MD5,
                "verified": (
                    archive_path.stat().st_size == EXPECTED_ARCHIVE_BYTES
                    and archive_md5 == EXPECTED_ARCHIVE_MD5
                ),
            }
        else:
            archive = {"path": str(archive_path), "missing": True, "verified": False}
    pieces = [inspect_piece(root, piece) for piece in EXPECTED_PIECES]
    total_notes = sum(int(piece.get("noteCount") or 0) for piece in pieces)
    total_tracks = sum(int(piece.get("audioTrackCount") or 0) for piece in pieces)
    issues = []
    if not readme_path.is_file():
        issues.append("readme-missing")
    if not license_ok:
        issues.append("noncommercial-no-redistribution-license-not-confirmed")
    if archive is not None and not archive.get("verified"):
        issues.append("archive-checksum-invalid")
    for piece in pieces:
        issues.extend(f"{piece['piece']}:{issue}" for issue in piece.get("issues") or [])
    ready = not issues and len(pieces) == len(EXPECTED_PIECES)
    return {
        "ok": True,
        "dataset": "PHENICX-Anechoic",
        "datasetRoot": str(root),
        "source": "https://doi.org/10.5281/zenodo.1289821",
        "license": {
            "annotations": "CC BY-NC-SA; non-commercial only; no redistribution or modification",
            "audio": "rights and redistribution policy remain with Aalto University and named rights holders",
            "localResearchOnly": True,
            "redistributionAllowed": False,
            "licenseEvidenceFound": license_ok,
        },
        "archive": archive,
        "pieces": pieces,
        "counts": {
            "pieceCount": len(pieces),
            "readyPieceCount": sum(piece.get("ready") is True for piece in pieces),
            "violinAudioTrackCount": total_tracks,
            "goldNoteCount": total_notes,
        },
        "goldType": "manually-aligned-per-instrument-note-onset-offset-text",
        "scoreType": "unaligned-original-score-note-onset-offset-text",
        "adapterRequirement": "mix-all-synchronized-violin-tracks-per-piece-before-evaluation",
        "readyForAlignmentBenchmark": ready,
        "issues": issues,
    }


def render_markdown(report: dict[str, Any]) -> str:
    rows = [
        "# PHENICX-Anechoic Dataset Audit",
        "",
        f"- readyForAlignmentBenchmark: {str(report['readyForAlignmentBenchmark']).lower()}",
        f"- counts: {report['counts']}",
        f"- goldType: {report['goldType']}",
        f"- adapterRequirement: {report['adapterRequirement']}",
        f"- issues: {report['issues']}",
        "",
        "| Piece | Tracks | Notes | Unique onsets | Max polyphony | MIDI range | Duration | Ready |",
        "|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for piece in report["pieces"]:
        rows.append(
            "| {piece} | {tracks} | {notes} | {onsets} | {polyphony} | {low}-{high} | {duration:.3f}s | {ready} |".format(
                piece=piece["piece"],
                tracks=piece.get("audioTrackCount", 0),
                notes=piece.get("noteCount", 0),
                onsets=piece.get("uniqueOnsetCount", 0),
                polyphony=piece.get("maxPolyphony", 0),
                low=piece.get("midiMin", ""),
                high=piece.get("midiMax", ""),
                duration=float(piece.get("audioDurationSeconds") or 0.0),
                ready=str(piece.get("ready") is True).lower(),
            )
        )
    rows.extend(
        [
            "",
            "The dataset is local non-commercial research material. Do not commit or redistribute audio or annotations.",
            "",
        ]
    )
    return "\n".join(rows)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit local PHENICX violin audio and manually aligned note annotations.")
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--archive", default=str(DEFAULT_ARCHIVE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_audit(Path(args.root), Path(args.archive) if args.archive else None)
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["readyForAlignmentBenchmark"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
