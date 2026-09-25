# HANDOFF: Feature implementation session — 2026-09-25

Purpose: a complete handoff so another AI (or a later session) can continue
the ten-feature implementation from exactly where this session stopped.

Repo: `/Users/utkarshkhajuria/Desktop/Concord Dev` (branch `main`, HEAD
`e35907f`, everything UNCOMMITTED). The uncommitted tree contains:
(1) the five review-tools features (history/restore, anchored comments,
briefing, drafts, concordpack), (2) three verified bug fixes from today
(worker CMD 9 FOLD_AFTER; per-item comment outbox keys; per-document
advisory ingest lock), (3) the Feature-1 start described below.

**Everything currently on disk is verified green**: tsc + eslint clean,
263 unit tests / 24 files, 74 db tests, wasm smoke, native ctest 3/3,
Rust lib 89 + all 30 integration/chaos suites serial, clippy 0,
browser E2E 14/14 twice. Do not start new work without re-running
`npm run typecheck && npm run test` first.

## Project architecture in one paragraph

Next.js 16 + Tiptap editor. CRDT engine is C++ compiled to WASM
(`wasm/dist/`, glue `src/lib/crdt/runtime.ts`, worker wrapper
`src/lib/crdt/worker/*`, RPC protocol `src/lib/crdt/worker/protocol.ts`).
A Web Worker owns the live document; editor ↔ worker bridge is
`src/lib/crdt/editor-bridge.ts`; TipTap doc ↔ CRDT stream mapping is
`src/lib/crdt/pm-model.ts` + `src/lib/comments/anchors.ts` (item IDs are
`"<replica>:<counter>"` strings). Sync: `src/lib/sync/sync-session.ts`
(transport `transport.ts`, durable outbox `pending-store.ts`), Rust
gateway `rust/sync-gateway/src/` (WS in `src/ws/`, durable log in
`src/db/repo.rs` — `crdt_operations` table, bigserial `id` = server seq;
native worker binary `build/native/worker/concord-worker`, protocol
commands 1-9 in `cpp/worker/main.cpp`; 8=VISIBLE_AFTER, 9=FOLD_AFTER).
Review-tools UI: `src/components/document-tools.tsx` (History/Comments/
Drafts/Concordpack tabs; `documentPreview()` renders visible JSON blocks).

## THE TEN FEATURES (approved scope)

Tier 1: (1) time-travel scrubber, (2) CRDT-anchored live cursors/presence,
(3) Jepsen-lite convergence checker. Tier 2: (4) suggestion mode,
(5) client-verifiable history proofs (Merkle + signed receipt), (6) perf
benchmark gate, (7) deterministic simulation harness. Tier 3: (8) PWA,
(9) markdown import/export, (10) CRDT-native lists (investigation).
Rationale and scope decisions: see the research summary in the session
log / memory (`concord-feature-claims.md`). Rule: never break working
features; verify after each feature.

## ✅ DONE: Feature 1 core — replay module + tests

- `src/lib/crdt/replay.ts` — `DocumentReplay` + `ReplayError`.
  `DocumentReplay.open(ops: Uint8Array[], factory)` → `at(index)` →
  `{json, digest}` after the first `index` ops; `length`; `close()`.
  Design: temporary engine on reserved replica 1n (same as gateway
  reconstruction); checkpoint SNAPSHOTS every `stride = max(8, ceil(√n))`
  ops so backward jumps rebase via `importFromSnapshot` + ≤stride
  re-applies; forward steps apply incrementally; bounded caches
  (64 rendered states). `applyRemote` returns `"applied" | "duplicate"`
  — tolerate "duplicate" defensively.
- `tests/crdt/replay.test.ts` — 3 tests, all passing: prefix
  reconstruction equals an independent fold (json AND digest), arbitrary
  jump patterns are stable, invalid indices/logs/use-after-close throw.
  GOTCHA (cost 30 min): the runtime does `await loadFactory()` — pass
  the loader FUNCTION (e.g. `getFactory`), never the awaited module.
  The test file has the correct cached-loader pattern (`getFactory`).
- Verified: typecheck + eslint clean, 3/3 replay tests, 263 total.

## ✅ DONE: Feature 1 UI — Replay tab

- `src/components/document-tools.tsx` — 5th `ReplayPanel` tab (icon
  `Rewind`). On open: `await flushEditorBridge()` → `client.exportOps()`
  → `DocumentReplay.open(ops, loadBrowserCrdtFactory)`; renders a
  `type="range"` slider (`aria-label="Replay position"`, describedby the
  live "State after N of M operations" label, `aria-valuetext`), the CRDT
  digest (mono, break-all, `aria-live="polite"`), Start/Latest buttons,
  and `documentPreview(JSON.parse(state.json))` in the existing read-only
  renderer. Keyed by `document.id` so a document switch remounts clean
  (no synchronous setState-in-effect — the react-hooks purity lint is
  strict). Folds are serialized through a coalescing runner (ref-based:
  latest-target-wins) because the replay engine is single-threaded and
  stateful; rapid drags never overlap folds.
- `src/lib/crdt/replay.ts` — hardened with a `closed` guard: `at()`
  rejects once closed, and a rebase that finishes AFTER `close()` frees
  the freshly-imported engine instead of resurrecting a closed replay
  (prevents a WASM engine leak on unmount-mid-jump).
- `tests/browser/review-tools.spec.ts` — extends the browser gate: opens
  Replay, asserts latest state shows the live text, Home scrubs to the
  empty prefix (text gone), End returns to latest.
- Verified: typecheck + eslint clean (also cleared a stale `_rank`
  unused-var warning in repositories/comments.ts), 263 unit tests,
  75 db tests, replay 3/3, browser review-tools 1/1 (49.7s incl. stack).

## ⏭️ NEXT: Feature 3 — Jepsen-lite convergence checker

## Feature 2 — anchored presence/live cursors (design)

- Rust: `rust/sync-gateway/src/ws/` — add ephemeral frame kinds
  `presence` (client→gw: {replicaId, user label, anchor:{itemId,side},
  ts}) and server→clients relay to other doc subscribers. NO DB writes;
  fan out via the existing NATS subject structure (see `src/bus/`);
  TTL ~30s server-side (drop silent peers), max payload ~512B,
  rate-limit per connection (reuse `ephemeral/ratelimit.rs` patterns).
- Client: decode in `src/lib/sync/transport.ts`; expose
  `onPresence(peers)`; `sync-session` passes through to a new
  `usePresenceStore` (zustand, pattern: `use-sync-status-store.ts`).
  Throttle local sends to ~10Hz from selectionchange; send own anchor
  via `resolvePointAnchor` (add a single-point variant beside
  `resolveAnchor` in `src/lib/comments/anchors.ts` — reuse
  `textItemPositions`).
- UI: `src/components/presence-overlay.tsx` — absolutely-positioned
  carets over the editor using resolved PM coordinates (per-anchor
  `resolveAnchors` gives from/to; caret = point); color = hash(replicaId)
  → palette; label chip; hide own replica. Render inside the editor
  container (position: relative).
- Tests: Rust `tests/presence_relay.rs` (ws_integration pattern: two
  connections, assert relay + TTL); unit tests for point-anchor
  resolution; browser: extend `tests/browser/journey.spec.ts` pattern —
  two contexts, assert each sees the other's presence marker.
- Risk containment: purely additive frame types; durable path untouched;
  bump any protocol version guard only if the WS handshake requires it
  (check `src/protocol/` frame decode — unknown frame types should be
  ignorable; verify fail-closed vs ignore behavior first).

## ✅ DONE: Feature 3 — Jepsen-lite convergence checker

`rust/sync-gateway/tests/convergence_invariants.rs` — seeded, deterministic,
dependency-free (inline splitmix64 PRNG). Skips when DB/worker absent. Two
`#[tokio::test(multi_thread)]` tests, ~1.1s total (budget <30s), serial:
- `durability_invariants_under_adversarial_schedules` (seeds 1/42/1337/90125):
  N=4 replicas, seeded batch schedule with CONCURRENT cross-replica ingests
  (`tokio::spawn`) + duplicate re-sends. Invariant A: a fresh full paged
  catch-up returns every acked op exactly once (no dup rows). Invariant B: a
  reader doing INCREMENTAL catch-up with a rolling cursor CONCURRENTLY with the
  ingests, then draining, still sees every acked op (rolling-cursor skip guard
  for the advisory-lock commit-ordering fix). Plus strictly-increasing seqs.
- `convergence_round_trips_through_the_durable_log` (seeds 3/21/4242): worker
  `generate_ops` → 60-op causal stream + ground-truth digest; ingest in causal
  order with random batching + concurrent duplicate retries; reconstruct
  straight from the DB catch-up → digest must equal the ground truth, and
  retries add no rows.
- KEY FINDING (verified with a throwaway probe, documented in the test): the
  native worker's batch `reconstruct` folds in the given order and is NOT
  reorder-independent (reverse/shuffle → different digest). The live
  `applyRemote` buffers pending ops; the batch reconstruct does not. So the
  honest convergence property is "the durable `id` order (kept gapless+causal
  by the advisory lock) round-trips to the canonical state", NOT "any fold
  order converges". The first draft asserted arbitrary-shuffle convergence and
  correctly FAILED — replaced with the causal round-trip above.
- Verified: `cargo fmt --check` clean, `cargo clippy --test
  convergence_invariants` clean, both tests pass (7 seeds).

## ✅ DONE: Feature 2 — CRDT-anchored live cursors/presence

Purely additive; the durable op path is untouched. All layers:

- **Rust protocol** (`src/protocol/control.rs`): `presence` (c→s:
  `{replicaId, anchorItem?, anchorSide, headItem?, headSide}` — CRDT
  `r:c` item ids, not offsets), `presence_update` (s→c relay with
  gateway-stamped `connectionId`/`userId`), `presence_leave` (s→c).
  `PresenceSide` is a bounded enum (keeps `Frame`'s `Eq` derive).
  Unit tests: roundtrip with/without optional items, unknown-field/side
  rejection.
- **Rust gateway** (`src/ws/mod.rs`): `handle_presence` — READY-only,
  authenticated+joined only, dropped (never an error) otherwise;
  per-connection rate limit via NEW `SCOPE_PRESENCE` (1200/min ≈ 20/s,
  client sends ~8 Hz) in `src/ephemeral/ratelimit.rs`; 64-byte hint caps.
  Identity stamped from the session — client claims never trusted.
  Disconnect broadcasts `presence_leave` BEFORE `registry.leave`.
- **Rust registry** (`src/sessions/mod.rs`): `relay_ephemeral` — skips
  sender, DROPS on full queue, never marks/closes slow peers (presence
  must not exert durable-path backpressure). Unit test proves the
  slow-peer contract.
- **Client protocol** (`src/lib/sync/protocol.ts`): mirrored
  payload validators (optional item fields), frame types.
- **Client transport** (`src/lib/sync/transport.ts`): `sendPresence`
  (READY-only, best-effort, never throws), `onPresenceUpdate`/
  `onPresenceLeave` events (optional — old tests unaffected).
- **Session** (`sync-session.ts`): `sendPresence` passthrough +
  `onPresenceUpdate/onPresenceLeave` options.
- **Store** (`src/lib/presence/use-presence-store.ts`): peers keyed by
  gateway connection id, 30s TTL sweep, `peerColor` (deterministic
  hsl from replica id). 3 unit tests.
- **Anchors** (`src/lib/comments/anchors.ts`): `anchorPoint` (collapsed
  caret → adjacent item+side; prefers item-END for forward typing),
  `resolvePointAnchors` (batch resolution, one stream traversal).
  4 unit tests incl. insert-glue + orphan honesty.
- **Broadcast hook** (`src/lib/presence/use-presence-cursors.ts`):
  trailing-throttled ~8 Hz selection publisher + 4s idle HEARTBEAT
  (late joiners learn existing carets; TTLs stay fresh when quiet),
  5s peer sweep. Gated on `bridgeMode === "crdt"`.
- **Overlay** (`src/components/presence-overlay.tsx`): resolves peer
  anchors against the live stream on doc change/peer arrival, renders
  carets + label chips + same-line selection bands (pointer-events-none,
  aria-hidden). Stream fetch is GATED on peerCount>0 — this was a live
  bug: as a child of the editor it ran before `client.init()` and knocked
  the bridge into fallback mode (caught by the E2E editor-readiness gate).
- **Wiring** (`use-sync-session.ts` returns `{syncNow, sendPresence}`,
  clears the presence store on teardown; `editor.tsx` mounts the overlay
  inside a `relative` wrapper around `EditorContent`).
- **E2E** (`tests/browser/journey.spec.ts` "I2"): two sessions, both type,
  nudge carets, each renders the peer's `[data-testid="presence-caret"]`.
  NOTE: anchors need a caret ADJACENT to a text item (Home alone = doc
  boundary = unanchored by design; the heartbeat is what makes a peer
  that joins later appear without more typing).
- Verified: fmt/clippy clean, lib 93, ws_integration 17/17 serial,
  270 unit tests, FULL browser E2E 15/15 (2.9m) incl. I2 + all prior gates.

## ✅ DONE: Feature 5 — client-verifiable history proofs

- **Rust core** (`src/maintenance/proofs.rs`, 6 unit tests): SHA-256
  Merkle over the retained log — `leaf = H(0x00 || seq(u64 BE) ||
  len_prefix(operation_id) || checksum_hex)`, `node = H(0x01 || l || r)`,
  duplicate-last for odd levels, empty root = 32 zero bytes. The
  length-prefix exists because a probe test PROVED the naive
  concatenation ambiguous (`("10:0","aa")` ≡ `("10:0a","a")`).
  `ProofSigner` (Ed25519 via new `ed25519-dalek` dep): process-global
  `ProofSigner::shared()` (OnceLock, same pattern as `Metrics::global`)
  seeded from env `GATEWAY_SIGNING_KEY` (64 hex chars) or an EPHEMERAL
  per-process key with a startup warning. Canonical receipt message =
  `version(1) || document(16) || seq(8 BE) || root(32) ||
  stateDigest(u16-len) || opCount(8) || issuedAtMs(8) || keyId(u8-len)`.
- **Endpoint** (`src/http/mod.rs`): GET
  `/api/v1/documents/{id}/proof?seq=N` (default = durable cursor; `seq`
  is the ABSOLUTE server bigserial id — same space as the catch-up
  cursor, so a boundary before the doc's first op is a legitimate
  empty-state proof). View-or-better (outsider 404), history rate
  budget, pruned = `seq < compaction_floor_seq` → 409. Response: leaf +
  audit path (last retained leaf) + root + `stateDigest` (worker
  reconstruct at N) + Ed25519 receipt + `publicKey` + `keyEphemeral`.
- **Next proxy** (`src/server/gateway-history-proxy.ts` +
  `src/app/api/gateway/documents/[documentId]/proof/route.ts`): same
  hardening surface (UUID, bearer-only, no-store, redirect:error).
- **Client verify** (`src/lib/crdt/proofs.ts` + 4 tests): byte-exact TS
  mirror — merkle replay (WebCrypto SHA-256), canonical receipt bytes
  (BigInt u64s), Ed25519 verify (WebCrypto Ed25519), state binding =
  receipt `stateDigest` === the replica's OWN digest. Trust model
  honestly surfaced in the UI: same-response key detects gateway-side
  tampering; third-party verifiability needs the key out of band or a
  pinned keyId; `keyEphemeral` is labeled.
- **UI**: "Verify server receipt" in the Concordpack tab (flushes the
  bridge, takes the replica digest, fetches the proof, renders
  merkle/signature/state results).
- **E2E**: review-tools spec now clicks it and asserts
  "Server receipt verified" + "matches this replica: yes" against the
  real gateway (release binary rebuilt with the endpoint).
- Verified: lib proofs 6/6, `proofs_api.rs` 2/2 (end-to-end verify +
  tampered sig/leaf rejection + authz matrix + boundary rules),
  fmt/clippy clean, 4 client tests, review-tools E2E 1/1 (45.9s; one
  earlier run hit a known-flaky history-preview step, clean on rerun).

## ✅ DONE: Feature 6 — 100k-op WASM benchmark + perf gate

- `scripts/bench/big-doc-bench.mjs`: drives the browser-served WASM
  (`public/wasm/*`) through the exact runtime ABI (same driver pattern as
  browser-profile.mjs). Builds a 100k-op doc (40 paragraphs × ~2.5k chars),
  then measures across runs: fold-from-scratch (applyRemote all ops),
  exportSnapshot, importFromSnapshot, digest — p50/p95/min/max + derived
  throughput. Correctness gates inside every run: fold digests identical
  across runs/replicas; imported-snapshot digest == fold digest.
  `--ops/--runs/--write-baseline` (baseline →
  `.agent/bench/baselines/big-doc-baseline.json`).
- Baseline (2026-09-25, M-series, Node-instrumented): fold 100k = 38.5ms
  p50 (2.6M ops/s), export 140ms, import 36.7ms, digest 299ms, snapshot
  7.36 MB.
- `tests/perf/big-doc-gate.test.ts`: vitest unit-project gate, SKIPPED
  unless `CONCORD_PERF_GATE=1` (timing bounds flake on loaded CI runners).
  Loose asymptotic bounds — fold < 30s (~750× headroom), snapshot import
  < 5s (~100× headroom) — so only a genuine big-O regression trips it;
  precise trending stays with the bench script + baseline compare.
  Verified: skips by default (1 skipped), passes enforced
  (fold 35.9ms / import 35.5ms).

## ✅ DONE: Feature 9 — markdown export/import

- `src/lib/markdown.ts` (7 tests): Concord-flavored markdown over the
  collaborative subset — paragraphs, headings 1–6, bold `**x**`, italic
  `*x*`, strikethrough `~~x~~`, underline `<u>x</u>`, backslash escapes.
  HONEST scope notes: inline code is NOT in the CRDT mark registry
  (pm-model SUPPORTED_MARKS), so backticks stay literal (escaped on
  export, never parsed) instead of silently dropping styling; align/
  lineHeight have no markdown equivalent → dropped + COUNTED in the
  result; non-collaborative nodes flagged via `lossless: false`.
  Export applies CommonMark flanking (edge whitespace moves OUTSIDE
  delimiters — `**bold and** *italic*`, not the ambiguous
  `**bold and ***italic*`); import is a small recursive-descent inline
  parser (<u> → ** → * → ~~; unknown constructs stay literal text,
  never dropped); one line = one block; CRLF normalized. Round-trip
  guarantee: export∘import is a stable fixed point (byte-identical
  re-export), exact deep-equal without edge-whitespace runs.
- UI: 6th "Markdown" tab in document-tools.tsx — Export markdown
  (downloads .md after flushEditorBridge; reports dropped
  attributes/lossy nodes in the status line), Import as new edits
  (textarea → importMarkdown → editor.commands.setContent emitUpdate —
  normal CRDT edits through the bridge, prior history preserved),
  subset note with the "never silently dropped" honesty rule.
- E2E: review-tools spec exports + re-imports and asserts the document
  content survives as CRDT edits. Verified: 7 unit tests, typecheck/
  lint clean, review-tools E2E 1/1 (59.7s).
- Also fixed lint in the bench script (no-assign-module-variable,
  unused sourceDigest → now canonical-digest assert).

## ✅ DONE: Feature 8 — PWA (installable, offline shell)

- `public/manifest.webmanifest`: name/start_url/scope/display=standalone,
  theme #174b65, icons 192/512 (`any`) + 512 `maskable`.
- `public/icon-{192,512}.png` generated from `src/app/icon.svg` via
  `scripts/pwa/generate-icons.mjs` (rsvg-convert; exits 0 with a notice
  when absent). PNG magic bytes pinned by test.
- `public/sw.js` — cache policy chosen for local-first CORRECTNESS:
  - `/_next/static/*` + icons: cache-first (immutable content-hashed).
  - `/crdt-worker.js` + `/wasm/*`: NETWORK-FIRST with cache fallback —
    keeps the P7-M032 staleness contract (the client fetches the worker
    with cache:'reload'; a cache-first SW would re-pin stale engine code
    across deploys). Offline fallback keeps the editor working.
  - `/api/*`: NEVER cached (auth/session honesty).
  - navigations: network-first + same-URL cache fallback, opportunistic
    fill, LRU-capped at 30 entries — a previously-visited document opens
    offline (cached shell + engine + IndexedDB).
  - cross-origin (gateway/Clerk) never intercepted; GET-only.
- `src/components/pwa-registration.tsx`: registration HARD-GATED on
  `process.env.NODE_ENV === "production"` (dev caching breaks HMR),
  after window load, failures silent. Mounted in the root layout;
  `metadata.manifest` + `viewport.themeColor` set.
- Verified: 5 contract tests (`tests/pwa.test.ts`: manifest fields, PNG
  magic bytes, SW never-caches-API, engine network-first, same-origin/
  navigate caps, prod-only registration); `npm run build` clean; prod
  server check — manifest served as `application/manifest+json`, linked
  in HTML, sw.js + icons 200, registration module compiled into prod
  chunks WITH the gate. Dev mode (browser E2E) unaffected — no SW.

## ✅ DONE: Feature 4 — suggestion mode v1 (anchor sidecar)

NO op-format change — the CRDT binary format is untouched; suggestions are
a server-side sidecar exactly like comments (~90% mirrored machinery):

- **Schema** (`drizzle/0002_add_document_suggestions.sql` + schema.ts):
  `document_suggestions` (id PK, document FK cascade, author FK, CRDT
  anchor start/end item+side, quotedText ≤1000, proposedText ≤4000,
  status enum proposed/accepted/rejected/discharged, resolvedAt/resolvedBy)
  + checks mirroring comments. Generated via `drizzle-kit generate`;
  migrated on dev + test DBs.
- **Service** (`src/server/services/suggestions.ts`): comment-pattern
  idempotency (global suggestion IDs; same-bytes retry → duplicate:true;
  cross-document ID reuse → 409 BEFORE authz), propose = COMMENTER+,
  accept = EDITOR+ (it authorizes a document mutation), reject/discharge =
  EDITOR+ or the author. Discharge = the honest terminal state (anchor
  orphaned by later edits; accept-after-reject etc. → 409). Audited via
  new `document.suggestion.*` actions (resourceType union extended).
- **Routes**: GET/POST `/api/documents/[id]/suggestions` + POST
  `.../[suggestionId]` (+ response.ts error mapping).
- **UI** (`src/components/suggestions-panel.tsx` + 7th tab): propose from
  the current selection (replacement; empty proposed text = deletion;
  v1 note: bare-caret insertions are later work), per-suggestion anchor
  resolution with honest status ("Target text changed or was deleted"),
  Accept & apply = authorize+mark FIRST, then apply through the editor
  bridge as normal CRDT edits (host-owned `applyReplacement`:
  delete/insert/replace via TipTap range ops); if the anchor orphaned →
  auto-DISCHARGE instead of mis-applying; if application throws after
  marking → discharge too (the record never claims success it didn't
  achieve).
- **Tests**: 4 db tests (roles matrix, author-withdraw, idempotent
  retries + conflicting terminals + cross-doc ID reuse, discharge
  lifecycle) against live Postgres; browser E2E step: select all →
  propose → Accept & apply → document text actually replaced.
- Verified: tsc/lint clean, db 4/4, review-tools E2E 1/1 (55.4s).

## ✅ DONE: Feature 7 — deterministic simulation harness

`tests/sync/deterministic-sim.test.ts` — DEVIATION FROM THE PLAN (an
improvement): NO `transportFactory` refactor was needed. The existing test
seam (`vi.stubGlobal("WebSocket", ...)` — the same pattern
worker-engine-port.test.ts already uses) injects a scripted gateway socket
without touching production code, so SyncSession stays untouched.

- Harness: seeded splitmix64 PRNG → 3 schedules × 2 seeds (happy,
  drop-every-3rd + reconnects, reconnect-heavy) driving the REAL
  SyncSession over the REAL CrdtWorkerCore (the product WASM engine) against
  a ModelGateway implementing the durable-log rules (sequential seq,
  idempotent identity ingest) and folding every acked op through its own
  engine replica. The scripted socket speaks the real protocol
  (hello/auth/join/streamed catch-up pages + sync_done — NOTE: the real
  gateway streams ALL pages unprompted; the client never re-requests;
  durable_acks with committed identities; pre-ingest batch drops).
- Invariants per run: (A) no acked op lost — every client-sent identity in
  the model exactly once; (B) persisted cursor monotone; (C) local replica
  digest == model digest (CRDT convergence over any arrival order); (D)
  outbox fully drained.
- VERIFIED TO BITE: a temporary mutation (model silently loses one op of a
  multi-op batch) makes the suite FAIL in 0.6s; clean run passes in ~7.3s.
  Mutation scaffolding removed after the check.
- Honest scope: action schedules are seeded; settlement uses real timers +
  vi.waitFor — interleaving may vary, but the invariants are
  schedule-insensitive so any failure is a genuine bug.

## ✅ DONE: Feature 10 — CRDT-native lists (investigation + design ONLY)

`docs/DESIGN_CRDT_NATIVE_LISTS.md`. Key finding: delimiters ALREADY carry
their block type as a validated initial attr (`doc.cpp:79` →
`AllowedAttrs` registry: paragraph/heading-1..6 only, fail-closed) — lists
need NO wire/protocol change: extend the registry with `list-item` +
`list`/`depth`/`checked` LWW block attrs, flatten TipTap's nested lists in
pm-model (deterministic unflatten), widen anchors, and solve the
mixed-replica compat cliff (recommend accept-unknown-block-type, digest-
stability-tested). Estimated 3–4 focused days; NOT started by design.

## Full verification (final, 2026-09-26, after all ten features)

- `npm run typecheck` clean · `npm run lint` clean (0 errors, 0 warnings)
- `npm run test` — 287 passed + 1 skipped (perf gate; `CONCORD_PERF_GATE=1`
  runs it: fold 100k 35.9ms / import 35.5ms) / 28 files
- `npm run test:db` — 79 passed (incl. 4 new suggestion tests)
- `npm run build` — clean (verified during Feature 8 with a prod-server
  smoke of manifest/sw/icons)
- Rust: `cargo fmt --check` clean · clippy `--all-targets` 0 warnings ·
  lib 99 passed · ws_integration 17/17 + proofs_api 2/2 +
  convergence_invariants 2/2 (all serial, live Postgres + native worker)
- Browser E2E `npm run test:browser` — **15/15 passed (3.3m)** including
  the new I2 presence-cursor relay and the extended review-tools spec
  (Replay scrub + server-receipt verify + markdown round trip + suggestion
  accept-and-apply), twice-stable across the day's runs.
- Release gateway rebuilt with presence + proof endpoints before E2E.

Nothing is committed (HEAD e35907f) — the whole changeset awaits review.

## Feature 5 — history proofs (design)

Rust: per-document Merkle tree over `(seq, operation_id,
payload_checksum)` leaves, rebuilt/maintained on ingest or computed
on demand (on-demand over the log ≤ N is fine for v1). New GET
`/api/v1/documents/{id}/revisions/proof?seq=N` (route in
`src/http/mod.rs`, handler in `src/maintenance/history.rs` — follow the
existing revision routes + rate limiting): returns `{leaf, proof[],
root, seq}` + an Ed25519-signed receipt `{root, seq, documentId,
signed_at}` using a gateway signing key (env `GATEWAY_SIGNING_KEY`,
dev fallback: generate+persist to the DB `gateway_settings` or file;
document the trust model honestly — key rotation is out of scope v1).
Client: `src/lib/crdt/proofs.ts` (SHA-256 via WebCrypto, verify path +
signature), wire a "Verify against server receipt" action into the
Concordpack tab. Tests: Rust proof endpoint (valid/tampered/wrong-seq);
client verify unit test with a fixture receipt.

## Feature 6 — perf benchmark gate (design)

`scripts/bench/big-doc-bench.mjs` (Node, loads wasm/dist directly —
same loader pattern as `tests/crdt/replay.test.ts` `getFactory`):
build a 100k-op doc by generating ops with one engine, then measure:
fold-from-scratch (reconstruct), applyRemote throughput (ops/s),
exportSnapshot, importFromSnapshot, digest; report p50/p95 of repeated
runs (JSON to stdout + `--write-baseline`). Gate: `tests/perf/
big-doc-gate.test.ts` (vitest, unit project, gated by env
`CONCORD_PERF_GATE=1` so normal CI isn't flaky): assert fold 100k ops
< 30s and snapshot import < 5s (loose bounds; the point is trend
detection, add baseline-compare later via `--write-baseline`).

## Feature 9 — markdown (design)

`src/lib/markdown.ts`: export — walk TipTap doc (doc→blocks→runs;
mirror `documentPreview` block shapes); paragraphs/headings (#..######)
/bold/italic/inline code; unsupported blocks → HTML-ish comment or
skipped (document choice). Import — parse the same subset; if the doc
would contain unsupported constructs, hand the whole doc to the
existing fallback path instead. Apply imports through the live editor
bridge as normal CRDT edits (never a side channel). Tests: round-trip
+ edge cases (empty, nested marks, hard breaks).

## Feature 8 — PWA (design)

`public/manifest.webmanifest` (name/icons — generate 192/512 PNGs from
the existing logo SVG via a script, don't commit binaries blindly),
`public/sw.js`: cache-first for `/_next/static/*` + same-origin icons,
network-first for pages with offline fallback to a cached shell;
register in the root layout ONLY when `process.env.NODE_ENV ===
"production"` (dev caching breaks HMR — hard gate). Keep the CRDT
worker/network paths untouched. Verify: `npm run build && npm start`,
Lighthouse/installability manual check; add a smoke spec that the
manifest is served.

## Feature 4 — suggestion mode v1 (design; deliberately NOT op-format tags)

Do NOT extend the binary op format (deep C++/Rust change, risks the
working core). V1 = sidecar anchored suggestions: a suggestion = {id,
author, anchor range (CRDT item IDs — reuse comments anchoring),
proposed text, status proposed/accepted/rejected/discharged}. Store
server-side like comments (mirror `src/server/services/comments.ts`
routes/tables/audit/roles: authors EDITOR+, resolve OWNER/EDITOR) or
local-only first. UI: "Suggest edit" from a selection → panel chip;
Accept = apply via editor bridge (normal durable edits) + mark accepted;
Reject = mark rejected; if the anchor orphans (target deleted), mark
discharged (same honesty rules as comments). This reuses ~90% comments
machinery. Future deep version (documented, not built): ops tagged with
suggestion IDs in the CRDT format for true op-level accept/reject.

## Feature 7 — deterministic simulation (scoped design)

Refactor: `SyncSession` constructs its own `SyncTransport` — add an
optional `transportFactory` option (default = current behavior; purely
additive). Simulator (`tests/sync/deterministic-sim.test.ts`): seeded
PRNG drives a scripted transport (join/catch-up/acks/peer-ops/drops/
reorders) + a model gateway (durable log with today's ordering rules) +
the real `worker-engine-port` + real `PendingOpStore` (fake IndexedDB —
check `src/lib/sync/pending-store.ts` for its storage seam or use
fake-indexeddb if already available). Invariants: no acked op lost,
cursor monotone, local replica converges to the model digest, briefing
counts match. Start with 3 schedules (happy, drop-every-3rd, reorder+
duplicates); grow later. This is the stretch item — do it last.

## Feature 10 — CRDT lists (investigation only)

Check whether `localInsertDelimiter(index, blockType)` already
represents list blocks in the C++ core (doc.hpp/delim attrs) and what
falls back today (`collaborative-mode-indicator.tsx` says lists are
fallback content). If delims carry blockType, the work is bridge
allowlist + anchors block-type acceptance + tests; if not, write the
design (attrs model, PM node mapping) in docs/ and stop. Do NOT start
the C++ work without a fresh go-ahead.

## Environment gotchas (learned the hard way today)

- ZCode harness reaps long-running background bash tasks (SIGTERM,
  exit 143) — even setsid'd ones eventually die. Run heavy suites in
  foreground chunks; for a long-lived server spawn detached
  (`python3 -c "import os; os.setsid(); os.execv(...)"`) and expect a
  finite lifetime.
- Playwright browser E2E: `npm run test:browser` spawns its own stack
  (Next :3111, gateway random port, `concord_e2e` DB, 13 Clerk E2E
  users) and takes a run lock at `node_modules/.concord-e2e.lock`.
  Stale lock with dead pid → delete it. Sign-in uses Clerk Backend API
  sign-in tickets (`CLERK_SECRET_KEY` in `.env.local`) consumed via
  `window.Clerk.client.signIn.create({strategy:"ticket"})` — see
  `tests/browser/helpers.ts` and `scripts/browser-e2e-setup.mjs`.
- Rust suites: EVERY integration/chaos suite runs `--test-threads=1`
  (CI convention). Env: `GATEWAY_DATABASE_URL=postgres://concord:
  concord_local_dev@127.0.0.1:5433/concord_test` (migrate via
  `node scripts/db/migrate.mjs "$GATEWAY_DATABASE_URL"`),
  `GATEWAY_CLERK_ISSUER=https://fun-blowfish-5798.clerk.accounts.dev`.
- Freshly relinked native binaries can flake on first execs (macOS
  Gatekeeper/XProtect) — rerun before diagnosing.
- Docker port 3000 = Grafana (not Next). Compose: db :5433, redis,
  nats, prometheus.
- WASM in tests: load from `wasm/dist/` and pass the loader FUNCTION
  (see replay.test.ts `getFactory`) — the runtime awaits it.
- A parallel "Opus" agent session has edited this repo before
  (memory: `concord-feature-claims.md` has file-ownership claims).
  Check `git status` + recent mtimes before editing; leave a claims
  note there.

## Verification commands (run after each feature)

```
npm run typecheck && npm run lint && npm run test          # web
npm run test:db                                            # needs docker db
(cd rust && cargo fmt --all --check && cargo clippy --all-targets)
(cd rust && GATEWAY_DATABASE_URL=... GATEWAY_CLERK_ISSUER=... cargo test --release --lib)
# then each --test suite serially; full matrix in docs/HISTORY.md
npm run wasm:smoke && (cd build/native && ctest)           # native
npm run test:browser                                       # full E2E stack
```

Progress tracker: ALL TEN FEATURES ✅ (F1–F10; F10 = design only).
Final verification matrix: see the section above / session log.
Update this file + memory as features land.
