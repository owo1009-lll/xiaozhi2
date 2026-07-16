#!/usr/bin/env python3
"""Split the verified merged measures 2/3 in the Op.45 No.34 HOMR draft.

This is a narrowly scoped, fail-closed repair.  It only accepts the observed
6/8 shape: measure 2 contains exactly twelve duration divisions and every
other measure contains six.  Existing notes and notation elements are moved,
not regenerated.
"""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
DEFAULT_CANDIDATE = (
    REPO
    / "data"
    / "experiments"
    / "western-strings-m4"
    / "op45-34-same-edition-gold-candidate"
    / "op45-34-homr-candidate.musicxml"
)


def sounding_duration(element: ET.Element) -> int:
    total = 0
    for note in element.findall("note"):
        if note.find("chord") is not None or note.find("grace") is not None:
            continue
        duration = note.findtext("duration")
        if duration is not None:
            total += int(duration)
    return total


def split_merged_measure(tree: ET.ElementTree) -> dict[str, object]:
    root = tree.getroot()
    part = root.find("part")
    if part is None:
        raise ValueError("score has no part")
    measures = part.findall("measure")
    durations = [sounding_duration(measure) for measure in measures]

    if len(measures) == 33 and all(duration == 6 for duration in durations):
        return {
            "changed": False,
            "reason": "already-repaired",
            "measureCountBefore": 33,
            "measureCountAfter": 33,
        }
    if len(measures) != 32:
        raise ValueError(f"expected 32 pre-repair measures, got {len(measures)}")
    if durations[1] != 12:
        raise ValueError(f"expected merged measure 2 duration 12, got {durations[1]}")
    unexpected = [index + 1 for index, duration in enumerate(durations) if index != 1 and duration != 6]
    if unexpected:
        raise ValueError(f"non-merged measures do not equal 6 divisions: {unexpected}")

    merged = measures[1]
    split_index: int | None = None
    elapsed = 0
    for index, child in enumerate(list(merged)):
        if child.tag == "note" and child.find("chord") is None and child.find("grace") is None:
            duration = child.findtext("duration")
            elapsed += int(duration or 0)
        if elapsed == 6:
            split_index = index + 1
            break
        if elapsed > 6:
            raise ValueError("measure 2 crosses the split inside a note")
    if split_index is None:
        raise ValueError("could not find a six-division split in measure 2")

    trailing = list(merged)[split_index:]
    if not trailing:
        raise ValueError("measure 2 has no content after the split")
    new_measure = ET.Element("measure", {"number": "3"})
    for child in trailing:
        merged.remove(child)
        new_measure.append(child)
    for measure in reversed(measures[2:]):
        measure.set("number", str(int(measure.get("number", "0")) + 1))
    part.insert(2, new_measure)

    repaired = part.findall("measure")
    repaired_durations = [sounding_duration(measure) for measure in repaired]
    if len(repaired) != 33 or any(duration != 6 for duration in repaired_durations):
        raise ValueError("post-repair invariant failed: expected 33 six-division measures")
    if [int(measure.get("number", "0")) for measure in repaired] != list(range(1, 34)):
        raise ValueError("post-repair measure numbering is not contiguous 1..33")
    return {
        "changed": True,
        "reason": "split-measure-2-into-2-and-3",
        "measureCountBefore": 32,
        "measureCountAfter": 33,
        "measureDurationDivisions": 6,
    }


def write_tree_atomic(tree: ET.ElementTree, destination: Path) -> None:
    ET.indent(tree, space="  ")
    xml_body = ET.tostring(tree.getroot(), encoding="unicode")
    payload = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' + xml_body + "\n"
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=destination.name + ".", suffix=".tmp", dir=destination.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
        os.replace(temporary_name, destination)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, default=DEFAULT_CANDIDATE)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    tree = ET.parse(candidate)
    result = split_merged_measure(tree)
    if result["changed"] and not args.check:
        write_tree_atomic(tree, candidate)
    print(json.dumps({**result, "candidate": str(candidate), "checkOnly": args.check}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
