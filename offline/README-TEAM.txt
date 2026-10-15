KO-EN TRANSLATION BOT — TEAM SETUP (offline, local model)
=========================================================

WHAT THIS IS
  translation-bot.html  — the bot. Works in Chrome/Edge/Firefox/Safari.
  start-translation-bot.* — starts the local model server, then opens the bot.
  Everything runs on YOUR machine. No internet needed after setup. No text
  is sent anywhere: the bot only talks to http://localhost:8080 on your own
  computer.

SETUP (one time, ~10 min, ~5 GB download)
------------------------------------------
1. Get the llama.cpp server binary
   Windows: https://github.com/ggerganov/llama.cpp/releases
            download the latest "llama-<version>-bin-win-<cpu/cuda>.zip",
            copy llama-server.exe into this folder.
   Mac:     brew install llama.cpp
   Linux:   your package manager, or build from the repo above.

2. Get the model (one GGUF file, ~4.7 GB)
   https://huggingface.co/LGAI-EXAONE  ->  EXAONE-3.5-GGUF collection
   File: EXAONE-3.5-7.8B-Instruct-Q4_K_M.gguf
   Place it in this folder and rename it to:
       exaone-3.5-7.8b-instruct-Q4_K_M.gguf
   (or edit the MODEL= line in the start script).

3. Run it
   Windows: double-click start-translation-bot.bat
   Mac/Linux: bash start-translation-bot.sh
   The bot opens in your browser. Keep the server window open.

DAILY USE
  - Type or paste text, Ctrl+Enter to send.
  - Direction toggle: KO>EN / EN>KO.
  - Tone presets: neutral / formal business / legal / casual marketing /
    technical documentation. Formal and legal auto-use polite Korean.
  - Roundtrip QA: translates KO>EN then back to KO. If the back-translation
    diverges from your original, treat that segment as low-confidence and
    re-check it.
  - Glossary: add terms once; the bot must use them. Export the JSON and
    share it with the team so everyone translates terms identically.
    Import merges by replacing the local list — agree on one master file.
  - Batch: attach a .txt/.md file (one segment per line) or paste lines,
    get back original TAB translation (.txt) or JSON.

LICENSE — READ BEFORE BUSINESS USE
  EXAONE 3.5 is released under the EXAONE AI Model License 1.1 - NC
  (NON-COMMERCIAL). Internal drafting, research, and QA are fine.
  Do NOT use EXAONE-translated output as final commercial deliverables.
  For commercial-grade Korean translation use a paid API (NAVER CLOVA
  Studio / HyperCLOVA X, Papago, DeepL) or a commercially licensed model.

TROUBLESHOOTING
  - "server offline": the start script did not keep running, or port 8080
    is taken. Close other llama-server instances and start again.
  - First message is slow: the model is loading into memory. Normal.
  - GPU not used: llama.cpp runs on CPU by default. It works, just slower.
    (Windows CUDA builds use the GPU automatically when available.)
  - Settings panel lets you change the server address if you run the
    server on another machine/port.
