@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "ROOT=%~dp0"
set "FRONTEND_DIR=%ROOT%frontend"

if not exist "%FRONTEND_DIR%\package.json" (
  echo [ERROR] frontend\package.json not found.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found in PATH.
  exit /b 1
)

call :kill_port 8333
call :kill_port 5173

echo [INFO] Starting CPA dev servers with hot reload...
echo [INFO] API  : http://127.0.0.1:8333
echo [INFO] Web  : http://127.0.0.1:5173

start "CPA Dev API" cmd /k "cd /d ""%FRONTEND_DIR%"" && npm run dev:api"
start "CPA Dev Web" cmd /k "cd /d ""%FRONTEND_DIR%"" && npm run dev:web"

exit /b 0

:kill_port
set "PORT=%~1"
set "FOUND_PID=0"
for /f %%P in ('powershell.exe -NoProfile -Command "$pids=@(); try { $pids = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction Stop ^| Select-Object -ExpandProperty OwningProcess -Unique } catch { $pids = netstat -ano ^| Select-String ':%PORT%\s+.*LISTENING\s+(\d+)$' ^| ForEach-Object { $_.Matches[0].Groups[1].Value } }; $pids ^| Sort-Object -Unique ^| ForEach-Object { $_ }"') do (
  set "FOUND_PID=1"
  echo [INFO] Port %PORT% is occupied by PID %%P. Killing...
  taskkill /PID %%P /F >nul 2>nul
  if errorlevel 1 (
    echo [WARN] Failed to kill PID %%P on port %PORT%.
  ) else (
    echo [INFO] Killed PID %%P on port %PORT%.
  )
)
if "%FOUND_PID%"=="0" (
  echo [INFO] Port %PORT% is free.
) else (
  timeout /t 1 /nobreak >nul
)
exit /b 0
