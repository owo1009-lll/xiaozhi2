$utf8NoBom = New-Object System.Text.UTF8Encoding $false

try {
  [Console]::InputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
} catch {
}

if ([string]::IsNullOrWhiteSpace($env:PYTHONIOENCODING)) {
  $env:PYTHONIOENCODING = "utf-8"
}

if ([string]::IsNullOrWhiteSpace($env:PYTHONUTF8)) {
  $env:PYTHONUTF8 = "1"
}
