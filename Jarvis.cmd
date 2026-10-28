@echo off
setlocal
cd /d "%~dp0"
title Jarvis
echo.
echo  J A R V I S
echo  Preparing your local assistant...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 (
  echo.
  echo Jarvis could not finish preparing. Please read the message above.
  pause
  exit /b 1
)
"%~dp0.runtime\python\python.exe" "%~dp0jarvis_server.py" %*
if errorlevel 1 (
  echo.
  echo Jarvis stopped with an error. Please read the message above.
  pause
  exit /b 1
)
