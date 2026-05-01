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

TWO_STAFF_REPEATED_SYSTEMS_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
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
      <attributes><divisions>4</divisions><staves>2</staves><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><staff>1</staff></note>
      <note default-x="60"><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><staff>2</staff></note>
      <note default-x="60"><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><staff>2</staff></note>
    </measure>
    <measure number="2" width="420">
      <print new-system="yes"><system-layout><top-system-distance>360</top-system-distance></system-layout></print>
      <attributes><staves>2</staves></attributes>
      <note default-x="60"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><staff>1</staff></note>
      <note default-x="60"><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><staff>2</staff></note>
      <note default-x="60"><chord/><pitch><step>B</step><octave>3</octave></pitch><duration>4</duration><staff>2</staff></note>
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

SYSTEM_SPARSE_LEAD_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
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
      <attributes><divisions>4</divisions><staves>3</staves><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>6</octave></pitch><duration>4</duration><staff>1</staff></note>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><staff>2</staff></note>
      <note default-x="160"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><staff>2</staff></note>
      <note default-x="260"><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><staff>2</staff></note>
      <note default-x="60"><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><staff>3</staff></note>
      <note default-x="60"><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><staff>3</staff></note>
    </measure>
  </part>
</score-partwise>
"""

WHOLE_PDF_NEW_PAGE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <defaults>
    <page-layout>
      <page-height>1600</page-height>
      <page-width>1200</page-width>
    </page-layout>
  </defaults>
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <print new-system="yes"><system-layout><top-system-distance>120</top-system-distance></system-layout></print>
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="2" width="420">
      <note default-x="60"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="3" width="420">
      <print new-page="yes" new-system="yes"><system-layout><top-system-distance>130</top-system-distance></system-layout></print>
      <note default-x="60"><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="4" width="420">
      <note default-x="60"><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>
"""

NON_NUMERIC_MEASURE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1A" width="420">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="X2" width="420">
      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>88</per-minute></metronome></direction-type>
        <sound tempo="88"/>
      </direction>
      <note default-x="60"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="coda" width="420">
      <note default-x="60"><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>
"""

BACKUP_FORWARD_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60">
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>8</duration>
      </note>
      <backup><duration>8</duration></backup>
      <note default-x="60">
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration>
      </note>
      <forward><duration>4</duration></forward>
      <note default-x="220">
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration>
      </note>
    </measure>
  </part>
</score-partwise>
"""

GRACE_CUE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="40">
        <grace/>
        <pitch><step>C</step><octave>6</octave></pitch>
      </note>
      <note default-x="80">
        <pitch><step>D</step><octave>5</octave></pitch>
        <duration>4</duration>
      </note>
      <note default-x="150">
        <cue/>
        <pitch><step>A</step><octave>4</octave></pitch>
        <duration>4</duration>
      </note>
      <note default-x="240">
        <pitch><step>E</step><octave>5</octave></pitch>
        <duration>4</duration>
      </note>
    </measure>
  </part>
</score-partwise>
"""

CHINESE_PIANO_THEN_VOICE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>钢琴</part-name></score-part>
    <score-part id="P2"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <attributes><divisions>4</divisions><staves>2</staves></attributes>
      <note default-x="60"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff></note>
      <note default-x="60"><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff></note>
      <note default-x="60"><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><staff>2</staff></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1" width="420">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
      <note default-x="160"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
      <note default-x="260"><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration></note>
      <note default-x="360"><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>
"""

SAFE_VOICE_WITH_PIANO_MULTI_SYSTEM_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <defaults>
    <page-layout>
      <page-height>1600</page-height>
      <page-width>1200</page-width>
    </page-layout>
  </defaults>
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="420">
      <print new-system="yes"><system-layout><top-system-distance>120</top-system-distance></system-layout></print>
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="80"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
      <note default-x="220"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="2" width="420">
      <print new-system="yes"><system-layout><top-system-distance>360</top-system-distance></system-layout></print>
      <note default-x="80"><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration></note>
      <note default-x="220"><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1" width="420">
      <attributes><divisions>4</divisions><staves>2</staves></attributes>
      <note default-x="80"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff></note>
      <note default-x="80"><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><staff>1</staff></note>
      <note default-x="80"><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>4</duration><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>
"""

PAGEWISE_MEASURE_PAGE_1 = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="300">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="2" width="300">
      <note default-x="60"><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>
"""

PAGEWISE_MEASURE_PAGE_2 = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1" width="300">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note default-x="60"><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
    <measure number="2" width="300">
      <direction><direction-type><words>page-local marking</words></direction-type></direction>
      <note default-x="60"><pitch><step>G</step><octave>5</octave></pitch><duration>4</duration></note>
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
        two_staff_source = Path(tmp) / "two-staff-repeated-systems.musicxml"
        two_staff_source.write_text(TWO_STAFF_REPEATED_SYSTEMS_MUSICXML, encoding="utf-8")
        two_staff_request = ScoreImportRequest(
            jobId="two-staff-repeated-systems-test",
            pdfPath=str(two_staff_source),
            originalFilename="two-staff-repeated-systems.musicxml",
            titleHint="Two Staff Repeated Systems Test",
            selectedPartHint="Voice",
        )
        two_staff_section, *_ = analyzer._parse_musicxml_source_to_section(
            two_staff_source,
            two_staff_request,
            "Voice",
            "page-001-s01",
            "Two Staff Repeated Systems",
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
        system_sparse_source = Path(tmp) / "system-sparse-lead.musicxml"
        system_sparse_source.write_text(SYSTEM_SPARSE_LEAD_MUSICXML, encoding="utf-8")
        system_sparse_request = ScoreImportRequest(
            jobId="system-sparse-lead-test",
            pdfPath=str(system_sparse_source),
            originalFilename="system-sparse-lead.musicxml",
            titleHint="System Sparse Lead Test",
            selectedPartHint="Voice",
        )
        system_sparse_section, *_ = analyzer._parse_musicxml_source_to_section(
            system_sparse_source,
            system_sparse_request,
            "Voice",
            "page-001-s01",
            "System Sparse Lead",
            1,
        )
        whole_pdf_source = Path(tmp) / "whole-pdf-new-page.musicxml"
        whole_pdf_source.write_text(WHOLE_PDF_NEW_PAGE_MUSICXML, encoding="utf-8")
        whole_pdf_request = ScoreImportRequest(
            jobId="whole-pdf-new-page-test",
            pdfPath=str(whole_pdf_source),
            originalFilename="whole-pdf-new-page.musicxml",
            titleHint="Whole PDF New Page Test",
            selectedPartHint="Erhu",
        )
        whole_pdf_section, *_ = analyzer._parse_musicxml_source_to_section(
            whole_pdf_source,
            whole_pdf_request,
            "Erhu",
            "section-a",
            "Whole PDF New Page",
            1,
        )
        non_numeric_source = Path(tmp) / "non-numeric-measures.musicxml"
        non_numeric_source.write_text(NON_NUMERIC_MEASURE_MUSICXML, encoding="utf-8")
        non_numeric_request = ScoreImportRequest(
            jobId="non-numeric-measures-test",
            pdfPath=str(non_numeric_source),
            originalFilename="non-numeric-measures.musicxml",
            titleHint="Non Numeric Measures Test",
            selectedPartHint="Erhu",
        )
        non_numeric_section, _, _, _, non_numeric_marking_stats = analyzer._parse_musicxml_source_to_section(
            non_numeric_source,
            non_numeric_request,
            "Erhu",
            "section-a",
            "Non Numeric Measures",
            1,
        )
        backup_forward_source = Path(tmp) / "backup-forward.musicxml"
        backup_forward_source.write_text(BACKUP_FORWARD_MUSICXML, encoding="utf-8")
        backup_forward_request = ScoreImportRequest(
            jobId="backup-forward-test",
            pdfPath=str(backup_forward_source),
            originalFilename="backup-forward.musicxml",
            titleHint="Backup Forward Test",
            selectedPartHint="Erhu",
        )
        backup_forward_section, *_ = analyzer._parse_musicxml_source_to_section(
            backup_forward_source,
            backup_forward_request,
            "Erhu",
            "section-a",
            "Backup Forward",
            1,
        )
        grace_cue_source = Path(tmp) / "grace-cue.musicxml"
        grace_cue_source.write_text(GRACE_CUE_MUSICXML, encoding="utf-8")
        grace_cue_request = ScoreImportRequest(
            jobId="grace-cue-test",
            pdfPath=str(grace_cue_source),
            originalFilename="grace-cue.musicxml",
            titleHint="Grace Cue Test",
            selectedPartHint="Erhu",
        )
        grace_cue_section, *_ = analyzer._parse_musicxml_source_to_section(
            grace_cue_source,
            grace_cue_request,
            "Erhu",
            "section-a",
            "Grace Cue",
            1,
        )
        safe_voice_source = Path(tmp) / "safe-voice-with-piano-multi-system.musicxml"
        safe_voice_source.write_text(SAFE_VOICE_WITH_PIANO_MULTI_SYSTEM_MUSICXML, encoding="utf-8")
        safe_voice_request = ScoreImportRequest(
            jobId="safe-voice-with-piano-multi-system-test",
            pdfPath=str(safe_voice_source),
            originalFilename="safe-voice-with-piano-multi-system.musicxml",
            titleHint="Safe Voice With Piano Multi System",
            selectedPartHint="Voice",
        )
        safe_voice_section, *_ = analyzer._parse_musicxml_source_to_section(
            safe_voice_source,
            safe_voice_request,
            "Voice",
            "section-safe",
            "Safe Voice With Piano Multi System",
            1,
        )
        pagewise_source_1 = Path(tmp) / "pagewise-001.musicxml"
        pagewise_source_2 = Path(tmp) / "pagewise-002.musicxml"
        pagewise_source_1.write_text(PAGEWISE_MEASURE_PAGE_1, encoding="utf-8")
        pagewise_source_2.write_text(PAGEWISE_MEASURE_PAGE_2, encoding="utf-8")
        pagewise_request = ScoreImportRequest(
            jobId="pagewise-measure-test",
            pdfPath=str(pagewise_source_1),
            originalFilename="pagewise-measure-test.pdf",
            titleHint="Pagewise Measure Test",
            selectedPartHint="Erhu",
        )
        pagewise_piece_pack, _, _ = analyzer._build_piece_pack_from_musicxml_sources(
            [pagewise_source_1, pagewise_source_2],
            pagewise_request,
            "Erhu",
        )

    chinese_piano_candidates = analyzer._extract_musicxml_part_candidates(
        CHINESE_PIANO_THEN_VOICE_MUSICXML,
        "Voice",
    )
    chinese_voice = next((candidate for candidate in chinese_piano_candidates if candidate.get("id") == "P2"), None)
    backup_forward_candidates = analyzer._extract_musicxml_part_candidates(
        BACKUP_FORWARD_MUSICXML,
        "Erhu",
    )
    backup_forward_erhu = next((candidate for candidate in backup_forward_candidates if candidate.get("id") == "P1"), None)
    grace_cue_candidates = analyzer._extract_musicxml_part_candidates(
        GRACE_CUE_MUSICXML,
        "Erhu",
    )
    grace_cue_erhu = next((candidate for candidate in grace_cue_candidates if candidate.get("id") == "P1"), None)
    safe_voice_candidates = analyzer._extract_musicxml_part_candidates(
        SAFE_VOICE_WITH_PIANO_MULTI_SYSTEM_MUSICXML,
        "Voice",
    )
    safe_voice_candidate = next((candidate for candidate in safe_voice_candidates if candidate.get("id") == "P1"), None)

    require(section is not None, "MusicXML did not produce a section.")
    require(merged_section is not None, "Merged voice MusicXML did not produce a section.")
    require(system_section is not None, "System-merged voice MusicXML did not produce a section.")
    require(two_staff_section is not None, "Two-staff repeated systems MusicXML did not produce a section.")
    require(sparse_section is not None, "Sparse false lead MusicXML did not produce a section.")
    require(system_sparse_section is not None, "System sparse lead MusicXML did not produce a section.")
    require(whole_pdf_section is not None, "Whole-PDF new-page MusicXML did not produce a section.")
    require(non_numeric_section is not None, "Non-numeric measure MusicXML did not produce a section.")
    require(backup_forward_section is not None, "Backup/forward MusicXML did not produce a section.")
    require(grace_cue_section is not None, "Grace/cue MusicXML did not produce a section.")
    require(safe_voice_section is not None, "Safe voice with piano multi-system MusicXML did not produce a section.")
    require(pagewise_piece_pack is not None, "Pagewise MusicXML sources did not produce a piece pack.")
    require(chinese_voice is not None, "Chinese piano fixture should include the trailing Voice candidate.")
    require(backup_forward_erhu is not None, "Backup/forward fixture should expose the Erhu part candidate.")
    require(grace_cue_erhu is not None, "Grace/cue fixture should expose the Erhu part candidate.")
    require(safe_voice_candidate is not None, "Safe voice fixture should expose the leading Voice part candidate.")
    require(
        chinese_voice.get("isAfterExplicitPiano") is True,
        "Voice after a Chinese-named piano part should be flagged as after explicit piano.",
    )
    require(
        chinese_voice.get("isLikelyAccompanimentSplit") is True,
        "Voice after a Chinese-named piano part should be treated as an accompaniment split risk.",
    )
    require(
        chinese_voice.get("safeForErhuProjection") is False,
        "Voice after a Chinese-named piano part should not be auto-trusted for erhu projection.",
    )
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
    two_staff_notes = two_staff_section["notes"]
    two_staff_pairs = {
        (int(note["notePosition"]["systemIndex"]), int(note["notePosition"]["staffIndex"]))
        for note in two_staff_notes
        if note.get("notePosition")
    }
    require(two_staff_pairs == {(1, 1), (2, 1)}, f"Two-staff systems should keep the top staff in every system, got {two_staff_pairs}.")
    require([note["midiPitch"] for note in two_staff_notes] == [74, 76], "Two-staff systems should retain both erhu melody systems.")
    sparse_notes = sparse_section["notes"]
    sparse_systems = {int(note["notePosition"]["systemIndex"]) for note in sparse_notes if note.get("notePosition")}
    require(sparse_systems == {4}, f"Sparse false lead should be suppressed; kept systems {sparse_systems}.")
    require([note["midiPitch"] for note in sparse_notes] == [74, 76, 77], "Sparse false lead should keep only the real erhu melody system.")
    system_sparse_notes = system_sparse_section["notes"]
    system_sparse_staffs = {int(note["notePosition"]["staffIndex"]) for note in system_sparse_notes if note.get("notePosition")}
    require(system_sparse_staffs == {2}, f"System sparse lead should promote dense melody staff 2, got {system_sparse_staffs}.")
    require(
        [note["midiPitch"] for note in system_sparse_notes] == [74, 76, 77],
        "System sparse lead should suppress the one-note pseudo top staff and keep the real melody line.",
    )
    whole_pdf_notes = whole_pdf_section["notes"]
    whole_pdf_pages = [int(note["notePosition"]["pageNumber"]) for note in whole_pdf_notes if note.get("notePosition")]
    whole_pdf_systems = [int(note["notePosition"]["systemIndex"]) for note in whole_pdf_notes if note.get("notePosition")]
    require(whole_pdf_pages == [1, 1, 2, 2], f"Whole-PDF MusicXML should honor print new-page markers, got pages {whole_pdf_pages}.")
    require(whole_pdf_systems == [1, 1, 1, 1], f"Whole-PDF MusicXML should reset system index on a new page, got systems {whole_pdf_systems}.")
    non_numeric_notes = non_numeric_section["notes"]
    require(
        [note["measureIndex"] for note in non_numeric_notes] == [1, 2, 3],
        f"Non-numeric measure labels should parse numeric parts or fall back to sequence order, got {[note['measureIndex'] for note in non_numeric_notes]}.",
    )
    require(non_numeric_marking_stats.get("tempoChangeCount", 0) >= 1, "Non-numeric measure labels should not drop tempo markings.")
    backup_forward_notes = backup_forward_section["notes"]
    require(
        [note["midiPitch"] for note in backup_forward_notes] == [74, 76],
        f"Backup/forward MusicXML should collapse same-beat secondary voices and keep the melody, got {[note['midiPitch'] for note in backup_forward_notes]}.",
    )
    require(
        [round(float(note["beatStart"]), 3) for note in backup_forward_notes] == [0.0, 2.0],
        f"Backup/forward MusicXML should honor timeline rewinds and forwards, got {[note['beatStart'] for note in backup_forward_notes]}.",
    )
    require(
        backup_forward_erhu.get("chordRatio", 0) > 0,
        "Backup/forward MusicXML part scoring should count overlapping voices as chord evidence.",
    )
    grace_cue_notes = grace_cue_section["notes"]
    require(
        [note["midiPitch"] for note in grace_cue_notes] == [74, 76],
        f"Grace/cue MusicXML should exclude unscored ornament and cue notes, got {[note['midiPitch'] for note in grace_cue_notes]}.",
    )
    require(
        [round(float(note["beatStart"]), 3) for note in grace_cue_notes] == [0.0, 2.0],
        f"Grace/cue MusicXML should keep cue duration in the timeline while excluding cue notes, got {[note['beatStart'] for note in grace_cue_notes]}.",
    )
    require(
        grace_cue_erhu.get("noteCount") == 2,
        f"Grace/cue MusicXML part scoring should ignore unscored notes, got noteCount={grace_cue_erhu.get('noteCount')}.",
    )
    require(
        safe_voice_candidate.get("safeForErhuProjection") is True,
        "Leading monophonic Voice part should remain safe for erhu projection even with a separate piano part.",
    )
    require(
        safe_voice_candidate.get("isLikelyAccompanimentSplit") is False,
        "Leading monophonic Voice part should not be treated as an accompaniment split risk.",
    )
    safe_voice_notes = safe_voice_section["notes"]
    safe_voice_systems = {int(note["notePosition"]["systemIndex"]) for note in safe_voice_notes if note.get("notePosition")}
    require(
        len(safe_voice_systems) == 2,
        f"Safe leading Voice part should keep both melody systems on the page, got {safe_voice_systems}.",
    )
    require(
        [note["midiPitch"] for note in safe_voice_notes] == [74, 76, 77, 79],
        f"Safe leading Voice part should retain both monophonic melody systems, got {[note['midiPitch'] for note in safe_voice_notes]}.",
    )
    pagewise_notes = [
        note
        for section_item in pagewise_piece_pack["sections"]
        for note in section_item["notes"]
    ]
    require(
        [note["measureIndex"] for note in pagewise_notes] == [1, 2, 3, 4],
        f"Pagewise MusicXML should infer global measure numbers across local page resets, got {[note['measureIndex'] for note in pagewise_notes]}.",
    )
    require(
        [note["notePosition"]["localMeasureIndex"] for note in pagewise_notes] == [1, 2, 1, 2],
        "Pagewise MusicXML should preserve original page-local measure indices for diagnostics.",
    )
    pagewise_markings = [
        marking
        for section_item in pagewise_piece_pack["sections"]
        for marking in section_item.get("markings", [])
    ]
    require(
        pagewise_markings and pagewise_markings[0]["measureIndex"] == 4 and pagewise_markings[0]["localMeasureIndex"] == 2,
        f"Pagewise markings should be remapped to global measure numbers, got {pagewise_markings}.",
    )
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
