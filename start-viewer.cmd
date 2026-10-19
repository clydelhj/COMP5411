@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
    py -3 scripts\serve.py
    goto finished
)
where python >nul 2>nul
if not errorlevel 1 (
    python scripts\serve.py
    goto finished
)
echo Python 3 was not found. Install Python, or open index-1m.html directly.
pause
exit /b 1
:finished
if errorlevel 1 pause
