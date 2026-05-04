from __future__ import annotations

import json
import sys
import tempfile
import warnings
from pathlib import Path

from pypdf import PdfWriter


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SERVICE = ROOT / "python-service"
sys.path.insert(0, str(PYTHON_SERVICE))
warnings.filterwarnings("ignore", message="pkg_resources is deprecated.*")

from analyzer import ErhuAnalyzer  # noqa: E402
from config import Settings  # noqa: E402
from schemas import ScoreImportRequest  # noqa: E402


SIMPLE_MUSICXML = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Erhu</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration></note>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration></note>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>8</duration></note>
    </measure>
  </part>
</score-partwise>
"""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ai-erhu-omr-whole-skip-") as temp_dir:
        root = Path(temp_dir)
        pdf_path = root / "large-single-page.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=300, height=420)
        with pdf_path.open("wb") as handle:
            writer.write(handle)

        settings = Settings(
            data_root=str(root / "data"),
            audiveris_cli=sys.executable,
            omr_whole_pdf_max_pages=6,
            omr_whole_pdf_max_file_mb=0.000001,
            omr_pagewise_workers=1,
        )
        analyzer = ErhuAnalyzer(settings)
        whole_runs = 0
        pagewise_runs = 0

        def fake_run_audiveris(_input_path: Path, _output_dir: Path) -> str:
            nonlocal whole_runs
            whole_runs += 1
            return ""

        def fake_run_audiveris_pagewise(_pdf_path: Path, output_dir: Path) -> tuple[list[str], dict[str, object]]:
            nonlocal pagewise_runs
            pagewise_runs += 1
            output_dir.mkdir(parents=True, exist_ok=True)
            musicxml_path = output_dir / "page-001.musicxml"
            musicxml_path.write_text(SIMPLE_MUSICXML, encoding="utf-8")
            return [str(musicxml_path)], {
                "mode": "pagewise",
                "pageCount": 1,
                "pageResultCacheHits": 0,
                "pageResultCacheMisses": 1,
                "pageResultCacheHitRate": 0.0,
                "renderCacheHits": 0,
                "renderCacheMisses": 1,
                "renderCacheHitRate": 0.0,
                "tileRenderCacheHits": 0,
                "tileRenderCacheMisses": 0,
                "tileRenderCacheHitRate": 0.0,
                "pageOmrRuns": 1,
                "tileOmrRuns": 0,
                "dedupedPageTasks": 0,
                "uniquePageOmrTasks": 1,
                "reusedPageResults": 0,
                "pageTaskReductionRate": 0.0,
                "resultCount": 1,
                "workers": 1,
            }

        analyzer._run_audiveris = fake_run_audiveris  # type: ignore[method-assign]
        analyzer._run_audiveris_pagewise = fake_run_audiveris_pagewise  # type: ignore[method-assign]

        result = analyzer.import_pdf_score(
            ScoreImportRequest(
                jobId="large-single-page-skip-test",
                pdfPath=str(pdf_path),
                originalFilename=pdf_path.name,
                titleHint="Large Single Page Skip Test",
                selectedPartHint="Erhu",
                outputDir=str(root / "score-import"),
            )
        )
        stats = result.omrStats or {}
        require(result.omrStatus == "completed", f"Expected completed import, got {result.omrStatus!r}.")
        require(whole_runs == 0, f"Whole-PDF OMR should be skipped for oversized PDF, got {whole_runs} runs.")
        require(pagewise_runs == 1, f"Expected one pagewise OMR call, got {pagewise_runs}.")
        require(stats.get("mode") == "pagewise", f"Expected pagewise stats, got {stats}.")
        require(stats.get("wholePdfAttempted") is False, f"Whole-PDF should not be attempted, got {stats}.")
        require(stats.get("wholePdfSkippedReason") == "file-size", f"Expected file-size skip reason, got {stats}.")
        require(int(stats.get("pdfFileSizeBytes") or 0) > 0, f"Expected PDF byte size diagnostics, got {stats}.")
        require(result.selectedPart == "Erhu", f"Expected selected part Erhu, got {result.selectedPart!r}.")

        print(json.dumps({
            "ok": True,
            "wholeRuns": whole_runs,
            "pagewiseRuns": pagewise_runs,
            "selectedPart": result.selectedPart,
            "omrStats": stats,
            "warnings": result.warnings,
        }, ensure_ascii=False, indent=2))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
