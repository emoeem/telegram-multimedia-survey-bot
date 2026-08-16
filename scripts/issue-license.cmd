@echo off
setlocal
cd /d "%~dp0.."
node "%~dp0issue-license.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Authorization was not issued.
pause
exit /b %EXIT_CODE%
