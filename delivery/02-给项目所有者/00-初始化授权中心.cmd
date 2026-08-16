@echo off
setlocal
call "%~dp0..\..\scripts\setup-license-admin.cmd"
exit /b %ERRORLEVEL%
