#!/usr/bin/env bash
# Downloads pinned third-party browser assets into web/vendor/.
# Used both locally and by the GitHub Pages deploy workflow.
set -euo pipefail

WLLAMA_VERSION="3.8.1"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/web/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$VENDOR"
mkdir -p "$VENDOR/wllama/wasm"

echo "-> @wllama/wllama@$WLLAMA_VERSION"
curl -fsSL "https://registry.npmjs.org/@wllama/wllama/-/wllama-$WLLAMA_VERSION.tgz" | tar xz -C "$TMP"
cp "$TMP/package/esm/index.js" "$VENDOR/wllama/index.js"
cp "$TMP/package/esm/wasm/wllama.wasm" "$VENDOR/wllama/wasm/wllama.wasm"
cp "$TMP/package/LICENCE" "$VENDOR/wllama/LICENSE" 2>/dev/null || true
rm -rf "$TMP/package"



# (coi-serviceworker no longer needed: the edge worker sends COOP/COEP)

echo "Vendor assets ready in $VENDOR"
