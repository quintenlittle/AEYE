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

:: SD1.5 base AnimateDiff motion adapters mount on -- a community fine-tune
:: gives far more coherent clips than the vanilla base. Override by setting
:: AEYE_ANIMATEDIFF_BASE yourself before launching.
if not defined AEYE_ANIMATEDIFF_BASE set "AEYE_ANIMATEDIFF_BASE=emilianJR/epiCRealism"

:: CPU-offload strategy for the image/video pipelines:
::   none       = load straight to GPU (fastest, needs the VRAM)  [default here]
::   model      = whole-module offload (fast, low idle VRAM)
::   sequential = submodule offload (fits ~2GB VRAM, slowest)
:: Change this line to trade speed for VRAM headroom during testing.
if not defined AEYE_OFFLOAD set "AEYE_OFFLOAD=none"

:: make sure the desktop shell (pywebview) is installed -- small, one-time
".venv\Scripts\python.exe" -c "import webview" >nul 2>&1
if errorlevel 1 (
    echo [*] First run: installing the desktop shell ^(pywebview^) ...
    ".venv\Scripts\python.exe" -m pip install pywebview
    if errorlevel 1 (
        echo [X] pywebview install failed -- use start.bat ^(browser mode^) instead.
        pause
        exit /b 1
    )
)

:: launch windowless (pythonw) -- any errors land in aeye.log
start "" ".venv\Scripts\pythonw.exe" desktop.py
exit /b 0
