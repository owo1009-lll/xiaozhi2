#!/usr/bin/env python3
"""Extract notehead coordinates from LilyPond SVG output.

LilyPond can tag grobs for the SVG backend, so compiling with

    \\override NoteHead.output-attributes = #'((class . "lynotehead"))

marks every notehead. This walks the SVG accumulating nested translate
transforms and returns one normalized position per notehead, in document
order — which is score order, so index N is the Nth pitched note.

That ordering is what lets the caller bind a notehead to `xml-mN-nM` without
any recognition step: the picture and the note list come from the same source
file, so the only thing that can go wrong is a count mismatch, which the caller
checks explicitly.
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

SVG_NS = "http://www.w3.org/2000/svg"
TRANSLATE = re.compile(r"translate\(\s*(-?[\d.]+)\s*,?\s*(-?[\d.]+)?\s*\)")
SCALE = re.compile(r"scale\(\s*(-?[\d.]+)\s*,?\s*(-?[\d.]+)?\s*\)")


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_viewbox(root: ET.Element) -> tuple[float, float, float, float]:
    raw = (root.get("viewBox") or "").split()
    if len(raw) != 4:
        raise RuntimeError("svg has no usable viewBox")
    return tuple(float(v) for v in raw)  # type: ignore[return-value]


def walk(element: ET.Element, x: float, y: float, out: list[dict[str, Any]], tagged: bool) -> None:
    """Depth-first walk accumulating translate() offsets."""
    transform = element.get("transform") or ""
    match = TRANSLATE.search(transform)
    if match:
        x += float(match.group(1))
        y += float(match.group(2) or 0.0)

    is_notehead = tagged or "lynotehead" in (element.get("class") or "").split()
    if is_notehead and local(element.tag) == "path":
        out.append({"x": x, "y": y})
        return

    for child in element:
        walk(child, x, y, out, is_notehead)


def extract(svg_path: Path) -> dict[str, Any]:
    root = ET.parse(svg_path).getroot()
    min_x, min_y, width, height = parse_viewbox(root)
    positions: list[dict[str, Any]] = []
    walk(root, 0.0, 0.0, positions, False)

    normalized = []
    for position in positions:
        normalized.append({
            "x": round((position["x"] - min_x) / width, 8),
            "y": round((position["y"] - min_y) / height, 8),
        })
    return {
        "svg": svg_path.name,
        "viewBox": [min_x, min_y, width, height],
        "noteheads": len(normalized),
        "positions": normalized,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--svg", required=True, nargs="+")
    parser.add_argument("--expect-notes", type=int, default=0)
    args = parser.parse_args()

    pages = [extract(Path(p)) for p in args.svg]
    total = sum(page["noteheads"] for page in pages)
    ok = (args.expect_notes == 0) or (total == args.expect_notes)
    print(json.dumps({
        "ok": ok,
        "pages": len(pages),
        "totalNoteheads": total,
        "expectedNotes": args.expect_notes,
        "perPage": [{"svg": p["svg"], "noteheads": p["noteheads"], "viewBox": p["viewBox"]} for p in pages],
        "first3": pages[0]["positions"][:3] if pages else [],
    }, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
