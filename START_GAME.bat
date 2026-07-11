@echo off
setlocal
title LAST SIGNAL ONLINE SERVER
set "NODE_EXE="

where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"

if not defined NODE_EXE (
  set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if exist "%BUNDLED_NODE%" set "NODE_EXE=%BUNDLED_NODE%"
)

if not defined NODE_EXE (
  echo Node.js 18 or newer is required.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)

cd /d "%~dp0"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:3000'"
echo.
echo LAST SIGNAL server is running.
echo Keep this window open while playing.
echo Local address: http://localhost:3000
echo.
"%NODE_EXE%" server.js

