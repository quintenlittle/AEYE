@echo off
rem Remove the AEYE board-ticker relay login task.
schtasks /Delete /TN "AEYE 4chan relay" /F >nul 2>&1
exit /b 0
