#!/usr/bin/env bash
cd "$(dirname "$0")"
MODEL="exaone-3.5-7.8b-instruct-Q4_K_M.gguf"

if ! command -v llama-server >/dev/null 2>&1; then
  echo ""
  echo "  [ERROR] llama-server not found."
  echo "  1. Install llama.cpp (brew install llama.cpp, or build from"
  echo "     https://github.com/ggerganov/llama.cpp)"
  echo "  2. Make sure 'llama-server' is in your PATH."
  echo "  See README-TEAM.txt for full steps."
  exit 1
fi

if [ ! -f "$MODEL" ]; then
  echo ""
  echo "  [ERROR] Model file not found: $MODEL"
  echo "  Download an EXAONE 3.5 GGUF from https://huggingface.co/LGAI-EXAONE"
  echo "  (collection: EXAONE-3.5-GGUF) into this folder, or edit MODEL= in"
  echo "  this script to point at any other GGUF file."
  exit 1
fi

echo "  Starting translation server..."
( sleep 3; open "translation-bot.html" 2>/dev/null || xdg-open "translation-bot.html" ) &
llama-server -m "$MODEL" -c 32768 --port 8080
