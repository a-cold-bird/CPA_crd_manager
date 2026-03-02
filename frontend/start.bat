@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

set "PORT=8333"
set "NO_BUILD=0"
if /I "%~1"=="--no-build" set "NO_BUILD=1"

echo [INFO] Starting CPA Console Backend and Frontend Delivery on port %PORT%...
echo [INFO] Checking and killing processes listening on port %PORT%...

set "KILLED_PIDS=;"
for /f "tokens=5" %%P in ('netstat -aon ^| findstr /C:":%PORT%" ^| findstr /C:"LISTENING"') do (
  call :KILL_PID %%P
)
goto :AFTER_KILL

:KILL_PID
set "PID=%~1"
if "%PID%"=="" goto :eof
if "%PID%"=="0" goto :eof
echo %KILLED_PIDS% | findstr /C:";%PID%;" >nul
if not errorlevel 1 goto :eof
echo [INFO] Killing PID %PID% on port %PORT%
taskkill /F /PID %PID% >nul 2>nul
set "KILLED_PIDS=%KILLED_PIDS%%PID%;"
goto :eof

:AFTER_KILL

if "%NO_BUILD%"=="1" (
  echo [INFO] Skip build enabled: --no-build. Using existing dist.
  goto run_server
)

echo [INFO] Building frontend assets...
call npm run build
if errorlevel 1 (
  echo [WARN] Build failed. Trying fallback to existing dist...
  if not exist dist\index.html (
    echo [ERROR] dist\index.html not found. Cannot start in production mode.
    pause
    exit /b 1
  )
  echo [INFO] Found existing dist. Continue starting server.
)

:run_server
node server.js
pause
