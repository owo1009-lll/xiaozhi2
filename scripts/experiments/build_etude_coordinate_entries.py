#!/usr/bin/env python3
"""Build display renders and note coordinates for LilyPond-sourced etudes.

One LilyPond compile emits the publisher's own engraving (fingerings, bowings,
slurs intact) as SVG plus the exact MIDI. Tagging grobs via output-attributes
makes staves, barlines and noteheads addressable, so the picture the student
sees and the coordinates used for on-score highlighting come from the SAME
pass — deriving them from different renderers is what silently misaligns them.

Score order is rebuilt from geometry (noteheads grouped by tagged staff, sorted
left to right). That is the only inferred step, so it is verified against the
MIDI pitch sequence: on a staff higher pitch sits higher, so pitch must
correlate with -y inside every system. A wrong order collapses that number.

    py -3.11 scripts/experiments/build_etude_coordinate_entries.py \
        --source-dir <lys dir> --wrapper-template sitt|buettgenbach \
        --midi-dir <dir> --piece-prefix <id> --out-root <dir> [--limit N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
LILYPOND = Path(os.environ.get("LOCALAPPDATA", "")) / (
    "Microsoft/WinGet/Packages/LilyPond.LilyPond_Microsoft.Winget.Source_8wekyb3d8bbwe"
    "/lilypond-2.24.4/bin/lilypond.exe"
)
SIDECAR_CONTRACT = "western-public-multipage-coordinate-sidecar-v1"
RASTER_ZOOM = 2.0
MIN_CORRELATION = 0.90

TRANSLATE = re.compile(r"translate\(\s*(-?[\d.]+)\s*,?\s*(-?[\d.]+)?\s*\)")

RASTERIZE_NODE = """
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
const zoom = Number(process.env.RG_ZOOM || '2');
const image = await loadImage(process.env.RG_SVG);
const w = Math.round(image.width * zoom), h = Math.round(image.height * zoom);
const canvas = createCanvas(w, h);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
ctx.drawImage(image, 0, 0, w, h);
await fs.writeFile(process.env.RG_PNG, canvas.toBuffer('image/png'));
"""

TAGGED_STAFF = """  \\new Staff \\with {
    \\override NoteHead.output-attributes = #'((class . "lynotehead"))
    \\override BarLine.output-attributes = #'((class . "lybarline"))
    \\override StaffSymbol.output-attributes = #'((class . "lystaff"))
    \\override Tie.output-attributes = #'((class . "lytie"))
  }"""


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def collect(element: ET.Element, x: float, y: float, wanted: str,
            out: list[dict[str, float]], inside: bool) -> None:
    transform = element.get("transform") or ""
    match = TRANSLATE.search(transform)
    if match:
        x += float(match.group(1))
        y += float(match.group(2) or 0.0)
    tagged = inside or wanted in (element.get("class") or "").split()
    if tagged and local(element.tag) in {"path", "rect", "line", "polygon"}:
        out.append({"x": x, "y": y})
        if wanted != "lystaff":
            return
    for child in element:
        collect(child, x, y, wanted, out, tagged)


def parse_svg(svg_path: Path) -> dict[str, Any]:
    root = ET.parse(svg_path).getroot()
    view = (root.get("viewBox") or "").split()
    if len(view) != 4:
        raise RuntimeError(f"{svg_path.name}: no viewBox")
    min_x, min_y, width, height = (float(v) for v in view)

    result: dict[str, Any] = {"viewBox": [min_x, min_y, width, height]}
    for wanted in ("lynotehead", "lybarline", "lystaff", "lytie"):
        found: list[dict[str, float]] = []
        collect(root, 0.0, 0.0, wanted, found, False)
        result[wanted] = found
    return result


def staff_bands(staff_marks: list[dict[str, float]]) -> list[tuple[float, float]]:
    """Each tagged StaffSymbol draws five lines; group them into y bands."""
    if not staff_marks:
        return []
    ys = sorted(mark["y"] for mark in staff_marks)
    gaps = [ys[i + 1] - ys[i] for i in range(len(ys) - 1)]
    typical = statistics.median([g for g in gaps if g > 0] or [1.0])
    bands: list[list[float]] = [[ys[0]]]
    for index in range(1, len(ys)):
        if ys[index] - ys[index - 1] > typical * 4:
            bands.append([])
        bands[-1].append(ys[index])
    return [(min(b) - (max(b) - min(b)), max(b) + (max(b) - min(b))) for b in bands]


def pearson(a: list[float], b: list[float]) -> float:
    if len(a) < 3:
        return 1.0
    mean_a, mean_b = statistics.fmean(a), statistics.fmean(b)
    num = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
    den = (sum((x - mean_a) ** 2 for x in a) ** 0.5) * (sum((y - mean_b) ** 2 for y in b) ** 0.5)
    return num / den if den else 0.0


def musicxml_pitches(musicxml_path: Path) -> list[int]:
    """Pitches in score order, from the same MusicXML the score store imports.

    MIDI is not the right yardstick here: a tie across a barline is one sounded
    note but two MusicXML notes and two engraved noteheads, so comparing against
    MIDI would report a phantom mismatch on every tied piece.
    """
    from music21 import chord, converter

    pitches: list[int] = []
    for element in converter.parse(str(musicxml_path)).flatten().notes:
        if isinstance(element, chord.Chord):
            pitches.extend(sorted(p.midi for p in element.pitches))
        else:
            pitches.append(element.pitch.midi)
    return pitches


def wrapper_source(template: str, include_name: str, variable: str) -> str:
    includes = ['\\include "defs.ly"', f'\\include "{include_name}"'] if template == "sitt" \
        else [f'\\include "{include_name}"']
    return "\n".join([
        '\\version "2.24.4"',
        *includes,
        "\\score {",
        TAGGED_STAFF,
        f"  \\{variable}",
        "  \\layout { }",
        "  \\midi { }",
        "}",
        "",
    ])


def rasterize(svg_path: Path, png_path: Path) -> None:
    env = {**os.environ, "RG_SVG": str(svg_path), "RG_PNG": str(png_path), "RG_ZOOM": str(RASTER_ZOOM)}
    result = subprocess.run(
        ["node", "--input-type=module", "-"],
        input=RASTERIZE_NODE, text=True, capture_output=True, env=env, cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        raise RuntimeError(f"rasterize failed: {result.stderr[:300]}")


def build_piece(piece_id: str, svg_paths: list[Path], musicxml_path: Path,
                out_dir: Path, edition_id: str) -> dict[str, Any]:
    pitches = musicxml_pitches(musicxml_path)
    pages: list[dict[str, Any]] = []
    notes: list[dict[str, Any]] = []
    measures: list[dict[str, Any]] = []
    correlations: list[float] = []
    cursor = 0
    measure_index = 0

    dropped_unisons = 0

    for page_index, svg_path in enumerate(svg_paths):
        parsed = parse_svg(svg_path)
        min_x, min_y, width, height = parsed["viewBox"]
        bands = staff_bands(parsed["lystaff"])

        png_path = out_dir / f"render-page-{page_index + 1:02d}.png"
        rasterize(svg_path, png_path)
        pages.append({
            "pageIndex": page_index,
            "pageNumber": page_index + 1,
            "svgViewBox": [min_x, min_y, width, height],
            "render": png_path.name,
        })

        for band_top, band_bottom in bands:
            in_band = [n for n in parsed["lynotehead"] if band_top <= n["y"] <= band_bottom]
            # Chord tones share an x; MIDI sorts simultaneous notes by ascending
            # pitch, and higher pitch sits at a smaller y, so break ties on -y.
            in_band.sort(key=lambda n: (round(n["x"], 3), -n["y"]))

            # The score store is filled from MusicXML, where a tie across a
            # barline is TWO note elements — exactly the two noteheads LilyPond
            # draws. So tie continuations are kept: dropping them would make the
            # sidecar shorter than the note list it has to index into.
            # A unison double stop is different: one staff position, two heads,
            # one note. That duplicate still has to go.
            drop: set[int] = set()
            for i in range(1, len(in_band)):
                if i in drop:
                    continue
                previous = in_band[i - 1]
                # A unison double stop sits on one staff position, so LilyPond
                # nudges the second head sideways by about one head width.
                if abs(in_band[i]["y"] - previous["y"]) < 0.30 and abs(in_band[i]["x"] - previous["x"]) < 1.5:
                    drop.add(i)
                    dropped_unisons += 1
            in_band = [n for i, n in enumerate(in_band) if i not in drop]
            window = pitches[cursor:cursor + len(in_band)]
            if len(window) == len(in_band) and len(in_band) >= 3:
                correlations.append(pearson([-n["y"] for n in in_band], [float(p) for p in window]))

            bars = sorted(b["x"] for b in parsed["lybarline"] if band_top <= b["y"] <= band_bottom)
            for note in in_band:
                measure_of = sum(1 for bar in bars if bar < note["x"])
                notes.append({
                    "xmlPitchedNoteIndex": cursor,
                    "noteId": "",
                    "pageIndex": page_index,
                    "pageNumber": page_index + 1,
                    "systemMeasureOffset": measure_of,
                    # LilyPond anchors a notehead path at the glyph's left edge,
                    # so the box is grown rightwards to sit on the head itself
                    # rather than half a head to its left.
                    "bboxNormalized": [
                        round((note["x"] - min_x) / width, 8),
                        round((note["y"] - min_y - 0.55) / height, 8),
                        round((note["x"] - min_x + 1.2) / width, 8),
                        round((note["y"] - min_y + 0.55) / height, 8),
                    ],
                })
                cursor += 1

            previous = None
            for bar in bars:
                measure_index += 1
                measures.append({
                    "globalMeasureIndex": measure_index,
                    "pageIndex": page_index,
                    "pageNumber": page_index + 1,
                    "bboxNormalized": [
                        round(((previous if previous is not None else min_x) - min_x) / width, 8),
                        round((band_top - min_y) / height, 8),
                        round((bar - min_x) / width, 8),
                        round((band_bottom - min_y) / height, 8),
                    ],
                })
                previous = bar

    for index, note in enumerate(notes):
        note["xmlPitchedNoteIndex"] = index

    worst = min(correlations) if correlations else 1.0
    return {
        "contract": SIDECAR_CONTRACT,
        "pieceId": piece_id,
        "editionId": edition_id,
        "renderer": {"id": "lilypond", "version": "2.24.4", "rasterZoom": RASTER_ZOOM},
        "counts": {
            "pages": len(pages),
            "systems": sum(len(staff_bands(parse_svg(p)["lystaff"])) for p in svg_paths),
            "staves": 0,
            "measures": len(measures),
            "notes": len(notes),
        },
        "verification": {
            "musicxmlNotes": len(pitches),
            "noteheads": len(notes),
            "droppedUnisonDuplicates": dropped_unisons,
            "countsMatch": len(pitches) == len(notes),
            "worstSystemPitchYCorrelation": round(worst, 4),
            "correlationThreshold": MIN_CORRELATION,
            "passed": len(pitches) == len(notes) and worst >= MIN_CORRELATION,
        },
        "pages": pages,
        "systems": [],
        "staves": [],
        "measures": measures,
        "notes": notes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--wrapper-template", choices=["sitt", "buettgenbach"], required=True)
    parser.add_argument("--master", default="")
    parser.add_argument("--midi-dir", required=True)
    parser.add_argument("--piece-prefix", required=True)
    parser.add_argument("--edition-id", required=True)
    parser.add_argument("--out-root", required=True)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    source_dir = Path(args.source_dir).resolve()
    midi_dir = Path(args.midi_dir).resolve()
    out_root = Path(args.out_root).resolve()
    out_root.mkdir(parents=True, exist_ok=True)

    ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}

    def roman_to_int(roman: str) -> int:
        total = 0
        for i, ch in enumerate(roman):
            value = ROMAN[ch]
            nxt = ROMAN.get(roman[i + 1]) if i + 1 < len(roman) else None
            total += -value if (nxt and value < nxt) else value
        return total

    jobs: list[tuple[int, str, str]] = []  # (number, include file, variable)
    if args.wrapper_template == "sitt":
        for path in sorted(source_dir.glob("[0-9]*.ly"), key=lambda p: int(p.stem)):
            text = path.read_text(encoding="utf-8", errors="replace")
            match = re.search(r"^\s*([A-Za-z]+)\s*=\s*\\relative", text, re.M)
            if match:
                jobs.append((int(path.stem), path.name, match.group(1)))
    else:
        master = Path(args.master).resolve()
        text = master.read_text(encoding="utf-8", errors="replace")
        for name in sorted(set(re.findall(r"^(study[IVXLC]+)\s*=", text, re.M))):
            jobs.append((roman_to_int(name[len("study"):]), master.name, name))
        jobs.sort()

    if args.limit:
        jobs = jobs[: args.limit]

    built: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for number, include_name, variable in jobs:
        piece_id = f"{args.piece_prefix}-no{number:02d}"
        wrapper = source_dir / f"_coord-{variable}.ly"
        wrapper.write_text(wrapper_source(args.wrapper_template, include_name, variable), encoding="utf-8")
        stem = f"_coordout-{variable}"
        # A previous run may have written a different page split under the same
        # stem; leaving those behind would silently double-count noteheads.
        for stale in source_dir.glob(f"{stem}*.svg"):
            stale.unlink()
        subprocess.run(
            [str(LILYPOND), "-s", "-dbackend=svg", f"--output={stem}", wrapper.name],
            cwd=str(source_dir), capture_output=True, text=True, timeout=600,
        )
        svgs = sorted(source_dir.glob(f"{stem}*.svg"))
        out_dir = out_root / piece_id
        # The MusicXML is the yardstick, because it is what the score store
        # imports and therefore what the sidecar has to index into.
        musicxml_path = out_dir / "score.musicxml"
        if not svgs or not musicxml_path.exists():
            failed.append({"pieceId": piece_id, "reason": "svg or musicxml missing"})
            continue

        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            sidecar = build_piece(piece_id, svgs, musicxml_path, out_dir, args.edition_id)
        except Exception as error:  # noqa: BLE001
            failed.append({"pieceId": piece_id, "reason": str(error)[:200]})
            continue

        (out_dir / "coordinates.json").write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=2), encoding="utf-8")
        built.append({
            "pieceId": piece_id,
            "pages": sidecar["counts"]["pages"],
            "notes": sidecar["counts"]["notes"],
            "measures": sidecar["counts"]["measures"],
            "passed": sidecar["verification"]["passed"],
            "correlation": sidecar["verification"]["worstSystemPitchYCorrelation"],
        })

    not_passed = [row for row in built if not row["passed"]]
    print(json.dumps({
        "ok": not failed and not not_passed,
        "built": len(built),
        "failed": failed,
        "verificationFailures": not_passed,
        "pieces": built,
    }, ensure_ascii=False, indent=2))
    return 0 if (not failed and not not_passed) else 1


if __name__ == "__main__":
    raise SystemExit(main())
