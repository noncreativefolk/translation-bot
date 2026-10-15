/**
 * Edge gate for the translation bot.
 *
 * Every request is checked here before any app asset is served:
 *   1. Known AI crawlers / scraping tools / headless browsers are refused outright.
 *   2. Visitors without a valid session cookie get only a small challenge page
 *      (Cloudflare Turnstile). The app's HTML/JS/WASM is never sent to them.
 *   3. Passing Turnstile (verified server-side) issues a short-lived HMAC-signed,
 *      HttpOnly cookie bound to the visitor's IP + User-Agent.
 *
 * Secrets (wrangler secret put): TURNSTILE_SECRET, SESSION_KEY
 * Vars (wrangler.jsonc):         TURNSTILE_SITEKEY
 */

const COOKIE = "tb_s";
const SESSION_SECONDS = 12 * 60 * 60; // 12 h

// AI crawlers, SEO/scraper bots, HTTP libraries and automation tools.
const BLOCK_UA = new RegExp([
  "GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-Web", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  "PerplexityBot", "Perplexity-User", "Google-Extended", "GoogleOther", "Google-CloudVertexBot", "Gemini-Deep-Research",
  "Applebot-Extended", "Bytespider", "TikTokSpider", "CCBot", "Diffbot", "FacebookBot", "Meta-External", "meta-webindexer",
  "cohere-ai", "cohere-training", "YouBot", "Amazonbot", "AI2Bot", "Ai2Bot-Dolma", "Timpibot", "omgili", "ImagesiftBot",
  "PetalBot", "DuckAssistBot", "MistralAI-User", "Kangaroo Bot", "Scrapy", "Firecrawl", "FirecrawlAgent", "Crawl4AI",
  "Jina", "Bravebot", "Novellum", "QualifiedBot", "SemrushBot", "AhrefsBot", "MJ12bot", "DotBot", "DataForSeoBot",
  "HeadlessChrome", "Headless", "PhantomJS", "Puppeteer", "Playwright", "Selenium", "webdriver", "Electron/",
  "python-requests", "python-httpx", "aiohttp", "urllib", "curl/", "Wget", "Go-http-client", "okhttp", "node-fetch",
  "undici", "axios", "libwww", "Java/", "HttpClient", "httpie", "Postman", "insomnia", "Deno/", "Bun/",
].map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|"), "i");

// Paths a challenge page itself needs, served without a session.
const PUBLIC = new Set(["/robots.txt", "/__gate/verify", "/favicon.ico"]);

const SECURITY_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const ROBOTS = `# No crawling, indexing or AI training of any kind.
User-agent: *
Disallow: /
DisallowAITraining: /
Content-Usage: train-ai=n
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ua = request.headers.get("User-Agent") || "";

    if (url.pathname === "/robots.txt") return withHeaders(new Response(ROBOTS, { headers: { "Content-Type": "text/plain" } }));

    // 1. Hard block: empty UA, automation tools, AI crawlers, or Cloudflare-verified bots.
    const cf = request.cf || {};
    const verifiedBot = cf.botManagement && cf.botManagement.verifiedBot;
    if (!ua || BLOCK_UA.test(ua) || verifiedBot) return deny();

    // 2. Turnstile verification endpoint.
    if (url.pathname === "/__gate/verify" && request.method === "POST") return verify(request, env, ua);

    // 3. Session check. No valid session -> challenge page only.
    const ok = await validSession(request, env, ua);
    if (!ok) {
      // Non-HTML subresources (JS/WASM/etc.) get a bare 403, never content.
      const accept = request.headers.get("Accept") || "";
      if (url.pathname !== "/" && !url.pathname.endsWith(".html") && !accept.includes("text/html")) return deny();
      return withHeaders(new Response(challengePage(env.TURNSTILE_SITEKEY, url.pathname + url.search), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      }));
    }

    // 4. Authorised: serve the static app.
    const res = await env.ASSETS.fetch(request);
    return withHeaders(res, { "Cache-Control": res.headers.get("Cache-Control") || "private, no-cache" });
  },
};

/* ---------------- helpers ---------------- */

function withHeaders(res, extra = {}) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) r.headers.set(k, v);
  r.headers.delete("Server");
  return r;
}

function deny() {
  return withHeaders(new Response("Forbidden", { status: 403, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } }));
}

async function verify(request, env, ua) {
  let token = "";
  try { token = (await request.json()).token || ""; } catch (_) {}
  if (!token || token.length > 4096) return deny();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const out = await r.json().catch(() => ({}));
  const host = new URL(request.url).hostname;
  // `hostname` is "example.com" for Cloudflare's test keys; accept it only off-production.
  const hostOk = out.hostname === host || (env.ALLOW_TEST_KEYS === "1" && out.hostname === "example.com");
  if (!out.success || !hostOk) return deny();

  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const value = `${exp}.${await sign(env.SESSION_KEY, `${exp}|${ip}|${ua}`)}`;
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return withHeaders(new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Set-Cookie": `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Strict${secure}`,
    },
  }));
}

async function validSession(request, env, ua) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9]+)\\.([A-Za-z0-9_-]+)`));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!exp || exp < Date.now() / 1000) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const expected = await sign(env.SESSION_KEY, `${exp}|${ip}|${ua}`);
  return timingSafeEqual(expected, m[2]);
}

async function sign(secret, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function challengePage(sitekey, next) {
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive,noai,noimageai">
<title>Checking your browser…</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1117;color:#e7e9ee;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.box{text-align:center;padding:32px}h1{font-size:18px;margin:0 0 8px}p{color:#9aa3b2;margin:0 0 20px}#err{color:#ff7b7b;margin-top:12px}</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=tbInit&render=explicit" async defer></script>
</head><body><div class="box"><h1>One moment…</h1><p>Verifying you are a person before opening the translation tool.</p>
<div id="ts"></div><div id="err"></div></div>
<script>
function tbInit(){turnstile.render("#ts",{sitekey:${JSON.stringify(sitekey)},theme:"dark",callback:function(t){
fetch("/__gate/verify",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({token:t})})
.then(function(r){if(r.ok){location.replace(${JSON.stringify(safeNext)})}else{document.getElementById("err").textContent="Verification failed. Reload to try again."}})
.catch(function(){document.getElementById("err").textContent="Network error. Reload to try again."})},
"error-callback":function(){document.getElementById("err").textContent="Verification error. Reload to try again."}})}
</script></body></html>`;
}
