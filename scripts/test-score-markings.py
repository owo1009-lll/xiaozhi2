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
from schemas import ScoreImportRequest  # noqa: E402


SAMPLE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <defaults>
    <page-layout>
      <page-height>1600</page-height>
      <page-width>1200</page-width>
      <page-margins type="both">
        <left-margin>70</left-margin>
        <right-margin>70</right-margin>
        <top-margin>80</top-margin>
        <bottom-margin>80</bottom-margin>
      </page-margins>
    </page-layout>
  </defaults>
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <print new-system="yes">
        <system-layout>
          <system-margins><left-margin>20</left-margin><right-margin>0</right-margin></system-margins>
          <top-system-distance>140</top-system-distance>
        </system-layout>
      </print>
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type>
          <metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome>
          <words>Allegro cantabile</words>
          <dynamics><mf/></dynamics>
          <wedge type="crescendo"/>
        </direction-type>
        <sound tempo="96" dynamics="80"/>
      </direction>
      <note default-x="80">
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>4</duration>
        <notations>
          <articulations><staccato/><accent/></articulations>
          <technical><harmonic/></technical>
          <ornaments><trill-mark/></ornaments>
        </notations>
      </note>
      <note default-x="210">
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration>
        <notations><slur type="start" number="1"/></notations>
      </note>
      <barline location="right"><repeat direction="forward"/></barline>
    </measure>
    <measure number="2" width="420">
      <direction placement="below">
        <direction-type><dynamics><p/></dynamics><wedge type="stop"/></direction-type>
        <sound dynamics="45"/>
      </direction>
      <note default-x="80">
        <pitch><step>F</step><alter>1</alter><octave>5</octave></pitch>
        <duration>8</duration>
        <notations><slur type="stop" number="1"/></notations>
      </note>
      <barline location="right"><repeat direction="backward" times="2"/></barline>
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

MERGED_VOICE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <attributes>
        <divisions>4</divisions>
        <staves>3</staves>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note default-x="60">
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>4</duration>
        <staff>1</staff>
      </note>
      <note default-x="60">
        <chord/>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <staff>2</staff>
      </note>
      <note default-x="60">
        <chord/>
        <pitch><step>C</step><octave>3</octave></pitch>
        <duration>4</duration>
        <staff>3</staff>
      </note>
      <note default-x="160">
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration>
        <staff>1</staff>
      </note>
      <note default-x="160">
        <chord/>
        <pitch><step>G</step><octave>3</octave></pitch>
        <duration>4</duration>
        <staff>3</staff>
      </note>
    </measure>
  </part>
</score-partwise>
"""

SYSTEM_MERGED_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <defaults>
    <page-layout>
      <page-height>1600</page-height>
      <page-width>1200</page-width>
    </page-layout>
  </defaults>
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <print new-system="yes"><system-layout><top-system-distance>120</top-system-distance></system-layout></print>
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="2" width="420">
      <print new-system="yes"><system-layout><top-system-distance>260</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="3" width="420">
      <print new-system="yes"><system-layout><top-system-distance>400</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="4" width="420">
      <print new-system="yes"><system-layout><top-system-distance>540</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="5" width="420">
      <print new-system="yes"><system-layout><top-system-distance>680</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>B</step><octave>3</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="6" width="420">
      <print new-system="yes"><system-layout><top-system-distance>820</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>A</step><octave>2</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>
"""

SPARSE_FALSE_LEAD_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <defaults>
    <page-layout>
      <page-height>1600</page-height>
      <page-width>1200</page-width>
    </page-layout>
  </defaults>
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <print new-system="yes"><system-layout><top-system-distance>100</top-system-distance></system-layout></print>
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>6</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="2" width="420">
      <print new-system="yes"><system-layout><top-system-distance>240</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="3" width="420">
      <print new-system="yes"><system-layout><top-system-distance>380</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="4" width="420">
      <print new-system="yes"><system-layout><top-system-distance>520</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
      <note default-x="160"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
      <note default-x="260"><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="5" width="420">
      <print new-system="yes"><system-layout><top-system-distance>660</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="6" width="420">
      <print new-system="yes"><system-layout><top-system-distance>800</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note>
      <note default-x="60"><chord/><pitch><step>E</step><octave>3</octave></pitch><duration>4</duration></note>
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
        source = Path(tmp) / "markings.musicxml"
        source.write_text(SAMPLE_MUSICXML, encoding="utf-8")
        request = ScoreImportRequest(
            jobId="score-marking-test",
            pdfPath=str(source),
            originalFilename="markings.musicxml",
            titleHint="Score Marking Test",
            selectedPartHint="erhu",
        )
        section, detected_parts, selected_part, part_candidates, marking_stats = analyzer._parse_musicxml_source_to_section(
            source,
            request,
            "erhu",
            "page-001-s01",
            "自动识谱第 1 页 片段 1",
            1,
        )
        merged_source = Path(tmp) / "merged-voice.musicxml"
        merged_source.write_text(MERGED_VOICE_MUSICXML, encoding="utf-8")
        merged_request = ScoreImportRequest(
            jobId="merged-voice-test",
            pdfPath=str(merged_source),
            originalFilename="merged-voice.musicxml",
            titleHint="Merged Voice Test",
            selectedPartHint="Voice",
        )
        merged_section, *_ = analyzer._parse_musicxml_source_to_section(
            merged_source,
            merged_request,
            "Voice",
            "page-001-s01",
            "Merged Voice",
            1,
        )
        system_source = Path(tmp) / "system-merged-voice.musicxml"
        system_source.write_text(SYSTEM_MERGED_MUSICXML, encoding="utf-8")
        system_request = ScoreImportRequest(
            jobId="system-merged-voice-test",
            pdfPath=str(system_source),
            originalFilename="system-merged-voice.musicxml",
            titleHint="System Merged Voice Test",
            selectedPartHint="Voice",
        )
        system_section, *_ = analyzer._parse_musicxml_source_to_section(
            system_source,
            system_request,
            "Voice",
            "page-001-s01",
            "System Merged Voice",
            1,
        )
        sparse_source = Path(tmp) / "sparse-false-lead.musicxml"
        sparse_source.write_text(SPARSE_FALSE_LEAD_MUSICXML, encoding="utf-8")
        sparse_request = ScoreImportRequest(
            jobId="sparse-false-lead-test",
            pdfPath=str(sparse_source),
            originalFilename="sparse-false-lead.musicxml",
            titleHint="Sparse False Lead Test",
            selectedPartHint="Voice",
        )
        sparse_section, *_ = analyzer._parse_musicxml_source_to_section(
            sparse_source,
            sparse_request,
            "Voice",
            "page-001-s01",
            "Sparse False Lead",
            1,
        )

    require(section is not None, "MusicXML did not produce a section.")
    require(merged_section is not None, "Merged voice MusicXML did not produce a section.")
    require(system_section is not None, "System-merged voice MusicXML did not produce a section.")
    require(sparse_section is not None, "Sparse false lead MusicXML did not produce a section.")
    merged_notes = merged_section["notes"]
    merged_staffs = {int(note["notePosition"]["staffIndex"]) for note in merged_notes if note.get("notePosition")}
    require(merged_staffs == {1}, f"Merged voice should keep only erhu/top staff, got {merged_staffs}.")
    require([note["midiPitch"] for note in merged_notes] == [74, 76], "Merged voice should keep the top erhu melody pitches.")
    require(
        merged_section.get("scoreLineStats", {}).get("erhuNoteCount") == 2,
        "Merged voice should mark retained notes as erhu line notes.",
    )
    system_notes = system_section["notes"]
    system_systems = {int(note["notePosition"]["systemIndex"]) for note in system_notes if note.get("notePosition")}
    require(system_systems == {1, 4}, f"Three-line system split should keep only erhu systems 1 and 4, got {system_systems}.")
    require([note["midiPitch"] for note in system_notes] == [74, 76], "Three-line system split should exclude piano accompaniment lines.")
    sparse_notes = sparse_section["notes"]
    sparse_systems = {int(note["notePosition"]["systemIndex"]) for note in sparse_notes if note.get("notePosition")}
    require(sparse_systems == {4}, f"Sparse false lead should be suppressed; kept systems {sparse_systems}.")
    require([note["midiPitch"] for note in sparse_notes] == [74, 76, 77], "Sparse false lead should keep only the real erhu melody system.")
    notes = section["notes"]
    first_note = notes[0]
    require(selected_part == "Erhu", f"Expected Erhu selected part, got {selected_part!r}.")
    require(part_candidates and part_candidates[0]["label"] == "Erhu", "Erhu should rank ahead of piano.")
    require(first_note["activeTempo"] == 96, "Tempo should propagate to notes.")
    require(first_note["activeDynamic"] == "mf", "Dynamic should propagate to notes.")
    require("staccato" in first_note["articulations"], "Articulation staccato missing.")
    require("accent" in first_note["articulations"], "Articulation accent missing.")
    require("harmonic" in first_note["techniques"], "Technical harmonic missing.")
    require("trill-mark" in first_note["techniques"], "Ornament trill-mark missing.")
    require(marking_stats.get("tempoChangeCount", 0) >= 1, "Tempo marking missing.")
    require(marking_stats.get("dynamicChangeCount", 0) >= 2, "Dynamic markings missing.")
    require(marking_stats.get("repeatCount", 0) >= 2, "Repeat structure missing.")

    print(
        json.dumps(
            {
                "ok": True,
                "selectedPart": selected_part,
                "selectedPartConfidence": section.get("selectedPartConfidence"),
                "detectedParts": detected_parts,
                "topPartCandidate": part_candidates[0] if part_candidates else None,
                "markingStats": marking_stats,
                "firstNote": {
                    "activeTempo": first_note.get("activeTempo"),
                    "activeDynamic": first_note.get("activeDynamic"),
                    "articulations": first_note.get("articulations"),
                    "notations": first_note.get("notations"),
                    "techniques": first_note.get("techniques"),
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
