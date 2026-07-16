#!/usr/bin/env python3
"""Build focused P0 gold and a fail-closed coordinate review workspace."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from xml.etree import ElementTree as ET

from eval_western_strings_m4_omr_benchmark import child, child_text, local_name, pitch_to_midi, read_score_xml
from western_m4_omr_structure import read_omr_structure


REPO = Path(__file__).resolve().parents[2]
DEFAULT_BENCHMARK = REPO / "data/experiments/western-strings-m4/independent-source-benchmark/omr-benchmark.json"
DEFAULT_VARIANTS = REPO / "data/experiments/western-strings-m4/independent-real-jpg-variants"
DEFAULT_OUT = REPO / "data/experiments/western-strings-m4/focused-symbol-gold"


def best_part(root: ET.Element) -> ET.Element:
    parts = [element for element in root.iter() if local_name(str(element.tag)) == "part"]
    if not parts:
        raise ValueError("no-part")
    return max(parts, key=lambda part: sum(local_name(str(value.tag)) == "note" for value in part.iter()))


def diatonic_staff_position(note: ET.Element) -> int | None:
    pitch = child(note, "pitch")
    if pitch is None:
        return None
    step = child_text(pitch, "step")
    octave = child_text(pitch, "octave")
    if step not in "CDEFGAB" or not octave:
        return None
    try:
        # Treble staff bottom line E4 is position zero; top line F5 is eight.
        return int(octave) * 7 + "CDEFGAB".index(step) - (4 * 7 + "CDEFGAB".index("E"))
    except ValueError:
        return None


def write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows({key: row.get(key, "") for key in columns} for row in rows)


def focused_rows(piece_id: str, gold_path: Path) -> tuple[list[dict], list[dict]]:
    root = ET.fromstring(read_score_xml(gold_path))
    part = best_part(root)
    accidentals: list[dict] = []
    ledgers: list[dict] = []
    note_index = 0
    for measure_position, measure in enumerate(
        [value for value in list(part) if local_name(str(value.tag)) == "measure"],
        1,
    ):
        for note in [value for value in list(measure) if local_name(str(value.tag)) == "note"]:
            if child(note, "rest") is not None or child(note, "chord") is not None:
                continue
            midi = pitch_to_midi(note)
            if midi is None:
                continue
            note_index += 1
            accidental = child_text(note, "accidental")
            pitch = child(note, "pitch")
            alter = child_text(pitch, "alter") if pitch is not None else ""
            if accidental:
                accidentals.append(
                    {
                        "pieceId": piece_id,
                        "measure": measure_position,
                        "noteIndex": note_index,
                        "midi": midi,
                        "accidental": accidental,
                        "alter": alter,
                        "goldSource": str(gold_path.relative_to(REPO)),
                    }
                )
            position = diatonic_staff_position(note)
            if position is not None and (position < 0 or position > 8):
                ledgers.append(
                    {
                        "pieceId": piece_id,
                        "measure": measure_position,
                        "noteIndex": note_index,
                        "midi": midi,
                        "staffPositionFromE4": position,
                        "ledgerSide": "below" if position < 0 else "above",
                        "goldSource": str(gold_path.relative_to(REPO)),
                    }
                )
    return accidentals, ledgers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", default=str(DEFAULT_BENCHMARK))
    parser.add_argument("--variants", default=str(DEFAULT_VARIANTS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()
    benchmark = json.loads(Path(args.benchmark).read_text(encoding="utf-8"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    accidentals: list[dict] = []
    ledgers: list[dict] = []
    clefs: list[dict] = []
    coordinate_tasks: list[dict] = []
    for source in benchmark.get("rows", []):
        if not source.get("benchmarkUsable"):
            continue
        piece_id = source["pieceId"]
        gold_path = REPO / source["goldPath"]
        piece_accidentals, piece_ledgers = focused_rows(piece_id, gold_path)
        accidentals.extend(piece_accidentals)
        ledgers.extend(piece_ledgers)
        omr_files = sorted((Path(args.variants) / piece_id / "up2" / "omr").glob("*.omr"))
        if not omr_files:
            continue
        raw = read_omr_structure(omr_files[0])
        clef_by_staff = {
            f"{item.get('page')}:{item.get('staff')}": item for item in raw.get("clefs", [])
        }
        for staff in raw.get("staffs", []):
            prediction = clef_by_staff.get(staff) or {}
            clefs.append(
                {
                    "pieceId": piece_id,
                    "staffId": staff,
                    "goldClef": "TREBLE",
                    "predictedClef": prediction.get("kind", "missing"),
                    "predictionScore": prediction.get("score", ""),
                    "correct": prediction.get("kind") == "TREBLE",
                    "goldBasis": "verified violin source score and standard line-start clef",
                }
            )
        # Audiveris bbox values are review proposals, never coordinate gold.
        for index, prediction in enumerate(raw.get("coordinateSymbols", []), 1):
            bounds = prediction.get("bounds") or {}
            coordinate_tasks.append(
                {
                    "pieceId": piece_id,
                    "symbolType": prediction.get("tag", ""),
                    "symbolIndex": index,
                    "page": prediction.get("page", ""),
                    "rawSymbolId": prediction.get("id", ""),
                    "predictedX": bounds.get("x", ""),
                    "predictedY": bounds.get("y", ""),
                    "predictedW": bounds.get("w", ""),
                    "predictedH": bounds.get("h", ""),
                    "humanCenterX": "",
                    "humanCenterY": "",
                    "reviewStatus": "",
                }
            )

    write_csv(out / "accidental-gold.csv", accidentals, [
        "pieceId", "measure", "noteIndex", "midi", "accidental", "alter", "goldSource"
    ])
    write_csv(out / "ledger-note-gold.csv", ledgers, [
        "pieceId", "measure", "noteIndex", "midi", "staffPositionFromE4", "ledgerSide", "goldSource"
    ])
    write_csv(out / "line-start-clef-gold.csv", clefs, [
        "pieceId", "staffId", "goldClef", "predictedClef", "predictionScore", "correct", "goldBasis"
    ])
    write_csv(out / "coordinate-review-tasks.csv", coordinate_tasks, [
        "pieceId", "symbolType", "symbolIndex", "page", "rawSymbolId", "predictedX", "predictedY", "predictedW",
        "predictedH", "humanCenterX", "humanCenterY", "reviewStatus"
    ])
    summary = {
        "pieceCount": len({row["pieceId"] for row in clefs}),
        "accidentalGoldCount": len(accidentals),
        "ledgerNoteGoldCount": len(ledgers),
        "lineStartClefGoldCount": len(clefs),
        "lineStartClefCorrectCount": sum(row["correct"] for row in clefs),
        "coordinateReviewTaskCount": len(coordinate_tasks),
        "coordinateGoldReady": False,
        "coordinateBlockingReason": "independent-photo-human-bbox-review-missing",
    }
    report = {
        "schemaVersion": 1,
        "summary": summary,
        "artifacts": {
            "accidentals": "accidental-gold.csv",
            "ledgerNotes": "ledger-note-gold.csv",
            "lineStartClefs": "line-start-clef-gold.csv",
            "coordinateReviewTasks": "coordinate-review-tasks.csv",
        },
        "safety": [
            "Accidental and ledger-note labels come from independent verified MusicXML gold.",
            "Line-start clef gold uses the verified violin source and checks every staff line detected in the raw OMR graph.",
            "Audiveris bounding boxes are only review proposals. Coordinate accuracy remains blocked until a human supplies independent centers.",
        ],
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "summary": summary, "out": str(out)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
