param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PythonArgs
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$candidates = @()
$venvPython = Join-Path $repoRoot "python-service\.venv\Scripts\python.exe"
$venvSitePackages = Join-Path $repoRoot "python-service\.venv\Lib\site-packages"
$extraSiteRunner = Join-Path $repoRoot "scripts\run-python-extra-site.py"

function Test-CudaPython {
  param(
    [string]$PythonExe
  )

  if (-not $PythonExe) {
    return $false
  }

  try {
    $result = & $PythonExe -c "import torch; print('1' if torch.cuda.is_available() else '0')" 2>$null
    return (($result | Select-Object -Last 1) -eq "1")
  } catch {
    return $false
  }
}

if ($env:ERHU_PYTHON_EXE) {
  $candidates += $env:ERHU_PYTHON_EXE
}

$preferCuda = ($env:ERHU_PREFER_CUDA_PYTHON -and $env:ERHU_PREFER_CUDA_PYTHON.Trim().ToLowerInvariant() -notin @("0", "false", "no", "off"))
$systemPython = (Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $env:ERHU_PYTHON_EXE -and $preferCuda -and $systemPython -and (Test-CudaPython -PythonExe $systemPython) -and (Test-Path $venvSitePackages) -and (Test-Path $extraSiteRunner)) {
  $env:ERHU_EXTRA_SITE_PACKAGES = $venvSitePackages
  & $systemPython $extraSiteRunner @PythonArgs
  exit $LASTEXITCODE
}

$candidates += @(
  $venvPython,
  (Join-Path $repoRoot "python-service\.venv-local\Scripts\python.exe"),
  "C:\Users\Administrator\ai-erhu-python311\Scripts\python.exe"
)

$pythonExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $pythonExe) {
  throw "No managed Python interpreter was found. Set ERHU_PYTHON_EXE or create python-service\\.venv."
}

& $pythonExe @PythonArgs
exit $LASTEXITCODE
