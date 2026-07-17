param(
  [string]$Wheelhouse = "",
  [string]$ModelBundle = "",
  [string]$BootstrapPython = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "setup-console-utf8.ps1")

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifestPath = Join-Path $repoRoot "config\western-photo-score-deployment.json"
$preflightScript = Join-Path $PSScriptRoot "preflight-western-photo-score-deployment.mjs"
$preflightReportPath = Join-Path $repoRoot "data\experiments\western-strings-m4\photo-score-deployment-preflight.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$audioSpec = $manifest.runtime.audioPython
$homrSpec = $manifest.runtime.homr

function Resolve-RepoPath {
  param([string]$Configured)

  if ([string]::IsNullOrWhiteSpace($Configured)) {
    throw "A required path is not configured."
  }
  if ([IO.Path]::IsPathRooted($Configured)) {
    return [IO.Path]::GetFullPath($Configured)
  }
  return [IO.Path]::GetFullPath((Join-Path $repoRoot $Configured))
}

$runtimeRoot = Resolve-RepoPath -Configured ([string]$homrSpec.runtimeRootDefaultRelativePath)
$audioPythonPath = Resolve-RepoPath -Configured ([string]$audioSpec.defaultRelativePath)
$audioRuntimeRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $audioPythonPath) ".."))
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "data\tools"))
$toolsPrefix = $toolsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$experimentsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "data\experiments"))
$experimentsPrefix = $experimentsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $runtimeRoot.StartsWith($toolsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing HOMR runtime outside data/tools: $runtimeRoot"
}
if ($runtimeRoot.StartsWith($experimentsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing HOMR runtime under data/experiments: $runtimeRoot"
}
if (-not $audioRuntimeRoot.StartsWith($toolsPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $audioRuntimeRoot.StartsWith($experimentsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing audio runtime outside stable data/tools: $audioRuntimeRoot"
}

$lockFile = Resolve-RepoPath -Configured ([string]$homrSpec.lockFile)
$resolvedWheelhouse = if (-not [string]::IsNullOrWhiteSpace($Wheelhouse)) {
  Resolve-RepoPath -Configured $Wheelhouse
} else {
  Resolve-RepoPath -Configured ([string]$homrSpec.offlineWheelhouseDefaultRelativePath)
}
$resolvedModelBundle = if (-not [string]::IsNullOrWhiteSpace($ModelBundle)) {
  Resolve-RepoPath -Configured $ModelBundle
} else {
  Resolve-RepoPath -Configured ([string]$homrSpec.offlineModelBundleDefaultRelativePath)
}
if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) {
  throw "HOMR lock file is missing: $lockFile"
}
if (-not (Test-Path -LiteralPath $resolvedWheelhouse -PathType Container)) {
  throw "Offline wheelhouse is missing: $resolvedWheelhouse"
}

if (Test-Path -LiteralPath $runtimeRoot) {
  if (-not $Force) {
    throw "HOMR runtime already exists. Re-run with -Force only after confirming the stable target: $runtimeRoot"
  }
  # runtimeRoot has already been resolved and proven to be under data/tools.
  Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeRoot) | Out-Null

$bootstrapArgs = @()
if (-not [string]::IsNullOrWhiteSpace($BootstrapPython)) {
  $bootstrapExe = [IO.Path]::GetFullPath($BootstrapPython)
  if (-not (Test-Path -LiteralPath $bootstrapExe -PathType Leaf)) {
    throw "Bootstrap Python does not exist: $bootstrapExe"
  }
} elseif (-not [string]::IsNullOrWhiteSpace($env:WESTERN_PHOTO_SCORE_BOOTSTRAP_PYTHON_EXE)) {
  $bootstrapExe = [IO.Path]::GetFullPath($env:WESTERN_PHOTO_SCORE_BOOTSTRAP_PYTHON_EXE)
  if (-not (Test-Path -LiteralPath $bootstrapExe -PathType Leaf)) {
    throw "WESTERN_PHOTO_SCORE_BOOTSTRAP_PYTHON_EXE does not exist: $bootstrapExe"
  }
} else {
  $bootstrapExe = (Get-Command py -ErrorAction Stop | Select-Object -First 1).Source
  $bootstrapArgs = @("-3.11")
}

# Basic Pitch/TensorFlow must remain on NumPy 1.x while HOMR requires NumPy
# 2.4.x. Give the audio side its own exact executable. The lightweight venv
# inherits the already validated host packages; every launch revalidates their
# exact versions in deployment preflight, so host drift fails closed.
if ($Force -and (Test-Path -LiteralPath $audioRuntimeRoot)) {
  Remove-Item -LiteralPath $audioRuntimeRoot -Recurse -Force
}
if (-not (Test-Path -LiteralPath $audioPythonPath -PathType Leaf)) {
  if (Test-Path -LiteralPath $audioRuntimeRoot) {
    throw "Audio runtime exists but its Python executable is missing: $audioRuntimeRoot"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $audioRuntimeRoot) | Out-Null
  & $bootstrapExe @bootstrapArgs -m venv --system-site-packages $audioRuntimeRoot
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $audioPythonPath -PathType Leaf)) {
    throw "Failed to create the isolated photo-score audio environment."
  }
}

& $bootstrapExe @bootstrapArgs -m venv $runtimeRoot
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create the isolated HOMR Python environment."
}
$homrPython = Join-Path $runtimeRoot "Scripts\python.exe"
$homrExecutable = Join-Path $runtimeRoot "Scripts\homr.exe"
if (-not (Test-Path -LiteralPath $homrPython -PathType Leaf)) {
  throw "Created environment has no Python executable: $homrPython"
}

$previousNoIndex = $env:PIP_NO_INDEX
$previousDisableVersionCheck = $env:PIP_DISABLE_PIP_VERSION_CHECK
try {
  $env:PIP_NO_INDEX = "1"
  $env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
  & $homrPython -m pip install --no-index --only-binary=:all: --find-links $resolvedWheelhouse --requirement $lockFile
  if ($LASTEXITCODE -ne 0) {
    throw "Offline HOMR dependency installation failed. No network fallback was attempted."
  }
} finally {
  if ($null -eq $previousNoIndex) { Remove-Item Env:PIP_NO_INDEX -ErrorAction SilentlyContinue } else { $env:PIP_NO_INDEX = $previousNoIndex }
  if ($null -eq $previousDisableVersionCheck) { Remove-Item Env:PIP_DISABLE_PIP_VERSION_CHECK -ErrorAction SilentlyContinue } else { $env:PIP_DISABLE_PIP_VERSION_CHECK = $previousDisableVersionCheck }
}

$moduleRootJson = & $homrPython -c "import importlib.util,json; names=['homr','rapidocr']; print(json.dumps({name:list(importlib.util.find_spec(name).submodule_search_locations)[0] for name in names}))"
if ($LASTEXITCODE -ne 0) {
  throw "Unable to resolve installed HOMR/RapidOCR package roots."
}
$moduleRoots = ($moduleRootJson | Select-Object -Last 1) | ConvertFrom-Json
$copiedModels = 0
foreach ($model in @($homrSpec.models)) {
  $packageRoot = [string]$moduleRoots.($model.package)
  if ([string]::IsNullOrWhiteSpace($packageRoot)) {
    throw "Installed package root is missing for model package: $($model.package)"
  }
  $relativeNative = ([string]$model.relativePath).Replace("/", [IO.Path]::DirectorySeparatorChar)
  $destination = [IO.Path]::GetFullPath((Join-Path $packageRoot $relativeNative))
  $destinationReady = $false
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    $destinationReady = ((Get-Item -LiteralPath $destination).Length -eq [long]$model.bytes) -and ($destinationHash -eq [string]$model.sha256)
  }
  if ($destinationReady) {
    continue
  }
  $source = [IO.Path]::GetFullPath((Join-Path $resolvedModelBundle (Join-Path ([string]$model.package) $relativeNative)))
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Offline model bundle is missing required artifact: $source"
  }
  $sourceInfo = Get-Item -LiteralPath $source
  $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sourceInfo.Length -ne [long]$model.bytes -or $sourceHash -ne [string]$model.sha256) {
    throw "Offline model artifact does not match the deployment manifest: $source"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
  $copiedModels += 1
}

& $homrPython -m pip check
if ($LASTEXITCODE -ne 0) {
  throw "Installed HOMR runtime failed pip check."
}
if (-not (Test-Path -LiteralPath $homrExecutable -PathType Leaf)) {
  throw "Installed HOMR runtime has no CLI executable: $homrExecutable"
}

# Run the same live preflight used by production. A pending license may keep
# deploymentReady=false, but both runtimes managed by this setup script must
# pass their host checks before setup is considered successful.
$env:ERHU_HOMR_CLI = $homrExecutable
$nodeExe = (Get-Command node -ErrorAction Stop | Select-Object -First 1).Source
& $nodeExe $preflightScript --manifest $manifestPath | Out-Null
$fullPreflightExit = $LASTEXITCODE
if (-not (Test-Path -LiteralPath $preflightReportPath -PathType Leaf)) {
  throw "Deployment preflight did not write its report: $preflightReportPath"
}
$preflight = Get-Content -LiteralPath $preflightReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($preflight.host.components.audioPython.ready -ne $true) {
  $reasons = @($preflight.host.components.audioPython.blockingReasons) -join ","
  throw "Installed photo-score audio runtime failed deployment host checks: $reasons"
}
if ($preflight.host.components.homr.ready -ne $true) {
  $reasons = @($preflight.host.components.homr.blockingReasons) -join ","
  throw "Installed HOMR runtime failed deployment host checks: $reasons"
}

[ordered]@{
  ok = $true
  audioRuntimeReady = [bool]$preflight.host.components.audioPython.ready
  audioRuntimeRoot = $audioRuntimeRoot
  audioPython = $audioPythonPath
  homrRuntimeReady = $true
  runtimeRoot = $runtimeRoot
  homrExecutable = $homrExecutable
  lockFile = $lockFile
  offlineWheelhouse = $resolvedWheelhouse
  copiedModelCount = $copiedModels
  governanceReady = $preflight.governanceReady
  hostReady = $preflight.hostReady
  deploymentReady = $preflight.deploymentReady
  fullPreflightExit = $fullPreflightExit
  note = if ($preflight.deploymentReady) { "full deployment preflight passed" } else { "Audio and HOMR runtimes are ready; full deployment remains fail-closed on reported governance/host blockers" }
} | ConvertTo-Json -Depth 4
