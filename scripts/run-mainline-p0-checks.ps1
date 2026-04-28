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
}

Invoke-Step "server syntax" { node --check server.js }
Invoke-Step "frontend build" { npm run build }
Invoke-Step "score markings" { npm run test:score-markings }
Invoke-Step "score issue projection" { npm run test:score-issues }
Invoke-Step "DTW alignment quality" { npm run test:dtw-quality }
Invoke-Step "real corpus pairing audit" { npm run test:real-corpus -- --max-pairs $CorpusPairs }

Write-Host "P0 mainline checks completed."
