@echo off
setlocal EnableExtensions

echo ===========================================
echo   Kill All Chrome Processes
echo ===========================================

tasklist 2>nul | find /I "chrome.exe" >nul
if errorlevel 1 (
  echo [INFO] No chrome.exe process found.
  exit /b 0
)

taskkill /F /T /IM chrome.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to kill chrome.exe. Please run as administrator.
  exit /b 1
)

echo [OK] All chrome.exe processes have been terminated.
exit /b 0
