#!/usr/bin/env python3
"""Build independent Kayser Op.20 M4 gold from the editor's LilyPond source."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


ROMAN = {
    4: "IV",
    5: "V",
    13: "XIII",
    16: "XVI",
    18: "XVIII",
}

PHOTO_CASES = {
    "violin-ex09": {"studyNumber": 4, "measureStart": 1, "measureEnd": 18},
    "violin-ex05": {"studyNumber": 5, "measureStart": 1, "measureEnd": 50},
    "violin-ex08": {"studyNumber": 13, "measureStart": 1, "measureEnd": 40},
    "violin-ex10": {"studyNumber": 16, "measureStart": 1, "measureEnd": 27},
    "violin-ex12": {"studyNumber": 18, "measureStart": 1, "measureEnd": 27},
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def extract_lilypond_assignment(source: str, variable: str) -> str:
    match = re.search(rf"(?m)^{re.escape(variable)}\s*=\s*\\relative\b", source)
    if not match:
        raise ValueError(f"Missing LilyPond variable: {variable}")

    brace_start = source.find("{", match.start())
    if brace_start < 0:
        raise ValueError(f"Missing opening brace for {variable}")

    depth = 0
    in_string = False
    escaped = False
    in_comment = False
    index = brace_start
    while index < len(source):
        char = source[index]
        if in_comment:
            if char == "\n":
                in_comment = False
            index += 1
            continue
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == "%":
            in_comment = True
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[match.start() : index + 1]
        index += 1

    raise ValueError(f"Unbalanced braces for {variable}")


def lilypond_executable() -> str:
    command = shutil.which("lilypond")
    if command:
        return command

    winget_root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    matches = sorted(winget_root.glob("LilyPond.LilyPond_*/*/bin/lilypond.exe"))
    if matches:
        return str(matches[-1])
    raise RuntimeError("LilyPond 2.24+ is required but was not found")


def build_lilypond_file(assignment: str, variable: str, snippet: Path) -> str:
    include_path = snippet.resolve().as_posix().replace('"', '\\"')
    return "\n".join(
        [
            '\\version "2.24.4"',
            f'\\include "{include_path}"',
            assignment,
            "",
            "\\score {",
            "  \\new Staff \\with { midiInstrument = #\"violin\" } {",
            f"    \\{variable}",
            "  }",
            "  \\layout {}",
            "  \\midi {}",
            "}",
            "",
        ]
    )


def load_midi_score(midi_path: Path):
    try:
        from music21 import converter
    except ImportError as error:
        raise RuntimeError("music21 is required for MIDI-to-MusicXML conversion") from error

    score = converter.parse(str(midi_path), quantizePost=True)
    score.makeNotation(inPlace=True)
    return score


def write_musicxml(score, musicxml_path: Path) -> None:
    score.write("musicxml", fp=str(musicxml_path))


def write_benchmark_intake(base_intake: Path, out_dir: Path, photo_gold: list[dict]) -> Path:
    with base_intake.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = list(reader.fieldnames or [])
        rows_by_piece = {str(row.get("pieceId") or ""): row for row in reader}

    extra_fields = ["goldProvenance", "goldSourceManifest"]
    fieldnames.extend(field for field in extra_fields if field not in fieldnames)
    output_rows = []
    for gold in photo_gold:
        piece_id = gold["pieceId"]
        if piece_id not in rows_by_piece:
            raise RuntimeError(f"Base intake has no row for {piece_id}")
        row = dict(rows_by_piece[piece_id])
        gold_path = out_dir / gold["path"]
        try:
            relative_gold_path = gold_path.relative_to(Path.cwd()).as_posix()
        except ValueError:
            relative_gold_path = gold_path.as_posix()
        row["requiredCleanScorePath"] = relative_gold_path
        row["goldProvenance"] = "independent-source-derived-gold"
        manifest_path = out_dir / "independent-gold-manifest.json"
        try:
            row["goldSourceManifest"] = manifest_path.relative_to(Path.cwd()).as_posix()
        except ValueError:
            row["goldSourceManifest"] = manifest_path.as_posix()
        row["cleanScoreReviewNotes"] = (
            "Independent Kayser Op.20 source-derived gold; CC-BY-SA-4.0; "
            "photo identity and visible measure range verified before benchmark."
        )
        output_rows.append(row)

    output_path = out_dir / "independent-source-benchmark-intake.csv"
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build independent Kayser Op.20 MusicXML gold from LilyPond source."
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--snippet", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--source-repo", default="https://codeberg.org/pbuettgen/music-scores")
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--studies", nargs="+", type=int, default=sorted(ROMAN))
    parser.add_argument("--base-intake", type=Path)
    args = parser.parse_args()

    unsupported = sorted(set(args.studies) - set(ROMAN))
    if unsupported:
        parser.error(f"Unsupported study numbers: {unsupported}")
    if not args.source.is_file():
        parser.error(f"Source file does not exist: {args.source}")
    if not args.snippet.is_file():
        parser.error(f"Snippet file does not exist: {args.snippet}")

    source_path = args.source.resolve()
    snippet_path = args.snippet.resolve()
    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    source_text = source_path.read_text(encoding="utf-8")
    lilypond = lilypond_executable()
    artifacts = []
    scores_by_study = {}

    for number in args.studies:
        roman = ROMAN[number]
        variable = f"study{roman}"
        prefix = f"kayser-op20-no{number:02d}"
        assignment = extract_lilypond_assignment(source_text, variable)
        lilypond_path = out_dir / f"{prefix}.ly"
        lilypond_path.write_text(
            build_lilypond_file(assignment, variable, snippet_path),
            encoding="utf-8",
            newline="\n",
        )

        output_prefix = out_dir / prefix
        subprocess.run(
            [lilypond, "-dno-point-and-click", f"--output={output_prefix}", str(lilypond_path)],
            check=True,
        )

        midi_candidates = [out_dir / f"{prefix}.midi", out_dir / f"{prefix}.mid"]
        midi_path = next((path for path in midi_candidates if path.is_file()), None)
        if midi_path is None:
            raise RuntimeError(f"LilyPond did not produce MIDI for study {number}")

        musicxml_path = out_dir / f"{prefix}.musicxml"
        score = load_midi_score(midi_path)
        write_musicxml(score, musicxml_path)
        scores_by_study[number] = score
        artifact_paths = [lilypond_path, out_dir / f"{prefix}.pdf", midi_path, musicxml_path]
        artifacts.append(
            {
                "studyNumber": number,
                "studyRoman": roman,
                "photoIds": [
                    piece_id
                    for piece_id, photo_case in PHOTO_CASES.items()
                    if photo_case["studyNumber"] == number
                ],
                "files": {
                    path.suffix.lstrip("."): {
                        "path": path.name,
                        "sha256": sha256(path),
                        "bytes": path.stat().st_size,
                    }
                    for path in artifact_paths
                },
            }
        )

    manifest = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "purpose": "Independent real-photo M4 OMR gold; not derived from Audiveris output.",
        "work": "Heinrich Ernst Kayser, 36 Violin Studies, Op.20",
        "editor": "Philipp Buettgenbach",
        "license": "CC-BY-SA-4.0",
        "sourceRepository": args.source_repo,
        "sourceCommit": args.source_commit,
        "sourcePath": source_path.as_posix(),
        "sourceSha256": sha256(source_path),
        "artifacts": artifacts,
        "limitations": [
            "MusicXML is converted through LilyPond MIDI and music21.",
            "Pitch and rhythmic sequence are suitable for OMR evaluation; engraving details are not gold.",
            "Each photo-to-study identity still requires visual edition verification before benchmark admission.",
        ],
    }
    photo_gold = []
    for piece_id, photo_case in PHOTO_CASES.items():
        study_number = photo_case["studyNumber"]
        if study_number not in scores_by_study:
            continue
        measure_start = photo_case["measureStart"]
        measure_end = photo_case["measureEnd"]
        sliced_score = scores_by_study[study_number].measures(measure_start, measure_end)
        output_path = out_dir / f"{piece_id}.independent-source-gold.musicxml"
        write_musicxml(sliced_score, output_path)
        part = sliced_score.parts[0]
        measures = list(part.getElementsByClass("Measure"))
        photo_gold.append(
            {
                "pieceId": piece_id,
                "studyNumber": study_number,
                "measureStart": measure_start,
                "measureEnd": measure_end,
                "measureCount": len(measures),
                "noteCount": len(list(sliced_score.recurse().notes)),
                "path": output_path.name,
                "sha256": sha256(output_path),
                "bytes": output_path.stat().st_size,
            }
        )
    manifest["photoGold"] = photo_gold
    if args.base_intake:
        base_intake = args.base_intake.resolve()
        if not base_intake.is_file():
            parser.error(f"Base intake does not exist: {base_intake}")
        benchmark_intake = write_benchmark_intake(base_intake, out_dir, photo_gold)
        manifest["benchmarkIntake"] = benchmark_intake.name
    manifest_path = out_dir / "independent-gold-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest_path), "studyCount": len(artifacts)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
