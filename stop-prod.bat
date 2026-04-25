@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-prod.ps1"
echo.
echo AI Erhu background services have been stopped.
pause
