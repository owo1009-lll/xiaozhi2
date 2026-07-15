#!/usr/bin/env python3
"""Run Oemer and preserve its note-head coordinates as a JSON sidecar.

Oemer keeps note bounding boxes in memory while building MusicXML, but its CLI
only writes the symbolic score. This wrapper captures the exact AddNote action
order used to emit MusicXML and saves coordinates against the clean, dewarped
image that Oemer actually analyzed. It does not modify the installed package.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import numpy as np
import sklearn
from PIL import Image

from oemer import layers
from oemer.build_system import AddInit, AddMeasure, AddNote, MusicXMLBuilder
from oemer.ete import clear_data, extract


def integer_bbox(value: Any) -> list[int]:
    if value is None or len(value) != 4:
        raise ValueError(f"invalid Oemer note bbox: {value!r}")
    return [int(round(float(item))) for item in value]


def pitched_xml_note_count(path: Path) -> int:
    root = ElementTree.parse(path).getroot()
    count = 0
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != "note":
            continue
        if any(child.tag.rsplit("}", 1)[-1] == "pitch" for child in element):
            count += 1
    return count


def measure_index_by_note_action(builder: MusicXMLBuilder) -> dict[int, int]:
    indexes: dict[int, int] = {}
    measure_index = 0
    for action in builder.actions:
        if isinstance(action, (AddInit, AddMeasure)):
            measure_index = int(action.measure.number)
            continue
        if isinstance(action, AddNote):
            indexes[id(action)] = measure_index
    return indexes


def coordinate_row(action: AddNote, measure_index: int, xml_note_index: int) -> dict[str, Any]:
    note = action.note
    bbox = integer_bbox(note.bbox)
    return {
        "xmlPitchedNoteIndex": xml_note_index,
        "oemerNoteId": int(note.id) if note.id is not None else None,
        "measureIndex": measure_index,
        "trackIndex": int(note.track),
        "voice": int(action.voice),
        "isChordContinuation": bool(action.chord),
        "bboxPixels": bbox,
        "centerPixels": [round((bbox[0] + bbox[2]) / 2, 3), round((bbox[1] + bbox[3]) / 2, 3)],
    }


def add_normalized_coordinates(rows: list[dict[str, Any]], width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise ValueError("coordinate canvas dimensions must be positive")
    for row in rows:
        x1, y1, x2, y2 = row["bboxPixels"]
        row["bboxNormalized"] = [
            round(max(0.0, min(1.0, x1 / width)), 8),
            round(max(0.0, min(1.0, y1 / height)), 8),
            round(max(0.0, min(1.0, x2 / width)), 8),
            round(max(0.0, min(1.0, y2 / height)), 8),
        ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("-o", "--output-dir", required=True)
    parser.add_argument("--coordinates", required=True)
    parser.add_argument("--coordinate-canvas", required=True)
    parser.add_argument("--expected-sklearn", default="")
    parser.add_argument("--use-tf", action="store_true")
    parser.add_argument("--save-cache", action="store_true")
    parser.add_argument("--without-deskew", action="store_true")
    args = parser.parse_args()

    if args.expected_sklearn and sklearn.__version__ != args.expected_sklearn:
        raise RuntimeError(
            f"scikit-learn version mismatch: expected {args.expected_sklearn}, got {sklearn.__version__}"
        )

    # Keep the image argument relative when the caller runs inside the image
    # directory. OpenCV in Oemer cannot reliably decode absolute Windows paths
    # containing non-ASCII characters.
    image = Path(args.image)
    output_dir = Path(args.output_dir).resolve()
    coordinates_path = Path(args.coordinates).resolve()
    canvas_path = Path(args.coordinate_canvas).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    coordinates_path.parent.mkdir(parents=True, exist_ok=True)
    canvas_path.parent.mkdir(parents=True, exist_ok=True)

    captured: dict[str, Any] = {}
    original_to_musicxml = MusicXMLBuilder.to_musicxml
    original_add_note_perform = AddNote.perform

    def wrapped_to_musicxml(builder: MusicXMLBuilder, *call_args: Any, **call_kwargs: Any) -> bytes:
        captured["notes"] = []
        captured["measureByAction"] = measure_index_by_note_action(builder)
        return original_to_musicxml(builder, *call_args, **call_kwargs)

    def wrapped_add_note_perform(action: AddNote, *call_args: Any, **call_kwargs: Any) -> Any:
        element = original_add_note_perform(action, *call_args, **call_kwargs)
        if element is not None:
            rows = captured.setdefault("notes", [])
            rows.append(
                coordinate_row(
                    action,
                    int(captured.get("measureByAction", {}).get(id(action), 0)),
                    len(rows),
                )
            )
        return element

    MusicXMLBuilder.to_musicxml = wrapped_to_musicxml
    AddNote.perform = wrapped_add_note_perform
    clear_data()
    try:
        musicxml_path = Path(
            extract(
                argparse.Namespace(
                    img_path=str(image),
                    output_path=str(output_dir),
                    use_tf=bool(args.use_tf),
                    save_cache=bool(args.save_cache),
                    without_deskew=bool(args.without_deskew),
                )
            )
        ).resolve()
    finally:
        MusicXMLBuilder.to_musicxml = original_to_musicxml
        AddNote.perform = original_add_note_perform

    canvas = np.asarray(layers.get_layer("original_image"))
    if canvas.ndim != 3 or canvas.shape[2] != 3:
        raise RuntimeError(f"unexpected Oemer coordinate canvas shape: {canvas.shape}")
    Image.fromarray(canvas[:, :, ::-1]).save(canvas_path)

    notes = list(captured.get("notes") or [])
    xml_note_count = pitched_xml_note_count(musicxml_path)
    if len(notes) != xml_note_count:
        raise RuntimeError(
            f"Oemer coordinate count mismatch: actions={len(notes)}, xml pitched notes={xml_note_count}"
        )
    height, width = int(canvas.shape[0]), int(canvas.shape[1])
    add_normalized_coordinates(notes, width, height)
    payload = {
        "schemaVersion": 1,
        "engine": "oemer",
        "engineVersion": importlib.metadata.version("oemer"),
        "coordinateSpace": "oemer-clean-dewarped-canvas",
        "inputImage": str(image.resolve()),
        "musicxmlPath": os.path.relpath(musicxml_path, coordinates_path.parent),
        "coordinateCanvasPath": os.path.relpath(canvas_path, coordinates_path.parent),
        "canvasWidth": width,
        "canvasHeight": height,
        "pitchedXmlNoteCount": xml_note_count,
        "coordinateNoteCount": len(notes),
        "notes": notes,
    }
    coordinates_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "ok": True,
                "musicxml": str(musicxml_path),
                "coordinates": str(coordinates_path),
                "coordinateCanvas": str(canvas_path),
                "noteCount": len(notes),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
