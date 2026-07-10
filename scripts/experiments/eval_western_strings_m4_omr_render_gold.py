#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M4 OMR independent-gold evaluation via render-then-recognize.

Pipeline per piece:
  1. Take a clean MusicXML (.mxl) as INDEPENDENT GOLD (Bach Violin Dataset scores).
  2. Render it to page PNGs with Verovio (digital render domain).
  3. Combine pages into one PDF, run Audiveris -batch -export blind.
  4. Parse recognized MusicXML with music21, compare note sequences vs gold:
     pitch-sequence precision / recall / F1, note counts, measure counts.

Honesty notes (keep in every report):
  - Digital renders are the EASY domain for OMR (clean glyphs, no photo noise).
    Results are an UPPER BOUND; photographed scores will be worse.
  - This is eval-only; nothing here touches the score store or runtime gates.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_AUDIVERIS = REPO / "data" / "tools" / "audiveris" / "extracted" / "Audiveris" / "Audiveris.exe"
DEFAULT_SCORES_DIR = REPO / "音频" / "Bach独奏小提琴数据集" / "bach-violin-dataset" / "scores"
DEFAULT_OUT = REPO / "data" / "experiments" / "western-strings-m4" / "render-gold-omr"


def read_musicxml_text(mxl_path: Path) -> str:
    if zipfile.is_zipfile(mxl_path):
        with zipfile.ZipFile(mxl_path) as z:
            names = [n for n in z.namelist()
                     if n.lower().endswith((".xml", ".musicxml")) and not n.lower().startswith("meta-inf/")]
            if not names:
                raise RuntimeError(f"no musicxml inside {mxl_path}")
            return z.read(names[0]).decode("utf-8")
    return mxl_path.read_text(encoding="utf-8")


def render_pages_to_pngs(mxl_path: Path, out_dir: Path, scale: int, raster_zoom: float) -> list[Path]:
    """Verovio SVG pages -> PNG via node @napi-rs/canvas (same rasterizer as repo MuSViT eval)."""
    import verovio
    tk = verovio.toolkit()
    tk.setOptions({"scale": scale, "footer": "none", "header": "none",
                   "breaks": "auto", "adjustPageHeight": False})
    if not tk.loadData(read_musicxml_text(mxl_path)):
        raise RuntimeError(f"verovio could not load {mxl_path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    pngs: list[Path] = []
    node_code = """
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
const zoom = Number(process.env.RG_ZOOM || '2.5');
const image = await loadImage(process.env.RG_SVG);
const w = Math.round(image.width * zoom), h = Math.round(image.height * zoom);
const canvas = createCanvas(w, h);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
ctx.drawImage(image, 0, 0, w, h);
await fs.writeFile(process.env.RG_PNG, canvas.toBuffer('image/png'));
"""
    for page in range(1, tk.getPageCount() + 1):
        svg_path = out_dir / f"page-{page:02d}.svg"
        png_path = out_dir / f"page-{page:02d}.png"
        svg_text = tk.renderToSVG(page)
        # node rasterizer (resvg) does not apply Verovio's CSS `{stroke:currentColor}`,
        # which erases staff lines/stems/barlines. Make stroke explicit.
        svg_text = svg_text.replace("{stroke:currentColor}", "{stroke:#000000}")
        svg_text = svg_text.replace('class="definition-scale" color="black"',
                                    'class="definition-scale" color="black" stroke="#000000"')
        svg_path.write_text(svg_text, encoding="utf-8")
        env = {**__import__("os").environ,
               "RG_SVG": str(svg_path), "RG_PNG": str(png_path), "RG_ZOOM": str(raster_zoom)}
        res = subprocess.run(["node", "--input-type=module", "-"], input=node_code, text=True,
                             capture_output=True, env=env, cwd=str(REPO))
        if res.returncode != 0:
            raise RuntimeError(f"rasterize failed p{page}: {res.stderr[:300]}")
        pngs.append(png_path)
    return pngs


def degrade_image(png_path: Path, out_path: Path, level: str, seed: int) -> Path:
    """Apply scan-like or photo-like degradation to a clean render (gold stays independent)."""
    import random
    import numpy as np
    from PIL import Image, ImageFilter, ImageEnhance
    rng = random.Random(seed)
    im = Image.open(png_path).convert("L")
    if level == "scan":
        im = im.rotate(rng.uniform(-0.8, 0.8), expand=True, fillcolor=255)  # slight skew
        im = ImageEnhance.Contrast(im).enhance(0.85)
        arr = np.asarray(im).astype(np.int16)
        arr = arr + np.random.default_rng(seed).integers(-14, 14, arr.shape)  # sensor noise
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
        im = im.filter(ImageFilter.GaussianBlur(0.6))
    elif level == "photo":
        w, h = im.size
        dx = int(w * 0.025)
        coeffs = _perspective_coeffs(  # mild keystone warp
            [(0, 0), (w, 0), (w, h), (0, h)],
            [(rng.randint(0, dx), rng.randint(0, dx)), (w - rng.randint(0, dx), rng.randint(0, dx)),
             (w - rng.randint(0, dx), h - rng.randint(0, dx)), (rng.randint(0, dx), h - rng.randint(0, dx))])
        im = im.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=255)
        xx, yy = np.meshgrid(np.linspace(0, 1, im.size[0]), np.linspace(0, 1, im.size[1]))
        shade = 1.0 - 0.25 * ((xx - rng.random()) ** 2 + (yy - rng.random()) ** 2)  # uneven light
        arr = np.asarray(im).astype(np.float32) * shade
        arr = arr + np.random.default_rng(seed).normal(0, 6, arr.shape)
        im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
        im = im.filter(ImageFilter.GaussianBlur(0.9))
        im = ImageEnhance.Contrast(im).enhance(0.8)
    im.convert("RGB").save(out_path, quality=80)
    return out_path


def _perspective_coeffs(src, dst):
    import numpy as np
    matrix = []
    for (x, y), (u, v) in zip(dst, src):
        matrix.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        matrix.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    A = np.array(matrix, dtype=np.float64)
    B = np.array([c for pt in src for c in pt], dtype=np.float64)
    return np.linalg.solve(A, B).tolist()


def pngs_to_book(pngs: list[Path], book_path: Path) -> Path:
    """Multi-page TIFF book for Audiveris (PIL PDF writer needs JPEG codec; TIFF does not)."""
    from PIL import Image
    images = [Image.open(p).convert("RGB") for p in pngs]
    images[0].save(book_path, save_all=True, append_images=images[1:], compression="tiff_deflate")
    return book_path


def run_audiveris(audiveris: Path, pdf_path: Path, out_dir: Path, timeout_s: int) -> tuple[int, list[Path]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(audiveris), "-batch", "-export", "-output", str(out_dir), str(pdf_path)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    (out_dir / "audiveris.log").write_text((res.stdout or "") + "\n" + (res.stderr or ""),
                                           encoding="utf-8", errors="replace")
    mxls = sorted(out_dir.rglob("*.mxl"))
    return res.returncode, mxls


def note_events(mxl_path: Path):
    """music21 -> ordered list of onset events; each event = sorted tuple of midi pitches (chord-aware)."""
    from music21 import converter
    s = converter.parse(str(mxl_path))
    flat = s.flatten()
    events: dict[float, set[int]] = {}
    for n in flat.notes:
        off = float(n.offset)
        ps = {int(p.midi) for p in n.pitches}
        events.setdefault(round(off, 4), set()).update(ps)
    seq = []
    for off in sorted(events):
        seq.extend(sorted(events[off]))
    measures = len(s.parts[0].getElementsByClass("Measure")) if s.parts else 0
    return seq, len(events), measures


def compare(gold_seq: list[int], rec_seq: list[int]) -> dict:
    sm = SequenceMatcher(a=gold_seq, b=rec_seq, autojunk=False)
    matched = sum(b.size for b in sm.get_matching_blocks())
    precision = matched / len(rec_seq) if rec_seq else 0.0
    recall = matched / len(gold_seq) if gold_seq else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"goldNotes": len(gold_seq), "recNotes": len(rec_seq), "matched": matched,
            "pitchPrecision": round(precision, 4), "pitchRecall": round(recall, 4),
            "pitchF1": round(f1, 4)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pieces", nargs="+", required=True,
                    help="score ids like bwv1001_mov3 (resolved under scores/<work>/<id>.mxl)")
    ap.add_argument("--scores-dir", default=str(DEFAULT_SCORES_DIR))
    ap.add_argument("--audiveris", default=str(DEFAULT_AUDIVERIS))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--scale", type=int, default=80)
    ap.add_argument("--zoom", type=float, default=2.1)
    ap.add_argument("--timeout", type=int, default=420)
    ap.add_argument("--degrade", choices=["none", "scan", "photo"], default="none",
                    help="apply synthetic degradation to renders before OMR (gold stays clean)")
    args = ap.parse_args(argv)

    scores_dir = Path(args.scores_dir).resolve()
    out_root = Path(args.out).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    results = []
    for piece in args.pieces:
        work = piece.split("_")[0]
        gold_mxl = scores_dir / work / f"{piece}.mxl"
        pdir = out_root / piece
        row = {"piece": piece, "goldScore": str(gold_mxl.relative_to(REPO))}
        try:
            pngs = render_pages_to_pngs(gold_mxl, pdir / "render", args.scale, args.zoom)
            if args.degrade != "none":
                degraded = []
                for k, p in enumerate(pngs):
                    dp = pdir / "render" / f"degraded-{args.degrade}-{k+1:02d}.png"
                    degraded.append(degrade_image(p, dp, args.degrade, seed=hash(piece) % 9973 + k))
                pngs = degraded
            book = pngs_to_book(pngs, pdir / f"{piece}.tiff")
            code, mxls = run_audiveris(Path(args.audiveris), book, pdir / "omr", args.timeout)
            row.update({"pages": len(pngs), "audiverisExit": code,
                        "recognizedMxl": str(mxls[0].relative_to(REPO)) if mxls else ""})
            if not mxls:
                row["status"] = "omr-no-output"
            else:
                gseq, g_onsets, g_meas = note_events(gold_mxl)
                rseq, r_onsets, r_meas = note_events(mxls[0])
                row.update(compare(gseq, rseq))
                row.update({"goldMeasures": g_meas, "recMeasures": r_meas,
                            "goldOnsets": g_onsets, "recOnsets": r_onsets, "status": "ok"})
        except Exception as exc:  # keep going, report per piece
            row["status"] = f"error: {exc}"[:300]
        results.append(row)
        print(json.dumps(row, ensure_ascii=False))

    ok = [r for r in results if r.get("status") == "ok"]
    summary = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "domain": {"none": "digital-render (UPPER BOUND; photo domain will be worse)",
                   "scan": "synthetic scan-like degradation (skew+noise+blur) on clean renders",
                   "photo": "synthetic photo-like degradation (perspective+shading+noise+blur) on clean renders",
                   }[args.degrade],
        "goldProvenance": "independent clean MusicXML (Bach Violin Dataset, public domain scores)",
        "pieces": results,
        "aggregate": {
            "evaluated": len(ok),
            "meanPitchPrecision": round(sum(r["pitchPrecision"] for r in ok) / len(ok), 4) if ok else None,
            "meanPitchRecall": round(sum(r["pitchRecall"] for r in ok) / len(ok), 4) if ok else None,
            "meanPitchF1": round(sum(r["pitchF1"] for r in ok) / len(ok), 4) if ok else None,
        },
    }
    (out_root / "render-gold-omr-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary["aggregate"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
