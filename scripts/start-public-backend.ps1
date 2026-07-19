param(
  # Comma-separated origins allowed to call the student API from the browser.
  # The apex Vercel domain; add www or preview domains here if you use them.
  [string]$Origin = "https://stringinstrumentdiagnosis.icu",
  [switch]$SkipBuild
)

# Starts the analysis backend in PUBLIC mode for the go-live tunnel:
#   - WESTERN_PUBLIC_MODE=true      -> tunnel traffic is limited to student endpoints
#   - ERHU_BIND_HOST=127.0.0.1      -> port is loopback-only; the tunnel is the only way in
#   - WESTERN_PUBLIC_ORIGIN=$Origin -> CORS allows the Vercel student site
# The operator's review console stays reachable locally at http://localhost:3000/?mode=strings
# because local (header-less) requests bypass the public guard. Keep this window open;
# Ctrl+C stops the server. Run cloudflared separately (see docs/go-live-guide.md).

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "setup-console-utf8.ps1")
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $SkipBuild) {
  Push-Location $repoRoot
  try {
    npm run build
  } finally {
    Pop-Location
  }
}

$env:NODE_ENV = "production"
$env:PORT = "3000"
$env:ERHU_BIND_HOST = "127.0.0.1"
$env:WESTERN_PUBLIC_MODE = "true"
$env:WESTERN_PUBLIC_ORIGIN = $Origin

Write-Host ""
Write-Host "Public student backend"
Write-Host "----------------------"
Write-Host "Bind:           127.0.0.1:3000 (loopback only; reachable publicly only via the tunnel)"
Write-Host "Public mode:    on (tunnel traffic limited to student endpoints)"
Write-Host "Allowed origin: $Origin"
Write-Host "Local console:  http://localhost:3000/?mode=strings"
Write-Host "Health:         http://localhost:3000/api/health"
Write-Host ""
Write-Host "Keep this window open. Press Ctrl+C to stop."
Write-Host ""

Push-Location $repoRoot
try {
  node server.js
} finally {
  Pop-Location
}
