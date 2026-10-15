// Builds web/ -> dist/ : obfuscates the app logic, minifies the HTML, copies vendor assets.
// The readable source never ships; only dist/ is deployed.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import JavaScriptObfuscator from "javascript-obfuscator";
import { minify } from "html-minifier-terser";

const SRC = "web", OUT = "dist";
if (!existsSync(`${SRC}/vendor/wllama/index.js`)) throw new Error("Run `npm run vendor` first");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Vendor files (open-source runtime) copied as-is.
cpSync(`${SRC}/vendor`, `${OUT}/vendor`, { recursive: true });
if (existsSync(`${SRC}/download`)) cpSync(`${SRC}/download`, `${OUT}/download`, { recursive: true });

// Obfuscate our own logic (prompts, flows, model config).
const src = readFileSync(`${SRC}/app.js`, "utf8");
const obf = JavaScriptObfuscator.obfuscate(src, {
  target: "browser",
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  stringArray: true,
  stringArrayEncoding: ["rc4"],
  stringArrayThreshold: 1,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: "function",
  transformObjectKeys: true,
  numbersToExpressions: true,
  unicodeEscapeSequence: false,
  disableConsoleOutput: true,
  debugProtection: true,
  debugProtectionInterval: 4000,
  reservedStrings: ["\\./vendor/wllama/index\\.js"],
}).getObfuscatedCode();

// Content-hashed filename so the name itself reveals nothing and caches bust per release.
const hash = createHash("sha256").update(obf).digest("hex").slice(0, 12);
const appName = `a.${hash}.js`;
writeFileSync(`${OUT}/${appName}`, obf);

const html = readFileSync(`${SRC}/index.html`, "utf8").replace('src="app.js"', `src="${appName}"`);
const min = await minify(html, {
  collapseWhitespace: true,
  removeComments: true,
  minifyCSS: true,
  minifyJS: true,
  removeAttributeQuotes: false,
});
writeFileSync(`${OUT}/index.html`, min);
console.log(`built dist/ (app ${appName}, ${(obf.length / 1024).toFixed(0)} KB obfuscated)`);
