#!/usr/bin/env python3
"""Turn compiled solo-violin MIDI into analyzable public-library entries.

Pipeline per etude, reusing exactly the chain the existing 32 Bach entries use
so the geometry matches:

    solo MIDI  ->  MusicXML (music21)  ->  Verovio  ->  SVG pages
                                                    ->  PNG renders
                                                    ->  note/measure boxes

The MIDI itself was transcoded from the publisher's LilyPond source, so pitches
and durations are exact; nothing here is recognition. The renders and the
coordinates come from the SAME Verovio pass, which is what makes on-score
highlighting land on the note the student is actually looking at — deriving one
from the publisher PDF and the other from Verovio would silently misalign them.

    py -3.11 scripts/experiments/build_lilypond_etude_library.py \
        --midi-dir <dir> --piece-prefix <id> --out-root <dir> [--limit N]
"""

from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_CONTRACT = "western-public-multipage-coordinate-sidecar-v1"
RENDER_SCALE = 80
RASTER_ZOOM = 2.0


def local_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def has_class(element: ET.Element, name: str) -> bool:
    return name in (element.get("class") or "").split()


def midi_to_musicxml(midi_path: Path, out_path: Path) -> int:
    from music21 import chord, converter

    score = converter.parse(str(midi_path))
    score.write("musicxml", fp=str(out_path))
    notes = list(score.flatten().notes)
    return sum(len(n.pitches) if isinstance(n, chord.Chord) else 1 for n in notes)


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


def render_with_verovio(musicxml_path: Path, out_dir: Path) -> tuple[list[Path], list[Path]]:
    """Renders SVG (for coordinates) and PNG (for display) from one pass."""
    import os
    import subprocess

    import verovio

    out_dir.mkdir(parents=True, exist_ok=True)
    toolkit = verovio.toolkit()
    toolkit.setOptions({
        "scale": RENDER_SCALE,
        "footer": "none",
        "header": "none",
        "breaks": "auto",
        "adjustPageHeight": False,
    })
    # loadData, not loadFile: this repository lives under a non-ASCII path and
    # Verovio's native file loader cannot open it.
    if not toolkit.loadData(musicxml_path.read_text(encoding="utf-8")):
        raise RuntimeError(f"verovio could not load {musicxml_path}")

    svg_paths: list[Path] = []
    png_paths: list[Path] = []
    for page in range(1, toolkit.getPageCount() + 1):
        svg_text = toolkit.renderToSVG(page)
        # The node rasterizer does not apply Verovio's CSS `{stroke:currentColor}`,
        # which would erase staff lines, stems and barlines. Make stroke explicit.
        svg_text = svg_text.replace("{stroke:currentColor}", "{stroke:#000000}")
        svg_text = svg_text.replace(
            'class="definition-scale" color="black"',
            'class="definition-scale" color="black" stroke="#000000"',
        )
        svg_path = out_dir / f"page-{page:02d}.svg"
        svg_path.write_text(svg_text, encoding="utf-8")
        svg_paths.append(svg_path)

        png_path = out_dir / f"render-page-{page:02d}.png"
        env = {**os.environ, "RG_SVG": str(svg_path), "RG_PNG": str(png_path), "RG_ZOOM": str(RASTER_ZOOM)}
        result = subprocess.run(
            ["node", "--input-type=module", "-"],
            input=RASTERIZE_NODE, text=True, capture_output=True, env=env, cwd=str(REPO_ROOT),
        )
        if result.returncode != 0:
            raise RuntimeError(f"rasterize failed page {page}: {result.stderr[:300]}")
        png_paths.append(png_path)
    return svg_paths, png_paths


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--midi-dir", required=True)
    parser.add_argument("--piece-prefix", required=True)
    parser.add_argument("--out-root", required=True)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    midi_dir = Path(args.midi_dir).resolve()
    out_root = Path(args.out_root).resolve()
    midis = sorted(midi_dir.glob(f"{args.piece_prefix}-no*.mid"))
    if args.limit:
        midis = midis[: args.limit]

    results: list[dict[str, Any]] = []
    for midi_path in midis:
        piece_id = midi_path.stem
        work_dir = out_root / piece_id
        work_dir.mkdir(parents=True, exist_ok=True)

        musicxml_path = work_dir / "score.musicxml"
        xml_notes = midi_to_musicxml(midi_path, musicxml_path)
        svg_paths, png_paths = render_with_verovio(musicxml_path, work_dir)

        results.append({
            "pieceId": piece_id,
            "musicxml": str(musicxml_path.relative_to(REPO_ROOT)).replace("\\", "/"),
            "xmlNotes": xml_notes,
            "pages": len(png_paths),
            "svg": [str(p.relative_to(REPO_ROOT)).replace("\\", "/") for p in svg_paths],
            "renders": [str(p.relative_to(REPO_ROOT)).replace("\\", "/") for p in png_paths],
        })

    print(json.dumps({
        "ok": True,
        "contract": SIDECAR_CONTRACT,
        "renderer": {"id": "verovio", "scale": RENDER_SCALE, "rasterZoom": RASTER_ZOOM},
        "built": len(results),
        "pieces": results,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
