@echo off
setlocal
set "ROOT=%~dp0.."
set "VENV=%ROOT%\.pdf-tools-venv"

where py >nul 2>nul
if not errorlevel 1 (
  set "PYTHON=py -3"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3 was not found. Install Python 3 from python.org, then run this again.
    pause
    exit /b 1
  )
  set "PYTHON=python"
)

if not exist "%VENV%\Scripts\python.exe" (
  echo First use: creating PDF conversion environment...
  %PYTHON% -m venv "%VENV%"
  if errorlevel 1 goto :failed
)

"%VENV%\Scripts\python.exe" -c "import pymupdf" >nul 2>nul
if errorlevel 1 (
  echo First use: installing PDF recognition component...
  "%VENV%\Scripts\python.exe" -m pip install --disable-pip-version-check pymupdf
  if errorlevel 1 goto :failed
)

"%VENV%\Scripts\python.exe" "%ROOT%\scripts\forms_pdf_to_survey.py" %*
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" echo Done. Upload only survey.json to the Bot.
pause
exit /b %RESULT%

:failed
echo PDF conversion setup failed. Check your Internet connection and Python installation.
pause
exit /b 1
