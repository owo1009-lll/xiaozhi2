param(
  [int]$CorpusPairs = 3
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "setup-console-utf8.ps1")
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

$env:ERHU_PREFER_CUDA_PYTHON = "false"
$env:ERHU_TORCH_DEVICE = "cpu"
$env:CUDA_VISIBLE_DEVICES = ""

Invoke-Step "server syntax" { node --check server.js }
Invoke-Step "server P0 guards" { npm run test:server-p0 }
Invoke-Step "JSON store concurrency" { npm run test:json-store }
Invoke-Step "score store archive cap" { npm run test:score-store-archive }
Invoke-Step "SQLite migration dry-run" { npm run test:sqlite-migration }
Invoke-Step "SQLite score store runtime" { npm run test:server-sqlite-store }
Invoke-Step "ops health and task controls" { npm run test:ops-health }
Invoke-Step "server boundary modules" { npm run test:server-boundaries }
Invoke-Step "task queue bounds" { npm run test:task-queue }
Invoke-Step "server task queue 429" { npm run test:server-task-queue-429 }
Invoke-Step "job state contract" { npm run test:job-state-contract }
Invoke-Step "quality baseline guard" { npm run test:quality-baseline }
Invoke-Step "teacher validation workflow" { npm run test:teacher-validation }
Invoke-Step "teacher validation readiness" { npm run audit:teacher-validation-readiness }
Invoke-Step "MusicXML fallback contract" { npm run test:musicxml-fallback-contract }
Invoke-Step "DL analyzer dependencies" { powershell -ExecutionPolicy Bypass -File scripts\run-python.ps1 scripts\check-mainline-analyzer.py }
Invoke-Step "analyzer CPU phase diagnostic" { npm run test:analyzer-cpu-phases }
Invoke-Step "analyzer audio helpers" { npm run test:analyzer-audio }
Invoke-Step "PWA delivery" { npm run test:pwa }
Invoke-Step "mojibake guard" { npm run test:mojibake }
Invoke-Step "Windows installer shortcuts" { npm run test:windows-installer }
Invoke-Step "Windows launcher contract" { npm run test:windows-launcher }
Invoke-Step "frontend build" { npm run build }
Invoke-Step "frontend split guard" { npm run test:frontend-split }
Invoke-Step "P2 split guard" { npm run test:p2-mainline }
Invoke-Step "student status helpers" { npm run test:student-status }
Invoke-Step "student UI copy guard" { npm run test:student-ui-copy }
Invoke-Step "MusicXML fallback import" { npm run test:musicxml-import }
Invoke-Step "separation quality diagnostics" { npm run test:separation-quality }
Invoke-Step "analyzer score role helpers" { npm run test:analyzer-score-roles }
Invoke-Step "score markings" { npm run test:score-markings }
Invoke-Step "OMR pagewise dedupe" { npm run test:omr-pagewise-dedupe }
Invoke-Step "OMR whole PDF skip" { npm run test:omr-whole-pdf-skip }
Invoke-Step "OMR provider diagnostics" { npm run test:omr-provider-diagnostics }
Invoke-Step "HOMR boundary" { npm run audit:homr-boundary }
Invoke-Step "OMR quality gate" { npm run test:omr-quality-gate }
Invoke-Step "score issue projection" { npm run test:score-issues }
Invoke-Step "DTW alignment quality" { npm run test:dtw-quality }
Invoke-Step "real corpus pairing audit" { npm run test:real-corpus -- --max-pairs $CorpusPairs }

Write-Host "P0 mainline checks completed."
