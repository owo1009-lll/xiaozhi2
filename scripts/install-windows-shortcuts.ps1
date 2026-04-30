param(
  [string]$ShortcutName = "",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$startTarget = Join-Path $repoRoot "start-prod.bat"
$stopTarget = Join-Path $repoRoot "stop-prod.bat"

function ConvertFrom-CodePointList {
  param([int[]]$CodePoints)
  $chars = @()
  foreach ($codePoint in $CodePoints) {
    $chars += [char]$codePoint
  }
  return -join $chars
}

if (-not $ShortcutName.Trim()) {
  $ShortcutName = ConvertFrom-CodePointList @(20108, 32993, 32, 65, 73, 32, 33258, 20027, 32451, 20064)
}
$stopLabel = ConvertFrom-CodePointList @(20851, 38381)
$startDescription = ConvertFrom-CodePointList @(21551, 21160, 20108, 32993, 32, 65, 73, 32, 33258, 20027, 32451, 20064)
$stopDescription = ConvertFrom-CodePointList @(20851, 38381, 20108, 32993, 32, 65, 73, 32, 33258, 20027, 32451, 20064)

if (-not (Test-Path $startTarget)) {
  throw "Start launcher not found: $startTarget"
}
if (-not (Test-Path $stopTarget)) {
  throw "Stop launcher not found: $stopTarget"
}

function New-AppShortcut {
  param(
    [object]$Shell,
    [string]$ShortcutPath,
    [string]$TargetPath,
    [string]$WorkingDirectory,
    [string]$Description
  )

  $shortcut = $Shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $TargetPath
  $shortcut.WorkingDirectory = $WorkingDirectory
  $shortcut.Description = $Description
  $shortcut.WindowStyle = 7
  $shortcut.Save()
}

$targetDirectories = @()
if ($OutputDir.Trim()) {
  $targetDirectories += (Join-Path $repoRoot $OutputDir)
} else {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $programs = [Environment]::GetFolderPath("Programs")
  if ($desktop) {
    $targetDirectories += $desktop
  }
  if ($programs) {
    $targetDirectories += (Join-Path $programs $ShortcutName)
  }
}

if (-not $targetDirectories.Count) {
  throw "No shortcut target directory is available."
}

$shell = New-Object -ComObject WScript.Shell
$created = @()

foreach ($directory in $targetDirectories) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null

  $startShortcut = Join-Path $directory "$ShortcutName.lnk"
  New-AppShortcut `
    -Shell $shell `
    -ShortcutPath $startShortcut `
    -TargetPath $startTarget `
    -WorkingDirectory $repoRoot `
    -Description $startDescription
  $created += $startShortcut

  $stopShortcut = Join-Path $directory "$ShortcutName - $stopLabel.lnk"
  New-AppShortcut `
    -Shell $shell `
    -ShortcutPath $stopShortcut `
    -TargetPath $stopTarget `
    -WorkingDirectory $repoRoot `
    -Description $stopDescription
  $created += $stopShortcut
}

Write-Host (
  @{
    ok = $true
    shortcutCount = $created.Count
    shortcuts = $created
  } | ConvertTo-Json -Depth 3
)
