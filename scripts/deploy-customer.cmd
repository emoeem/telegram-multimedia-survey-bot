@echo off
setlocal
cd /d "%~dp0.."
node "%~dp0deploy-customer.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Deployment failed with exit code %EXIT_CODE%.
if "%~1"=="" pause
exit /b %EXIT_CODE%
