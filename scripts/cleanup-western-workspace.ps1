param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$paperRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot "paper"))
$rootPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$paperPrefix = $paperRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

function Resolve-SafeTarget {
  param([string]$Target)

  $resolved = [IO.Path]::GetFullPath($Target)
  if (-not $resolved.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing target outside workspace: $resolved"
  }
  if ($resolved.Equals($paperRoot, [StringComparison]::OrdinalIgnoreCase) -or
      $resolved.StartsWith($paperPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing paper target: $resolved"
  }
  return $resolved
}

function Measure-Target {
  param([string]$Target)

  if (-not (Test-Path -LiteralPath $Target)) {
    return [pscustomobject]@{ files = 0; bytes = 0 }
  }
  $files = @(Get-ChildItem -LiteralPath $Target -Recurse -File -Force -ErrorAction SilentlyContinue)
  $bytes = [long](($files | Measure-Object -Property Length -Sum).Sum)
  return [pscustomobject]@{ files = $files.Count; bytes = $bytes }
}

$targets = @(
  (Join-Path $repoRoot "data\experiments\model-bakeoff\.venv"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\oemer-compat-venv"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\homr-compat-venv"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\clarity-compat-venv"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\clarity-omr-src"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\clarity-pretrained-download-cache"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\_dbg"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\homr-smoke"),
  (Join-Path $repoRoot "data\experiments\western-strings-m4\clarity-smoke"),
  (Join-Path $repoRoot "dist")
)

$clarityBenchmarkRoot = Join-Path $repoRoot "data\experiments\western-strings-m4\clarity-source-benchmark"
if (Test-Path -LiteralPath $clarityBenchmarkRoot) {
  $targets += Get-ChildItem -LiteralPath $clarityBenchmarkRoot -Directory -Force |
    ForEach-Object { Join-Path $_.FullName "work" }
}

foreach ($sourceRoot in @("scripts", "python-service", "research-analysis")) {
  $absoluteRoot = Join-Path $repoRoot $sourceRoot
  if (-not (Test-Path -LiteralPath $absoluteRoot)) {
    continue
  }
  $targets += Get-ChildItem -LiteralPath $absoluteRoot -Directory -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @("__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache") -and
      $_.FullName -notmatch "[\\/]\.venv(?:[\\/]|$)" -and
      $_.FullName -notmatch "[\\/]\.venv-local(?:[\\/]|$)"
    } |
    Select-Object -ExpandProperty FullName
}

$rows = @()
foreach ($target in @($targets | Sort-Object -Unique)) {
  $safeTarget = Resolve-SafeTarget -Target $target
  $measure = Measure-Target -Target $safeTarget
  $existed = Test-Path -LiteralPath $safeTarget
  $removed = $false
  if ($Apply -and $existed) {
    Remove-Item -LiteralPath $safeTarget -Recurse -Force
    $removed = -not (Test-Path -LiteralPath $safeTarget)
  }
  $relativePath = $safeTarget.Substring($rootPrefix.Length).Replace("\", "/")
  $rows += [pscustomobject]@{
    path = $relativePath
    files = $measure.files
    bytes = $measure.bytes
    existed = [bool]$existed
    removed = [bool]$removed
  }
}

$totalBytes = [long](($rows | Measure-Object -Property bytes -Sum).Sum)
[pscustomobject]@{
  ok = $true
  mode = if ($Apply) { "apply" } else { "preview" }
  paperPreserved = $true
  targetCount = $rows.Count
  totalBytes = $totalBytes
  totalMiB = [Math]::Round($totalBytes / 1MB, 2)
  targets = $rows
} | ConvertTo-Json -Depth 5
