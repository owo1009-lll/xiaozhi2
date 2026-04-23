param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$PythonArgs
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$candidates = @()

if ($env:ERHU_PYTHON_EXE) {
  $candidates += $env:ERHU_PYTHON_EXE
}

$candidates += @(
  (Join-Path $repoRoot "python-service\.venv\Scripts\python.exe"),
  (Join-Path $repoRoot "python-service\.venv-local\Scripts\python.exe"),
  "C:\Users\Administrator\ai-erhu-python311\Scripts\python.exe"
)

$pythonExe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $pythonExe) {
  throw "No managed Python interpreter was found. Set ERHU_PYTHON_EXE or create python-service\\.venv."
}

& $pythonExe @PythonArgs
exit $LASTEXITCODE
