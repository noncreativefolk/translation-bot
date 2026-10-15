import { Wllama, LoggerWithoutDebug } from "./vendor/wllama/index.js";

/* ---------------- in-browser model config ---------------- */
// IQ3_M imatrix quant (bartowski): 1.29 GB vs 1.64 GB Q4_K_M, same translation quality in our KO/EN benchmark.
const MODEL = {
  repo: "bartowski/EXAONE-3.5-2.4B-Instruct-GGUF",
  file: "EXAONE-3.5-2.4B-Instruct-IQ3_M.gguf",
  label: "EXAONE 3.5 2.4B IQ3_M",
};
MODEL.url = "https://huggingface.co/" + MODEL.repo + "/resolve/main/" + MODEL.file;
const N_CTX = 4096;

/* ---------------- state ---------------- */
const LS = { ep: "tb_endpoint", gloss: "tb_glossary", tone: "tb_tone", dir: "tb_dir", engine: "tb_engine" };
let engine = localStorage.getItem(LS.engine) || "browser";
let wllama = null;          // Wllama instance once loaded
let modelLoading = null;    // in-flight load promise
let endpoint = localStorage.getItem(LS.ep) || "http://localhost:8080";
let glossary = [];
try { glossary = JSON.parse(localStorage.getItem(LS.gloss) || "[]"); } catch (e) { glossary = []; }
let direction = localStorage.getItem(LS.dir) || "ko2en";
let serverOk = false;
let busy = false;
let batchAbort = null;

const $ = (id) => document.getElementById(id);
const history_ = $("history");

/* ---------------- helpers ---------------- */
function fallbackCopy(txt, done) {
  const ta = document.createElement("textarea");
  ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}
function saveGlossary() { localStorage.setItem(LS.gloss, JSON.stringify(glossary)); renderGlossary(); }
function srcName() { return direction === "ko2en" ? "Korean" : "English"; }
function tgtName() { return direction === "ko2en" ? "English" : "Korean"; }

/* ---------------- in-browser engine (llama.cpp → WebAssembly / WebGPU) ---------------- */
function setStatus(cls, text) { $("statusDot").className = "dot " + cls; $("statusText").textContent = text; }
function fmtGB(b) { return (b / 1073741824).toFixed(2) + " GB"; }

function newWllama() {
  return new Wllama({ default: new URL("./vendor/wllama/wasm/wllama.wasm", import.meta.url).href }, {
    logger: LoggerWithoutDebug,
    allowOffline: true,      // reuse cached model when offline
    parallelDownloads: 3,
  });
}

/* ---------------- storage-aware model loading ----------------
 * Normally models are cached in the browser (OPFS) so they download once.
 * Incognito/private windows and low-disk browsers have a tiny storage quota, so
 * caching fails with QuotaExceededError. In that case we stream the model
 * straight into memory instead (works, but re-downloads every visit). */
let storageWarned = false;
async function canCache(bytesNeeded) {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist().catch(() => {});
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (!est || !est.quota) return true;
    return (est.quota - (est.usage || 0)) > bytesNeeded * 1.15;
  } catch (_) { return true; }
}
function isQuotaError(e) {
  const s = String((e && (e.name + " " + e.message)) || e);
  return /quota|QuotaExceeded|storage/i.test(s);
}
/** Download into memory (used only when the browser can't cache). One retry on network failure. */
async function fetchToBlob(url, onBytes) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const total = +r.headers.get("content-length") || 0;
      let loaded = 0;
      const counted = r.body.pipeThrough(new TransformStream({ transform(c, ctl) { loaded += c.byteLength; onBytes(loaded, total); ctl.enqueue(c); } }));
      return { blob: await new Response(counted).blob(), total };
    } catch (e) {
      if (attempt >= 1) throw new Error("Download failed (" + (e && e.message ? e.message : e) + "). This window has limited storage — open the tool in a normal (non-Incognito) Chrome window.");
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}
function warnNoCache() {
  if (storageWarned) return;
  storageWarned = true;
  const msg = "This browser window can't save the models (private/Incognito window or low disk space).\n\nThe translator will still load into memory (re-downloads each visit). The image reader (1.6 GB) may not can't load here.\n\nFor one-time downloads and image reading, open this page in a normal Chrome window.";
  for (const id of ["engineHint", "visionHint"]) { const el = $(id); if (el && !el.textContent.startsWith("Ready")) el.dataset.nocache = "1"; }
  setTimeout(() => alert(msg), 0);
}
/** urls: [model] or [model, mmproj]; sizeHint in bytes; onProgress(loaded,total) */
async function loadModelSmart(w, urls, sizeHint, params, onProgress) {
  const cacheOk = await canCache(sizeHint);
  if (cacheOk) {
    try {
      const src = urls.length > 1 ? { url: urls[0], mmprojUrl: urls[1] } : urls[0];
      await w.loadModelFromUrl(src, { ...params, progressCallback: ({ loaded, total }) => onProgress(loaded, total) });
      return { cached: true };
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      for (const u of urls) { try { await w.cacheManager.delete(u); } catch (_) {} }   // drop partial file
      try { await w.exit(); } catch (_) {}
      w = null;
    }
  }
  // In-memory fallback (no persistent cache).
  warnNoCache();
  const w2 = w || newWllama();
  const done = new Array(urls.length).fill(0), totals = new Array(urls.length).fill(0);
  const blobs = await Promise.all(urls.map((u, i) => fetchToBlob(u, (l, t) => {
    done[i] = l; totals[i] = t;
    onProgress(done.reduce((a, b) => a + b, 0), totals.reduce((a, b) => a + b, 0) || sizeHint);
  }).then((x) => x.blob)));
  await w2.loadModel(blobs, params);
  return { cached: false, instance: w2 };
}

async function isModelCached() {
  try {
    const w = newWllama();
    const models = await w.modelManager.getModels();
    return models.some(m => m.url === MODEL.url && m.size > 0);
  } catch (e) { return false; }
}

async function loadBrowserModel() {
  if (wllama && wllama.isModelLoaded()) return;
  if (modelLoading) return modelLoading;
  modelLoading = (async () => {
    const btn = $("loadModel"), wrap = $("dlBarWrap"), bar = $("dlBar"), hint = $("engineHint");
    btn.disabled = true;
    wrap.classList.remove("hidden");
    setStatus("", "loading model…");
    let w = newWllama();
    const gpu = w.isSupportWebGPU();
    try {
      const res = await loadModelSmart(w, [MODEL.url], 1.3e9, { n_ctx: N_CTX, n_gpu_layers: gpu ? 999 : 0 }, (loaded, total) => {
        const f = total ? loaded / total : 0;
        bar.style.width = Math.round(f * 100) + "%";
        hint.textContent = "Downloading " + fmtGB(loaded) + " / " + fmtGB(total || loaded) + (storageWarned ? " (not cached in this window)" : " (one-time)");
      });
      if (res.instance) w = res.instance;
      wllama = w;
      bar.style.width = "100%";
      const mt = w.isMultithread() ? w.getNumThreads() + " threads" : "single thread";
      hint.textContent = "Ready · " + (gpu ? "WebGPU" : "CPU (" + mt + ")") + (res.cached ? " · cached for next time" : " · not cached (private window / low storage)");
      btn.textContent = "Model loaded";
      $("clearModel").classList.remove("hidden");
      setTimeout(() => wrap.classList.add("hidden"), 800);
      updateStatus();
    } catch (e) {
      try { await w.exit(); } catch (_) {}
      btn.disabled = false;
      wrap.classList.add("hidden");
      hint.textContent = "Load failed: " + (e && e.message ? e.message : e);
      setStatus("bad", "model failed to load");
      throw e;
    } finally {
      modelLoading = null;
    }
  })();
  return modelLoading;
}

async function clearModelCache() {
  if (!confirm("Delete the cached models (translator ~1.3 GB + image reader ~1.6 GB) from this browser? They re-download next time.")) return;
  try { if (wllama) await wllama.exit(); } catch (_) {}
  try { if (vision) await vision.exit(); } catch (_) {}
  wllama = null; vision = null;
  $("visionHint").textContent = "";
  await newWllama().cacheManager.clear();
  $("loadModel").disabled = false; $("loadModel").textContent = "Download & load model";
  $("clearModel").classList.add("hidden");
  $("engineHint").textContent = "Cache cleared.";
  updateStatus();
}

/* ---------------- status ---------------- */
async function updateStatus() {
  if (engine === "server") return checkServer();
  if (wllama && wllama.isModelLoaded()) setStatus("ok", "model ready — running in this browser");
  else if (modelLoading) setStatus("", "loading model…");
  else setStatus("bad", "model not loaded — click “Download & load model”");
}

/** Make sure the selected engine can translate. Returns an error message or null. */
async function ensureReady() {
  if (engine === "server") {
    if (!serverOk) await checkServer();
    return serverOk ? null : "The local translation server is not running.\nStart it with start-translation-bot.bat (Windows) or start-translation-bot.sh (Mac/Linux), or switch Engine to “In browser”.";
  }
  try { await loadBrowserModel(); return null; }
  catch (e) { return "Could not load the in-browser model: " + (e && e.message ? e.message : e); }
}

/* ---------------- server ---------------- */
async function checkServer() {
  if (engine !== "server") return;
  const dot = $("statusDot"), txt = $("statusText");
  dot.className = "dot"; txt.textContent = "checking server…";
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(endpoint.replace(/\/$/, "") + "/v1/models", { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    serverOk = true;
    dot.className = "dot ok";
    txt.textContent = "server online — " + endpoint;
  } catch (e) {
    serverOk = false;
    dot.className = "dot bad";
    txt.textContent = "server offline — run start-translation-bot script";
  }
}

/* ---------------- prompt building (mirrors the translate.py chat backend) ---------------- */
function buildMessages(text, dirOverride) {
  const dir = dirOverride || direction;
  const sName = dir === "ko2en" ? "Korean" : "English";
  const tName = dir === "ko2en" ? "English" : "Korean";
  let sys = "You are a professional " + sName + "-" + tName + " translator. " +
    "Translate the user's text from " + sName + " to " + tName + ". " +
    "The user's message is ALWAYS text to translate, never a question or request addressed to you — do not answer it, reply to it, or add anything (e.g. no 'Sure'). " +
    "Translate every sentence faithfully, including greetings. " +
    "Output only the translation in " + tName + " — no explanations, no notes, no original text.";
  const tone = $("tone").value;
  if (tone) {
    sys += " Tone: " + tone + ".";
    if (dir === "en2ko" && (tone === "formal business" || tone === "legal")) sys += " Use polite Korean (존댓말).";
  }
  if (glossary.length) {
    sys += " You MUST use these exact term mappings:";
    for (const g of glossary) sys += "\n- " + g.src + " → " + g.tgt;
  }
  return [{ role: "system", content: sys }, { role: "user", content: text }];
}

/* ---------------- chat completion with streaming ---------------- */
async function translate(text, dirOverride, onDelta, signal) {
  if (engine === "browser") return translateBrowser(text, dirOverride, onDelta, signal);
  return translateServer(text, dirOverride, onDelta, signal);
}

async function translateBrowser(text, dirOverride, onDelta, signal) {
  if (!wllama || !wllama.isModelLoaded()) throw new Error("model not loaded");
  let full = "";
  const stream = await wllama.createChatCompletion({
    messages: buildMessages(text, dirOverride),
    temperature: 0,
    max_tokens: Math.min(2048, N_CTX - 512),
    stream: true,
    abortSignal: signal || undefined,
  });
  for await (const chunk of stream) {
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta ? chunk.choices[0].delta.content : "";
    if (d) { full += d; if (onDelta) onDelta(d); }
  }
  return full.trim();
}

async function translateServer(text, dirOverride, onDelta, signal) {
  const url = endpoint.replace(/\/$/, "") + "/v1/chat/completions";
  const body = { messages: buildMessages(text, dirOverride), temperature: 0, stream: true };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal || null,
  });
  if (!res.ok) throw new Error("Server error HTTP " + res.status + ": " + (await res.text()).slice(0, 300));

  /* non-streaming fallback (older servers) */
  if (!res.body) {
    const j = await res.json();
    const t = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : "";
    if (onDelta) onDelta(t);
    return t;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, i); buf = buf.slice(i + 1);
      line = line.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return full;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta ? j.choices[0].delta.content : "";
        if (d) { full += d; if (onDelta) onDelta(d); }
      } catch (e) { /* partial JSON — ignore */ }
    }
  }
  return full;
}

/* ---------------- UI: messages ---------------- */
function addMsg(cls) {
  const d = document.createElement("div");
  d.className = "msg " + cls;
  history_.appendChild(d);
  history_.scrollTop = history_.scrollHeight;
  return d;
}
function addUser(text) {
  const d = addMsg("user");
  d.textContent = text;
}
function addBotShell(label) {
  const d = addMsg("bot");
  if (label) {
    const l = document.createElement("span");
    l.className = "lbl"; l.textContent = label;
    d.appendChild(l);
  }
  const body = document.createElement("div");
  d.appendChild(body);
  return { root: d, body };
}
function addCopyBtn(shell, getText) {
  const a = document.createElement("div"); a.className = "actions";
  const b = document.createElement("button"); b.className = "btn small"; b.textContent = "Copy";
  b.onclick = () => {
    const done = () => { b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1200); };
    const txt = getText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
    } else {
      fallbackCopy(txt, done);
    }
  };
  a.appendChild(b); shell.root.appendChild(a);
}

/* ---------------- send flow ---------------- */
async function doSend(textOverride) {
  const ta = $("input");
  const text = (typeof textOverride === "string" ? textOverride : ta.value).trim();
  if (!text || busy) return;
  busy = true; $("send").disabled = true;
  addUser(text);
  if (typeof textOverride !== "string") ta.value = "";
  const notReady = await ensureReady();
  if (notReady) {
    const e = addBotShell("error");
    e.body.textContent = notReady;
    e.root.classList.add("error");
    busy = false; $("send").disabled = false;
    return;
  }
  const rt = $("roundtrip").checked;
  try {
    if (!rt) {
      const sh = addBotShell(srcName() + " → " + tgtName());
      const full = await translate(text, null, (d) => { sh.body.textContent += d; history_.scrollTop = history_.scrollHeight; });
      sh.body.textContent = full || "(empty response)";
      addCopyBtn(sh, () => full);
    } else {
      const sh = addBotShell("ROUNDTRIP QA");
      const fwd = await translate(text, "ko2en", (d) => { sh.body.textContent += d; history_.scrollTop = history_.scrollHeight; });
      sh.body.textContent = "";
      const f1 = document.createElement("div"); f1.textContent = "EN: " + (fwd || "(empty)");
      const f2 = document.createElement("div"); f2.style.marginTop = "6px"; f2.textContent = "KO (back-translation): ";
      sh.body.appendChild(f1); sh.body.appendChild(f2);
      let backAcc = "";
      const back = await translate(fwd, "en2ko", (d) => { backAcc += d; f2.textContent = "KO (back-translation): " + backAcc; });
      f2.textContent = "KO (back-translation): " + back;
      const note = document.createElement("div");
      note.className = "hint"; note.style.marginTop = "6px";
      note.textContent = "Original vs back-translation divergence flags low-confidence segments — verify manually before use.";
      sh.body.appendChild(note);
      addCopyBtn(sh, () => "EN: " + fwd + "\nKO (back): " + back);
    }
  } catch (err) {
    const e = addBotShell("error");
    e.root.classList.add("error");
    e.body.textContent = "Translation failed: " + err.message + "\nIf the server was stopped, restart it and retry.";
  }
  busy = false; $("send").disabled = false;
  history_.scrollTop = history_.scrollHeight;
}

/* ---------------- glossary ---------------- */
function renderGlossary() {
  $("glossCount").textContent = glossary.length;
  const list = $("glossList"); list.textContent = "";
  glossary.forEach((g, i) => {
    const r = document.createElement("div"); r.className = "gloss-row";
    const s = document.createElement("span"); s.className = "src"; s.textContent = g.src;
    const a = document.createElement("span"); a.className = "arrow"; a.textContent = "→";
    const t = document.createElement("span"); t.textContent = g.tgt;
    const del = document.createElement("button"); del.className = "btn small del danger"; del.textContent = "x";
    del.onclick = () => { glossary.splice(i, 1); saveGlossary(); };
    r.appendChild(s); r.appendChild(a); r.appendChild(t); r.appendChild(del);
    list.appendChild(r);
  });
  if (!glossary.length) { const p = document.createElement("p"); p.className = "hint"; p.textContent = "No terms yet."; list.appendChild(p); }
}
$("gAdd").onclick = () => {
  const s = $("gSrc").value.trim(), t = $("gTgt").value.trim();
  if (!s || !t) return;
  glossary.push({ src: s, tgt: t });
  $("gSrc").value = ""; $("gTgt").value = "";
  saveGlossary();
};
$("gExport").onclick = () => {
  const blob = new Blob([JSON.stringify({ version: 1, pairs: glossary }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "translation-glossary.json"; a.click();
  URL.revokeObjectURL(a.href);
};
$("gImportBtn").onclick = () => $("gImport").click();
$("gImport").onchange = (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const j = JSON.parse(r.result);
      const pairs = Array.isArray(j) ? j : j.pairs;
      if (!Array.isArray(pairs)) throw new Error("bad format");
      glossary = pairs.filter(p => p && p.src && p.tgt).map(p => ({ src: String(p.src), tgt: String(p.tgt) }));
      saveGlossary();
    } catch (e) { alert("Import failed: not a valid glossary JSON."); }
  };
  r.readAsText(f);
  ev.target.value = "";
};

/* ---------------- batch ---------------- */
let batchResults = [];
function setProgress(show, label, frac, count) {
  $("progress").style.display = show ? "flex" : "none";
  if (label !== undefined) $("progLabel").textContent = label;
  $("progBar").style.width = Math.round(frac * 100) + "%";
  if (count !== undefined) $("progCount").textContent = count;
}
async function runBatch() {
  if (busy) return;
  let lines = [];
  const f = $("batchFile").files[0];
  if (f) {
    const txt = await f.text();
    lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } else {
    lines = $("batchText").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  if (!lines.length) { alert("Nothing to translate — attach a .txt/.md file or paste lines."); return; }
  const notReady = await ensureReady();
  if (notReady) { alert(notReady); return; }

  busy = true; batchAbort = new AbortController();
  $("batchStart").disabled = true; $("batchCancel").classList.remove("hidden");
  batchResults = [];
  const dir = direction; /* batch uses the current direction for all lines */
  for (let i = 0; i < lines.length; i++) {
    if (batchAbort.signal.aborted) break;
    setProgress(true, "Translating (" + dir + ")…", i / lines.length, (i + 1) + " / " + lines.length);
    try {
      const out = await translate(lines[i], null, null, batchAbort.signal);
      batchResults.push({ original: lines[i], translation: out });
    } catch (e) {
      if (batchAbort.signal.aborted) break;
      batchResults.push({ original: lines[i], translation: "", error: e.message });
    }
  }
  const done = batchResults.length;
  setProgress(true, batchAbort.signal.aborted ? "Cancelled." : "Done.", 1, done + " / " + lines.length);
  $("batchStart").disabled = false; $("batchCancel").classList.add("hidden");
  $("batchDl").classList.remove("hidden");
  busy = false;
}
$("batchStart").onclick = runBatch;
$("batchCancel").onclick = () => { if (batchAbort) batchAbort.abort(); };
$("dlTxt").onclick = () => {
  const t = batchResults.map(r => r.original + "\t" + (r.translation || ("ERROR: " + (r.error || "")))).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([t], { type: "text/plain" }));
  a.download = "batch-translation.txt"; a.click(); URL.revokeObjectURL(a.href);
};
$("dlJson").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(batchResults, null, 2)], { type: "application/json" }));
  a.download = "batch-translation.json"; a.click(); URL.revokeObjectURL(a.href);
};

/* ---------------- panels / controls ---------------- */
function toggle(id, btn) { $(id).classList.toggle("hidden"); }
$("btnGloss").onclick = () => toggle("glossPanel");
$("btnBatch").onclick = () => toggle("batchPanel");
$("btnSettings").onclick = () => toggle("settingsPanel");
$("dirSeg").addEventListener("click", (e) => {
  if (e.target.dataset.dir) {
    direction = e.target.dataset.dir;
    localStorage.setItem(LS.dir, direction);
    for (const b of $("dirSeg").children) b.className = b.dataset.dir === direction ? "on" : "";
  }
});
$("saveSettings").onclick = () => {
  endpoint = $("endpoint").value.trim() || "http://localhost:8080";
  localStorage.setItem(LS.ep, endpoint);
  checkServer();
};
$("checkNow").onclick = checkServer;
$("send").onclick = () => doSend();
$("input").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") doSend();
});
/* ---------------- image → copy extraction (Qwen3-VL 2B, in browser) ---------------- */
const VISION = {
  // Official Qwen Q4_K_M (1.11 GB) + Q8_0 vision projector (0.45 GB) = 1.56 GB vs 2.28 GB Q8_0; 0 errors on our banner tests.
  url: "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/Qwen3VL-2B-Instruct-Q4_K_M.gguf",
  mmprojUrl: "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf",
  maxMP: 0.6,  // megapixels sent to the model; larger images exhaust browser GPU memory
  prompt: "Extract all text in this image exactly as written, line by line, top to bottom. " +
          "Keep the original language and spelling, including numbers, symbols and currency signs. Output only the text.",
};
let vision = null, visionLoading = null;
const imageQueue = [];
let imageRunning = false;

async function loadVision() {
  if (vision && vision.isModelLoaded()) return;
  if (visionLoading) return visionLoading;
  visionLoading = (async () => {
    const hint = $("visionHint"), wrap = $("vBarWrap"), bar = $("vBar");
    let w = newWllama();
    wrap.classList.remove("hidden");
    hint.textContent = "Loading image reader…";
    try {
      const res = await loadModelSmart(w, [VISION.url, VISION.mmprojUrl], 1.56e9, { n_ctx: 4096, n_gpu_layers: w.isSupportWebGPU() ? 999 : 0 }, (loaded, total) => {
        bar.style.width = Math.round((total ? loaded / total : 0) * 100) + "%";
        hint.textContent = "Downloading image reader " + fmtGB(loaded) + " / " + fmtGB(total || loaded) + (storageWarned ? " (not cached in this window)" : " (one-time)");
      });
      if (res.instance) w = res.instance;
      vision = w;
      hint.textContent = "Image reader ready" + (res.cached ? " · cached for next time" : " · not cached (private window / low storage)");
    } catch (e) {
      try { await w.exit(); } catch (_) {}
      hint.textContent = "Image reader failed to load: " + (e && e.message ? e.message : e);
      throw e;
    } finally {
      wrap.classList.add("hidden");
      visionLoading = null;
    }
  })();
  return visionLoading;
}

/** Downscale to VISION.maxMP and re-encode as PNG (also normalises webp/gif/etc). */
async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, Math.sqrt(VISION.maxMP * 1e6 / (bmp.width * bmp.height)));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);   // flatten transparency
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  return blob.arrayBuffer();
}

function addImageMsg(file) {
  const d = addMsg("user img");
  const im = document.createElement("img");
  im.src = URL.createObjectURL(file); im.alt = file.name || "image";
  d.appendChild(im);
}

async function extractImage(file) {
  addImageMsg(file);
  const sh = addBotShell("COPY FROM IMAGE — " + (file.name || "pasted image"));
  sh.body.textContent = "Reading text… (runs on this device)";
  try {
    await loadVision();
    const data = await prepareImage(file);
    const t0 = performance.now();
    let full = "";
    sh.body.textContent = "";
    const stream = await vision.createChatCompletion({
      messages: [{ role: "user", content: [{ type: "image", data }, { type: "text", text: VISION.prompt }] }],
      temperature: 0, max_tokens: 1024, stream: true,
    });
    for await (const chunk of stream) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta ? chunk.choices[0].delta.content : "";
      if (d) { full += d; sh.body.textContent = full; history_.scrollTop = history_.scrollHeight; }
    }
    full = full.trim();
    sh.body.textContent = "";
    if (!full) { sh.body.textContent = "No text found in this image."; return; }
    const ta = document.createElement("textarea");
    ta.className = "extract"; ta.value = full; ta.rows = Math.min(14, full.split("\n").length + 1);
    ta.title = "Fix any misread words before translating";
    sh.body.appendChild(ta);
    const note = document.createElement("div");
    note.className = "hint"; note.style.marginTop = "4px";
    note.textContent = "Extracted in " + ((performance.now() - t0) / 1000).toFixed(1) + "s · check and edit, then translate. Image never left this device.";
    sh.body.appendChild(note);
    const a = document.createElement("div"); a.className = "actions";
    const bT = document.createElement("button"); bT.className = "btn small primary"; bT.textContent = "Translate this";
    bT.onclick = async () => {
      if (busy) return;
      const dir = /[가-힣]/.test(ta.value) ? "ko2en" : "en2ko";   // auto-pick direction from the copy
      if (dir !== direction) $("dirSeg").querySelector('[data-dir="' + dir + '"]').click();
      await doSend(ta.value);
    };
    const bL = document.createElement("button"); bL.className = "btn small"; bL.textContent = "Translate line by line";
    bL.title = "Translate each line separately (keeps banner structure: headline / sub-copy / button)";
    bL.onclick = () => {
      $("batchText").value = ta.value; $("batchFile").value = "";
      $("batchPanel").classList.remove("hidden");
      const dir = /[가-힣]/.test(ta.value) ? "ko2en" : "en2ko";
      if (dir !== direction) $("dirSeg").querySelector('[data-dir="' + dir + '"]').click();
      runBatch();
    };
    a.appendChild(bT); a.appendChild(bL); sh.root.appendChild(a);
    addCopyBtn(sh, () => ta.value);
  } catch (e) {
    sh.root.classList.add("error");
    sh.body.textContent = "Could not read this image: " + (e && e.message ? e.message : e);
  }
}

function queueImages(files) {
  for (const f of files) if (f && f.type && f.type.startsWith("image/")) imageQueue.push(f);
  if (imageRunning) return;
  imageRunning = true;
  (async () => {
    while (imageQueue.length) await extractImage(imageQueue.shift());
    imageRunning = false;
  })();
}

$("btnImage").onclick = () => $("imageFile").click();
$("imageFile").onchange = (e) => { queueImages([...e.target.files]); e.target.value = ""; };
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); queueImages(files); }
});
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
document.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("dropHint").style.display = "flex"; } });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropHint").style.display = "none"; } });
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("dropHint").style.display = "none";
  const imgs = [...e.dataTransfer.files].filter(f => f.type.startsWith("image/"));
  if (imgs.length) queueImages(imgs);
  else if (e.dataTransfer.files.length) { $("batchPanel").classList.remove("hidden"); }
});

/* ---------------- engine switch ---------------- */
function applyEngine() {
  for (const b of $("engineSeg").children) b.className = b.dataset.engine === engine ? "on" : "";
  $("browserEngine").classList.toggle("hidden", engine !== "browser");
  $("serverEngine").classList.toggle("hidden", engine !== "server");
  updateStatus();
}
$("engineSeg").addEventListener("click", (e) => {
  if (!e.target.dataset.engine || busy) return;
  engine = e.target.dataset.engine;
  localStorage.setItem(LS.engine, engine);
  applyEngine();
});
$("loadModel").onclick = () => loadBrowserModel().catch(() => {});
$("clearModel").onclick = clearModelCache;

/* ---------------- init ---------------- */
$("endpoint").value = endpoint;
$("tone").value = localStorage.getItem(LS.tone) || "";
$("tone").addEventListener("change", () => localStorage.setItem(LS.tone, $("tone").value));
for (const b of $("dirSeg").children) b.className = b.dataset.dir === direction ? "on" : "";
renderGlossary();
applyEngine();
setInterval(() => { if (engine === "server") checkServer(); }, 30000);

/* Remove cached files from older model versions (e.g. previous larger quants) to free storage. */
(async () => {
  try {
    const keep = new Set([MODEL.url, VISION.url, VISION.mmprojUrl]);
    const cm = newWllama().cacheManager;
    for (const e of await cm.list()) {
      const u = e.metadata && e.metadata.originalURL;
      if (u && !keep.has(u)) await cm.delete(e.name);
    }
  } catch (_) {}
})();

/* Warn up front when this window can't hold the models (Incognito / private / low disk). */
(async () => {
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const free = est && est.quota ? est.quota - (est.usage || 0) : Infinity;
    if (free < 3.3e9) {
      const d = document.createElement("div");
      d.className = "hint";
      d.style.cssText = "background:#3a2a10;border:1px solid #7a5a20;color:#ffd58a;padding:8px 10px;border-radius:8px;margin-bottom:10px";
      d.textContent = "This looks like a private/Incognito window or a browser with little free storage. Models can't be saved here: the translator re-downloads every visit and the image reader may not load. Open this page in a normal Chrome window for one-time downloads.";
      $("modelCard").prepend(d);
    }
  } catch (_) {}
})();
/* Auto-load the model on startup if it is already cached (no network download needed). */
isModelCached().then((cached) => {
  if (cached) {
    $("clearModel").classList.remove("hidden");
    if (engine === "browser") { $("engineHint").textContent = "Model found in browser cache — loading…"; loadBrowserModel().catch(() => {}); }
  } else if (!navigator.gpu) {
    $("engineHint").textContent = "Tip: Chrome or Edge with WebGPU is much faster. This browser will use CPU.";
  }
});
