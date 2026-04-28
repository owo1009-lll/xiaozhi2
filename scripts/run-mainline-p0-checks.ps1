param(
  [int]$CorpusPairs = 3
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )
  Write-Host "==> $Name"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "P0 check failed: $Name exited with code $LASTEXITCODE"
  }
}

$env:ERHU_PREFER_CUDA_PYTHON = "true"

Invoke-Step "server syntax" { node --check server.js }
Invoke-Step "DL analyzer dependencies" { powershell -ExecutionPolicy Bypass -File scripts\run-python.ps1 scripts\check-mainline-analyzer.py }
Invoke-Step "frontend build" { npm run build }
Invoke-Step "MusicXML fallback import" { npm run test:musicxml-import }
Invoke-Step "score markings" { npm run test:score-markings }
Invoke-Step "score issue projection" { npm run test:score-issues }
Invoke-Step "DTW alignment quality" { npm run test:dtw-quality }
Invoke-Step "real corpus pairing audit" { npm run test:real-corpus -- --max-pairs $CorpusPairs }

Write-Host "P0 mainline checks completed."
