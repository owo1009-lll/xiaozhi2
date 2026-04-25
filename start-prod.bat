@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-prod.ps1" -OpenBrowser
echo.
echo If the browser did not open, visit http://127.0.0.1:3000/
pause
