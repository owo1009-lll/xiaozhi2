from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import wave
from collections import Counter
from pathlib import Path
from typing import Any

import pretty_midi


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO_ROOT / "data" / "external" / "hf2-hardanger-fiddle"
DEFAULT_OUT = REPO_ROOT / "data" / "experiments" / "western-strings-hf2-hardanger-audit.json"
DEFAULT_MARKDOWN = REPO_ROOT / "data" / "experiments" / "western-strings-hf2-hardanger-audit.md"
EXPECTED_REPOSITORY_COMMIT = "b9f5d564bd8f9e7e6a841905681c301229b5d76a"
EXPECTED_MANIFEST_ROWS = 119
EXPECTED_HF1_ROWS = 100
EXPECTED_HF1_SONGS = 20


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_bool(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def read_manifest(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    required = {
        "id",
        "song_name",
        "audio_relpath",
        "midi_relpath",
        "audio_sha256",
        "midi_sha256",
        "has_emotional_variations",
        "emotion",
        "notes",
    }
    if not rows:
        raise ValueError("empty-manifest")
    missing = required - set(rows[0])
    if missing:
        raise ValueError(f"manifest-columns-missing:{','.join(sorted(missing))}")
    return rows


def inspect_wav(path: Path) -> dict[str, Any]:
    with wave.open(str(path), "rb") as handle:
        sample_rate = handle.getframerate()
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        frames = handle.getnframes()
    return {
        "sampleRate": sample_rate,
        "channels": channels,
        "sampleWidthBytes": sample_width,
        "frames": frames,
        "durationSeconds": frames / sample_rate if sample_rate else 0.0,
    }


def onset_polyphony(notes: list[pretty_midi.Note], tolerance_seconds: float = 0.012) -> dict[str, int]:
    if not notes:
        return {"polyphonicOnsetGroupCount": 0, "polyphonicNoteCount": 0, "maxOnsetPolyphony": 0}
    groups: list[list[pretty_midi.Note]] = []
    for note in sorted(notes, key=lambda item: (item.start, item.pitch, item.end)):
        if not groups or note.start - groups[-1][0].start > tolerance_seconds:
            groups.append([note])
        else:
            groups[-1].append(note)
    polyphonic = [group for group in groups if len(group) > 1]
    return {
        "polyphonicOnsetGroupCount": len(polyphonic),
        "polyphonicNoteCount": sum(len(group) for group in polyphonic),
        "maxOnsetPolyphony": max((len(group) for group in groups), default=0),
    }


def inspect_midi(path: Path) -> dict[str, Any]:
    midi = pretty_midi.PrettyMIDI(str(path))
    notes = [note for instrument in midi.instruments for note in instrument.notes]
    pitch_bends = [bend for instrument in midi.instruments for bend in instrument.pitch_bends]
    invalid_notes = [
        note
        for note in notes
        if not all(math.isfinite(value) for value in (note.start, note.end))
        or note.start < 0
        or note.end <= note.start
        or not 0 <= note.pitch <= 127
    ]
    result = {
        "instrumentCount": len(midi.instruments),
        "noteCount": len(notes),
        "pitchBendCount": len(pitch_bends),
        "durationSeconds": midi.get_end_time(),
        "midiMin": min((note.pitch for note in notes), default=None),
        "midiMax": max((note.pitch for note in notes), default=None),
        "invalidNoteCount": len(invalid_notes),
    }
    result.update(onset_polyphony(notes))
    return result


def provenance_for_row(row: dict[str, str]) -> str:
    if parse_bool(row.get("has_emotional_variations")):
        return "hf1-performer-annotated-normal-transferred-and-human-verified-expressive"
    if str(row.get("notes") or "").strip() == "processed":
        return "hf2-processed-derived-midi-provenance-not-independently-reverified-here"
    if str(row.get("notes") or "").strip() == "archival":
        return "hf2-archival-derived-midi-provenance-not-independently-reverified-here"
    return "unknown"


def inspect_pair(root: Path, row: dict[str, str]) -> dict[str, Any]:
    audio_path = root / row["audio_relpath"]
    midi_path = root / row["midi_relpath"]
    issues: list[str] = []
    if not audio_path.is_file():
        issues.append("audio-missing")
    if not midi_path.is_file():
        issues.append("midi-missing")
    if issues:
        return {
            "id": row["id"],
            "songName": row["song_name"],
            "issues": issues,
            "ready": False,
        }
    audio_sha256 = sha256_file(audio_path)
    midi_sha256 = sha256_file(midi_path)
    if audio_sha256 != row["audio_sha256"]:
        issues.append("audio-sha256-mismatch")
    if midi_sha256 != row["midi_sha256"]:
        issues.append("midi-sha256-mismatch")
    try:
        audio = inspect_wav(audio_path)
    except Exception as error:  # pragma: no cover - surfaced in audit output
        audio = {"error": f"{type(error).__name__}:{error}"}
        issues.append("audio-invalid")
    try:
        midi = inspect_midi(midi_path)
    except Exception as error:  # pragma: no cover - surfaced in audit output
        midi = {"error": f"{type(error).__name__}:{error}"}
        issues.append("midi-invalid")
    if not issues:
        if int(midi.get("noteCount") or 0) == 0:
            issues.append("midi-empty")
        if int(midi.get("invalidNoteCount") or 0) > 0:
            issues.append("midi-invalid-notes")
        if float(midi.get("durationSeconds") or 0.0) > float(audio.get("durationSeconds") or 0.0) + 0.1:
            issues.append("midi-exceeds-audio-duration")
    return {
        "id": row["id"],
        "songName": row["song_name"],
        "emotion": row.get("emotion") or "",
        "category": row.get("notes") or "emotional-variant",
        "humanVerifiedHf1": parse_bool(row.get("has_emotional_variations")),
        "goldProvenance": provenance_for_row(row),
        "audioPath": str(audio_path.resolve()),
        "midiPath": str(midi_path.resolve()),
        "audioSha256": audio_sha256,
        "midiSha256": midi_sha256,
        "audio": audio,
        "midi": midi,
        "issues": issues,
        "ready": not issues,
    }


def build_audit(root: Path) -> dict[str, Any]:
    root = root.resolve()
    manifest_path = root / "data" / "manifests" / "manifest.csv"
    readme_path = root / "README.md"
    issues: list[str] = []
    if not manifest_path.is_file():
        return {
            "ok": False,
            "dataset": "HF2 Hardanger Fiddle Dataset",
            "datasetRoot": str(root),
            "readyForExternalHumanVerifiedStressPilot": False,
            "issues": ["manifest-missing"],
        }
    rows = read_manifest(manifest_path)
    readme = readme_path.read_text(encoding="utf-8-sig") if readme_path.is_file() else ""
    license_ok = "license: cc-by-4.0" in readme.lower()
    if not license_ok:
        issues.append("cc-by-4.0-license-not-confirmed")
    if len(rows) != EXPECTED_MANIFEST_ROWS:
        issues.append(f"manifest-row-count:{len(rows)}")
    if len({row["id"] for row in rows}) != len(rows):
        issues.append("duplicate-manifest-id")
    if len({row["audio_relpath"] for row in rows}) != len(rows):
        issues.append("duplicate-audio-path")
    if len({row["midi_relpath"] for row in rows}) != len(rows):
        issues.append("duplicate-midi-path")
    inspected = [inspect_pair(root, row) for row in rows]
    for pair in inspected:
        issues.extend(f"{pair['id']}:{issue}" for issue in pair.get("issues") or [])
    hf1_rows = [pair for pair in inspected if pair.get("humanVerifiedHf1") is True]
    hf1_songs = {pair["songName"] for pair in hf1_rows}
    if len(hf1_rows) != EXPECTED_HF1_ROWS:
        issues.append(f"hf1-row-count:{len(hf1_rows)}")
    if len(hf1_songs) != EXPECTED_HF1_SONGS:
        issues.append(f"hf1-song-count:{len(hf1_songs)}")
    if any(pair.get("ready") is not True for pair in hf1_rows):
        issues.append("hf1-pair-not-ready")
    total_notes = sum(int(pair.get("midi", {}).get("noteCount") or 0) for pair in inspected)
    hf1_notes = sum(int(pair.get("midi", {}).get("noteCount") or 0) for pair in hf1_rows)
    polyphonic_pairs = [
        pair
        for pair in inspected
        if int(pair.get("midi", {}).get("polyphonicOnsetGroupCount") or 0) > 0
    ]
    sample_rates = Counter(int(pair.get("audio", {}).get("sampleRate") or 0) for pair in inspected)
    channels = Counter(int(pair.get("audio", {}).get("channels") or 0) for pair in inspected)
    category_counts = Counter(pair.get("category") or "" for pair in inspected)
    emotion_counts = Counter(pair.get("emotion") or "" for pair in inspected)
    csv_paths = sorted((root / "data" / "raw").glob("csv/**/*.csv"))
    ready = not issues and len(hf1_rows) == EXPECTED_HF1_ROWS
    return {
        "ok": True,
        "dataset": "HF2 Hardanger Fiddle Dataset",
        "datasetRoot": str(root),
        "source": "https://huggingface.co/datasets/Bots4M/HF2-Hardanger-fiddle-dataset",
        "sourceRevision": EXPECTED_REPOSITORY_COMMIT,
        "primaryEvidence": "https://doi.org/10.5334/tismir.139 and https://doi.org/10.5281/zenodo.5624587",
        "license": "CC BY 4.0",
        "scope": "hardanger-fiddle-out-of-domain-expressive-and-polyphonic-stress",
        "manifestSha256": sha256_file(manifest_path),
        "counts": {
            "manifestRows": len(inspected),
            "readyPairs": sum(pair.get("ready") is True for pair in inspected),
            "uniqueSongs": len({pair["songName"] for pair in inspected}),
            "hf1HumanVerifiedRows": len(hf1_rows),
            "hf1HumanVerifiedSongs": len(hf1_songs),
            "hf1HumanVerifiedNotes": hf1_notes,
            "totalMidiNotes": total_notes,
            "polyphonicPairCount": len(polyphonic_pairs),
            "rawHighPrecisionCsvCount": len(csv_paths),
        },
        "sampleRateCounts": dict(sorted(sample_rates.items())),
        "channelCounts": dict(sorted(channels.items())),
        "categoryCounts": dict(sorted(category_counts.items())),
        "emotionCounts": dict(sorted(emotion_counts.items())),
        "goldPolicy": {
            "primaryPilotRows": "has_emotional_variations=true only",
            "primaryPilotProvenance": "normal annotations made by performers; expressive variants transferred then human-verified",
            "otherRows": "audit-only until provenance is separately confirmed",
            "rawCsvCoverage": "one pair only; do not claim all 119 rows preserve original CSV",
        },
        "readyForExternalHumanVerifiedStressPilot": ready,
        "readyForClassicalViolinReleaseBenchmark": False,
        "readyForStudentRelease": False,
        "issues": issues,
        "pairs": inspected,
    }


def render_markdown(report: dict[str, Any]) -> str:
    counts = report.get("counts") or {}
    return "\n".join(
        [
            "# HF2 Hardanger Fiddle Dataset Audit",
            "",
            f"- readyForExternalHumanVerifiedStressPilot: {str(report.get('readyForExternalHumanVerifiedStressPilot') is True).lower()}",
            f"- readyForClassicalViolinReleaseBenchmark: {str(report.get('readyForClassicalViolinReleaseBenchmark') is True).lower()}",
            f"- readyForStudentRelease: {str(report.get('readyForStudentRelease') is True).lower()}",
            f"- manifestRows / readyPairs: {counts.get('manifestRows', 0)} / {counts.get('readyPairs', 0)}",
            f"- HF1 human-verified rows / songs / notes: {counts.get('hf1HumanVerifiedRows', 0)} / {counts.get('hf1HumanVerifiedSongs', 0)} / {counts.get('hf1HumanVerifiedNotes', 0)}",
            f"- polyphonicPairCount: {counts.get('polyphonicPairCount', 0)}",
            f"- rawHighPrecisionCsvCount: {counts.get('rawHighPrecisionCsvCount', 0)}",
            f"- issues: {report.get('issues') or []}",
            "",
            "Only has_emotional_variations=true rows enter the primary human-verified stress pilot. This is Hardanger fiddle evidence, not a classical-violin or student release benchmark.",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit HF2 Hardanger fiddle audio/MIDI pairs and gold provenance.")
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_audit(Path(args.root))
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": report.get("ok"),
                "counts": report.get("counts"),
                "readyForExternalHumanVerifiedStressPilot": report.get(
                    "readyForExternalHumanVerifiedStressPilot"
                ),
                "readyForClassicalViolinReleaseBenchmark": report.get(
                    "readyForClassicalViolinReleaseBenchmark"
                ),
                "readyForStudentRelease": report.get("readyForStudentRelease"),
                "issues": report.get("issues"),
                "out": str(out_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report.get("readyForExternalHumanVerifiedStressPilot") else 2


if __name__ == "__main__":
    raise SystemExit(main())
