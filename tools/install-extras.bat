@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AEYE - AI extras installer
cd /d "%~dp0"

:: this script lives in {app}\tools ; requirements-*.txt + pybuild.txt sit in {app}
for %%i in ("%~dp0..") do set "APPROOT=%%~fi"

:: clear any previous success marker so an aborted/failed run (e.g. Python not
:: found) can't look successful to the installer
del /q "%APPDATA%\AEYE\extras\.aeye_extras_ok" >nul 2>&1

:: the app records the Python major.minor it was frozen with -- the extras venv
:: MUST match it (ABI) or torch etc. won't import into the frozen app
set "PYVER=3.12"
if exist "%APPROOT%\pybuild.txt" set /p PYVER=<"%APPROOT%\pybuild.txt"

echo =====================================================
echo A E Y E  --  AI extras (optional, GPU-accelerated)
echo =====================================================
echo.
echo Builds a private Python %PYVER% environment under
echo   %%APPDATA%%\AEYE\extras
echo holding the heavy AI stack (PyTorch, transformers, diffusers,
echo Whisper, RAG). Re-run anytime to add features or repair.
echo.

:: ------------------------------------------------------------------
:: locate Python %PYVER% (extras MUST match the frozen app's ABI)
:: ------------------------------------------------------------------
set "PYX="
py -%PYVER% --version >nul 2>&1 && set "PYX=py -%PYVER%"
if not defined PYX (
    set "PYVERNODOT=%PYVER:.=%"
    for %%d in ("%LOCALAPPDATA%\Programs\Python\Python!PYVERNODOT!" "%ProgramFiles%\Python!PYVERNODOT!") do (
        if not defined PYX if exist "%%~d\python.exe" set "PYX="%%~d\python.exe""
    )
)

if not defined PYX (
    echo [X] Python %PYVER% was not found. The AI extras must use %PYVER% to
    echo     match the app. Install it, then re-run this.
    choice /c YN /m "    Install Python %PYVER% via winget now"
    if errorlevel 2 (
        echo Get it from https://www.python.org/downloads/
        pause
        exit /b 1
    )
    winget install -e --id Python.Python.%PYVER% --accept-source-agreements --accept-package-agreements
    py -%PYVER% --version >nul 2>&1 && set "PYX=py -%PYVER%"
    if not defined PYX (
        echo [X] Still can't see Python %PYVER% - open a NEW terminal and re-run this.
        pause
        exit /b 1
    )
)

echo [OK] Using Python %PYVER% for the extras venv.
echo.

:: pass through any flags (installer supplies e.g. --hf --rag --gpu auto);
:: with none, install_extras.py runs its interactive menu
%PYX% "%~dp0install_extras.py" --reqs "%APPROOT%" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
    echo [OK] Done. Start AEYE to use the new features.
) else (
    echo [X] Extras install reported errors (exit %RC%).
)
:: pause when launched interactively (no args), OR whenever it errored -- so a
:: failure during an automated install stays on screen instead of vanishing
if "%~1"=="" (
    pause
) else (
    if not "%RC%"=="0" pause
)
exit /b %RC%
