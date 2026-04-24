@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [standalone] Node.js was not found on PATH.
  echo [standalone] Install Node.js from https://nodejs.org and re-run this file.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [standalone] npm was not found on PATH.
  echo [standalone] Install Node.js from https://nodejs.org and re-run this file.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [standalone] Dependencies missing. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [standalone] npm install failed.
    echo.
    pause
    exit /b 1
  )
)

if not exist "frontend\dist\index.html" (
  echo [standalone] UI build missing. Running npm run build:ui...
  call npm run build:ui
  if errorlevel 1 (
    echo [standalone] UI build failed.
    echo.
    pause
    exit /b 1
  )
)

echo [standalone] Opening control page...
start "" "http://127.0.0.1:19321"

echo [standalone] Starting service...
call npm run dev
set "exit_code=%errorlevel%"

if not "%exit_code%"=="0" (
  echo.
  echo [standalone] Service stopped with exit code %exit_code%.
  pause
  exit /b %exit_code%
)

endlocal
