@echo off
rem Register the AEYE board-ticker relay to start (hidden) at login, and start it
rem now. Pin to Python 3.13 (matches AEYE's bundled ABI and the extras venv) so it
rem never drifts onto a different system Python that happens to be first on PATH.
setlocal
set "PYW="
rem 1) ask the py launcher for 3.13's windowless interpreter (exact full path)
for /f "delims=" %%p in ('py -3.13 -c "import sys,os;print(os.path.join(sys.base_prefix,'pythonw.exe'))" 2^>nul') do set "PYW=%%p"
rem 2) known 3.13 install locations
if not defined PYW for %%d in ("%LOCALAPPDATA%\Programs\Python\Python313" "%ProgramFiles%\Python313" "%SystemDrive%\Python313") do (
  if not defined PYW if exist "%%~d\pythonw.exe" set "PYW=%%~d\pythonw.exe"
)
rem 3) last resort: whatever pythonw is first on PATH
if not defined PYW set "PYW=pythonw"
schtasks /Create /TN "AEYE 4chan relay" /SC ONLOGON /RL LIMITED /F /TR "\"%PYW%\" \"%APPDATA%\AEYE\relay\aeye-4chan-relay.py\"" >nul 2>&1
schtasks /Run /TN "AEYE 4chan relay" >nul 2>&1
exit /b 0
