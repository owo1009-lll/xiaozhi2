param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string]$OutputDir = "exports"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $repoRoot $OutputDir
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$datasets = @(
  @{ Name = "participants"; File = "participants.csv" },
  @{ Name = "questionnaires"; File = "questionnaires.csv" },
  @{ Name = "expert-ratings"; File = "expert-ratings.csv" },
  @{ Name = "analyses"; File = "analyses.csv" }
)

foreach ($dataset in $datasets) {
  $uri = "$BaseUrl/api/erhu/research/export?dataset=$($dataset.Name)&format=csv"
  $outFile = Join-Path $targetDir $dataset.File
  Invoke-WebRequest -Uri $uri -OutFile $outFile
  Write-Host "Exported $($dataset.Name) -> $outFile"
}
