@echo off
setlocal

cd /d "%~dp0"

if not exist "node_modules" (
  echo [standalone] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [standalone] npm install failed.
    exit /b 1
  )
)

echo [standalone] Building UI...
call npm run build:ui
if errorlevel 1 (
  echo [standalone] UI build failed.
  exit /b 1
)

echo [standalone] Opening control page...
start "" "http://127.0.0.1:19321"

echo [standalone] Starting service...
call npm run dev

endlocal
