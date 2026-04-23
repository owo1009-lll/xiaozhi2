# Research Analysis Scripts

This folder converts exported research CSV files into paper-ready tables, figures, and summary files.
It now also generates Word-friendly Chinese paper draft text and a `.docx` draft.

## Install

Use the same virtual environment as `python-service`:

```powershell
cd C:\Users\Administrator\Downloads\ai二胡\python-service
.venv\Scripts\activate
pip install -r ..\research-analysis\requirements.txt
```

## Input files

Export these CSV files from the app:

- `participants.csv`
- `questionnaires.csv`
- `expert-ratings.csv`
- `analyses.csv`
- `validation-reviews.csv`
- `adjudications.csv`
- `piece-pass-summary.json` (optional)
- `piece-pass-sections.csv` (optional)

They correspond to:

- `/api/erhu/research/export?dataset=participants&format=csv`
- `/api/erhu/research/export?dataset=questionnaires&format=csv`
- `/api/erhu/research/export?dataset=expert-ratings&format=csv`
- `/api/erhu/research/export?dataset=analyses&format=csv`
- `/api/erhu/research/export?dataset=validation-reviews&format=csv`
- `/api/erhu/research/export?dataset=adjudications&format=csv`

## Run directly

```powershell
cd C:\Users\Administrator\Downloads\ai二胡
python-service\.venv\Scripts\python.exe research-analysis\analyze_exports.py ^
  --participants exports\participants.csv ^
  --questionnaires exports\questionnaires.csv ^
  --ratings exports\expert-ratings.csv ^
  --analyses exports\analyses.csv ^
  --validations exports\validation-reviews.csv ^
  --adjudications exports\adjudications.csv ^
  --piece-pass-summary exports\piece-pass-summary.json ^
  --piece-pass-sections exports\piece-pass-sections.csv ^
  --output-dir research-analysis\output
```

## Run through npm scripts

```powershell
npm run research:paper
```

Or export and analyze in one step:

```powershell
npm run research:export-and-paper
```

If you need an operational pilot packet from the newest whole-piece pass:

```powershell
npm run pilot:pack:taohuawu
```

## Output files

The default `research-analysis/output/` folder includes:

- `table_participant_overview.csv`
- `table_group_summary.csv`
- `table_group_ttests.csv`
- `table_questionnaire_summary.csv`
- `table_system_expert_correlations.csv`
- `table_analysis_usage.csv`
- `table_usage_correlations.csv`
- `table_prepost_long.csv`
- `table_prepost_summary.csv`
- `table_ancova_summary.csv`
- `table_expert_ratings_raw.csv`
- `table_validation_reviews_raw.csv`
- `table_validation_summary.csv`
- `table_validation_group_summary.csv`
- `table_validation_path_confusion.csv`
- `table_inter_rater_pairs.csv`
- `table_inter_rater_summary.csv`
- `table_inter_rater_by_group.csv`
- `table_inter_rater_by_stage.csv`
- `table_inter_rater_by_piece.csv`
- `table_inter_rater_adjudication_queue.csv`
- `table_adjudication_decisions.csv`
- `table_adjudication_summary.csv`
- `table_adjudication_by_group.csv`
- `table_adjudication_system_alignment.csv`
- `table_piece_pass_summary.csv`
- `table_piece_pass_sections.csv`
- `figure_gain_by_group.png`
- `figure_questionnaire_by_group.png`
- `figure_system_vs_expert.png`
- `figure_usage_vs_pitch_gain.png`
- `figure_prepost_trends.png`
- `figure_validation_by_group.png`
- `figure_validation_path_heatmap.png`
- `figure_inter_rater_metrics.png`
- `figure_adjudication_status.png`
- `figure_piece_pass_section_scores.png`
- `report.md`
- `summary.json`
- `paper_draft_zh.md`
- `paper_draft_zh.txt`
- `paper_draft_zh.docx`
- `results_section_zh.txt`
- `README.txt`

## Notes

- All CSV tables are written with `utf-8-sig` so they can be opened directly in Excel on Windows.
- The script expects numeric score columns in the exported CSV files; missing values are handled as `NaN`.
- `validation-reviews.csv` is optional at the script level; if it is missing, the validation tables and figures will fall back to empty placeholders.
- `adjudications.csv` is also optional; if it is missing, the adjudication tables and figure will fall back to empty placeholders.
- `piece-pass-summary.json` and `piece-pass-sections.csv` are optional; if they are missing, the whole-piece pass tables, figure, and report section will fall back to empty placeholders.
- When the same `analysisId` has reviews from at least two distinct `raterId` values, the script will also compute dual-rater agreement outputs including `Cohen's kappa`, `ICC`, and overlap F1 scores.
- The script now also produces stratified inter-rater outputs by `groupId`, `sessionStage`, and `scoreUnit`, plus an adjudication queue based on path mismatch, agreement-gap, and overlap-F1 thresholds.
- The script now supports empty exported datasets and will generate placeholder figures plus empty summary tables instead of failing.
- The current statistical outputs are designed for rapid paper drafting and should still be reviewed before submission.
- `paper_draft_zh.docx` is intended as a Word starter draft; you can refine wording, citations, and section order directly in Word.
