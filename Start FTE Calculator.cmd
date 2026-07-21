@echo off
title DPM FTE Calculator
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\serve.ps1"
if errorlevel 1 (
  echo.
  echo   The server could not start. The message above explains why.
  echo   You can still use the calculator by opening index.html directly,
  echo   but calculations will not be written to the data folder.
  echo.
  pause
)
