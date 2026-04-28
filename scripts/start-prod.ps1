param(
  [switch]$SkipBuild,
  [switch]$OpenBrowser
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
$analyzerPort = 8000
$serverAnalyzerUrl = "http://127.0.0.1:$analyzerPort"
$analyzerUrl = "$serverAnalyzerUrl/docs"
$isWindowsHost = ($env:OS -eq "Windows_NT") -or ($PSVersionTable.Platform -eq "Win32NT") -or ($IsWindows -eq $true)
$analyzerWorkers = if ($isWindowsHost) { 1 } else { 2 }

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

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

function Test-AnalyzerRouteReady {
  param(
    [int]$Port
  )

  try {
    $openApi = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/openapi.json" -TimeoutSec 2
    $paths = @($openApi.paths.PSObject.Properties.Name)
    return $paths -contains "/score/import-musicxml"
  } catch {
    return $false
  }
}

Stop-ManagedListener -Port 3000 -CommandPatterns @("server.js")
Stop-ManagedListener -Port 8000 -CommandPatterns @("uvicorn", "python-service")
Stop-ManagedListener -Port 8100 -CommandPatterns @("uvicorn", "python-service")

$staleAnalyzerListeners = @(Get-NetTCPConnection -LocalPort $analyzerPort -State Listen -ErrorAction SilentlyContinue)
if ($staleAnalyzerListeners.Count -gt 0 -and -not (Test-AnalyzerRouteReady -Port $analyzerPort)) {
  $analyzerPort = 8100
  $serverAnalyzerUrl = "http://127.0.0.1:$analyzerPort"
  $analyzerUrl = "$serverAnalyzerUrl/docs"
  Stop-ManagedListener -Port $analyzerPort -CommandPatterns @("uvicorn", "python-service")
}

if (-not $SkipBuild) {
  Push-Location $repoRoot
  try {
    npm run build
  } finally {
    Pop-Location
  }
}

$serverListenerBeforeStart = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
if ($serverListenerBeforeStart.Count -eq 0) {
  $serverCommand = "& { `$env:NODE_ENV='production'; `$env:PORT='3000'; `$env:ERHU_ANALYZER_URL='$serverAnalyzerUrl'; node server.js }"
  $startedServer = Start-Process -FilePath "powershell" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $serverCommand `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $serverLog `
    -RedirectStandardError $serverErrLog `
    -WindowStyle Hidden `
    -PassThru
}

$analyzerProcess = $null
if (Test-Path $pythonRunner) {
  $analyzerListenerBeforeStart = @(Get-NetTCPConnection -LocalPort $analyzerPort -State Listen -ErrorAction SilentlyContinue)
  if ($analyzerListenerBeforeStart.Count -eq 0) {
    $analyzerCommand = "& { `$env:ERHU_ENABLE_TORCHCREPE='true'; `$env:ERHU_ENABLE_MADMOM='true'; `$env:ERHU_PREFER_CUDA_PYTHON='true'; `$env:ERHU_TORCH_DEVICE='cuda'; `$env:ERHU_PORT='$analyzerPort'; & '$pythonRunner' -m uvicorn app:app --app-dir python-service --host 127.0.0.1 --port $analyzerPort --workers $analyzerWorkers --log-level warning }"
    $startedAnalyzer = Start-Process -FilePath "powershell" `
      -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $analyzerCommand `
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
$analyzerListener = @(Get-NetTCPConnection -LocalPort $analyzerPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
$serverPid = if ($serverListener.Count -gt 0) { $serverListener[0].OwningProcess } elseif ($startedServer) { $startedServer.Id } else { $null }
$analyzerPid = if ($analyzerListener.Count -gt 0) { $analyzerListener[0].OwningProcess } elseif ($startedAnalyzer) { $startedAnalyzer.Id } else { $null }

@{
  repoRoot = $repoRoot
  serverPid = $serverPid
  analyzerPid = $analyzerPid
  analyzerPort = $analyzerPort
  analyzerUrl = $serverAnalyzerUrl
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

if ($OpenBrowser -and $siteReady) {
  Start-Process $serverUrl | Out-Null
}
