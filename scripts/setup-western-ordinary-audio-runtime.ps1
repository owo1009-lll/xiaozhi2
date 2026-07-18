[CmdletBinding()]
param(
  [string]$PythonLauncher = "py",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$configPath = Join-Path $repoRoot "config\western-ordinary-audio-runtime.json"
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$pythonPath = [IO.Path]::GetFullPath((Join-Path $repoRoot ($config.python.defaultRelativePath -replace "/", "\")))
$runtimeRoot = Split-Path (Split-Path $pythonPath -Parent) -Parent
$lockPath = [IO.Path]::GetFullPath((Join-Path $repoRoot ($config.requirementsLock.path -replace "/", "\")))
$repoPrefix = $repoRoot.TrimEnd("\") + "\"

foreach ($target in @($pythonPath, $runtimeRoot, $lockPath)) {
  if (-not $target.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "ordinary-audio-runtime-target-outside-repository: $target"
  }
}

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
  New-Item -ItemType Directory -Path (Split-Path $runtimeRoot -Parent) -Force | Out-Null
  & $PythonLauncher -3.11 -m venv $runtimeRoot
  if ($LASTEXITCODE -ne 0) {
    throw "ordinary-audio-runtime-venv-create-failed: exit=$LASTEXITCODE"
  }
}

if (-not $SkipInstall) {
  $env:PYTHONNOUSERSITE = "1"
  $env:PYTHONSAFEPATH = "1"
  $env:PYTHONUTF8 = "1"
  & $pythonPath -m pip install --disable-pip-version-check --no-input -r $lockPath
  if ($LASTEXITCODE -ne 0) {
    throw "ordinary-audio-runtime-dependency-install-failed: exit=$LASTEXITCODE"
  }
}

& node (Join-Path $repoRoot "scripts\run-western-ordinary-audio-python.mjs") --preflight-only
if ($LASTEXITCODE -ne 0) {
  throw "ordinary-audio-runtime-preflight-failed: exit=$LASTEXITCODE"
}
