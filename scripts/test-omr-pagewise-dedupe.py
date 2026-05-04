from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from pypdf import PdfWriter


REPO_ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = REPO_ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))

from analyzer import ErhuAnalyzer  # noqa: E402
from config import Settings  # noqa: E402


SIMPLE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
    </measure>
  </part>
</score-partwise>
"""


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ai-erhu-omr-dedupe-") as temp_dir:
        root = Path(temp_dir)
        pdf_path = root / "duplicate-pages.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=300, height=420)
        writer.add_blank_page(width=300, height=420)
        with pdf_path.open("wb") as handle:
            writer.write(handle)

        settings = Settings(data_root=str(root / "data"))
        analyzer = ErhuAnalyzer(settings)
        run_count = 0

        def fake_run_audiveris(_input_path: Path, output_dir: Path) -> str:
            nonlocal run_count
            run_count += 1
            output_dir.mkdir(parents=True, exist_ok=True)
            output_path = output_dir / "fake.musicxml"
            output_path.write_text(SIMPLE_MUSICXML, encoding="utf-8")
            return str(output_path)

        analyzer._run_audiveris = fake_run_audiveris  # type: ignore[method-assign]

        sources, stats = analyzer._run_audiveris_pagewise(pdf_path, root / "pagewise")
        ok = (
            len(sources) == 2
            and run_count == 1
            and int(stats.get("pageOmrRuns", 0)) == 1
            and int(stats.get("dedupedPageTasks", 0)) == 1
            and int(stats.get("uniquePageOmrTasks", 0)) == 1
            and int(stats.get("reusedPageResults", 0)) == 1
            and float(stats.get("pageTaskReductionRate", 0.0)) == 0.5
        )
        print(
            json.dumps(
                {
                    "ok": ok,
                    "sourceCount": len(sources),
                    "audiverisRuns": run_count,
                    "stats": stats,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
