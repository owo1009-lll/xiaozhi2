from __future__ import annotations

import json
import sys
import tempfile
import warnings
import zipfile
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

SAMPLE_VIOLIN_PIANO_MUSICXML = SAMPLE_MUSICXML.replace(
    "<part-name>Erhu</part-name>",
    "<part-name>Violin</part-name>",
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def assert_import_result(result, label: str, expected_part: str = "Erhu") -> dict:
    piece_pack = result.piecePack or {}
    sections = piece_pack.get("sections") or []
    notes = [note for section in sections for note in (section.get("notes") or [])]
    part_candidates = result.partCandidates or piece_pack.get("partCandidates") or []

    require(result.omrStatus == "completed", f"{label} import should complete, got {result.omrStatus!r}.")
    require(bool(result.scoreId), f"{label} import should create a scoreId.")
    require(bool(piece_pack), f"{label} import should create a piecePack.")
    require(len(sections) >= 1, f"{label} import should create at least one section.")
    require(len(notes) == 3, f"{label} import should retain the three target melody notes, got {len(notes)}.")
    require([note.get("midiPitch") for note in notes] == [74, 76, 78], f"{label} import should retain target melody pitches only.")
    require(result.selectedPart == expected_part, f"Expected selectedPart {expected_part} for {label}, got {result.selectedPart!r}.")
    require(part_candidates and part_candidates[0].get("label") == expected_part, f"{expected_part} should rank ahead of piano in {label} candidates.")
    require(part_candidates[0].get("selectionAmbiguous") is False, f"Target candidate should not be ambiguous in {label}.")
    require(part_candidates[0].get("scoreGapToNext", 0) >= 0.9, f"Target-to-piano candidate gap should be explicit in {label}.")
    require(part_candidates[0].get("measureQuality", 0) > 0, f"Part candidate measure quality should be reported for {label}.")
    require(result.selectedPartConfidence and result.selectedPartConfidence >= 0.7, f"Selected target part confidence should be usable for {label}.")
    require(piece_pack.get("markingStats", {}).get("tempoChangeCount", 0) >= 1, f"Tempo marking should be preserved for {label}.")
    require(piece_pack.get("markingStats", {}).get("dynamicChangeCount", 0) >= 1, f"Dynamic marking should be preserved for {label}.")

    return {
        "scoreId": result.scoreId,
        "selectedPart": result.selectedPart,
        "selectedPartConfidence": result.selectedPartConfidence,
        "sectionCount": len(sections),
        "noteCount": len(notes),
        "topPartCandidate": part_candidates[0] if part_candidates else None,
        "markingStats": piece_pack.get("markingStats", {}),
    }


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

        mxl_source = Path(tmp) / "fallback-import.mxl"
        mxl_output_dir = Path(tmp) / "mxl-out"
        with zipfile.ZipFile(mxl_source, "w") as archive:
            archive.writestr(
                "META-INF/container.xml",
                """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>
  </rootfiles>
</container>
""",
            )
            archive.writestr("score.musicxml", SAMPLE_MUSICXML)
        mxl_result = analyzer.import_musicxml_score(
            MusicXmlImportRequest(
                jobId="mxl-fallback-test",
                musicxmlPath=str(mxl_source),
                originalFilename=mxl_source.name,
                titleHint="MXL Fallback Test",
                selectedPartHint="erhu",
                outputDir=str(mxl_output_dir),
            )
        )

        violin_source = Path(tmp) / "violin-piano.musicxml"
        violin_output_dir = Path(tmp) / "violin-piano-out"
        violin_source.write_text(SAMPLE_VIOLIN_PIANO_MUSICXML, encoding="utf-8")
        violin_result = analyzer.import_musicxml_score(
            MusicXmlImportRequest(
                jobId="violin-piano-import-test",
                musicxmlPath=str(violin_source),
                originalFilename=violin_source.name,
                titleHint="Violin and Piano Import Test",
                selectedPartHint="violin",
                outputDir=str(violin_output_dir),
            )
        )

    musicxml_summary = assert_import_result(result, "MusicXML")
    mxl_summary = assert_import_result(mxl_result, "MXL")
    violin_piano_summary = assert_import_result(
        violin_result,
        "Violin + Piano MusicXML",
        expected_part="Violin",
    )

    print(
        json.dumps(
            {
                "ok": True,
                "musicxml": musicxml_summary,
                "mxl": mxl_summary,
                "violinPianoMusicxml": violin_piano_summary,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
