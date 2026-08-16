@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the current Node.js LTS first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with PATH enabled.
  pause
  exit /b 1
)

echo Node.js:
node --version
echo npm:
npm --version
echo.
echo Installing dependencies...
npm install
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" echo Dependencies installed.
if not "%EXIT_CODE%"=="0" echo Dependency installation failed.
pause
exit /b %EXIT_CODE%
