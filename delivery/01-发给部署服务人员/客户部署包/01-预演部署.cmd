@echo off
setlocal
cd /d "%~dp0"
call scripts\deploy-customer.cmd --dry-run %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" echo Dry-run completed.
if not "%EXIT_CODE%"=="0" echo Dry-run failed.
pause
exit /b %EXIT_CODE%
