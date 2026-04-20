param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string]$ExportDir = "exports",
  [string]$OutputDir = "research-analysis\output"
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
& (Join-Path $scriptDir "export-research-data.ps1") -BaseUrl $BaseUrl -OutputDir $ExportDir
& (Join-Path $scriptDir "run-research-analysis.ps1") -Participants (Join-Path $ExportDir "participants.csv") `
  -Questionnaires (Join-Path $ExportDir "questionnaires.csv") `
  -Ratings (Join-Path $ExportDir "expert-ratings.csv") `
  -Analyses (Join-Path $ExportDir "analyses.csv") `
  -Validations (Join-Path $ExportDir "validation-reviews.csv") `
  -OutputDir $OutputDir
