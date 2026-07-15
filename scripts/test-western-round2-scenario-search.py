from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO / "scripts" / "experiments" / "search_western_strings_round2_scenarios.py"
SPEC = importlib.util.spec_from_file_location("search_western_strings_round2_scenarios", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def note(index: int, measure: int, midi: int, beat: float) -> dict:
    return {"noteIndex": index, "measure": measure, "midi": midi, "scoreBeat": beat}


def event(start: float, midi: int, diff: int = 0) -> dict:
    return {"start": start, "end": start + 0.4, "midi": midi, "pitchDiff": diff, "confidence": 0.9}


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="western-round2-score-") as temp:
        score_path = Path(temp) / "repeated-zero.musicxml"
        score_path.write_text(
            """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">
    <measure number="0"><attributes><divisions>1</divisions></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note></measure>
    <measure number="0"><note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration></note></measure>
  </part>
</score-partwise>
""",
            encoding="utf-8",
        )
        parsed = MODULE.parse_score_notes(score_path)
        assert [row["measure"] for row in parsed] == [1, 2]
        assert [row["scoreBeat"] for row in parsed] == [0.0, 1.0]

    notes = [note(index, index + 1, 60 + index, float(index)) for index in range(5)]

    wrong = [event(float(index), 60 + index) for index in range(5)]
    wrong[2] = event(2.0, 64, 2)
    wrong_rows = MODULE.wrong_pitch_candidates(notes, wrong)
    assert len(wrong_rows) == 1
    assert wrong_rows[0]["measureIndex"] == 3

    missing = [event(float(index), 60 + index) for index in range(5)]
    missing[2] = None
    missing_rows = MODULE.missing_note_candidates(notes, missing)
    assert len(missing_rows) == 1
    assert missing_rows[0]["measureIndex"] == 3

    rhythm = [event(value, 60 + index) for index, value in enumerate([0.0, 1.0, 2.7, 3.0, 4.0])]
    rhythm_rows = MODULE.rhythm_shift_candidates(notes, rhythm)
    assert rhythm_rows
    assert rhythm_rows[0]["measureIndex"] == 3
    assert rhythm_rows[0]["timingResidualBeats"] >= 0.5

    print("western round2 scenario search tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
