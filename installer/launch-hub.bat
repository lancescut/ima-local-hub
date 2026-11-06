@echo off
rem ImaLocalHub launcher: prefer bundled Node runtime, clean stale instances first
cd /d "%~dp0"
set NODE=%~dp0runtime\node.exe
if not exist "%NODE%" set NODE=node

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ImaLocalHub*hub.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

mkdir "%ProgramData%\ImaLocalHub\logs" 2>nul
"%NODE%" hub.js >> "%ProgramData%\ImaLocalHub\logs\hub.out.log" 2>&1
