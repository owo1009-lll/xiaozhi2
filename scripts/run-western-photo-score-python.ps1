$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "setup-console-utf8.ps1")

# Every argument supplied by the caller is a western_photo_score_pipeline.py
# argument. Runtime paths and the complete-engine-pool flag are controlled by
# the tracked deployment manifest and cannot be overridden by a caller.
$PipelineArgs = @($args)
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifestPath = Join-Path $repoRoot "config\western-photo-score-deployment.json"
$preflightScript = Join-Path $PSScriptRoot "preflight-western-photo-score-deployment.mjs"
$pipelineScript = Join-Path $PSScriptRoot "western_photo_score_pipeline.py"
$preflightReport = Join-Path $repoRoot "data\experiments\western-strings-m4\photo-score-deployment-preflight.json"

function Write-FailureJson {
  param(
    [string]$Reason,
    [string]$Detail = ""
  )

  [ordered]@{
    ok = $false
    reason = $Reason
    detail = $Detail
    deploymentPreflight = $preflightReport.Substring($repoRoot.Length).TrimStart("\").Replace("\", "/")
    autoDiagnosisIssued = $false
    studentFacing = $false
  } | ConvertTo-Json -Compress | Write-Output
}

function Resolve-ExactRuntimePath {
  param(
    [Parameter(Mandatory = $true)]$Spec,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $envName = [string]$Spec.pathEnv
  $envValue = if ($envName) { [Environment]::GetEnvironmentVariable($envName) } else { "" }
  $configured = if (-not [string]::IsNullOrWhiteSpace($envValue)) {
    $envValue.Trim()
  } else {
    [string]$Spec.defaultRelativePath
  }
  if ([string]::IsNullOrWhiteSpace($configured)) {
    throw "$Label runtime path is not configured."
  }
  $absolute = if ([IO.Path]::IsPathRooted($configured)) {
    [IO.Path]::GetFullPath($configured)
  } else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $configured))
  }
  if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) {
    $source = if (-not [string]::IsNullOrWhiteSpace($envValue)) { "environment variable $envName" } else { "manifest default" }
    throw "$Label executable from $source does not exist: $absolute"
  }
  return $absolute
}

$reserved = @("--audiveris", "--homr", "--require-complete-engine-pool")
foreach ($argument in $PipelineArgs) {
  $text = [string]$argument
  foreach ($name in $reserved) {
    if ($text -eq $name -or $text.StartsWith("$name=", [StringComparison]::OrdinalIgnoreCase)) {
      Write-FailureJson -Reason "photo-score-runtime-argument-reserved" -Detail "$name is controlled by the deployment manifest."
      exit 2
    }
  }
}

try {
  $nodeCommand = Get-Command node -ErrorAction Stop | Select-Object -First 1
} catch {
  Write-FailureJson -Reason "photo-score-runtime-resolution-failed" -Detail ([string]$_.Exception.Message)
  exit 2
}

# Windows PowerShell can promote native stderr to a terminating ErrorRecord
# when ErrorActionPreference is Stop. A normal fail-closed preflight writes its
# report to disk and exits 1, so suppress native output and preserve that exit
# code instead of misclassifying the governance block as runtime resolution.
$previousErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = "Continue"
  & $nodeCommand.Source $preflightScript --manifest $manifestPath --quiet *> $null
  $preflightExit = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
if ($preflightExit -ne 0) {
  Write-FailureJson -Reason "photo-score-deployment-preflight-failed" -Detail "See the deployment preflight artifact for governance and host blockers."
  exit $preflightExit
}

try {
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $manifestSha256 = ([BitConverter]::ToString($sha256.ComputeHash($manifestBytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  $manifest = $strictUtf8.GetString($manifestBytes) | ConvertFrom-Json
  $preflightResult = Get-Content -LiteralPath $preflightReport -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$preflightResult.manifestSha256 -ne $manifestSha256) {
    throw "Deployment manifest changed after preflight; rerun is required."
  }
  if ($preflightResult.deploymentReady -ne $true) {
    throw "Deployment preflight report is not ready."
  }
  $audioPython = Resolve-ExactRuntimePath -Spec $manifest.runtime.audioPython -Label "audio Python"
  $audiveris = Resolve-ExactRuntimePath -Spec $manifest.runtime.audiveris -Label "Audiveris"
  $homr = Resolve-ExactRuntimePath -Spec $manifest.runtime.homr -Label "HOMR"
  if (-not (Test-Path -LiteralPath $pipelineScript -PathType Leaf)) {
    throw "Photo-score pipeline is missing: $pipelineScript"
  }
} catch {
  Write-FailureJson -Reason "photo-score-runtime-resolution-failed" -Detail ([string]$_.Exception.Message)
  exit 2
}

& $audioPython $pipelineScript @PipelineArgs `
  --audiveris $audiveris `
  --homr $homr `
  --require-complete-engine-pool
$pipelineExit = $LASTEXITCODE
exit $pipelineExit
