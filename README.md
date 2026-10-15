# KO-EN Translation Bot

Private Korean ↔ English translation tool. The model runs **inside the user's browser**
(llama.cpp compiled to WebAssembly/WebGPU via [wllama](https://github.com/ngxson/wllama)),
so no text is sent to any server. Live: https://translation-bot.translation-bot.workers.dev

- Model: EXAONE 3.5 2.4B Instruct, Q4_K_M (~1.6 GB), downloaded once from Hugging Face and cached in the browser (OPFS).
- Best in Chrome/Edge (WebGPU). Other browsers fall back to CPU (slower).
- Image → copy: upload / paste / drop banner images; Qwen3-VL 2B (Q8_0 + mmproj, ~2.3 GB, Apache-2.0) reads the text in-browser, user edits, then EXAONE translates. Images are downscaled to 0.6 MP (larger exhausts browser GPU memory).
- Optional "Local server" engine talks to `llama-server` on `localhost:8080` (see `offline/`).

## Protection against scrapers / AI agents / reverse engineering

| Layer | What it does |
|---|---|
| Edge gate (`worker/index.js`) | Runs before every request. Refuses AI crawlers, scraping libraries, `curl`, and headless/automation browsers (403). |
| Cloudflare Turnstile | Visitors without a session only receive a tiny challenge page. App HTML/JS/WASM is never sent until Turnstile is solved and verified server-side. |
| Signed session | HMAC-signed, HttpOnly, SameSite=Strict cookie bound to IP + User-Agent, 12 h. A copied cookie does not work elsewhere. |
| Obfuscated build | `app.js` (prompts, flows, model config) ships only as RC4-string-encrypted, control-flow-flattened, self-defending JS with a content-hashed name. |
| No-AI signals | `robots.txt` disallow-all + `DisallowAITraining`, `X-Robots-Tag: noai, noimageai, noindex`. |
| Data never on the server | Users' text and images are processed in their own browser; there is nothing on the server to scrape. |

Secrets live on the Worker (`wrangler secret put TURNSTILE_SECRET` / `SESSION_KEY`), never in git.

## Layout

| Path | Purpose |
|---|---|
| `web/index.html`, `web/app.js` | The bot (UI + engines), readable source |
| `worker/index.js` | Edge gate (bot block, Turnstile, session, headers) |
| `scripts/build.mjs` | `web/` → `dist/` (obfuscate + minify); only `dist/` is deployed |
| `scripts/fetch-vendor.sh` | Downloads pinned wllama into `web/vendor/` |
| `offline/` | Original llama-server package (published as `download/translation-bot-offline.zip`) |
| `wrangler.jsonc` | Cloudflare config (Worker `translation-bot`, Gerald@teeo.space account) |
| `.github/workflows/deploy.yml` | Builds and deploys on every push to `main` |

## Develop locally

```bash
npm ci && npm run vendor
cp .dev.vars.example .dev.vars   # Turnstile test secret + random SESSION_KEY
npm run dev                      # http://localhost:8787 (Turnstile test keys, always pass)
```

## Deploy

Push to `main`. Requires repo secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit on the teeo.space account).
Manual: `npm run deploy`.

## License

EXAONE 3.5 weights: EXAONE AI Model License 1.1 – **NC (non-commercial)**. Internal drafting/QA only.
