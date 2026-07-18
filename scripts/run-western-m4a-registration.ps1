$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "setup-console-utf8.ps1")

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$configPath = Join-Path $repoRoot "config\western-m4a-registration.json"
$preflightScript = Join-Path $PSScriptRoot "preflight-western-m4a-registration.mjs"
$implementation = Join-Path $PSScriptRoot "western_m4a_registration.py"

try {
  $node = (Get-Command node -ErrorAction Stop | Select-Object -First 1).Source
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $node $preflightScript --quiet *> $null
    $preflightExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($preflightExit -ne 0) {
    throw "M4a registration runtime preflight failed."
  }
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $envValue = [Environment]::GetEnvironmentVariable([string]$config.runtime.pythonPathEnv)
  $configured = if ([string]::IsNullOrWhiteSpace($envValue)) {
    [string]$config.runtime.defaultPythonRelativePath
  } else {
    $envValue.Trim()
  }
  $python = if ([IO.Path]::IsPathRooted($configured)) {
    [IO.Path]::GetFullPath($configured)
  } else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $configured))
  }
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "M4a Python executable is missing after preflight."
  }
  if (-not (Test-Path -LiteralPath $implementation -PathType Leaf)) {
    throw "M4a registration implementation is missing after preflight."
  }
} catch {
  [ordered]@{
    contract = "western-m4a-supported-edition-registration-v1"
    ready = $false
    reason = "supported-edition-registration-runtime-preflight-failed"
    blockingReasons = @("supported-edition-registration-runtime-preflight-failed")
    detail = [string]$_.Exception.Message
    omrUsed = $false
    machineFeedbackPrepared = $false
    reviewRequired = $true
    studentFacing = $false
    automaticAdoptionAuthorized = $false
    autoDiagnosisIssued = $false
  } | ConvertTo-Json -Compress | Write-Output
  exit 2
}

& $python $implementation @args
exit $LASTEXITCODE
