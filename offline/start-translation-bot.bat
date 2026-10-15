@echo off
setlocal
cd /d "%~dp0"
set MODEL=exaone-3.5-7.8b-instruct-Q4_K_M.gguf

where llama-server >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] llama-server.exe not found in PATH.
  echo  1. Download llama.cpp release for Windows: https://github.com/ggerganov/llama.cpp/releases
  echo  2. Put llama-server.exe in this folder or add it to PATH.
  echo  See README-TEAM.txt for full steps.
  echo.
  pause
  exit /b 1
)

if not exist "%MODEL%" (
  echo.
  echo  [ERROR] Model file not found: %MODEL%
  echo  Download an EXAONE 3.5 GGUF from https://huggingface.co/LGAI-EXAONE
  echo  ^(collection: EXAONE-3.5-GGUF^) and place it in this folder as:
  echo      %MODEL%
  echo  Any other GGUF also works — edit the MODEL= line in this script.
  echo  See README-TEAM.txt for full steps.
  echo.
  pause
  exit /b 1
)

echo  Starting translation server...
start "translation-server" llama-server -m "%MODEL%" -c 32768 --port 8080
timeout /t 3 /nobreak >nul
start "" "translation-bot.html"
echo  Server window opened. Keep it running while translating.
echo  This tool is OFFLINE: the model runs locally, nothing is sent to the internet.
