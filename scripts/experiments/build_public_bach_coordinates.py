#!/usr/bin/env python3
"""Build multipage note/measure coordinates for analyzable public Bach scores."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

import build_western_m4a_supported_editions as m4a


REPO_ROOT = Path(__file__).resolve().parents[2]
LIBRARY_ROOT = REPO_ROOT / "data" / "public-score-library"
REGISTRY_PATH = LIBRARY_ROOT / "registry.json"
RENDER_ROOT = (
    REPO_ROOT
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "render-gold-omr"
)
SIDECAR_CONTRACT = "western-public-multipage-coordinate-sidecar-v1"
RENDERER = {
    "id": "verovio",
    "version": "6.2.1",
    "widthPixels": 1680,
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def page_number(path: Path) -> int:
    match = re.search(r"page-(\d+)\.", path.name, re.IGNORECASE)
    if not match:
        raise RuntimeError(f"invalid rendered page name: {path}")
    return int(match.group(1))


def extract_musicxml(mxl_path: Path, output_path: Path) -> None:
    with zipfile.ZipFile(mxl_path) as archive:
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        rootfile = next(
            (
                row
                for row in container.iter()
                if row.tag.rsplit("}", 1)[-1] == "rootfile"
            ),
            None,
        )
        member = (rootfile.attrib.get("full-path", "") if rootfile is not None else "").strip()
        if not member:
            raise RuntimeError(f"MXL rootfile is missing: {mxl_path}")
        output_path.write_bytes(archive.read(member))


def local_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def has_class(element: ET.Element, name: str) -> bool:
    return name in str(element.attrib.get("class", "")).split()


def parse_translate(value: str) -> tuple[float, float]:
    match = re.search(
        r"translate\(\s*(-?\d+(?:\.\d+)?)"
        r"(?:[\s,]+(-?\d+(?:\.\d+)?))?\s*\)",
        value,
    )
    if not match:
        return 0.0, 0.0
    return float(match.group(1)), float(match.group(2) or 0)


def normalized_box(
    box: list[float],
    width: float,
    height: float,
) -> list[float]:
    x1, y1, x2, y2 = box
    return [
        round(max(0.0, min(1.0, x1 / width)), 8),
        round(max(0.0, min(1.0, y1 / height)), 8),
        round(max(0.0, min(1.0, x2 / width)), 8),
        round(max(0.0, min(1.0, y2 / height)), 8),
    ]


def staff_line_box(staff: ET.Element) -> list[float] | None:
    points: list[tuple[float, float]] = []
    for row in list(staff):
        if local_name(row) != "path":
            continue
        numbers = [
            float(value)
            for value in re.findall(r"-?\d+(?:\.\d+)?", row.attrib.get("d", ""))
        ]
        if len(numbers) >= 4:
            points.extend(zip(numbers[0::2], numbers[1::2]))
    if not points:
        return None
    return [
        min(row[0] for row in points),
        min(row[1] for row in points),
        max(row[0] for row in points),
        max(row[1] for row in points),
    ]


def note_center(note: ET.Element) -> tuple[float, float]:
    notehead = next(
        (row for row in note.iter() if has_class(row, "notehead")),
        None,
    )
    use = next(
        (
            row
            for row in (notehead.iter() if notehead is not None else [])
            if local_name(row) == "use"
        ),
        None,
    )
    if use is None:
        raise RuntimeError("Verovio notehead has no positioned glyph")
    return parse_translate(use.attrib.get("transform", ""))


def attach_musicxml_note_ids(
    musicxml_path: Path,
    measures: list[dict[str, Any]],
) -> None:
    root = ET.parse(musicxml_path).getroot()
    part = next((row for row in root.iter() if local_name(row) == "part"), None)
    xml_measures = (
        [row for row in list(part) if local_name(row) == "measure"]
        if part is not None
        else []
    )
    if len(xml_measures) != len(measures):
        raise RuntimeError("MusicXML measure identity count drift")
    for global_measure_index, (xml_measure, parsed_measure) in enumerate(
        zip(xml_measures, measures),
        start=1,
    ):
        pitched_ordinals = []
        for note_ordinal, note in enumerate(
            (row for row in list(xml_measure) if local_name(row) == "note"),
            start=1,
        ):
            if any(local_name(row) == "pitch" for row in list(note)):
                pitched_ordinals.append(note_ordinal)
        if len(pitched_ordinals) != len(parsed_measure["notes"]):
            raise RuntimeError(
                f"MusicXML note identity count drift in measure {global_measure_index}"
            )
        for parsed_note, note_ordinal in zip(
            parsed_measure["notes"],
            pitched_ordinals,
        ):
            source_measure = str(
                parsed_measure.get("sourceMeasureNumber", "")
            ).strip()
            measure_identity = (
                source_measure
                if re.fullmatch(r"-?\d+", source_measure)
                else str(global_measure_index)
            )
            global_note_id = (
                f"xml-m{global_measure_index}-n{note_ordinal}"
            )
            source_note_id = (
                f"xml-m{measure_identity}-n{note_ordinal}"
            )
            parsed_note["noteId"] = global_note_id
            parsed_note["noteIds"] = list(
                dict.fromkeys([global_note_id, source_note_id])
            )


def build_verovio_page(
    svg_path: Path,
    remaining_measures: list[dict[str, Any]],
    page_index: int,
    measure_offset: int,
) -> tuple[dict[str, Any], int]:
    root = ET.parse(svg_path).getroot()
    definition = next(
        (row for row in root.iter() if has_class(row, "definition-scale")),
        None,
    )
    if definition is None:
        raise RuntimeError(f"Verovio definition-scale is missing: {svg_path}")
    view_box = [
        float(value) for value in definition.attrib.get("viewBox", "").split()
    ]
    if len(view_box) != 4:
        raise RuntimeError(f"Verovio viewBox is invalid: {svg_path}")
    width, height = view_box[2], view_box[3]
    page_margin = next(
        (row for row in definition.iter() if has_class(row, "page-margin")),
        None,
    )
    offset_x, offset_y = parse_translate(
        page_margin.attrib.get("transform", "") if page_margin is not None else ""
    )
    visual_measures = [
        row for row in definition.iter() if has_class(row, "measure")
    ]
    if not visual_measures or len(visual_measures) > len(remaining_measures):
        raise RuntimeError(
            f"invalid page measure count for {svg_path}: "
            f"visual={len(visual_measures)}, remaining={len(remaining_measures)}"
        )

    page_number_value = page_index + 1
    rendered_measures: list[dict[str, Any]] = []
    rendered_notes: list[dict[str, Any]] = []
    for local_index, (visual, score_measure) in enumerate(
        zip(visual_measures, remaining_measures),
        start=1,
    ):
        global_measure_index = measure_offset + local_index
        staff = next(
            (row for row in visual.iter() if has_class(row, "staff")),
            None,
        )
        staff_box = staff_line_box(staff) if staff is not None else None
        if staff_box is None:
            raise RuntimeError(
                f"measure staff geometry is missing: {svg_path} measure {local_index}"
            )
        measure_box = [
            staff_box[0] + offset_x - 45,
            staff_box[1] + offset_y - 135,
            staff_box[2] + offset_x + 45,
            staff_box[3] + offset_y + 135,
        ]
        rendered_measures.append(
            {
                "globalMeasureIndex": global_measure_index,
                "sourceMeasureNumber": score_measure["sourceMeasureNumber"],
                "pageIndex": page_index,
                "pageNumber": page_number_value,
                "bboxNormalized": normalized_box(measure_box, width, height),
            }
        )

        visual_notes = [
            row for row in visual.iter() if has_class(row, "note")
        ]
        score_notes = score_measure["notes"]
        if len(visual_notes) != len(score_notes):
            raise RuntimeError(
                f"measure {global_measure_index} rendered/XML pitched-note mismatch: "
                f"rendered={len(visual_notes)}, xml={len(score_notes)}"
            )
        for note_ordinal, (visual_note, score_note) in enumerate(
            zip(visual_notes, score_notes),
            start=1,
        ):
            x, y = note_center(visual_note)
            note_box = [
                x + offset_x - 175,
                y + offset_y - 135,
                x + offset_x + 175,
                y + offset_y + 135,
            ]
            rendered_notes.append(
                {
                    **score_note,
                    "noteId": score_note["noteId"],
                    "globalMeasureIndex": global_measure_index,
                    "sourceMeasureNumber": score_measure["sourceMeasureNumber"],
                    "pageIndex": page_index,
                    "pageNumber": page_number_value,
                    "bboxNormalized": normalized_box(note_box, width, height),
                }
            )

    return {
        "page": {
            "pageIndex": page_index,
            "pageNumber": page_number_value,
            "widthPixels": int(
                round(float(root.attrib.get("width", "0px").removesuffix("px")))
            ),
            "heightPixels": int(
                round(float(root.attrib.get("height", "0px").removesuffix("px")))
            ),
            "svgViewBox": view_box,
        },
        "systems": [],
        "staves": [],
        "measures": rendered_measures,
        "notes": rendered_notes,
    }, len(visual_measures)


def build_entry_sidecar(entry: dict[str, Any]) -> tuple[dict[str, Any], Path]:
    piece_id = str(entry["pieceId"])
    edition_id = str(entry["editionId"])
    score_path = LIBRARY_ROOT / str(entry["musicxmlPath"])
    render_dir = RENDER_ROOT / piece_id.replace("-", "_") / "render"
    png_pages = sorted(render_dir.glob("page-*.png"), key=page_number)
    svg_pages = sorted(render_dir.glob("page-*.svg"), key=page_number)
    expected_pages = len(entry.get("renderPaths") or [])
    if not score_path.is_file():
        raise RuntimeError(f"score is missing: {score_path}")
    if len(png_pages) != expected_pages or len(svg_pages) != expected_pages:
        raise RuntimeError(
            f"render page count mismatch for {piece_id}: "
            f"registry={expected_pages}, png={len(png_pages)}, svg={len(svg_pages)}"
        )

    with tempfile.TemporaryDirectory(prefix=f"public-bach-coordinates-{piece_id}-") as temp:
        musicxml_path = Path(temp) / "score.musicxml"
        extract_musicxml(score_path, musicxml_path)
        measures = m4a.parse_musicxml(musicxml_path)
        attach_musicxml_note_ids(musicxml_path, measures)

    measure_offset = 0
    pages: list[dict[str, Any]] = []
    systems: list[dict[str, Any]] = []
    staves: list[dict[str, Any]] = []
    rendered_measures: list[dict[str, Any]] = []
    rendered_notes: list[dict[str, Any]] = []
    for page_index, svg_path in enumerate(svg_pages):
        remaining = measures[measure_offset:]
        if not remaining:
            raise RuntimeError(f"render has extra pages after all measures: {piece_id}")
        located, consumed = build_verovio_page(
            svg_path,
            remaining,
            page_index,
            measure_offset,
        )
        pages.append(located["page"])
        systems.extend(located["systems"])
        staves.extend(located["staves"])
        rendered_measures.extend(located["measures"])
        rendered_notes.extend(located["notes"])
        measure_offset += consumed

    if measure_offset != len(measures):
        raise RuntimeError(
            f"not all measures were assigned for {piece_id}: "
            f"assigned={measure_offset}, score={len(measures)}"
        )
    expected_note_indexes = list(range(len(rendered_notes)))
    actual_note_indexes = [
        int(row["xmlPitchedNoteIndex"]) for row in rendered_notes
    ]
    if actual_note_indexes != expected_note_indexes:
        raise RuntimeError(f"note ordering drift for {piece_id}")

    sidecar = {
        "contract": SIDECAR_CONTRACT,
        "pieceId": piece_id,
        "editionId": edition_id,
        "renderer": RENDERER,
        "counts": {
            "pages": len(pages),
            "systems": len(systems),
            "staves": len(staves),
            "measures": len(rendered_measures),
            "notes": len(rendered_notes),
        },
        "pages": pages,
        "systems": systems,
        "staves": staves,
        "measures": rendered_measures,
        "notes": rendered_notes,
    }
    output_path = (
        LIBRARY_ROOT
        / "editions"
        / piece_id
        / edition_id
        / "coordinates.json"
    )
    return sidecar, output_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece-id", default="")
    args = parser.parse_args()

    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    entries = [
        row
        for row in registry.get("entries", [])
        if row.get("scoreId")
        and row.get("musicxmlPath")
        and re.fullmatch(r"bwv100[1-6]-mov\d+", str(row.get("pieceId", "")))
        and (not args.piece_id or row.get("pieceId") == args.piece_id)
    ]
    if args.piece_id and not entries:
        raise RuntimeError(f"analyzable Bach entry not found: {args.piece_id}")
    if not args.piece_id and len(entries) != 32:
        raise RuntimeError(f"expected 32 analyzable Bach entries, found {len(entries)}")

    summaries = []
    for entry in entries:
        sidecar, output_path = build_entry_sidecar(entry)
        payload = m4a.json_bytes(sidecar)
        m4a.write_bytes_if_changed(output_path, payload)
        entry["coordinateSidecarPath"] = output_path.relative_to(LIBRARY_ROOT).as_posix()
        entry["coordinateSidecarSha256"] = sha256_bytes(payload)
        summaries.append(
            {
                "pieceId": entry["pieceId"],
                **sidecar["counts"],
            }
        )

    m4a.write_bytes_if_changed(REGISTRY_PATH, m4a.json_bytes(registry))
    print(
        json.dumps(
            {
                "ok": True,
                "entryCount": len(entries),
                "entries": summaries,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
