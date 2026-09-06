#!/bin/bash
# Phase 2 WASM gate: build + smoke + parity/runtime tests.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run wasm:build
node wasm/smoke.mjs
npx vitest run tests/crdt
echo "WASM gate PASSED."
