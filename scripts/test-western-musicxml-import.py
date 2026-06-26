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
                outputDir=str(output_dir),
            )
        )

    piece_pack = result.piecePack or {}
    notes = [note for section in piece_pack.get("sections", []) for note in (section.get("notes") or [])]
    require(result.omrStatus == "completed", f"western MusicXML import should complete, got {result.omrStatus!r}: {result.error}")
    require(result.selectedPart == "Violin", f"expected selectedPart Violin, got {result.selectedPart!r}")
    require(len(notes) == 2, f"expected 2 violin notes, got {len(notes)}")
    require([note.get("midiPitch") for note in notes] == [67, 69], f"unexpected violin pitches: {notes}")
    print(json.dumps({"ok": True, "selectedPart": result.selectedPart, "noteCount": len(notes)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
