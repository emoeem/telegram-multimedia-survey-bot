@echo off
setlocal
call "%~dp0..\..\scripts\issue-license.cmd"
exit /b %ERRORLEVEL%
