from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path


EXPERIMENTS = Path(__file__).resolve().parent / "experiments"
sys.path.insert(0, str(EXPERIMENTS))

from repair_western_strings_m4_op45_merged_measure import (  # noqa: E402
    sounding_duration,
    split_merged_measure,
)


def note(duration: int = 1) -> ET.Element:
    element = ET.Element("note")
    ET.SubElement(element, "pitch")
    ET.SubElement(element, "duration").text = str(duration)
    return element


def fixture() -> ET.ElementTree:
    root = ET.Element("score-partwise")
    part = ET.SubElement(root, "part", {"id": "P1"})
    for number in range(1, 33):
        measure = ET.SubElement(part, "measure", {"number": str(number)})
        for _ in range(12 if number == 2 else 6):
            measure.append(note())
    return ET.ElementTree(root)


def test_split_preserves_notes_and_restores_structure() -> None:
    tree = fixture()
    result = split_merged_measure(tree)
    measures = tree.getroot().find("part").findall("measure")  # type: ignore[union-attr]
    assert result["changed"] is True
    assert len(measures) == 33
    assert [sounding_duration(measure) for measure in measures] == [6] * 33
    assert [int(measure.get("number", "0")) for measure in measures] == list(range(1, 34))
    assert sum(len(measure.findall("note")) for measure in measures) == 198


def test_second_run_is_idempotent() -> None:
    tree = fixture()
    split_merged_measure(tree)
    second = split_merged_measure(tree)
    assert second["changed"] is False
    assert second["reason"] == "already-repaired"


if __name__ == "__main__":
    test_split_preserves_notes_and_restores_structure()
    test_second_run_is_idempotent()
    print("western M4 Op.45 merged-measure repair tests passed")
