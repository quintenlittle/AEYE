@echo off
setlocal
title AEYE
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [X] No .venv found -- run install.bat first.
    pause
    exit /b 1
)

:: optional HuggingFace token for GATED models (Llama, Gemma, ...).
:: NOT needed for public models. Either set HF_TOKEN yourself, or just paste
:: your token into a file named hf_token.txt next to this script.
if not defined HF_TOKEN if exist "hf_token.txt" (
    for /f "usebackq delims=" %%t in ("hf_token.txt") do set "HF_TOKEN=%%t"
)
if defined HF_TOKEN (
    echo   [i] HuggingFace token loaded - gated models unlocked.
) else (
    echo   [i] No HuggingFace token - public models work; gated ones need one.
)

:: SD1.5 base AnimateDiff motion adapters mount on -- a community fine-tune
:: gives far more coherent clips than the vanilla base. Override by setting
:: AEYE_ANIMATEDIFF_BASE yourself before launching.
if not defined AEYE_ANIMATEDIFF_BASE set "AEYE_ANIMATEDIFF_BASE=emilianJR/epiCRealism"

:: CPU-offload strategy for the image/video pipelines:
::   none = load straight to GPU (fastest)  [default] | model = whole-module
::   offload | sequential = submodule offload (fits ~2GB VRAM, slowest)
if not defined AEYE_OFFLOAD set "AEYE_OFFLOAD=none"

:: open the browser once the server has had a moment to come up
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8130"

echo.
echo   AEYE is watching at http://127.0.0.1:8130   (Ctrl+C to stop)
echo.
".venv\Scripts\python.exe" server.py
pause
