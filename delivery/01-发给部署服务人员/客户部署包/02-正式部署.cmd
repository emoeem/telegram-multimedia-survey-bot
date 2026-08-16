@echo off
setlocal
cd /d "%~dp0"
call scripts\deploy-customer.cmd %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" echo Deployment completed.
if not "%EXIT_CODE%"=="0" echo Deployment failed.
pause
exit /b %EXIT_CODE%
