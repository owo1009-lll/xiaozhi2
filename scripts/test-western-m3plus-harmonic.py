from __future__ import annotations

import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "python-service"))

from analyzer import ErhuAnalyzer  # noqa: E402
from config import Settings  # noqa: E402
from schemas import AnalyzeRequest, PiecePack  # noqa: E402


ARTIFICIAL_HARMONIC_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch><duration>4</duration>
        <notations><technical><harmonic><artificial/><base-pitch/></harmonic></technical></notations>
      </note>
      <note>
        <chord/><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration>
        <notations><technical><harmonic><artificial/><touching-pitch/></harmonic></technical></notations>
      </note>
      <note>
        <chord/><pitch><step>C</step><octave>6</octave></pitch><duration>4</duration>
        <notations><technical><harmonic><artificial/><sounding-pitch/></harmonic></technical></notations>
      </note>
    </measure>
  </part>
</score-partwise>
"""


UNQUALIFIED_HARMONIC_XML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>4</divisions></attributes>
    <note>
      <pitch><step>A</step><octave>5</octave></pitch><duration>4</duration>
      <notations><technical><harmonic/></technical></notations>
    </note>
  </measure></part>
</score-partwise>
"""


def request() -> AnalyzeRequest:
    return AnalyzeRequest(
        participantId="m3plus-harmonic-test",
        piecePack=PiecePack(instrument="violin", meter="4/4", tempo=60),
    )


def main() -> int:
    analyzer = ErhuAnalyzer(Settings())
    notes = analyzer._parse_musicxml_score(
        ARTIFICIAL_HARMONIC_XML,
        request(),
        selected_part_hint="violin",
        collapse_melody=False,
    )
    assert len(notes) == 1
    assert notes[0].midi_pitch == 84
    assert "harmonic" in set(notes[0].techniques or [])
    assert "harmonic-artificial" in set(notes[0].techniques or [])
    assert "harmonic-sounding-pitch" in set(notes[0].techniques or [])

    unqualified = analyzer._parse_musicxml_score(
        UNQUALIFIED_HARMONIC_XML,
        request(),
        selected_part_hint="violin",
        collapse_melody=False,
    )
    assert unqualified == []

    print("western M3+ harmonic scoring tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
