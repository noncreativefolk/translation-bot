# KO-EN Translation Bot

Private Korean ↔ English translation tool. The model runs **inside the user's browser**
(llama.cpp compiled to WebAssembly/WebGPU via [wllama](https://github.com/ngxson/wllama)),
so no text is sent to any server. Hosted as static files on GitHub Pages.

- Model: EXAONE 3.5 2.4B Instruct, Q4_K_M (~1.6 GB), downloaded once from Hugging Face and cached in the browser (OPFS).
- Best in Chrome/Edge (WebGPU). Other browsers fall back to CPU (slower).
- Optional "Local server" engine talks to `llama-server` on `localhost:8080` (see `offline/`).

## Layout

| Path | Purpose |
|---|---|
| `web/index.html` | The bot (UI + engines) |
| `scripts/fetch-vendor.sh` | Downloads pinned wllama + coi-serviceworker into `web/` |
| `scripts/serve.py` | Local dev server with cross-origin-isolation headers |
| `offline/` | Original llama-server package (published as `download/translation-bot-offline.zip`) |
| `.github/workflows/deploy.yml` | Builds and deploys to GitHub Pages on every push to `main` |

## Develop locally

```bash
./scripts/fetch-vendor.sh
python3 scripts/serve.py      # http://localhost:8000
```

## Deploy

Push to `main`. The workflow fetches vendor assets, builds the offline zip and deploys Pages.

## License

EXAONE 3.5 weights: EXAONE AI Model License 1.1 – **NC (non-commercial)**. Internal drafting/QA only.
