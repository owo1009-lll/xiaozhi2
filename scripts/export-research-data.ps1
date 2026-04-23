param(
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string]$OutputDir = "exports",
  [string]$PiecePassRoot = "data\\piece-pass"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $repoRoot $OutputDir
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$datasets = @(
  @{ Name = "participants"; File = "participants.csv" },
  @{ Name = "questionnaires"; File = "questionnaires.csv" },
  @{ Name = "expert-ratings"; File = "expert-ratings.csv" },
  @{ Name = "analyses"; File = "analyses.csv" },
  @{ Name = "validation-reviews"; File = "validation-reviews.csv" },
  @{ Name = "adjudications"; File = "adjudications.csv" }
)

foreach ($dataset in $datasets) {
  $uri = "$BaseUrl/api/erhu/research/export?dataset=$($dataset.Name)&format=csv"
  $outFile = Join-Path $targetDir $dataset.File
  Invoke-WebRequest -Uri $uri -OutFile $outFile
  Write-Host "Exported $($dataset.Name) -> $outFile"
}

$piecePassDir = Join-Path $repoRoot $PiecePassRoot
if (Test-Path $piecePassDir) {
  $latestJson = Get-ChildItem -Path $piecePassDir -Recurse -Filter "*-whole-piece-pass.json" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($latestJson) {
    $latestCsv = Join-Path $latestJson.DirectoryName ($latestJson.BaseName + ".csv")
    $summaryOut = Join-Path $targetDir "piece-pass-summary.json"
    Copy-Item -LiteralPath $latestJson.FullName -Destination $summaryOut -Force
    Write-Host "Exported piece-pass-summary -> $summaryOut"

    if (Test-Path $latestCsv) {
      $sectionsOut = Join-Path $targetDir "piece-pass-sections.csv"
      Copy-Item -LiteralPath $latestCsv -Destination $sectionsOut -Force
      Write-Host "Exported piece-pass-sections -> $sectionsOut"
    }
  }
}
