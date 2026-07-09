from __future__ import annotations

import argparse
import csv
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKSPACE = ROOT / "data" / "experiments" / "western-strings-m4" / "independent-gold-workspace.csv"
DEFAULT_OUT = ROOT / "data" / "experiments" / "western-strings-m4" / "independent-gold-note-summary.csv"
DEFAULT_JSON = ROOT / "data" / "experiments" / "western-strings-m4" / "independent-gold-note-summary.json"
DEFAULT_MD = ROOT / "data" / "experiments" / "western-strings-m4" / "independent-gold-note-summary.md"

STEP_TO_SEMITONE = {
    "C": 0,
    "D": 2,
    "E": 4,
    "F": 5,
    "G": 7,
    "A": 9,
    "B": 11,
}

MIDI_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def local_name(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def child(element: ET.Element, name: str) -> ET.Element | None:
    for item in list(element):
        if local_name(item.tag) == name:
            return item
    return None


def children(element: ET.Element, name: str) -> list[ET.Element]:
    return [item for item in list(element) if local_name(item.tag) == name]


def text_of(element: ET.Element | None) -> str:
    return (element.text or "").strip() if element is not None else ""


def read_score_xml(path: Path) -> bytes:
    try:
        with zipfile.ZipFile(path) as archive:
            names = [
                name
                for name in archive.namelist()
                if name.lower().endswith((".xml", ".musicxml")) and not name.startswith("META-INF/")
            ]
            if names:
                return archive.read(names[0])
            return archive.read(archive.namelist()[0])
    except zipfile.BadZipFile:
        return path.read_bytes()


def pitch_to_midi(note: ET.Element) -> int | None:
    pitch = child(note, "pitch")
    if pitch is None:
        return None
    step = text_of(child(pitch, "step")).upper()
    octave_text = text_of(child(pitch, "octave"))
    alter_text = text_of(child(pitch, "alter"))
    if step not in STEP_TO_SEMITONE or not octave_text:
        return None
    try:
        octave = int(float(octave_text))
        alter = int(float(alter_text or "0"))
    except ValueError:
        return None
    return (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter


def midi_name(value: int | None) -> str:
    if value is None:
        return ""
    octave = value // 12 - 1
    return f"{MIDI_NAMES[value % 12]}{octave}"


def summarize_score(path: Path) -> dict:
    if not path.exists():
        return {"parseOk": "no", "issue": "editable-gold-missing"}
    try:
        root = ET.fromstring(read_score_xml(path))
    except Exception as exc:
        return {"parseOk": "no", "issue": f"parse-error:{type(exc).__name__}"}

    parts = [item for item in root.iter() if local_name(item.tag) == "part"]
    part_summaries = []
    for part in parts:
        measures = children(part, "measure")
        notes = []
        measure_numbers = []
        first_items = []
        for measure_index, measure in enumerate(measures, start=1):
            measure_number = measure.attrib.get("number") or str(measure_index)
            measure_numbers.append(measure_number)
            for note in children(measure, "note"):
                if child(note, "rest") is not None:
                    continue
                midi = pitch_to_midi(note)
                if midi is None:
                    continue
                notes.append(midi)
                if len(first_items) < 16:
                    first_items.append(f"m{measure_number}:{midi_name(midi)}")
        part_summaries.append({
            "partId": part.attrib.get("id") or "",
            "measureCount": len(measures),
            "noteCount": len(notes),
            "minMidi": min(notes) if notes else None,
            "maxMidi": max(notes) if notes else None,
            "firstMeasure": measure_numbers[0] if measure_numbers else "",
            "lastMeasure": measure_numbers[-1] if measure_numbers else "",
            "firstNotes": " ".join(first_items),
        })

    if not part_summaries:
        return {"parseOk": "no", "issue": "no-parts"}
    selected = max(part_summaries, key=lambda item: (item["noteCount"], item["measureCount"]))
    return {
        "parseOk": "yes",
        "issue": "",
        **selected,
        "pitchRange": f"{midi_name(selected['minMidi'])}-{midi_name(selected['maxMidi'])}" if selected["noteCount"] else "",
    }


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def build_markdown(rows: list[dict]) -> str:
    lines = [
        "# M4 Independent Gold Note Summary",
        "",
        "This is a machine summary of the current editable MXL files. It is not an OMR accuracy claim and does not replace score-editor correction.",
        "",
        "| # | pieceId | parse | measures | notes | pitchRange | first notes | editableGoldPath |",
        "|---:|---|---|---:|---:|---|---|---|",
    ]
    for index, row in enumerate(rows, start=1):
        lines.append(
            f"| {index} | {row.get('pieceId','')} | {row.get('parseOk','')} | {row.get('measureCount','')} | {row.get('noteCount','')} | {row.get('pitchRange','')} | {row.get('firstNotes','')} | `{row.get('editableGoldPath','')}` |"
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--json", default=str(DEFAULT_JSON))
    parser.add_argument("--md", default=str(DEFAULT_MD))
    args = parser.parse_args(argv)

    workspace = Path(args.workspace)
    rows = []
    with workspace.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            editable = ROOT / (row.get("editableGoldPath") or "")
            summary = summarize_score(editable)
            rows.append({
                "recordingId": row.get("recordingId", ""),
                "pieceId": row.get("pieceId", ""),
                "scoreId": row.get("scoreId", ""),
                "sourceScorePath": row.get("sourceScorePath", ""),
                "editableGoldPath": row.get("editableGoldPath", ""),
                **summary,
            })

    out_path = Path(args.out)
    json_path = Path(args.json)
    md_path = Path(args.md)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    columns = [
        "recordingId",
        "pieceId",
        "scoreId",
        "sourceScorePath",
        "editableGoldPath",
        "parseOk",
        "issue",
        "partId",
        "measureCount",
        "noteCount",
        "minMidi",
        "maxMidi",
        "pitchRange",
        "firstMeasure",
        "lastMeasure",
        "firstNotes",
    ]
    with out_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    json_path.write_text(json.dumps({"ok": True, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(build_markdown(rows), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "rows": len(rows),
        "parseOkRows": sum(1 for row in rows if row.get("parseOk") == "yes"),
        "csv": rel(out_path),
        "json": rel(json_path),
        "markdown": rel(md_path),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
