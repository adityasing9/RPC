@echo off
title RCPC Windows Agent
cd /d "%~dp0agent"
echo ========================================================
echo   Starting RCPC Windows Agent...
echo ========================================================
python run_agent.py
if errorlevel 1 (
    echo.
    echo Agent exited with an error. Press any key to close.
    pause >nul
)
