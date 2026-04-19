# Research Analysis Scripts

Use this folder to convert exported CSV data into tables and figures for paper drafts.

## Install

```powershell
cd python-service
.venv\Scripts\activate
pip install -r ..\research-analysis\requirements.txt
```

## Export data from the app

Download these four CSV files:

- `participants.csv`
- `questionnaires.csv`
- `expert-ratings.csv`
- `analyses.csv`

They correspond to:

- `/api/erhu/research/export?dataset=participants&format=csv`
- `/api/erhu/research/export?dataset=questionnaires&format=csv`
- `/api/erhu/research/export?dataset=expert-ratings&format=csv`
- `/api/erhu/research/export?dataset=analyses&format=csv`

## Generate tables and figures

```powershell
cd C:\Users\Administrator\Downloads\ai二胡
python-service\.venv\Scripts\python.exe research-analysis\analyze_exports.py ^
  --participants exports\participants.csv ^
  --questionnaires exports\questionnaires.csv ^
  --ratings exports\expert-ratings.csv ^
  --analyses exports\analyses.csv ^
  --output-dir research-analysis\output
```

## Output

- Group summary table
- Group t-test table
- Questionnaire summary table
- System vs expert correlation table
- Analysis usage table
- Boxplot for gains by group
- Questionnaire bar chart
- System vs expert scatter plot
- Usage vs gain scatter plot
