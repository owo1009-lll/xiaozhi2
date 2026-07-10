from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any

import pretty_midi


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO_ROOT / "data" / "external" / "violin-midi-dataset" / "extracted"
DEFAULT_ARCHIVE = (
    REPO_ROOT / "data" / "external" / "violin-midi-dataset" / "violin_MIDI_dataset.zip"
)
DEFAULT_OUT = (
    REPO_ROOT / "data" / "experiments" / "western-strings-violin-midi-dataset-audit.json"
)
DEFAULT_MARKDOWN = (
    REPO_ROOT / "data" / "experiments" / "western-strings-violin-midi-dataset-audit.md"
)
EXPECTED_ARCHIVE_BYTES = 51_912_255
EXPECTED_ARCHIVE_MD5 = "d2483df547e7acae40d9ced1b8924363"
MIN_WEAK_LABEL_READY_RATE = 0.98
FILENAME_RE = re.compile(
    r"^(?P<book>[^_]+)_(?P<etude>[^_]+)_(?P<performer>[^_]+)_(?P<video>.+)-(?P<start>\d{4})-(?P<end>\d{4})$"
)


def md5_file(path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 - required to verify the published archive checksum
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def parse_filename(path: Path) -> dict[str, Any]:
    match = FILENAME_RE.match(path.stem)
    if not match:
        raise ValueError(f"filename-format-invalid:{path.name}")
    values = match.groupdict()
    start = int(values["start"])
    end = int(values["end"])
    if end <= start:
        raise ValueError(f"filename-segment-duration-invalid:{path.name}")
    return {
        "book": values["book"],
        "etude": values["etude"],
        "performer": values["performer"],
        "youtubeId": values["video"],
        "youtubeStartSeconds": start,
        "youtubeEndSeconds": end,
        "linkedSegmentDurationSeconds": end - start,
    }


def inspect_midi(path: Path) -> dict[str, Any]:
    source = parse_filename(path)
    midi = pretty_midi.PrettyMIDI(str(path))
    notes = [note for instrument in midi.instruments for note in instrument.notes]
    bends = [bend for instrument in midi.instruments for bend in instrument.pitch_bends]
    issues = []
    if not notes:
        issues.append("midi-notes-empty")
    if any(
        not all(math.isfinite(value) for value in (note.start, note.end))
        or note.end <= note.start
        or not 0 <= int(note.pitch) <= 127
        for note in notes
    ):
        issues.append("midi-note-invalid")
    if any(
        not math.isfinite(float(bend.time)) or not -8192 <= int(bend.pitch) <= 8191
        for bend in bends
    ):
        issues.append("midi-pitch-bend-invalid")
    midi_duration = float(midi.get_end_time())
    linked_duration = int(source["linkedSegmentDurationSeconds"])
    if not math.isfinite(midi_duration) or midi_duration <= 0.0:
        issues.append("midi-duration-invalid")
    if abs(midi_duration - linked_duration) > max(10.0, linked_duration * 0.15):
        issues.append("midi-linked-duration-mismatch")
    return {
        "path": str(path),
        **source,
        "instrumentCount": len(midi.instruments),
        "noteCount": len(notes),
        "pitchBendCount": len(bends),
        "notesWithPitchBendInstrument": sum(
            len(instrument.notes)
            for instrument in midi.instruments
            if instrument.pitch_bends
        ),
        "midiMin": min((int(note.pitch) for note in notes), default=None),
        "midiMax": max((int(note.pitch) for note in notes), default=None),
        "midiDurationSeconds": midi_duration,
        "issues": issues,
        "ready": not issues,
    }


def build_audit(root: Path, archive: Path) -> dict[str, Any]:
    archive_hash = md5_file(archive) if archive.is_file() else None
    archive_report = {
        "path": str(archive),
        "bytes": archive.stat().st_size if archive.is_file() else None,
        "md5": archive_hash,
        "expectedBytes": EXPECTED_ARCHIVE_BYTES,
        "expectedMd5": EXPECTED_ARCHIVE_MD5,
        "verified": bool(
            archive.is_file()
            and archive.stat().st_size == EXPECTED_ARCHIVE_BYTES
            and archive_hash == EXPECTED_ARCHIVE_MD5
        ),
    }
    midi_paths = sorted(
        path
        for path in root.rglob("*.mid")
        if "__MACOSX" not in path.parts and not path.name.startswith("._")
    )
    rows = []
    failures = []
    for path in midi_paths:
        try:
            rows.append(inspect_midi(path))
        except Exception as exc:
            failures.append({"path": str(path), "reason": f"{type(exc).__name__}:{exc}"})
    issue_counts = Counter(issue for row in rows for issue in row["issues"])
    book_counts = Counter(row["book"] for row in rows)
    performer_counts = Counter(row["performer"] for row in rows)
    etude_counts = Counter(f"{row['book']}:{row['etude']}" for row in rows)
    structural_issues = {
        issue: count
        for issue, count in issue_counts.items()
        if issue != "midi-linked-duration-mismatch"
    }
    ready_count = sum(row["ready"] for row in rows)
    ready_rate = ready_count / len(rows) if rows else 0.0
    ready = bool(
        archive_report["verified"]
        and len(rows) == 1021
        and not failures
        and not structural_issues
        and ready_rate >= MIN_WEAK_LABEL_READY_RATE
    )
    return {
        "ok": bool(rows) and not failures,
        "dataset": "Violin MIDI Dataset",
        "source": "https://doi.org/10.5281/zenodo.13736820",
        "license": "CC BY-SA 4.0",
        "archive": archive_report,
        "counts": {
            "midiFileCount": len(rows),
            "readyMidiFileCount": ready_count,
            "quarantinedMidiFileCount": len(rows) - ready_count,
            "readyMidiRate": ready_rate,
            "bookCount": len(book_counts),
            "etudeCount": len(etude_counts),
            "performerCount": len(performer_counts),
            "noteCount": sum(row["noteCount"] for row in rows),
            "pitchBendCount": sum(row["pitchBendCount"] for row in rows),
            "linkedAudioHours": sum(row["linkedSegmentDurationSeconds"] for row in rows) / 3600.0,
            "midiHours": sum(row["midiDurationSeconds"] for row in rows) / 3600.0,
        },
        "bookFileCounts": dict(sorted(book_counts.items())),
        "issueCounts": dict(sorted(issue_counts.items())),
        "structuralIssueCounts": dict(sorted(structural_issues.items())),
        "failures": failures,
        "labelType": "score-aligned-weak-label-midi-with-pitch-bends",
        "audioIncluded": False,
        "humanFrameLevelGold": False,
        "readyAsWeakLabelSource": ready,
        "fullDatasetReady": bool(not failures and not issue_counts and len(rows) == 1021),
        "readyAsIndependentRecognitionBenchmark": False,
        "benchmarkBlockers": [
            "audio-not-included",
            "aligned-midi-is-model-generated-weak-label-not-human-frame-gold",
            "youtube-linked-audio-must-not-be-downloaded-or-redistributed-without-rights-review",
        ],
        "weakLabelUsePolicy": "Use only rows with ready=true. Quarantine linked-duration mismatches; do not rewrite their MIDI or URL ranges.",
        "rows": rows,
    }


def render_markdown(report: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Violin MIDI Dataset Audit",
            "",
            f"- readyAsWeakLabelSource: {str(report['readyAsWeakLabelSource']).lower()}",
            f"- readyAsIndependentRecognitionBenchmark: {str(report['readyAsIndependentRecognitionBenchmark']).lower()}",
            f"- fullDatasetReady: {str(report['fullDatasetReady']).lower()}",
            f"- archive: {report['archive']}",
            f"- counts: {report['counts']}",
            f"- bookFileCounts: {report['bookFileCounts']}",
            f"- issueCounts: {report['issueCounts']}",
            f"- benchmarkBlockers: {report['benchmarkBlockers']}",
            "",
        ]
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit the open Violin MIDI weak-label dataset.")
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--archive", default=str(DEFAULT_ARCHIVE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--markdown", default=str(DEFAULT_MARKDOWN))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_audit(Path(args.root).resolve(), Path(args.archive).resolve())
    out_path = Path(args.out).resolve()
    markdown_path = Path(args.markdown).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(
        json.dumps(
            {
                key: report[key]
                for key in (
                    "ok",
                    "archive",
                    "counts",
                    "bookFileCounts",
                    "issueCounts",
                    "structuralIssueCounts",
                    "readyAsWeakLabelSource",
                    "fullDatasetReady",
                    "readyAsIndependentRecognitionBenchmark",
                    "benchmarkBlockers",
                    "failures",
                )
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["readyAsWeakLabelSource"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
