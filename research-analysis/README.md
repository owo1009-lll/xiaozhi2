# Research Analysis Scripts

This folder converts exported research CSV files into paper-ready tables, figures, and summary files.

## Install

Use the same virtual environment as `python-service`:

```powershell
cd C:\Users\Administrator\Downloads\ai二胡\python-service
.venv\Scripts\activate
pip install -r ..\research-analysis\requirements.txt
```

## Input files

Export these four CSV files from the app:

- `participants.csv`
- `questionnaires.csv`
- `expert-ratings.csv`
- `analyses.csv`

They correspond to:

- `/api/erhu/research/export?dataset=participants&format=csv`
- `/api/erhu/research/export?dataset=questionnaires&format=csv`
- `/api/erhu/research/export?dataset=expert-ratings&format=csv`
- `/api/erhu/research/export?dataset=analyses&format=csv`

## Run directly

```powershell
cd C:\Users\Administrator\Downloads\ai二胡
python-service\.venv\Scripts\python.exe research-analysis\analyze_exports.py ^
  --participants exports\participants.csv ^
  --questionnaires exports\questionnaires.csv ^
  --ratings exports\expert-ratings.csv ^
  --analyses exports\analyses.csv ^
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

## Output files

The default `research-analysis/output/` folder includes:

- `table_participant_overview.csv`
- `table_group_summary.csv`
- `table_group_ttests.csv`
- `table_questionnaire_summary.csv`
- `table_system_expert_correlations.csv`
- `table_analysis_usage.csv`
- `table_usage_correlations.csv`
- `table_expert_ratings_raw.csv`
- `figure_gain_by_group.png`
- `figure_questionnaire_by_group.png`
- `figure_system_vs_expert.png`
- `figure_usage_vs_pitch_gain.png`
- `report.md`
- `summary.json`
- `README.txt`

## Notes

- All CSV tables are written with `utf-8-sig` so they can be opened directly in Excel on Windows.
- The script expects numeric score columns in the exported CSV files; missing values are handled as `NaN`.
- The current statistical outputs are designed for rapid paper drafting and should still be reviewed before submission.
