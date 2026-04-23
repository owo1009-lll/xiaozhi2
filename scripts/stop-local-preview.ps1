$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot "data"
$pidFile = Join-Path $dataDir "local-preview-pids.json"

function Stop-ProcessIfAlive {
  param(
    [int]$ProcessId
  )

  if (-not $ProcessId) {
    return $false
  }

  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    Write-Host "Stopped process $($process.Id)"
    return $true
  } catch {
    return $false
  }
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
        Write-Host "Stopped listener on port $Port ($($listener.OwningProcess))"
      } catch {
        Write-Host "Failed to stop listener on port $Port ($($listener.OwningProcess)): $($_.Exception.Message)"
      }
    }
  }
}

$stoppedAny = $false

if (Test-Path $pidFile) {
  try {
    $pidData = Get-Content -Path $pidFile -Raw | ConvertFrom-Json
    $stoppedAny = (Stop-ProcessIfAlive -ProcessId ([int]$pidData.serverPid)) -or $stoppedAny
    $stoppedAny = (Stop-ProcessIfAlive -ProcessId ([int]$pidData.analyzerPid)) -or $stoppedAny
  } catch {
    Write-Host "Failed to read PID file: $($_.Exception.Message)"
  }
}

Stop-ManagedListener -Port 3000 -CommandPatterns @("node", "server.js")
Stop-ManagedListener -Port 8000 -CommandPatterns @("uvicorn", "app:app", "python-service")

if (-not $stoppedAny) {
  Write-Host "No local preview processes are currently running."
}
