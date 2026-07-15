from __future__ import annotations

import json
import sys
import tempfile
import warnings
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))
warnings.filterwarnings("ignore", message="pkg_resources is deprecated.*")

from analyzer import ErhuAnalyzer  # noqa: E402
from config import Settings  # noqa: E402
from schemas import MusicXmlImportRequest  # noqa: E402


SAMPLE_VIOLIN_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Violin</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>4</divisions><staves>2</staves></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration></note>
    </measure>
  </part>
</score-partwise>
"""


SAMPLE_DOUBLE_STOP_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name /></score-part></part-list>
  <part id="P1">
    <measure number="0">
      <attributes><divisions>4</divisions></attributes>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="0">
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>4</duration></note>
      <note><chord/><pitch><step>C</step><alter>1</alter><octave>5</octave></pitch><duration>4</duration></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>
"""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    analyzer = ErhuAnalyzer(Settings())
    with tempfile.TemporaryDirectory() as temp_dir:
        source = Path(temp_dir) / "violin.musicxml"
        output_dir = Path(temp_dir) / "out"
        source.write_text(SAMPLE_VIOLIN_MUSICXML, encoding="utf-8")
        result = analyzer.import_musicxml_score(
            MusicXmlImportRequest(
                jobId="western-violin-import-test",
                musicxmlPath=str(source),
                originalFilename=source.name,
                titleHint="Western Violin Import Test",
                selectedPartHint="violin",
                instrument="violin",
                scoreSource="musicxml",
                tempoKnown=False,
                tempoSource="unknown",
                outputDir=str(output_dir),
            )
        )

        double_stop_source = Path(temp_dir) / "double-stop.musicxml"
        double_stop_source.write_text(SAMPLE_DOUBLE_STOP_MUSICXML, encoding="utf-8")
        double_stop_result = analyzer.import_musicxml_score(
            MusicXmlImportRequest(
                jobId="western-double-stop-import-test",
                musicxmlPath=str(double_stop_source),
                originalFilename=double_stop_source.name,
                titleHint="Western Double Stop Import Test",
                selectedPartHint="violin",
                instrument="violin",
                scoreSource="musicxml",
                tempoKnown=False,
                tempoSource="unknown",
                outputDir=str(Path(temp_dir) / "double-stop-out"),
            )
        )

    piece_pack = result.piecePack or {}
    notes = [note for section in piece_pack.get("sections", []) for note in (section.get("notes") or [])]
    require(result.omrStatus == "completed", f"western MusicXML import should complete, got {result.omrStatus!r}: {result.error}")
    require(result.selectedPart == "Violin", f"expected selectedPart Violin, got {result.selectedPart!r}")
    require(piece_pack.get("instrument") == "violin", f"expected instrument metadata, got {piece_pack.get('instrument')!r}")
    require(piece_pack.get("scoreSourceType") == "musicxml", f"expected MusicXML source metadata, got {piece_pack.get('scoreSourceType')!r}")
    require(piece_pack.get("tempoKnown") is False, f"missing tempo should remain unknown, got {piece_pack.get('tempoKnown')!r}")
    require(piece_pack.get("tempoSource") == "unknown", f"expected unknown tempo source, got {piece_pack.get('tempoSource')!r}")
    require(len(notes) == 2, f"expected 2 violin notes, got {len(notes)}")
    require([note.get("midiPitch") for note in notes] == [67, 69], f"unexpected violin pitches: {notes}")
    double_stop_notes = [
        note
        for section in (double_stop_result.piecePack or {}).get("sections", [])
        for note in (section.get("notes") or [])
    ]
    require(double_stop_result.omrStatus == "completed", "double-stop MusicXML import should complete")
    require(len(double_stop_notes) == 8, f"expected all 8 double-stop pitches, got {len(double_stop_notes)}")
    require(
        sorted({note.get("measureIndex") for note in double_stop_notes}) == [1, 2],
        f"duplicate MusicXML measure labels should fall back to document order: {double_stop_notes}",
    )
    require(
        [note.get("midiPitch") for note in double_stop_notes] == [62, 69, 64, 71, 66, 73, 67, 74],
        f"unexpected double-stop pitches: {double_stop_notes}",
    )
    print(json.dumps({
        "ok": True,
        "selectedPart": result.selectedPart,
        "noteCount": len(notes),
        "doubleStopNoteCount": len(double_stop_notes),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
