param(
  [string]$Participants = "exports\participants.csv",
  [string]$Questionnaires = "exports\questionnaires.csv",
  [string]$Ratings = "exports\expert-ratings.csv",
  [string]$Analyses = "exports\analyses.csv",
  [string]$Validations = "exports\validation-reviews.csv",
  [string]$Adjudications = "exports\adjudications.csv",
  [string]$PiecePassSummary = "exports\piece-pass-summary.json",
  [string]$PiecePassSections = "exports\piece-pass-sections.csv",
  [string]$OutputDir = "research-analysis\output"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonRunner = Join-Path $repoRoot "scripts\run-python.ps1"

$command = @(
  (Join-Path $repoRoot "research-analysis\analyze_exports.py"),
  "--participants", (Join-Path $repoRoot $Participants),
  "--questionnaires", (Join-Path $repoRoot $Questionnaires),
  "--ratings", (Join-Path $repoRoot $Ratings),
  "--analyses", (Join-Path $repoRoot $Analyses),
  "--validations", (Join-Path $repoRoot $Validations),
  "--adjudications", (Join-Path $repoRoot $Adjudications),
  "--output-dir", (Join-Path $repoRoot $OutputDir)
)

$piecePassSummaryPath = Join-Path $repoRoot $PiecePassSummary
if (Test-Path $piecePassSummaryPath) {
  $command += @("--piece-pass-summary", $piecePassSummaryPath)
}

$piecePassSectionsPath = Join-Path $repoRoot $PiecePassSections
if (Test-Path $piecePassSectionsPath) {
  $command += @("--piece-pass-sections", $piecePassSectionsPath)
}

& powershell -ExecutionPolicy Bypass -File $pythonRunner @command
