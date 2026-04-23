$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot "data"
$pidFile = Join-Path $dataDir "prod-pids.json"

function Stop-Pid {
  param(
    [int]$Pid
  )

  if (-not $Pid) {
    return
  }

  try {
    Stop-Process -Id $Pid -Force -ErrorAction Stop
    Write-Host "Stopped process $Pid"
  } catch {
    Write-Host ("Unable to stop process {0}: {1}" -f $Pid, $_.Exception.Message)
  }
}

if (Test-Path $pidFile) {
  try {
    $payload = Get-Content $pidFile -Raw | ConvertFrom-Json
    Stop-Pid -Pid ([int]$payload.serverPid)
    Stop-Pid -Pid ([int]$payload.analyzerPid)
  } catch {
    Write-Host ("Unable to read {0}: {1}" -f $pidFile, $_.Exception.Message)
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$prodListeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3000, 8000 })
foreach ($listener in $prodListeners) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -and $process.CommandLine -like "*$repoRoot*") {
      Stop-Pid -Pid $listener.OwningProcess
    }
  } catch {
    Write-Host ("Unable to inspect listener on port {0}: {1}" -f $listener.LocalPort, $_.Exception.Message)
  }
}
