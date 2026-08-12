@echo off
setlocal EnableExtensions
title AEYE build
cd /d "%~dp0"

echo =====================================================
echo A E Y E  --  build (PyInstaller + Inno Setup)
echo =====================================================
echo.

:: ------------------------------------------------------------------
:: locate a Python to build with. The frozen app + the AI-extras venv
:: must share this interpreter's major.minor (build.py records it in
:: pybuild.txt). Override by setting AEYE_BUILD_PY before running.
:: ------------------------------------------------------------------
set "BUILDPY=%AEYE_BUILD_PY%"
if not defined BUILDPY (
    py -3 --version >nul 2>&1 && set "BUILDPY=py -3"
)
if not defined BUILDPY (
    python --version >nul 2>&1 && set "BUILDPY=python"
)
if not defined BUILDPY (
    echo [X] No Python 3 found. Install Python 3 ^(3.11-3.13^) and re-run.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('%BUILDPY% --version') do echo [OK] Build interpreter: %%v

:: ------------------------------------------------------------------
:: dedicated build venv (keeps PyInstaller out of the app runtime)
:: ------------------------------------------------------------------
if not exist ".buildvenv\Scripts\python.exe" (
    echo [*] Creating build venv ^(.buildvenv^) ...
    %BUILDPY% -m venv .buildvenv
    if errorlevel 1 ( echo [X] venv creation failed. & pause & exit /b 1 )
)
set "BPY=%~dp0.buildvenv\Scripts\python.exe"

echo [*] Installing build + runtime dependencies ...
"%BPY%" -m pip install --upgrade pip wheel --quiet
"%BPY%" -m pip install --quiet pyinstaller
:: core runtime + Piper TTS (bundled into the exe) + huggingface_hub for the
:: default-voice pre-fetch
"%BPY%" -m pip install --quiet -r requirements.txt -r requirements-tts.txt
if errorlevel 1 ( echo [X] dependency install failed. & pause & exit /b 1 )

echo.
echo [*] Running build.py %* ...
"%BPY%" build.py %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" ( echo [OK] Build finished. ) else ( echo [X] Build failed ^(exit %RC%^). )
pause
exit /b %RC%
