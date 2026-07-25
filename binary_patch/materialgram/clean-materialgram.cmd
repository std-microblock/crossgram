@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js or run this script from the project development environment.
  pause
  exit /b 1
)

node.exe "%~dp0clean-materialgram.cjs" --yes
set "cleanup_exit=%errorlevel%"
echo.
if not "%cleanup_exit%"=="0" echo Cleanup did not complete. No further action was taken.
pause
exit /b %cleanup_exit%
