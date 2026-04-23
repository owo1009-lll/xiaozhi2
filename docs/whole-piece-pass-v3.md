# Whole-Piece Pass v3

This note records the current `桃花坞` whole-piece scaffold after extending the late PDF material and wiring the pass summary into the research export pipeline.

## Current scaffold status

- Piece id: `taohuawu-test-fragment`
- Structured sections: `41`
- Structured notes: `328`
- Coverage mode: `major-sections`
- Export bundle:
  - `data/score-exports/taohuawu-test-fragment/taohuawu-test-fragment.notes.json`
  - `data/score-exports/taohuawu-test-fragment/taohuawu-test-fragment.musicxml`
  - `data/score-exports/taohuawu-test-fragment/taohuawu-test-fragment.mid`
  - `data/score-exports/taohuawu-test-fragment/taohuawu-test-fragment.structure.json`

The pack is now a reusable whole-piece scaffold rather than a single fragment test. It still is not a literal bar-for-bar transcription of all `23` PDF pages, but it covers the main ordered sections deeply enough for whole-piece scanning and repeated validation.

## 2026-04-21 whole-piece pass result

Output directory:

- [taohuawu-whole-v3](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v3:1)

Core metrics:

- Matched sections: `41 / 41`
- Weighted pitch score: `48.04`
- Weighted rhythm score: `54.47`
- Weighted combined score: `55.06`
- Dominant practice path: `rhythm-first`

Primary weak sections from the current pass:

- `stacked-fanfare-hits`
- `coda-release`
- `rustic-turn`
- `open-string-sprint`
- `answer-phrase`

Primary outputs:

- [taohuawu-test-fragment-whole-piece-pass.md](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v3\taohuawu-test-fragment-whole-piece-pass.md:1)
- [taohuawu-test-fragment-whole-piece-pass.csv](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v3\taohuawu-test-fragment-whole-piece-pass.csv:1)
- [taohuawu-test-fragment-whole-piece-pass.json](C:\Users\Administrator\Downloads\ai二胡\data\piece-pass\taohuawu-whole-v3\taohuawu-test-fragment-whole-piece-pass.json:1)

## Export-chain integration

The whole-piece pass is no longer only a standalone diagnostics artifact.

`scripts/export-research-data.ps1` now copies the newest whole-piece pass files into:

- `exports/piece-pass-summary.json`
- `exports/piece-pass-sections.csv`

`research-analysis/analyze_exports.py` now reads those inputs and emits:

- `research-analysis/output/table_piece_pass_summary.csv`
- `research-analysis/output/table_piece_pass_sections.csv`
- `research-analysis/output/figure_piece_pass_section_scores.png`

The same whole-piece summary is also appended into:

- `research-analysis/output/report.md`
- `research-analysis/output/summary.json`

## Recommended next step

- Continue manual transcription for the remaining unstructured PDF regions if a closer-to-complete full score is needed.
- Use teacher review to calibrate the weakest sections before using the whole-piece pass as a formal paper-facing result.
