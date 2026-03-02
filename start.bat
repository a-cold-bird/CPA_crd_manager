@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

set "ROOT=%~dp0"

if not exist "%ROOT%frontend\start.bat" (
  echo [ERROR] frontend\start.bat not found.
  exit /b 1
)

pushd "%ROOT%frontend" >nul
call "%ROOT%frontend\start.bat" %*
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul

exit /b %EXIT_CODE%

