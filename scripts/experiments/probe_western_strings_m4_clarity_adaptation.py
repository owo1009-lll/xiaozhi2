#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build a tiny Clarity-OMR adaptation sample without touching blind photo gold.

The official training generator uses CairoSVG. On this Windows workspace Cairo's
native DLL is unavailable, while the repository already has a working SVG
rasterizer through ``@napi-rs/canvas``. This probe swaps only that rasterization
backend, then asks the unmodified Clarity generator to create staff crops and
staff-level token labels from one independent Bach MusicXML score.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image


REPO = Path(__file__).resolve().parents[2]
DEFAULT_CLARITY_TRAIN = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-train-source-audit"
)
DEFAULT_SCORE = (
    REPO
    / "音频"
    / "Bach独奏小提琴数据集"
    / "bach-violin-dataset"
    / "scores"
    / "bwv1001"
    / "bwv1001_mov1.mxl"
)
DEFAULT_OUT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "clarity-adaptation-pilot"
)
BLIND_GOLD_ROOT = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "independent-real-photo-gold"
)


NODE_RASTERIZER = r"""
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
const image = await loadImage(process.env.M4_SVG_PATH);
const canvas = createCanvas(Math.max(1, image.width), Math.max(1, image.height));
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
await fs.writeFile(process.env.M4_PNG_PATH, canvas.toBuffer('image/png'));
"""


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def rasterize_svg(svg_text: str, output_png: Path) -> Path:
    output_png.parent.mkdir(parents=True, exist_ok=True)
    svg_path = output_png.with_suffix(".svg.tmp")
    # resvg does not resolve Verovio's currentColor stroke consistently. Without
    # this compatibility rewrite, note groups become dense black rectangles.
    svg_text = svg_text.replace("{stroke:currentColor}", "{stroke:#000000}")
    svg_text = svg_text.replace(
        'class="definition-scale" color="black"',
        'class="definition-scale" color="black" stroke="#000000"',
    )
    # Clarity requests Verovio SVG bounding boxes for staff-label extraction.
    # The Windows resvg backend paints transparent bbox fills as opaque black;
    # ``none`` keeps the metadata geometry while preventing those blocks.
    svg_text = svg_text.replace(
        'fill="transparent" stroke-width="0"',
        'fill="none" stroke="none" style="fill:none;stroke:none" stroke-width="0"',
    )
    svg_path.write_text(svg_text, encoding="utf-8")
    env = {
        **os.environ,
        "M4_SVG_PATH": str(svg_path),
        "M4_PNG_PATH": str(output_png),
    }
    try:
        completed = subprocess.run(
            ["node", "--input-type=module", "-"],
            input=NODE_RASTERIZER,
            text=True,
            capture_output=True,
            cwd=REPO,
            env=env,
            timeout=120,
            check=False,
        )
        if completed.returncode != 0 or not output_png.exists():
            message = (completed.stderr or completed.stdout or "unknown node rasterizer error").strip()
            raise RuntimeError(f"Node SVG rasterization failed: {message[:500]}")
        return output_png
    finally:
        svg_path.unlink(missing_ok=True)


def install_node_rasterizer(generator_module, scratch_root: Path) -> None:
    counter = {"value": 0}

    def _next_png() -> Path:
        counter["value"] += 1
        return scratch_root / f"raster-{counter['value']:04d}.png"

    def _rasterize_svg_to_image(svg_text: str):
        png_path = rasterize_svg(svg_text, _next_png())
        with Image.open(png_path) as image:
            return image.convert("L").copy()

    def _maybe_write_png(svg_text: str, output_png: Path) -> bool:
        rasterize_svg(svg_text, output_png)
        return True

    generator_module._rasterize_svg_to_image = _rasterize_svg_to_image
    generator_module.maybe_write_png = _maybe_write_png


def install_training_crop_padding(generator_module) -> None:
    """Keep tempo text and left-side score context inside staff training crops."""
    original = generator_module._write_staff_crops

    def _write_staff_crops(**kwargs):
        kwargs.setdefault("vertical_padding_ratio", 0.60)
        kwargs.setdefault("horizontal_padding_ratio", 0.08)
        return original(**kwargs)

    generator_module._write_staff_crops = _write_staff_crops


def install_verovio_musicxml_loader(generator_module) -> None:
    """Load MusicXML from memory so Unicode Windows paths do not render as 0 pages."""

    def _render_svg_pages(
        source_path: Path,
        style_options: dict[str, object],
        max_pages_per_score: int | None,
        warning_counts=None,
        show_verovio_warnings: bool = False,
    ):
        import verovio

        capture = generator_module._NativeStderrCapture(enabled=not show_verovio_warnings)
        with capture:
            toolkit = verovio.toolkit()
            toolkit.setOptions(style_options)
            source_text = source_path.read_text(encoding="utf-8-sig")
            if not toolkit.loadData(source_text):
                raise RuntimeError(f"Verovio could not load MusicXML data from {source_path}")
            toolkit.redoLayout()
            page_count = int(toolkit.getPageCount())
            if max_pages_per_score is not None:
                page_count = min(page_count, max_pages_per_score)
            for page_no in range(1, page_count + 1):
                yield page_no, toolkit.renderToSVG(page_no)
        if warning_counts is not None:
            generator_module._record_verovio_warnings(capture.lines, warning_counts)

    generator_module.render_svg_pages = _render_svg_pages


def load_generator(clarity_train_root: Path):
    if not (clarity_train_root / "src" / "data" / "generate_synthetic.py").exists():
        raise FileNotFoundError(
            "Clarity training source is missing. Clone the official "
            "clquwu/Clarity-OMR-Train repository first."
        )
    sys.path.insert(0, str(clarity_train_root))
    try:
        return importlib.import_module("src.data.generate_synthetic")
    finally:
        sys.path.pop(0)


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def image_sanity_metrics(path: Path) -> dict[str, float | int | bool]:
    with Image.open(path) as image:
        gray = image.convert("L")
        histogram = gray.histogram()
        pixel_count = max(1, gray.width * gray.height)
        dark_ratio = sum(histogram[:64]) / pixel_count
        ink_ratio = sum(histogram[:200]) / pixel_count
        suspicious = dark_ratio > 0.30 or ink_ratio < 0.01
        return {
            "width": gray.width,
            "height": gray.height,
            "darkPixelRatio": round(dark_ratio, 6),
            "inkPixelRatio": round(ink_ratio, 6),
            "suspicious": suspicious,
        }


def prepare_musicxml_source(source_path: Path, output_root: Path) -> Path:
    if not zipfile.is_zipfile(source_path):
        return source_path
    with zipfile.ZipFile(source_path) as archive:
        candidates = [
            name
            for name in archive.namelist()
            if name.lower().endswith((".xml", ".musicxml"))
            and not name.lower().startswith("meta-inf/")
        ]
        if not candidates:
            raise RuntimeError(f"No MusicXML payload found inside {source_path}")
        extracted_path = output_root / "pilot-score.musicxml"
        extracted_path.write_bytes(archive.read(candidates[0]))
        return extracted_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clarity-train-root", type=Path, default=DEFAULT_CLARITY_TRAIN)
    parser.add_argument("--score", type=Path, default=DEFAULT_SCORE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--style", default="leipzig-default")
    parser.add_argument("--max-pages", type=int, default=1)
    parser.add_argument("--reset-output", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    clarity_train_root = args.clarity_train_root.resolve()
    score_path = args.score.resolve()
    output_root = args.out.resolve()
    blind_root = BLIND_GOLD_ROOT.resolve()

    if not score_path.exists():
        raise FileNotFoundError(f"Score not found: {score_path}")
    if _is_relative_to(score_path, blind_root):
        raise RuntimeError("Blind real-photo gold must never be used as adaptation input.")
    if args.reset_output and output_root.exists():
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)
    generator_score_path = prepare_musicxml_source(score_path, output_root)

    manifest_path = output_root / "pilot-source-manifest.jsonl"
    manifest_path.write_text(
        json.dumps(
            {
                "sample_id": generator_score_path.stem,
                "dataset": "m4_bach_adaptation",
                "split": "train",
                "musicxml_path": str(generator_score_path),
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    generator = load_generator(clarity_train_root)
    with tempfile.TemporaryDirectory(prefix="m4-clarity-raster-") as scratch:
        install_verovio_musicxml_loader(generator)
        install_node_rasterizer(generator, Path(scratch))
        install_training_crop_padding(generator)
        official_summary = generator.run(
            project_root=clarity_train_root,
            data_root=clarity_train_root / "data",
            input_manifest=manifest_path,
            output_dir=output_root / "generated",
            style_ids=[args.style],
            max_scores=1,
            max_pages_per_score=max(1, args.max_pages),
            seed=1337,
            render=True,
            write_png=True,
            roundtrip_validate=False,
            show_verovio_warnings=False,
            workers=1,
            allow_fallback_labels=False,
        )

    token_manifest = output_root / "generated" / "manifests" / "synthetic_token_manifest.jsonl"
    token_rows = read_jsonl(token_manifest)
    missing_images = []
    invalid_tokens = []
    deduplicated_rows = []
    seen_pairs = set()
    duplicate_pair_count = 0
    unique_image_paths: dict[str, Path] = {}
    for row in token_rows:
        image_path = (clarity_train_root / str(row.get("image_path", ""))).resolve()
        if not image_path.exists():
            missing_images.append(str(image_path))
        else:
            unique_image_paths[str(image_path)] = image_path
        sequence = row.get("token_sequence")
        if not isinstance(sequence, list) or sequence[:1] != ["<bos>"] or sequence[-1:] != ["<eos>"]:
            invalid_tokens.append(str(row.get("sample_id", "")))
            continue
        pair_key = (str(image_path), json.dumps(sequence, ensure_ascii=False, separators=(",", ":")))
        if pair_key in seen_pairs:
            duplicate_pair_count += 1
            continue
        seen_pairs.add(pair_key)
        deduplicated_rows.append(row)

    deduplicated_manifest = output_root / "clarity-adaptation-token-manifest.jsonl"
    deduplicated_manifest.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in deduplicated_rows),
        encoding="utf-8",
    )
    visual_metrics = {
        path_text: image_sanity_metrics(path)
        for path_text, path in sorted(unique_image_paths.items())
    }
    suspicious_images = [path for path, metrics in visual_metrics.items() if metrics["suspicious"]]

    pairing_mismatches = int(official_summary.get("token_pairing_mismatches", 0) or 0)
    passed = (
        bool(deduplicated_rows)
        and not missing_images
        and not invalid_tokens
        and not suspicious_images
        and pairing_mismatches == 0
    )
    report = {
        "schemaVersion": 1,
        "purpose": "M4 Clarity supervised-adaptation data feasibility probe",
        "evalOnly": True,
        "studentRuntimeTouched": False,
        "scorePath": str(score_path),
        "generatorScorePath": str(generator_score_path),
        "blindGoldRoot": str(blind_root),
        "blindHoldoutContaminated": False,
        "windowsUnicodePathCompatibility": "verovio-loadData",
        "style": args.style,
        "maxPages": max(1, args.max_pages),
        "tokenRowCount": len(token_rows),
        "deduplicatedTokenRowCount": len(deduplicated_rows),
        "duplicateImageTokenPairCount": duplicate_pair_count,
        "missingImageCount": len(missing_images),
        "invalidTokenSequenceCount": len(invalid_tokens),
        "tokenPairingMismatchCount": pairing_mismatches,
        "visualSampleCount": len(visual_metrics),
        "suspiciousVisualSampleCount": len(suspicious_images),
        "visualSanityReady": not suspicious_images and bool(visual_metrics),
        "dataPairingReady": passed,
        "officialGeneratorSummary": official_summary,
        "artifacts": {
            "sourceManifest": str(manifest_path),
            "officialTokenManifest": str(token_manifest),
            "adaptationTokenManifest": str(deduplicated_manifest),
            "visualSample": next(iter(visual_metrics), None),
        },
    }
    report_path = output_root / "clarity-adaptation-data-probe.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
