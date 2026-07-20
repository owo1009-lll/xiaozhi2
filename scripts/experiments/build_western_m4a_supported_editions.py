#!/usr/bin/env python3
"""Build the M4a supported-edition registry, coordinates, and semantic masks."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_PATH = REPO_ROOT / "config" / "western-m4a-supported-edition-seeds.json"
OUTPUT_ROOT = (
    REPO_ROOT
    / "data"
    / "experiments"
    / "western-strings-m4a"
    / "supported-editions"
)
REGISTRY_CONTRACT = "western-m4a-supported-edition-registry-v1"
SIDECAR_CONTRACT = "western-m4a-render-coordinate-sidecar-v1"
SEED_CONTRACT = "western-m4a-supported-edition-seeds-v1"
MASK_CLASSES = {
    "stem": "Stem",
    "beam": "Beam",
    "notehead": "Note",
    "barline": "BarLine",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_bytes_if_changed(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == data:
        return
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.replace(path)


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child(element: ET.Element, name: str) -> ET.Element | None:
    return next((row for row in element if local_name(row.tag) == name), None)


def child_text(element: ET.Element, name: str, default: str = "") -> str:
    row = child(element, name)
    return (row.text or default).strip() if row is not None else default


def parse_musicxml(path: Path) -> list[dict[str, Any]]:
    root = ET.parse(path).getroot()
    parts = [row for row in root.iter() if local_name(row.tag) == "part"]
    if len(parts) != 1:
        raise RuntimeError(f"M4a v1 registry builder requires one score part: {path}")
    measures: list[dict[str, Any]] = []
    pitched_index = 0
    for global_index, measure in enumerate(
        (row for row in parts[0] if local_name(row.tag) == "measure"), start=1
    ):
        notes: list[dict[str, Any]] = []
        for note in (row for row in measure if local_name(row.tag) == "note"):
            pitch = child(note, "pitch")
            if pitch is None:
                continue
            step = child_text(pitch, "step")
            octave = int(child_text(pitch, "octave"))
            alter = int(float(child_text(pitch, "alter", "0")))
            midi = (octave + 1) * 12 + {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[step] + alter
            notes.append(
                {
                    "xmlPitchedNoteIndex": pitched_index,
                    "pitch": {"step": step, "alter": alter, "octave": octave, "midi": midi},
                    "voice": child_text(note, "voice", "1"),
                    "isChordTone": child(note, "chord") is not None,
                }
            )
            pitched_index += 1
        measures.append(
            {
                "globalMeasureIndex": global_index,
                "sourceMeasureNumber": measure.attrib.get("number", str(global_index)),
                "notes": notes,
            }
        )
    if not measures or pitched_index == 0:
        raise RuntimeError(f"MusicXML contains no registerable measures/notes: {path}")
    return measures


def locate_musescore() -> Path:
    candidates = [
        os.environ.get("MUSESCORE4_BIN", ""),
        shutil.which("MuseScore4") or "",
        shutil.which("mscore4") or "",
        r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate).resolve()
    raise RuntimeError("MuseScore Studio 4 executable not found; set MUSESCORE4_BIN")


def renderer_version(executable: Path) -> str:
    result = subprocess.run(
        [str(executable), "--version"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    match = re.search(r"(\d+\.\d+\.\d+)", result.stdout + result.stderr)
    if not match:
        raise RuntimeError("Could not read MuseScore Studio version")
    return match.group(1)


def wait_for_single_page(directory: Path, stem: str, suffix: str) -> Path:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        pages = sorted(directory.glob(f"{stem}-*{suffix}"))
        if pages and all(row.stat().st_size > 0 for row in pages):
            if len(pages) != 1:
                raise RuntimeError(f"M4a v1 initial registry requires a single page; got {len(pages)}")
            return pages[0]
        time.sleep(0.05)
    raise RuntimeError(f"MuseScore did not emit {stem}-1{suffix}")


def render_score(executable: Path, musicxml: Path, dpi: int, directory: Path) -> tuple[Path, Path]:
    for stem, suffix, extra in [
        ("standard-render", ".png", ["-r", str(dpi)]),
        ("coordinate-source", ".svg", []),
    ]:
        output = directory / f"{stem}{suffix}"
        subprocess.run(
            [str(executable), *extra, "-o", str(output), str(musicxml)],
            check=True,
            capture_output=True,
        )
    return (
        wait_for_single_page(directory, "standard-render", ".png"),
        wait_for_single_page(directory, "coordinate-source", ".svg"),
    )


def png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    if len(data) != 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"invalid PNG render: {path}")
    return struct.unpack(">II", data[16:24])


def points(value: str) -> list[tuple[float, float]]:
    numbers = [float(row) for row in re.findall(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", value)]
    if len(numbers) % 2:
        raise RuntimeError("odd coordinate count in MuseScore SVG")
    return list(zip(numbers[::2], numbers[1::2]))


def svg_path_polygons(value: str, curve_steps: int = 20) -> list[list[tuple[float, float]]]:
    tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", value)
    polygons: list[list[tuple[float, float]]] = []
    polygon: list[tuple[float, float]] = []
    cursor = (0.0, 0.0)
    index = 0
    command = ""

    def number() -> float:
        nonlocal index
        if index >= len(tokens) or re.fullmatch(r"[A-Za-z]", tokens[index]):
            raise RuntimeError("missing coordinate in MuseScore SVG path")
        result = float(tokens[index])
        index += 1
        return result

    while index < len(tokens):
        if re.fullmatch(r"[A-Za-z]", tokens[index]):
            command = tokens[index]
            index += 1
        if command == "M":
            if polygon:
                polygons.append(polygon)
            cursor = (number(), number())
            polygon = [cursor]
            command = "L"
        elif command == "L":
            cursor = (number(), number())
            polygon.append(cursor)
        elif command == "C":
            control_1 = (number(), number())
            control_2 = (number(), number())
            endpoint = (number(), number())
            start = cursor
            for step in range(1, curve_steps + 1):
                t = step / curve_steps
                inverse = 1.0 - t
                polygon.append(
                    (
                        inverse**3 * start[0]
                        + 3 * inverse**2 * t * control_1[0]
                        + 3 * inverse * t**2 * control_2[0]
                        + t**3 * endpoint[0],
                        inverse**3 * start[1]
                        + 3 * inverse**2 * t * control_1[1]
                        + 3 * inverse * t**2 * control_2[1]
                        + t**3 * endpoint[1],
                    )
                )
            cursor = endpoint
        elif command in {"Z", "z"}:
            if polygon:
                polygons.append(polygon)
                polygon = []
            command = ""
        else:
            raise RuntimeError(f"unsupported MuseScore mask path command: {command}")
    if polygon:
        polygons.append(polygon)
    return polygons


def build_semantic_masks(
    svg_path: Path,
    png_path: Path,
    output_paths: dict[str, Path],
) -> dict[str, dict[str, Any]]:
    root = ET.parse(svg_path).getroot()
    view_box = [float(row) for row in root.attrib["viewBox"].split()]
    width, height = png_dimensions(png_path)
    scale_x, scale_y = width / view_box[2], height / view_box[3]
    result: dict[str, dict[str, Any]] = {}
    for mask_name, element_class in MASK_CLASSES.items():
        canvas = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(canvas)
        elements = [row for row in root.iter() if row.attrib.get("class") == element_class]
        for element in elements:
            tag = local_name(element.tag)
            if tag in {"polyline", "polygon"}:
                raw_points = points(element.attrib.get("points", ""))
                scaled = [(round(x * scale_x), round(y * scale_y)) for x, y in raw_points]
                if tag == "polygon" or element.attrib.get("fill", "none") != "none":
                    draw.polygon(scaled, fill=255)
                else:
                    stroke = float(element.attrib.get("stroke-width", "1"))
                    draw.line(
                        scaled,
                        fill=255,
                        width=max(1, round(stroke * (scale_x + scale_y) / 2)),
                        joint="curve",
                    )
            elif tag == "path":
                for polygon in svg_path_polygons(element.attrib.get("d", "")):
                    scaled = [(round(x * scale_x), round(y * scale_y)) for x, y in polygon]
                    if len(scaled) >= 3:
                        draw.polygon(scaled, fill=255)
            else:
                raise RuntimeError(f"unsupported MuseScore {element_class} element: {tag}")
        output = output_paths[mask_name]
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        canvas.save(temporary, format="PNG", optimize=True)
        temporary.replace(output)
        result[mask_name] = {
            "elementClass": element_class,
            "elementCount": len(elements),
            "foregroundPixelCount": int(sum(canvas.histogram()[1:])),
        }
    return result


def path_bbox(value: str) -> list[float]:
    commands = set(re.findall(r"[A-Za-z]", value))
    if not commands.issubset({"M", "C"}):
        raise RuntimeError(f"unsupported MuseScore note path commands: {sorted(commands)}")
    rows = points(value)
    return [
        min(row[0] for row in rows),
        min(row[1] for row in rows),
        max(row[0] for row in rows),
        max(row[1] for row in rows),
    ]


def group_staff_lines(lines: list[dict[str, float]]) -> list[dict[str, Any]]:
    rows = sorted(lines, key=lambda row: (row["y"], row["x1"]))
    if not rows or len(rows) % 5:
        raise RuntimeError(f"MuseScore SVG staff line count is not divisible by five: {len(rows)}")
    staves: list[dict[str, Any]] = []
    for index in range(0, len(rows), 5):
        group = rows[index : index + 5]
        gaps = [group[position + 1]["y"] - group[position]["y"] for position in range(4)]
        if min(gaps) <= 0 or max(gaps) / min(gaps) > 1.05:
            raise RuntimeError("MuseScore SVG staff lines are not a regular five-line staff")
        staves.append(
            {
                "staffIndex": len(staves),
                "x1": min(row["x1"] for row in group),
                "x2": max(row["x2"] for row in group),
                "y1": group[0]["y"],
                "y2": group[-1]["y"],
                "centerY": sum(row["y"] for row in group) / 5,
                "lineGap": sum(gaps) / len(gaps),
            }
        )
    return staves


def cluster_barline_x(values: list[float], tolerance: float) -> list[float]:
    clusters: list[list[float]] = []
    for value in sorted(values):
        if clusters and value - clusters[-1][-1] <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [max(cluster) for cluster in clusters]


def pixel_box(box: list[float], scale_x: float, scale_y: float, width: int, height: int) -> list[int]:
    x1 = max(0, min(width - 1, math.floor(box[0] * scale_x)))
    y1 = max(0, min(height - 1, math.floor(box[1] * scale_y)))
    x2 = max(x1 + 1, min(width, math.ceil(box[2] * scale_x)))
    y2 = max(y1 + 1, min(height, math.ceil(box[3] * scale_y)))
    return [x1, y1, x2, y2]


def normalized_box(box: list[int], width: int, height: int) -> list[float]:
    return [
        round(box[0] / width, 8),
        round(box[1] / height, 8),
        round(box[2] / width, 8),
        round(box[3] / height, 8),
    ]


def build_sidecar(
    svg_path: Path,
    png_path: Path,
    measures_xml: list[dict[str, Any]],
    piece_id: str,
    edition_id: str,
    renderer: dict[str, Any],
) -> dict[str, Any]:
    root = ET.parse(svg_path).getroot()
    view_box = [float(row) for row in root.attrib["viewBox"].split()]
    if len(view_box) != 4 or view_box[:2] != [0, 0]:
        raise RuntimeError(f"unsupported MuseScore SVG viewBox: {view_box}")
    width, height = png_dimensions(png_path)
    scale_x, scale_y = width / view_box[2], height / view_box[3]

    staff_lines: list[dict[str, float]] = []
    barlines: list[dict[str, float]] = []
    note_boxes: list[list[float]] = []
    for element in root.iter():
        element_class = element.attrib.get("class", "")
        if element_class == "StaffLines":
            row = points(element.attrib.get("points", ""))
            if len(row) == 2 and abs(row[0][1] - row[1][1]) < 0.01:
                staff_lines.append({"x1": row[0][0], "x2": row[1][0], "y": row[0][1]})
        elif element_class == "BarLine":
            row = points(element.attrib.get("points", ""))
            if len(row) == 2 and abs(row[0][0] - row[1][0]) < 0.01:
                barlines.append(
                    {
                        "x": row[0][0],
                        "y1": min(row[0][1], row[1][1]),
                        "y2": max(row[0][1], row[1][1]),
                        "centerY": (row[0][1] + row[1][1]) / 2,
                    }
                )
        elif element_class == "Note":
            note_boxes.append(path_bbox(element.attrib.get("d", "")))

    staves = group_staff_lines(staff_lines)
    measure_boxes: list[dict[str, Any]] = []
    for staff in staves:
        own_barlines = [
            row
            for row in barlines
            if abs(row["centerY"] - staff["centerY"]) <= max(staff["lineGap"] * 3, 1)
        ]
        boundaries = cluster_barline_x(
            [row["x"] for row in own_barlines],
            tolerance=staff["lineGap"] * 0.5,
        )
        boundaries = [row for row in boundaries if row > staff["x1"] + staff["lineGap"]]
        if not boundaries:
            raise RuntimeError(f"staff {staff['staffIndex']} has no measure boundaries")
        top = min(row["y1"] for row in own_barlines)
        bottom = max(row["y2"] for row in own_barlines)
        left = staff["x1"]
        for right in boundaries:
            if right <= left:
                continue
            measure_boxes.append(
                {
                    "staffIndex": staff["staffIndex"],
                    "systemIndex": staff["staffIndex"],
                    "viewBox": [left, top, right, bottom],
                }
            )
            left = right

    if len(measure_boxes) != len(measures_xml):
        raise RuntimeError(
            f"visual/XML measure count mismatch: visual={len(measure_boxes)}, xml={len(measures_xml)}"
        )

    visual_notes_by_measure: list[list[list[float]]] = [[] for _ in measure_boxes]
    for box in note_boxes:
        center_x = (box[0] + box[2]) / 2
        center_y = (box[1] + box[3]) / 2
        staff = min(staves, key=lambda row: abs(row["centerY"] - center_y))
        candidates = [
            (index, measure)
            for index, measure in enumerate(measure_boxes)
            if measure["staffIndex"] == staff["staffIndex"]
            and measure["viewBox"][0] <= center_x <= measure["viewBox"][2]
        ]
        if len(candidates) != 1:
            raise RuntimeError(f"could not assign rendered note at x={center_x:.2f}, y={center_y:.2f}")
        visual_notes_by_measure[candidates[0][0]].append(box)

    rendered_measures: list[dict[str, Any]] = []
    rendered_notes: list[dict[str, Any]] = []
    for index, (visual_measure, xml_measure) in enumerate(zip(measure_boxes, measures_xml), start=1):
        visuals = sorted(
            visual_notes_by_measure[index - 1],
            key=lambda row: ((row[0] + row[2]) / 2, (row[1] + row[3]) / 2),
        )
        xml_notes = xml_measure["notes"]
        if len(visuals) != len(xml_notes):
            raise RuntimeError(
                f"measure {index} rendered/XML pitched-note mismatch: rendered={len(visuals)}, xml={len(xml_notes)}"
            )
        measure_pixels = pixel_box(visual_measure["viewBox"], scale_x, scale_y, width, height)
        rendered_measures.append(
            {
                "globalMeasureIndex": index,
                "sourceMeasureNumber": xml_measure["sourceMeasureNumber"],
                "systemIndex": visual_measure["systemIndex"],
                "staffIndex": visual_measure["staffIndex"],
                "bboxPixels": measure_pixels,
                "bboxNormalized": normalized_box(measure_pixels, width, height),
            }
        )
        for visual, xml_note in zip(visuals, xml_notes):
            note_pixels = pixel_box(visual, scale_x, scale_y, width, height)
            rendered_notes.append(
                {
                    **xml_note,
                    "globalMeasureIndex": index,
                    "sourceMeasureNumber": xml_measure["sourceMeasureNumber"],
                    "systemIndex": visual_measure["systemIndex"],
                    "staffIndex": visual_measure["staffIndex"],
                    "bboxPixels": note_pixels,
                    "bboxNormalized": normalized_box(note_pixels, width, height),
                }
            )

    rendered_staves: list[dict[str, Any]] = []
    for staff in staves:
        view = [
            staff["x1"],
            staff["y1"] - staff["lineGap"] * 0.25,
            staff["x2"],
            staff["y2"] + staff["lineGap"] * 0.25,
        ]
        box = pixel_box(view, scale_x, scale_y, width, height)
        rendered_staves.append(
            {
                "staffIndex": staff["staffIndex"],
                "systemIndex": staff["staffIndex"],
                "bboxPixels": box,
                "bboxNormalized": normalized_box(box, width, height),
            }
        )
    rendered_systems = [
        {
            "systemIndex": row["systemIndex"],
            "staffIndices": [row["staffIndex"]],
            "bboxPixels": row["bboxPixels"],
            "bboxNormalized": row["bboxNormalized"],
        }
        for row in rendered_staves
    ]
    return {
        "contract": SIDECAR_CONTRACT,
        "pieceId": piece_id,
        "editionId": edition_id,
        "renderer": renderer,
        "page": {
            "pageIndex": 1,
            "widthPixels": width,
            "heightPixels": height,
            "svgViewBox": view_box,
            "svgToPixelScale": [round(scale_x, 10), round(scale_y, 10)],
        },
        "counts": {
            "systems": len(rendered_systems),
            "staves": len(rendered_staves),
            "measures": len(rendered_measures),
            "notes": len(rendered_notes),
        },
        "systems": rendered_systems,
        "staves": rendered_staves,
        "measures": rendered_measures,
        "notes": rendered_notes,
    }


def relative_to_registry(path: Path) -> str:
    return path.relative_to(OUTPUT_ROOT).as_posix()


def build_entry(
    seed: dict[str, Any],
    catalog_approval: dict[str, str],
    executable: Path,
    renderer: dict[str, Any],
) -> dict[str, Any]:
    piece_id = seed["pieceId"]
    edition_id = seed["editionId"]
    source = (REPO_ROOT / seed["sourceMusicxmlPath"]).resolve()
    if not source.is_file() or REPO_ROOT not in source.parents:
        raise RuntimeError(f"missing or unsafe MusicXML source: {seed['sourceMusicxmlPath']}")
    measures = parse_musicxml(source)
    entry_root = OUTPUT_ROOT / "editions" / piece_id / edition_id
    score_path = entry_root / "score.musicxml"
    render_path = entry_root / "render-page-01.png"
    sidecar_path = entry_root / "coordinates.json"
    mask_paths = {
        name: entry_root / f"{name}-mask-page-01.png" for name in MASK_CLASSES
    }

    source_bytes = source.read_bytes()
    write_bytes_if_changed(score_path, source_bytes)
    with tempfile.TemporaryDirectory(prefix=f"western-m4a-{piece_id}-") as temporary:
        png, svg = render_score(executable, score_path, int(renderer["dpi"]), Path(temporary))
        if b"currentColor" in svg.read_bytes():
            raise RuntimeError(f"unsafe stroke:currentColor render detected for {piece_id}")
        write_bytes_if_changed(render_path, png.read_bytes())
        sidecar = build_sidecar(svg, render_path, measures, piece_id, edition_id, renderer)
        mask_summary = build_semantic_masks(svg, render_path, mask_paths)
        sidecar["semanticMasks"] = mask_summary
        write_bytes_if_changed(sidecar_path, json_bytes(sidecar))

    return {
        "pieceId": piece_id,
        "editionId": edition_id,
        "title": seed["title"],
        "musicxmlPath": relative_to_registry(score_path),
        "musicxmlSha256": sha256_bytes(score_path.read_bytes()),
        "renderPath": relative_to_registry(render_path),
        "renderSha256": sha256_bytes(render_path.read_bytes()),
        "coordinateSidecarPath": relative_to_registry(sidecar_path),
        "coordinateSidecarSha256": sha256_bytes(sidecar_path.read_bytes()),
        "semanticMasks": {
            name: {
                "path": relative_to_registry(mask_paths[name]),
                "sha256": sha256_bytes(mask_paths[name].read_bytes()),
                **mask_summary[name],
            }
            for name in MASK_CLASSES
        },
        "rendererVersion": renderer["version"],
        "confirmedBy": catalog_approval["confirmedBy"],
        "confirmedAt": catalog_approval["confirmedAt"],
        "confirmationMethod": catalog_approval["confirmationMethod"],
        "confirmationSource": catalog_approval["source"],
        "confirmationCommit": catalog_approval["commit"],
        "licenseStatus": seed["licenseStatus"],
        "pageCount": 1,
    }


def main() -> None:
    seeds = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    if seeds.get("contract") != SEED_CONTRACT:
        raise RuntimeError("M4a seed contract mismatch")
    executable = locate_musescore()
    actual_version = renderer_version(executable)
    expected_version = seeds["renderer"]["version"]
    if actual_version != expected_version:
        raise RuntimeError(
            f"MuseScore version drift: expected={expected_version}, actual={actual_version}"
        )
    renderer = {
        "id": seeds["renderer"]["id"],
        "version": actual_version,
        "dpi": int(seeds["renderer"]["dpi"]),
    }
    entries = [
        build_entry(row, seeds["catalogApproval"], executable, renderer)
        for row in seeds["entries"]
    ]
    registry = {
        "contract": REGISTRY_CONTRACT,
        "generatedBy": "scripts/experiments/build_western_m4a_supported_editions.py",
        "catalogApproval": seeds["catalogApproval"],
        "renderer": renderer,
        "entries": entries,
    }
    registry_path = OUTPUT_ROOT / "registry.json"
    write_bytes_if_changed(registry_path, json_bytes(registry))
    print(
        json.dumps(
            {
                "ok": True,
                "registry": registry_path.relative_to(REPO_ROOT).as_posix(),
                "renderer": renderer,
                "entries": [f"{row['pieceId']}/{row['editionId']}" for row in entries],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
