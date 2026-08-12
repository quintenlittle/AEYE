@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AEYE - Ollama setup
color 0A

:: any argument (installer passes "auto") suppresses the closing pause so the
:: setup wizard isn't blocked waiting on a keypress
set "AUTO=%~1"

echo =====================================================
echo A E Y E  --  Ollama local model runtime
echo =====================================================
echo.
echo Installs Ollama (if missing) and pulls the default chat
echo model (dolphin-mistral, ~4 GB). Ollama serves the GGUF
echo models AEYE chats with; HuggingFace models don't need it.
echo.

:: ------------------------------------------------------------------
:: find / install Ollama
:: ------------------------------------------------------------------
set "OLLAMA_EXE="
where ollama >nul 2>&1 && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

if defined OLLAMA_EXE (
    echo [OK] Ollama detected.
    goto :model_pull
)

echo [i] Ollama not found - installing ...
winget --version >nul 2>&1
if not errorlevel 1 (
    echo [*] Installing Ollama via winget ...
    winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
)
if not exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    echo [*] Downloading the official Ollama installer ...
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '%TEMP%\OllamaSetup.exe'"
    if exist "%TEMP%\OllamaSetup.exe" (
        echo [*] Running the Ollama installer silently ...
        "%TEMP%\OllamaSetup.exe" /SILENT /NORESTART
        del /q "%TEMP%\OllamaSetup.exe" >nul 2>&1
    )
)
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
    echo [OK] Ollama installed.
) else (
    echo [X] Ollama install failed - get it from https://ollama.com/download
    echo     ^(AEYE still works with HuggingFace models via the AI extras.^)
    pause
    exit /b 1
)

:model_pull
echo.
echo [*] Making sure the Ollama server is up ...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:11434' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
    timeout /t 6 /nobreak >nul
)
echo [*] Pulling the default chat model (dolphin-mistral, ~4 GB) ...
"%OLLAMA_EXE%" pull dolphin-mistral
if errorlevel 1 (
    echo [i] Pull failed - you can pull any model later from the AEYE library.
) else (
    echo [OK] Default model ready.
)
echo.
echo [OK] Ollama setup complete. Start AEYE and pick a model.
if not defined AUTO pause
exit /b 0
