param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $repoRoot

$isWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isWindows) {
  Write-Host (@{ ok = $true; skipped = $true; reason = "Windows shortcuts require Windows COM." } | ConvertTo-Json)
  exit 0
}

$smokeRoot = Join-Path $repoRoot "data\install-smoke"
$runDir = Join-Path $smokeRoot ("shortcut-" + [guid]::NewGuid().ToString("N"))
$resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
$resolvedRunDir = [System.IO.Path]::GetFullPath($runDir)

if (-not $resolvedRunDir.StartsWith($resolvedSmokeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use installer smoke directory outside data\install-smoke: $resolvedRunDir"
}

try {
  $output = & powershell -ExecutionPolicy Bypass -File scripts\install-windows-shortcuts.ps1 -OutputDir $runDir
  if ($LASTEXITCODE -ne 0) {
    throw "installer exited with code $LASTEXITCODE"
  }

  $result = ($output -join "`n") | ConvertFrom-Json
  if (-not $result.ok -or [int]$result.shortcutCount -ne 2) {
    throw "installer returned an unexpected result: $($output -join ' ')"
  }

  $links = @(Get-ChildItem -LiteralPath $runDir -Filter "*.lnk")
  if ($links.Count -ne 2) {
    throw "expected 2 shortcut files, got $($links.Count)"
  }

  $shell = New-Object -ComObject WScript.Shell
  $expectedTargets = @(
    (Join-Path $repoRoot "start-prod.bat"),
    (Join-Path $repoRoot "stop-prod.bat")
  ) | ForEach-Object { [System.IO.Path]::GetFullPath($_) }

  foreach ($link in $links) {
    $shortcut = $shell.CreateShortcut($link.FullName)
    $target = [System.IO.Path]::GetFullPath($shortcut.TargetPath)
    if ($expectedTargets -notcontains $target) {
      throw "shortcut $($link.Name) points to unexpected target: $target"
    }
    $workingDirectory = [System.IO.Path]::GetFullPath($shortcut.WorkingDirectory)
    if ($workingDirectory -ne [System.IO.Path]::GetFullPath($repoRoot)) {
      throw "shortcut $($link.Name) has unexpected working directory: $workingDirectory"
    }
  }

  Write-Host (
    @{
      ok = $true
      shortcutCount = $links.Count
      outputDir = $runDir
      targets = $expectedTargets
    } | ConvertTo-Json -Depth 3
  )
} finally {
  if (Test-Path -LiteralPath $runDir) {
    $finalRunDir = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $runDir).Path)
    if ($finalRunDir.StartsWith($resolvedSmokeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $finalRunDir -Recurse -Force
    }
  }
}
