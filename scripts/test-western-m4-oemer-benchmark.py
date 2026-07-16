from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "experiments"))

from eval_western_strings_m4_oemer_benchmark import (  # noqa: E402
    THREAD_ENV,
    aggregate_metrics,
    automatic_adoption_ready,
    build_oemer_env,
    classify_oemer_failure,
    compare_engines,
    find_musicxml,
    prepare_viewer_trim,
    read_coordinate_sidecar,
)
from run_oemer_with_coordinates import add_normalized_coordinates, pitched_xml_note_count  # noqa: E402


with tempfile.TemporaryDirectory() as temporary_directory:
    root = Path(temporary_directory)
    assert find_musicxml(root) is None
    only = root / "score.musicxml"
    only.write_text("<score-partwise/>", encoding="utf-8")
    assert find_musicxml(root) == only
    (root / "second.musicxml").write_text("<score-partwise/>", encoding="utf-8")
    assert find_musicxml(root) is None

    log = root / "oemer.log"
    log.write_text("assert track_nums == 2, track_nums\nAssertionError: 3\n", encoding="utf-8")
    assert classify_oemer_failure(log) == "oemer-build-track-count-assertion"

    pitched_xml = root / "pitched.musicxml"
    pitched_xml.write_text(
        "<score-partwise><part><measure>"
        "<note><pitch><step>C</step><octave>4</octave></pitch></note>"
        "<note><rest/></note>"
        "</measure></part></score-partwise>",
        encoding="utf-8",
    )
    assert pitched_xml_note_count(pitched_xml) == 1
    coordinate_rows = [{"bboxPixels": [10, 20, 30, 40]}]
    add_normalized_coordinates(coordinate_rows, 100, 200)
    assert coordinate_rows[0]["bboxNormalized"] == [0.1, 0.1, 0.3, 0.2]
    canvas = root / "coordinate-canvas.png"
    canvas.write_bytes(b"canvas-present")
    sidecar = root / "coordinates.json"
    sidecar.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "coordinateSpace": "oemer-clean-dewarped-canvas",
                "coordinateCanvasPath": canvas.name,
                "canvasWidth": 100,
                "canvasHeight": 200,
                "coordinateNoteCount": 1,
                "pitchedXmlNoteCount": 1,
                "notes": [
                    {
                        **coordinate_rows[0],
                        "xmlPitchedNoteIndex": 0,
                        "measureIndex": 1,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    assert read_coordinate_sidecar(sidecar) is not None
    invalid = json.loads(sidecar.read_text(encoding="utf-8"))
    invalid["pitchedXmlNoteCount"] = 2
    sidecar.write_text(json.dumps(invalid), encoding="utf-8")
    assert read_coordinate_sidecar(sidecar) is None

    source = root / "viewer.png"
    from PIL import Image, ImageDraw

    viewer = Image.new("RGB", (100, 100), "black")
    ImageDraw.Draw(viewer).rectangle((0, 20, 99, 79), fill="white")
    viewer.save(source)
    trimmed = root / "trimmed.png"
    trim = prepare_viewer_trim(source, trimmed)
    assert trim["crop"] == [0, 20, 100, 80]
    assert Image.open(trimmed).size == (100, 60)

    invalid = json.loads(json.dumps({
        "schemaVersion": 1,
        "coordinateSpace": "oemer-clean-dewarped-canvas",
        "coordinateCanvasPath": canvas.name,
        "canvasWidth": 100,
        "canvasHeight": 200,
        "coordinateNoteCount": 1,
        "pitchedXmlNoteCount": 1,
        "notes": [{
            **coordinate_rows[0],
            "bboxNormalized": [-0.01, 0.1, 0.3, 0.2],
            "xmlPitchedNoteIndex": 0,
            "measureIndex": 1,
        }],
    }))
    sidecar.write_text(json.dumps(invalid), encoding="utf-8")
    assert read_coordinate_sidecar(sidecar) is None

    compat = root / "compat"
    compat.mkdir()
    env = build_oemer_env({"PYTHONPATH": "existing"}, compat)
    assert env["PYTHONPATH"] == str(compat) + os.pathsep + "existing"
    assert all(env[key] == value for key, value in THREAD_ENV.items())

oemer_rows = [
    {
        "pieceId": "a",
        "parseOk": True,
        "benchmarkUsable": True,
        "goldNotes": 100,
        "draftNotes": 100,
        "pitchExact": 99,
        "pitchPrecision": 0.99,
        "pitchRecall": 0.99,
        "onsetQuarterAccuracy": 0.99,
        "measureAccuracy": 0.99,
        "goldSourceVerified": "yes",
    },
    {
        "pieceId": "b",
        "parseOk": True,
        "benchmarkUsable": True,
        "goldNotes": 100,
        "draftNotes": 125,
        "pitchExact": 80,
        "pitchPrecision": 0.64,
        "pitchRecall": 0.8,
        "onsetQuarterAccuracy": 0.99,
        "measureAccuracy": 0.99,
        "goldSourceVerified": "yes",
    },
]
audiveris_rows = [
    {
        "pieceId": "a",
        "parseOk": True,
        "benchmarkUsable": True,
        "goldNotes": 100,
        "draftNotes": 100,
        "pitchExact": 90,
        "pitchPrecision": 0.9,
        "pitchRecall": 0.9,
        "onsetQuarterAccuracy": 0.9,
        "measureAccuracy": 0.9,
        "goldSourceVerified": "yes",
    }
]
summary = aggregate_metrics(oemer_rows)
assert summary["pitchPrecision"] == round(179 / 225, 6)
assert summary["pitchRecall"] == 0.895
assert summary["strictPassRows"] == 1
assert summary["engineFailureRows"] == 0
assert summary["pitchRecallIncludingEngineFailures"] == 0.895
assert summary["onsetQuarterAccuracy"] == 0.99
assert summary["measureAccuracy"] == 0.99
assert summary["pitchOnlyStrictPassRows"] == 1
assert summary["strictPassPieceIds"] == ["a"]
comparison = compare_engines(oemer_rows, audiveris_rows)
assert comparison["perPiece"] == [
    {
        "pieceId": "a",
        "oemerStatus": None,
        "oemerPrecision": 0.99,
        "oemerRecall": 0.99,
        "audiverisPrecision": 0.9,
        "audiverisRecall": 0.9,
        "precisionDelta": 0.09,
        "recallDelta": 0.09,
    }
]
assert comparison["oemer"]["strictPassRows"] == 1
assert comparison["pairedSubset"]["pieceIds"] == ["a"]
assert automatic_adoption_ready(aggregate_metrics([]), 0) is False
assert automatic_adoption_ready(summary, 2) is False
assert automatic_adoption_ready(aggregate_metrics([oemer_rows[0]]), 1) is True
pitch_only = [{**oemer_rows[0], "onsetQuarterAccuracy": 0.2}]
assert aggregate_metrics(pitch_only)["pitchOnlyStrictPassRows"] == 1
assert aggregate_metrics(pitch_only)["strictPassRows"] == 0
assert automatic_adoption_ready(aggregate_metrics(pitch_only), 1) is False

print('{"ok": true, "checks": ["output-discovery", "coordinate-sidecar", "failure-classification", "thread-env", "strict-gate", "engine-comparison"]}')
