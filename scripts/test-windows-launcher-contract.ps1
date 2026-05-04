param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$startProd = Get-Content (Join-Path $repoRoot "scripts\start-prod.ps1") -Raw
$startPreview = Get-Content (Join-Path $repoRoot "scripts\start-local-preview.ps1") -Raw
$stopProd = Get-Content (Join-Path $repoRoot "scripts\stop-prod.ps1") -Raw

$failures = @()

function Require-Text {
  param(
    [string]$Text,
    [string]$Needle,
    [string]$Reason
  )
  if (-not $Text.Contains($Needle)) {
    $script:failures += $Reason
  }
}

foreach ($scriptText in @($startProd, $startPreview)) {
  Require-Text $scriptText 'ERHU_PREFER_CUDA_PYTHON' 'launcher must set ERHU_PREFER_CUDA_PYTHON'
  Require-Text $scriptText 'ERHU_TORCH_DEVICE' 'launcher must set ERHU_TORCH_DEVICE'
  Require-Text $scriptText 'CUDA_VISIBLE_DEVICES' 'launcher must set CUDA_VISIBLE_DEVICES'
  Require-Text $scriptText '?mode=health' 'launcher must print the ops health page URL'
  Require-Text $scriptText '/api/erhu/ops/health' 'launcher must print the ops health API URL'
  Require-Text $scriptText 'scoreStoreBackend' 'launcher pid payload must include scoreStoreBackend'
  Require-Text $scriptText 'logs = @{' 'launcher pid payload must include log paths'
  Require-Text $scriptText 'Python analyzer is not ready' 'launcher must print analyzer-not-ready guidance'
  Require-Text $scriptText 'Check port' 'launcher must print port troubleshooting guidance'
}

Require-Text $startProd "ERHU_PREFER_CUDA_PYTHON='false'" 'production analyzer must be CPU-only by default'
Require-Text $startProd "ERHU_TORCH_DEVICE='cpu'" 'production analyzer must force torch CPU'
Require-Text $startProd "CUDA_VISIBLE_DEVICES=''" 'production analyzer must hide CUDA devices'
Require-Text $stopProd 'Logs were:' 'stop script must preserve log-path hints'

if ($failures.Count -gt 0) {
  Write-Error (@{ ok = $false; failures = $failures } | ConvertTo-Json -Depth 3)
  exit 1
}

Write-Host (@{
  ok = $true
  checks = @(
    "cpu-only-launch",
    "ops-health-url",
    "pid-log-metadata",
    "port-guidance",
    "stop-log-hints"
  )
} | ConvertTo-Json -Depth 3)
