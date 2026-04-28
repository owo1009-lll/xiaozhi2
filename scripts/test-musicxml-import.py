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


SAMPLE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type>
          <metronome><beat-unit>quarter</beat-unit><per-minute>88</per-minute></metronome>
          <words>cantabile</words>
          <dynamics><mp/></dynamics>
        </direction-type>
        <sound tempo="88" dynamics="60"/>
      </direction>
      <note default-x="80">
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>4</duration>
      </note>
      <note default-x="180">
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration>
      </note>
    </measure>
    <measure number="2" width="420">
      <note default-x="80">
        <pitch><step>F</step><alter>1</alter><octave>5</octave></pitch>
        <duration>8</duration>
      </note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1" width="420">
      <attributes>
        <divisions>4</divisions>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
      </attributes>
      <note default-x="80">
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>8</duration>
        <staff>1</staff>
      </note>
      <note default-x="80">
        <chord/>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>8</duration>
        <staff>1</staff>
      </note>
      <note default-x="80">
        <chord/>
        <pitch><step>G</step><octave>3</octave></pitch>
        <duration>8</duration>
        <staff>2</staff>
      </note>
    </measure>
  </part>
</score-partwise>
"""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    analyzer = ErhuAnalyzer(Settings())
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "fallback-import.musicxml"
        output_dir = Path(tmp) / "out"
        source.write_text(SAMPLE_MUSICXML, encoding="utf-8")
        result = analyzer.import_musicxml_score(
            MusicXmlImportRequest(
                jobId="musicxml-fallback-test",
                musicxmlPath=str(source),
                originalFilename=source.name,
                titleHint="MusicXML Fallback Test",
                selectedPartHint="erhu",
                outputDir=str(output_dir),
            )
        )

    piece_pack = result.piecePack or {}
    sections = piece_pack.get("sections") or []
    notes = [note for section in sections for note in (section.get("notes") or [])]
    part_candidates = result.partCandidates or piece_pack.get("partCandidates") or []

    require(result.omrStatus == "completed", f"MusicXML import should complete, got {result.omrStatus!r}.")
    require(bool(result.scoreId), "MusicXML import should create a scoreId.")
    require(bool(piece_pack), "MusicXML import should create a piecePack.")
    require(len(sections) >= 1, "MusicXML import should create at least one section.")
    require(len(notes) == 3, f"MusicXML import should retain the three erhu melody notes, got {len(notes)}.")
    require([note.get("midiPitch") for note in notes] == [74, 76, 78], "MusicXML import should retain erhu melody pitches only.")
    require(result.selectedPart == "Erhu", f"Expected selectedPart Erhu, got {result.selectedPart!r}.")
    require(part_candidates and part_candidates[0].get("label") == "Erhu", "Erhu should rank ahead of piano in part candidates.")
    require(result.selectedPartConfidence and result.selectedPartConfidence >= 0.7, "Selected erhu part confidence should be usable.")
    require(piece_pack.get("markingStats", {}).get("tempoChangeCount", 0) >= 1, "Tempo marking should be preserved.")
    require(piece_pack.get("markingStats", {}).get("dynamicChangeCount", 0) >= 1, "Dynamic marking should be preserved.")

    print(
        json.dumps(
            {
                "ok": True,
                "scoreId": result.scoreId,
                "selectedPart": result.selectedPart,
                "selectedPartConfidence": result.selectedPartConfidence,
                "sectionCount": len(sections),
                "noteCount": len(notes),
                "topPartCandidate": part_candidates[0] if part_candidates else None,
                "markingStats": piece_pack.get("markingStats", {}),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
