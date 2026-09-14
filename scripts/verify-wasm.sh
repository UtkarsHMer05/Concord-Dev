#!/bin/bash
# WASM gate: Emscripten build + ABI smoke + native-golden parity/runtime tests.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,8p' "$0"
  exit 0
fi

# Fail explicitly when a fresh checkout lacks the required local toolchain or
# installed test runner. `npx` is intentionally not used here: it may fetch a
# package and turn a missing dependency into an unrecorded environment change.
command -v node >/dev/null 2>&1
command -v emcmake >/dev/null 2>&1
if [ ! -x node_modules/.bin/vitest ]; then
  echo "verify-wasm: node_modules/.bin/vitest is missing; run npm ci first" >&2
  exit 2
fi

npm run wasm:build
node wasm/smoke.mjs
node_modules/.bin/vitest run tests/crdt
echo "WASM gate PASSED."
