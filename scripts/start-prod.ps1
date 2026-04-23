param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot "data"
$serverLog = Join-Path $dataDir "prod-server.log"
$serverErrLog = Join-Path $dataDir "prod-server-error.log"
$analyzerLog = Join-Path $dataDir "prod-analyzer.log"
$analyzerErrLog = Join-Path $dataDir "prod-analyzer-error.log"
$pidFile = Join-Path $dataDir "prod-pids.json"
$pythonRunner = Join-Path $repoRoot "scripts\run-python.ps1"
$serverUrl = "http://127.0.0.1:3000"
$analyzerUrl = "http://127.0.0.1:8000/docs"

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Find-ProcessByCommandLine {
  param(
    [string[]]$Patterns
  )

  Get-CimInstance Win32_Process | Where-Object {
    $commandLine = $_.CommandLine
    if (-not $commandLine) { return $false }
    foreach ($pattern in $Patterns) {
      if ($commandLine -notlike "*$pattern*") {
        return $false
      }
    }
    return $true
  } | Select-Object -First 1
}

function Stop-ManagedListener {
  param(
    [int]$Port,
    [string[]]$CommandPatterns
  )

  $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $process) {
      continue
    }

    $commandLine = $process.CommandLine
    $matches = $true
    foreach ($pattern in $CommandPatterns) {
      if (-not $commandLine -or $commandLine -notlike "*$pattern*") {
        $matches = $false
        break
      }
    }

    if ($matches) {
      try {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
      } catch {
        Write-Host "Failed to stop stale listener on port $Port ($($listener.OwningProcess)): $($_.Exception.Message)"
      }
    }
  }
}

function Wait-HttpReady {
  param(
    [string]$Url,
    [int]$Attempts = 30
  )

  for ($index = 0; $index -lt $Attempts; $index++) {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 800
    }
  }

  return $false
}

Stop-ManagedListener -Port 3000 -CommandPatterns @("node", "server.js")
Stop-ManagedListener -Port 8000 -CommandPatterns @("uvicorn", "app:app", "python-service")

if (-not $SkipBuild) {
  Push-Location $repoRoot
  try {
    npm run build
  } finally {
    Pop-Location
  }
}

$serverProcess = Find-ProcessByCommandLine -Patterns @($repoRoot, "node", "server.js")
if (-not $serverProcess) {
  $startedServer = Start-Process -FilePath "powershell" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$env:NODE_ENV='production'; $env:PORT='3000'; node server.js" `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $serverLog `
    -RedirectStandardError $serverErrLog `
    -WindowStyle Hidden `
    -PassThru
}

$analyzerProcess = $null
if (Test-Path $pythonRunner) {
  $analyzerProcess = Find-ProcessByCommandLine -Patterns @($repoRoot, "uvicorn", "python-service")
  if (-not $analyzerProcess) {
    $startedAnalyzer = Start-Process -FilePath "powershell" `
      -ArgumentList "-ExecutionPolicy", "Bypass", "-File", $pythonRunner, "-m", "uvicorn", "app:app", "--app-dir", "python-service", "--host", "127.0.0.1", "--port", "8000" `
      -WorkingDirectory $repoRoot `
      -RedirectStandardOutput $analyzerLog `
      -RedirectStandardError $analyzerErrLog `
      -WindowStyle Hidden `
      -PassThru
  }
}

$siteReady = Wait-HttpReady -Url "$serverUrl/api/health"
$analyzerReady = $false
if (Test-Path $pythonRunner) {
  $analyzerReady = Wait-HttpReady -Url $analyzerUrl
}

$serverListener = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
$analyzerListener = @(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
$serverPid = if ($serverListener.Count -gt 0) { $serverListener[0].OwningProcess } elseif ($startedServer) { $startedServer.Id } else { $null }
$analyzerPid = if ($analyzerListener.Count -gt 0) { $analyzerListener[0].OwningProcess } elseif ($startedAnalyzer) { $startedAnalyzer.Id } else { $null }

@{
  repoRoot = $repoRoot
  serverPid = $serverPid
  analyzerPid = $analyzerPid
  updatedAt = (Get-Date).ToString("o")
  mode = "production"
} | ConvertTo-Json | Set-Content -Path $pidFile -Encoding UTF8

Write-Host ""
Write-Host "Production project server"
Write-Host "-------------------------"
Write-Host "App URL:      $serverUrl"
Write-Host "Health URL:   $serverUrl/api/health"
Write-Host "Analyzer URL: $analyzerUrl"
Write-Host "Site ready:   $siteReady"
Write-Host "Analyzer:     $analyzerReady"
Write-Host ""
Write-Host "Logs:"
Write-Host "  $serverLog"
Write-Host "  $serverErrLog"
Write-Host "  $analyzerLog"
Write-Host "  $analyzerErrLog"
Write-Host "PID file:"
Write-Host "  $pidFile"
