# Concord — Browser Support Matrix (v1)

Status: Authoritative (Phase 7, M011)
Last updated: 2026-09-09

This document states, truthfully, which browsers can run the Concord v1 web
client and why. It is derived from a static API audit of the shipped client
code (`src/lib/crdt/**`, `src/lib/sync/**`, `src/app/**`, `src/components/**`)
and a feature scan of the compiled WebAssembly module (`public/wasm/concord-crdt.wasm`,
disassembled with binaryen `wasm-dis`). It is an API-level audit; interactive
browser validation (Safari WebKit, Chrome, Firefox) is performed separately by
the release lead with GUI tooling (M036) and will amend this matrix.

---

## 1. Required browser capabilities

The v1 client is a local-first application; the following platform features
are load-bearing (no polyfills are shipped):

| # | Capability | Where used | Evidence |
|---|---|---|---|
| 1 | **WebAssembly with bulk-memory** (`memory.copy`, `memory.fill`) | CRDT core (C++ compiled via Emscripten; 150 `memory.copy` + 7 `memory.fill` sites in the shipped binary) | `wasm-dis public/wasm/concord-crdt.wasm` |
| 2 | **WebAssembly i64 with JS BigInt integration** (`-sWASM_BIGINT=1`) | replica ids, counters, Lamport clocks cross the JS/WASM boundary as BigInt; `setBigUint64` in the sync protocol encoder | `wasm/CMakeLists.txt`, `src/lib/crdt/wasm-types.ts`, `src/lib/sync/protocol.ts:452` |
| 3 | **Web Workers — classic, constructed from a blob** (pre-bundled `/crdt-worker.js` fetched and loaded via `URL.createObjectURL`; the WASM glue loads inside the worker via `importScripts()` on an absolute same-origin URL) | CRDT engine runs in a dedicated worker (main thread stays free) | `src/lib/crdt/worker/client.ts` (blob construction), `src/lib/crdt/worker/crdt-worker.ts` (importScripts glue) |
| 4 | **IndexedDB** (basic CRUD: open, transactions, `getAll` via index, `put`, `delete`) | local replica durability (snapshot + op log) and the sync outbox | `src/lib/crdt/worker/idb.ts`, `src/lib/sync/pending-store.ts` |
| 5 | **WebSocket** | realtime sync transport to the Rust gateway (URL supplied explicitly — `ws://`/`wss://` chosen by deployment config, not page protocol inference) | `src/lib/sync/transport.ts:167` |
| 6 | **TextEncoder / TextDecoder** | UTF-8 encode/decode across the worker/WASM boundary | `src/lib/crdt/runtime.ts` |
| 7 | **fetch, Blob, URL.createObjectURL** | content mirror saves, export downloads, local image embeds | `src/lib/collaboration/provider.tsx`, editor navbar, toolbar image button |
| 8 | **requestAnimationFrame** | margin restore + online-status sync (cosmetic timing) | provider, save-status hook |
| 9 | **localStorage** (best-effort; private-mode tolerated) | replica identity, margin settings, spell-check preference — all wrapped in try/catch with in-session fallbacks | `src/lib/crdt/editor-bridge.ts`, provider, toolbar |
| 10 | **ES2022+ syntax** (class fields, `??`, optional chaining, async/await, `structuredClone` is NOT used) | all client code (Next.js 16 target) | source audit |

Not used (explicitly verified absent): WebAssembly SIMD (`v128` — 0 sites),
threads/`SharedArrayBuffer`/`Atomics` (0 sites; no COOP/COEP requirement),
reference types / `externref` beyond the MVP table model, `document.execCommand`,
Async Clipboard API, WebUSB/WebNFC/service workers, CSS container queries.

## 2. Feature-driven baseline requirements

Combining the audit above, a browser must support:

- **WebAssembly bulk-memory**: shipped in Chrome 75+, Firefox 62+ (preview) /
  Firefox 68+ (stable), Safari 15+ (Safari shipped bulk-memory in 15.0).
- **WASM BigInt integration**: Chrome 85+, Firefox 78+, Safari 15+.
- **Classic blob workers** (the shipped P7-M032 form — no module-worker
  requirement): Chrome 20+, Firefox 13+, Safari 7+ (far older than every
  other constraint; the module-worker Firefox 114 floor no longer applies).

Therefore the **minimum feature baseline is roughly Safari 15 / Chrome 85 /
Firefox 78-86** (bulk-memory + WASM BigInt are the binding constraints). Concord v1 targets and verifies current evergreen versions,
with the following matrix:

## 3. Support matrix (v1)

| Browser | Status | Notes |
|---|---|---|
| Chrome/Chromium (last 2 majors) | **Supported** (primary dev target) | WASM smoke + full unit/realtime harnesses run on Node/Chromium-adjacent toolchains; interactive validation by the release lead (M036) |
| Safari on macOS (16.4+) | **Supported** | All required APIs present since Safari 15; WASM BigInt stable in 16.x; the shipped worker is a classic blob worker (no module-worker requirement). Local WebKit validation was performed in the Phase 7 production E2E (the CSP 'wasm-unsafe-eval' finding was a live WebKit behavior) |
| Firefox (last 2 majors) | **Supported (API-level)** | Bulk-memory + WASM BigInt satisfied (Firefox 78+); the shipped classic blob worker lifts the old module-worker Firefox-114 floor. Interactive verification pending; no known incompatibilities in the API audit |
| Safari 15.x | Partial (untested) | APIs exist (bulk-memory, BigInt, classic workers); not covered by the interactive validation matrix — treated as unsupported for v1 claims |
| Edge/Opera (Chromium) | Expected to work (Chromium engine); not separately tested | |
| iOS/iPadOS Safari | Not verified for v1 (desktop-first product; see PRD §25a.C.5) | Responsive chrome is in place but the 816px document page is desktop-first |
| IE 11, legacy Edge, Safari < 15 | **Not supported** | No WASM bulk-memory/BigInt support; the CRDT engine cannot instantiate |
| Browsers with JavaScript disabled | Not supported | The product is a client-rendered application |

## 4. Degradation behavior (honest, not silent)

- **WASM or Worker unavailable** (very old browsers, strict CSP without
  `worker-src`): `Document.tsx` nulls the CRDT client (`typeof Worker ===
  "undefined"`), and the editor falls back to the transitional whole-document
  save path — the page still loads and edits persist through the server
  mirror. The collaborative-mode indicator reports the fallback honestly.
- **IndexedDB unavailable/blocked** (private modes, storage quotas): worker
  persistence and the outbox fail closed — saves surface the retry state;
  localStorage-dependent conveniences (margins, spell-check) degrade to
  in-memory defaults. The save-status indicator never claims server-synced
  before a successful mirror save.
- **WebSocket blocked** (proxies, corporate networks): the v1 product surface
  does not depend on the WS gateway (PRD §25a.B.1); the content mirror is
  plain HTTPS `fetch`, which works wherever the app itself loads.

## 5. Known compatibility notes

- The worker itself is pre-bundled as a CLASSIC worker
  (`public/crdt-worker.js` via `npm run worker:bundle`), fetched with
  `cache: 'reload'` and constructed from a blob URL; inside the worker the
  Emscripten glue loads via `importScripts()` on an absolute same-origin URL
  and the binary via `fetch()` (`src/lib/crdt/worker/crdt-worker.ts`).
  (History: the glue was once evaluated via `new Function` — blocked by the
  shipped CSP — and earlier via a module worker, which proved unreliable in
  embedded WebViews; the classic importScripts form is CSP-clean and the one
  that shipped.) This requires the `/wasm/*` assets and `/crdt-worker.js` to
  be served with the app (deployment runbook dependency).
- **WebKit note (live-found, P7-M033):** WebAssembly compilation is
  script-src-gated in WebKit — the CSP must carry `'wasm-unsafe-eval'` or the
  worker's engine init rejects with a CompileError (observed live on
  production; fixed with the narrow directive).
- The WASM module is built with `-sENVIRONMENT=web,worker` — it deliberately
  does not run in Node except through the explicit-instantiation smoke test
  (`wasm/smoke.mjs`).
- WebSocket URLs are deployment configuration, not inferred from page
  protocol; production deployments must terminate TLS at the edge and
  configure `wss://` (Operations runbook).

## 6. How this matrix was verified

- Static API audit of all client source (grep-based, enumerated above).
- WASM binary feature scan: `wasm-dis` over the shipped
  `concord-crdt.wasm` (bulk-memory sites counted; SIMD/atomics/reference
  types confirmed absent; i64 usage confirmed present).
- Build-link flags reviewed in `wasm/CMakeLists.txt`.
- Interactive browser validation (Safari/Chrome/Firefox GUI runs) is owned by
  the release lead as milestone M036 — results to be appended here.
