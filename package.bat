@echo off
setlocal
title AEYE packager
cd /d "%~dp0"

if exist skull.txt type skull.txt
echo.
echo Building a portable AEYE package (sources + installer, no venv,
echo no caches, no logs, no tokens) ...
echo.

if not exist dist mkdir dist
del /q "dist\aeye-portable.zip" >nul 2>&1

powershell -NoProfile -Command "Compress-Archive -Path 'server.py','desktop.py','paths.py','version.txt','install.bat','aeye.bat','start.bat','package.bat','build.py','build.bat','aeye.spec','BUILD.md','requirements.txt','requirements-hf.txt','requirements-img.txt','requirements-video.txt','requirements-tts.txt','requirements-stt.txt','requirements-rag.txt','requirements-web.txt','plugins','tools','installer','README.md','CLAUDE.md','skull.txt','AEYE.ico','static' -DestinationPath 'dist\aeye-portable.zip' -Force"
if errorlevel 1 (
    echo [X] Packaging failed.
    pause
    exit /b 1
)

echo [OK] dist\aeye-portable.zip is ready.
echo.
echo On the new machine: extract anywhere, then run install.bat.
echo (hf_token.txt is deliberately NOT packaged - copy it yourself
echo if you use gated models. Models re-download on the new machine.)
echo.
pause
