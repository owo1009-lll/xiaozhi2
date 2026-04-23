$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $repoRoot "data"
$pidFile = Join-Path $dataDir "prod-pids.json"

function Stop-Pid {
  param(
    [int]$TargetPid
  )

  if (-not $TargetPid) {
    return
  }

  try {
    Stop-Process -Id $TargetPid -Force -ErrorAction Stop
    Write-Host "Stopped process $TargetPid"
  } catch {
    Write-Host ("Unable to stop process {0}: {1}" -f $TargetPid, $_.Exception.Message)
  }
}

if (Test-Path $pidFile) {
  try {
    $payload = Get-Content $pidFile -Raw | ConvertFrom-Json
    Stop-Pid -TargetPid ([int]$payload.serverPid)
    Stop-Pid -TargetPid ([int]$payload.analyzerPid)
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
      Stop-Pid -TargetPid $listener.OwningProcess
    }
  } catch {
    Write-Host ("Unable to inspect listener on port {0}: {1}" -f $listener.LocalPort, $_.Exception.Message)
  }
}
