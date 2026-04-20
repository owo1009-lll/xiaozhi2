param(
  [string]$Participants = "exports\participants.csv",
  [string]$Questionnaires = "exports\questionnaires.csv",
  [string]$Ratings = "exports\expert-ratings.csv",
  [string]$Analyses = "exports\analyses.csv",
  [string]$Validations = "exports\validation-reviews.csv",
  [string]$OutputDir = "research-analysis\output"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $repoRoot "python-service\.venv\Scripts\python.exe"

& $pythonExe (Join-Path $repoRoot "research-analysis\analyze_exports.py") `
  --participants (Join-Path $repoRoot $Participants) `
  --questionnaires (Join-Path $repoRoot $Questionnaires) `
  --ratings (Join-Path $repoRoot $Ratings) `
  --analyses (Join-Path $repoRoot $Analyses) `
  --validations (Join-Path $repoRoot $Validations) `
  --output-dir (Join-Path $repoRoot $OutputDir)
