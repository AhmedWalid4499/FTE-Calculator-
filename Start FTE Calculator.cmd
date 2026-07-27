@echo off
title DPM FTE Calculator
cd /d "%~dp0"
rem -Sta puts PowerShell in a single-threaded apartment, which Outlook COM (the "Email result" button) requires.
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File "%~dp0server\serve.ps1"
if errorlevel 1 (
  echo.
  echo   The server could not start. The message above explains why.
  echo   You can still use the calculator by opening index.html directly,
  echo   but calculations will not be written to the data folder.
  echo.
  pause
)
