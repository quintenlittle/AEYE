@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AEYE installer
cd /d "%~dp0"

if exist skull.txt type skull.txt
echo.
echo =====================================================
echo A E Y E  --  the all-seeing LLM container
echo =====================================================
echo.
echo This installer will:
echo 1. find Python 3 ^(offer to install it if missing^)
echo 2. create a private virtual environment ^(.venv^)
echo 3. install the core app ^(server + desktop window^)
echo 4. optionally install Piper neural TTS ^(local voices^)
echo 5. optionally install Whisper speech-to-text ^(local mic dictation^)
echo 6. install Ollama if missing ^(winget, or the official installer^)
echo 7. pull the default chat model ^(dolphin-mistral, ~4 GB^)
echo 8. put an AEYE shortcut on your Desktop
echo 9. optionally install HuggingFace support ^(torch, several GB^) LAST
echo.
pause

:: ------------------------------------------------------------------
:: 1. locate Python
:: ------------------------------------------------------------------
call :find_python
if defined PYCMD goto :py_ok

echo [X] Python 3 was not found on this system.
choice /c YN /m "    Install Python 3.12 via winget now"
if errorlevel 2 (
    echo.
    echo Install Python from https://www.python.org/downloads/
    echo ^(tick "Add python.exe to PATH"^) then re-run install.bat.
    pause
    exit /b 1
)
winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements

:: winget updates PATH in the registry, but THIS shell still has the old copy
:: (env is inherited at launch). Re-read it so the install continues without
:: making the user open a new terminal -- most people just stop here.
echo [*] Refreshing this window's PATH ...
:: APPEND the registry copy, never replace it: the stored value can hold
:: unexpanded %SystemRoot% and overwriting PATH with that loses System32.
set "NEWPATH="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')" 2^>nul`) do set "NEWPATH=%%p"
if defined NEWPATH call set "PATH=%PATH%;%%NEWPATH%%"
call :find_python
if defined PYCMD goto :py_ok

:: PATH refresh did not take (per-user installs sometimes land late). Restart
:: ourselves ONE time through explorer.exe, which hands the new process a
:: freshly-read environment. The .aeye_relaunch sentinel stops this looping.
if not exist "%~dp0.aeye_relaunch" (
    echo.
    echo [*] Python is installed. Restarting the installer so it can see it -
    echo     a new window will open in a moment. You can close this one.
    echo.
    echo relaunched> "%~dp0.aeye_relaunch"
    start "" explorer.exe "%~f0"
    timeout /t 4 /nobreak >nul
    exit /b 0
)
del /q "%~dp0.aeye_relaunch" >nul 2>&1
echo [X] Python still not visible. Open a NEW terminal and run install.bat
echo again ^(PATH changes need a fresh shell^).
pause
exit /b 1

:py_ok
del /q "%~dp0.aeye_relaunch" >nul 2>&1
for /f "delims=" %%v in ('%PYCMD% --version') do echo [OK] Found %%v

:: ------------------------------------------------------------------
:: 2. virtual environment
:: ------------------------------------------------------------------
if not exist ".venv\Scripts\python.exe" (
    echo [*] Creating virtual environment in .venv ...
    %PYCMD% -m venv .venv
    if errorlevel 1 (
        echo [X] Failed to create the virtual environment.
        pause
        exit /b 1
    )
) else (
    echo [OK] Virtual environment already exists.
)
set "VPY=%~dp0.venv\Scripts\python.exe"

:: ------------------------------------------------------------------
:: 3. core app (server + desktop window)
:: ------------------------------------------------------------------
echo [*] Installing the core app ...
"%VPY%" -m pip install --upgrade pip wheel --quiet
"%VPY%" -m pip install -r requirements.txt
if errorlevel 1 (
    echo [X] Core install failed. Check your internet connection.
    pause
    exit /b 1
)
echo [OK] Core app installed ^(server + desktop window^).

:: ------------------------------------------------------------------
:: 4. optional Piper neural TTS
:: ------------------------------------------------------------------
echo.
echo Piper adds high-quality LOCAL neural voices for text-to-speech.
echo Fully offline. Voice files download on demand from the drawer.
choice /c YN /m "  Install Piper neural TTS"
if errorlevel 2 goto :stt_check
"%VPY%" -m pip install -r requirements-tts.txt
if errorlevel 1 (
    echo [i] Piper install failed - chat still works, it just won't speak.
) else (
    echo [OK] Piper installed.
    echo [*] Downloading the default voice ^(en_US-danny-low, ~63 MB^) ...
    "%VPY%" -c "import server; server._piper_files('en_US-danny-low', True)" >nul 2>&1
    if errorlevel 1 (
        echo [i] Default voice download failed - pick/download one in Manage ^> TTS.
    ) else (
        echo [OK] Default voice ready ^(danny-low, dalek effect, rate 0.85^).
    )
)

:: ------------------------------------------------------------------
:: 4b. optional Whisper speech-to-text (local dictation)
:: ------------------------------------------------------------------
:stt_check
echo.
echo Whisper adds LOCAL speech-to-text so you can dictate with your mic
echo ^(the mic button by the chat box^). Fully offline - the model downloads
echo once, then no audio ever leaves the machine.
choice /c YN /m "  Install Whisper speech-to-text"
if errorlevel 2 goto :rag_check
"%VPY%" -m pip install -r requirements-stt.txt
if errorlevel 1 (
    echo [i] Whisper install failed - chat still works, the mic just stays off.
) else (
    echo [OK] Whisper installed - click the mic by the chat box to dictate.
)

:: ------------------------------------------------------------------
:: 4c. optional document memory (local RAG - chat with your files)
:: ------------------------------------------------------------------
:rag_check
echo.
echo Document memory lets you add PDF / TXT / DOCX files in the MEMORY
echo drawer and chat about them. Fully offline - the small embedding
echo model ^(~90 MB^) downloads once, then your documents never leave
echo this machine.
choice /c YN /m "  Install document memory (RAG)"
if errorlevel 2 goto :ollama_check
"%VPY%" -m pip install -r requirements-rag.txt
if errorlevel 1 (
    echo [i] RAG install failed - chat still works, document upload stays off.
) else (
    echo [OK] Document memory installed - add files in the MEMORY drawer.
)

:: ------------------------------------------------------------------
:: 5. Ollama (winget, with a direct-download fallback)
:: ------------------------------------------------------------------
:ollama_check
echo.
set "OLLAMA_EXE="
where ollama >nul 2>&1 && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
if defined OLLAMA_EXE (
    echo [OK] Ollama detected.
    goto :model_pull
)

echo [i] Ollama was not found. It serves the GGUF chat models ^(incl. the
echo AEYE default model^); HuggingFace models work without it.
choice /c YN /m "  Install Ollama now"
if errorlevel 2 (
    echo You can install it later from https://ollama.com/download
    goto :shortcut
)

winget --version >nul 2>&1
if not errorlevel 1 (
    echo [*] Installing Ollama via winget ...
    winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
)
if not exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    echo [*] winget unavailable or failed - downloading the official installer ...
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '%TEMP%\OllamaSetup.exe'"
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
    echo [X] Ollama install failed - install it later from https://ollama.com/download
    echo ^(AEYE still works with HuggingFace models.^)
    goto :shortcut
)

:: ------------------------------------------------------------------
:: 6. default chat model
:: ------------------------------------------------------------------
:model_pull
echo.
echo [*] Pulling the default chat model ^(dolphin-mistral, ~4 GB^) ...
:: make sure the Ollama server is up before pulling (fresh installs don't
:: auto-start it when installed silently)
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:11434' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
    timeout /t 6 /nobreak >nul
)
"%OLLAMA_EXE%" pull dolphin-mistral
if errorlevel 1 (
    echo [i] Pull failed - you can pull it anytime from the AEYE library.
) else (
    echo [OK] Default model ready.
)

:: ------------------------------------------------------------------
:: 7. Desktop shortcut
:: ------------------------------------------------------------------
:shortcut
echo [*] Creating Desktop shortcut ...
:: Description stays a single word: it is the icon's hover tooltip, and a long
:: one lingers as a big dark popup OVER the app while it boots (the mouse is
:: still parked on the icon after the double-click).
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\AEYE.lnk'); $s.TargetPath = '%~dp0aeye.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0static\aeye.ico'; $s.WindowStyle = 7; $s.Description = 'AEYE'; $s.Save()" >nul 2>&1
if errorlevel 1 (
    echo [i] Could not create the shortcut - launch with aeye.bat instead.
) else (
    echo [OK] Desktop shortcut created ^(AEYE^).
)

:: ------------------------------------------------------------------
:: 8. optional HuggingFace support -- LAST, so a failure here can't
::    take the rest of the install down with it
:: ------------------------------------------------------------------
echo.
echo HuggingFace support lets AEYE load transformers models directly
echo ^(in addition to Ollama^) and adds image generation. It installs
echo PyTorch, which is several GB.
choice /c YN /m "  Install HuggingFace support"
if errorlevel 2 goto :done

where nvidia-smi >nul 2>&1
if errorlevel 1 (
    echo [*] No NVIDIA GPU detected - installing CPU build of PyTorch ...
    "%VPY%" -m pip install torch
) else (
    echo [*] NVIDIA GPU detected - installing CUDA build of PyTorch ...
    "%VPY%" -m pip install torch --index-url https://download.pytorch.org/whl/cu124
)
if errorlevel 1 (
    echo [X] PyTorch install failed - HuggingFace support skipped.
    echo Re-run install.bat later to retry just this step.
    goto :done
)
"%VPY%" -m pip install -r requirements-hf.txt
if errorlevel 1 (
    echo [X] transformers install failed - HuggingFace support incomplete.
    echo Re-run install.bat later to retry just this step.
    goto :done
)
"%VPY%" -m pip install bitsandbytes >nul 2>&1
if errorlevel 1 (
    echo [i] bitsandbytes unavailable - 4-bit loading will be disabled.
) else (
    echo [OK] bitsandbytes installed - 4-bit quantized loading enabled.
)
echo [*] Installing image-generation support ^(diffusers^) ...
"%VPY%" -m pip install -r requirements-img.txt
if errorlevel 1 (
    echo [i] diffusers install failed - image generation will be disabled.
) else (
    echo [OK] Image generation enabled ^(Stable Diffusion / SDXL / FLUX^).
)
echo [*] Installing video-generation support ^(dream: mp4 encoder^) ...
"%VPY%" -m pip install -r requirements-video.txt
if errorlevel 1 (
    echo [i] video encoder install failed - dream will save GIFs instead of mp4.
) else (
    echo [OK] Video generation enabled ^(AnimateDiff / ModelScope / Wan / LTX^).
)
echo [OK] HuggingFace support installed.

:: ------------------------------------------------------------------
:: done
:: ------------------------------------------------------------------
:done
echo.
echo =====================================================
echo Install complete. Open the eye with the AEYE
echo Desktop shortcut or aeye.bat
echo ^(start.bat runs it in your browser instead^).
echo =====================================================
echo.
choice /c YN /m "  Launch AEYE now"
if errorlevel 2 exit /b 0
call aeye.bat
exit /b 0

:: ------------------------------------------------------------------
:: :find_python -- sets PYCMD, or leaves it empty. Checks PATH first,
:: then the standard install locations: a just-installed Python is often
:: on disk before this shell's PATH knows about it.
:: ------------------------------------------------------------------
:find_python
set "PYCMD="
py -3 --version >nul 2>&1 && set "PYCMD=py -3"
if defined PYCMD goto :eof
python --version >nul 2>&1 && set "PYCMD=python"
if defined PYCMD goto :eof
if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" set "PYCMD="%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" -3"
if defined PYCMD goto :eof
for /f "delims=" %%d in ('dir /b /o-n "%LOCALAPPDATA%\Programs\Python\Python3*" 2^>nul') do (
    if not defined PYCMD if exist "%LOCALAPPDATA%\Programs\Python\%%d\python.exe" set "PYCMD="%LOCALAPPDATA%\Programs\Python\%%d\python.exe""
)
if defined PYCMD goto :eof
for /f "delims=" %%d in ('dir /b /o-n "%ProgramFiles%\Python3*" 2^>nul') do (
    if not defined PYCMD if exist "%ProgramFiles%\%%d\python.exe" set "PYCMD="%ProgramFiles%\%%d\python.exe""
)
goto :eof
