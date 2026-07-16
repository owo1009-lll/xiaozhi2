#!/usr/bin/env python3
from __future__ import annotations

import csv
import importlib.util
import tempfile
from pathlib import Path

from music21 import bar, note, stream


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts/experiments/eval_western_strings_m4_repeat_route.py"
SPEC = importlib.util.spec_from_file_location("m4_repeat_route", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def main() -> int:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        score = stream.Score()
        part = stream.Part()
        first = stream.Measure(number=1)
        first.leftBarline = bar.Repeat(direction="start")
        first.append(note.Note(60, quarterLength=1))
        second = stream.Measure(number=2)
        second.append(note.Note(62, quarterLength=1))
        second.rightBarline = bar.Repeat(direction="end")
        part.append([first, second])
        score.append(part)
        score_path = root / "repeat.musicxml"
        score.write("musicxml", fp=str(score_path))
        alignment_path = root / "alignment.csv"
        with alignment_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["start", "end"])
            writer.writerow([0.0, 0.5])
            writer.writerow([0.5, 1.0])
        result = MODULE.evaluate_route(score_path, alignment_path)
        assert result["printedNoteEvents"] == 2
        assert result["expandedNoteEvents"] == 4
        assert result["preferredRouteByCount"] == "printed"
        assert result["automaticExpansionSupported"] is False

        plain_score = stream.Score()
        plain_part = stream.Part()
        plain_measure = stream.Measure(number=1)
        plain_measure.append(note.Note(64, quarterLength=1))
        plain_part.append(plain_measure)
        plain_score.append(plain_part)
        plain_path = root / "plain.musicxml"
        plain_score.write("musicxml", fp=str(plain_path))
        hypothesis = MODULE.inspect_op45_repeat_hypothesis(plain_path, plain_path)
        assert hypothesis["machineReadableRepeatMarkerCount"] == 0
        assert hypothesis["status"] == "repeat-hypothesis-unsupported-no-markers"
        assert hypothesis["sameEditionCandidate"]["noteEvents"] == 1
    print("western M4 repeat-route tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
