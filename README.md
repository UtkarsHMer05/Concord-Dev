# Concord

Concord is a local-first collaborative document workspace with a
self-engineered synchronization stack: a C++20 sequence CRDT compiled to
WebAssembly for the browser, Rust WebSocket gateways for fanout and
authorization, PostgreSQL as the durable source of truth, NATS JetStream
for inter-gateway transport, and Redis for ephemeral state. No
collaboration SaaS is involved — the sync stack, from the merge
semantics to the wire protocol to the gateways, is built and tested in
this repository.

**Live demo:**
[http://concord-production-lb-1774514437.ap-south-1.elb.amazonaws.com](http://concord-production-lb-1774514437.ap-south-1.elb.amazonaws.com)
— deployed on AWS from this repository. No custom domain is owned yet,
so the demo serves plain HTTP/WSC; the TLS posture and the exact
domain-based upgrade path are documented in
[`docs/SECURITY.md`](docs/SECURITY.md) §10.1.

## What is technically difficult about it

- **The same CRDT must merge identically everywhere.** One C++20 core
  (YATA-style origin anchoring, tombstones, last-writer-wins attribute
  registers) is compiled both to native (the server-side worker) and to
  WASM (the browser), and every correctness suite asserts native and
  WASM digests are byte-identical. Replicas converge under arbitrary
  reordering, duplication, and partition — verified by a 130-seed
  randomized campaign (1.06 M operations, 0 divergent replicas) and a
  27-scenario chaos matrix (gateway/NATS/Redis/Postgres/worker faults,
  including compound scenarios; 0 lost durable-ACKed operations within
  the documented fault model).
- **Durability is a contract, not a hope.** An operation is acknowledged
  only after its PostgreSQL commit; delivery is at-least-once +
  idempotent (operation identity is the canonical bytes; a unique index
  is the dedup boundary). A client crash mid-batch, a gateway SIGKILL
  after commit-before-ACK, a NATS redelivery storm — all are tested
  scenarios, and none lose an acknowledged operation.
  [`docs/FAILURE_MODEL.md`](docs/FAILURE_MODEL.md) states exactly what is
  and is not claimed (no exactly-once, no unqualified zero-loss).
- **Local-first is real.** The browser edits into a local replica
  (IndexedDB op-log + snapshots inside a Web Worker) and syncs when a
  gateway is reachable. Offline edits queue durably and re-send with
  stable identities on reconnect; a stale client past a compaction
  floor resyncs from a checksum-verified snapshot before trusting it.

## What runs where, and why

| Layer | Language | Why |
|---|---|---|
| CRDT core, snapshots, hashing, verification worker | C++20 (native + Emscripten → WASM) | deterministic merge semantics in one codebase, compiled twice; the server worker reuses the same engine for snapshot/recovery verification |
| Browser runtime: TipTap ⇄ CRDT bridge, Web Worker, IndexedDB, sync session | TypeScript | product UI + the client half of the wire protocol |
| Sync gateways: WebSocket transport, authN/authZ, bounded queues, backpressure, graceful drain | Rust (tokio) | long-lived connections, strict frame budgets, measured SIGTERM draining |
| Durable truth: accepted operations, ACLs, snapshots, history, audit | PostgreSQL 18 | the only durable store; WAL commit precedes every ACK |
| Inter-gateway fanout | NATS JetStream | event transport with msg-id dedup; explicitly **not** the ordering authority, **not** durable truth |
| Presence, rate limits, caches | Redis | ephemeral only; safe to FLUSHALL by design |

Removed deliberately: Convex and Liveblocks (Phases 0–1) — zero runtime
references; smoke tests assert their old endpoints 404.

## How a write becomes durable

1. A keystroke diffs against the replica's canonical state and emits
   CRDT operations (identity `replica:counter`; bytes stable across
   retries).
2. The client sends a binary batch over the WebSocket; the gateway
   re-checks authorization per batch, decodes under strict size/count
   budgets, and ingests in one multi-row
   `INSERT … ON CONFLICT DO NOTHING` inside a transaction.
3. The durable ACK is emitted only after commit; the client's outbox
   marks the ops `durably_acked`. On any failure the ops stay pending
   and re-send under the same identities — the server dedups.
4. Post-commit, the gateway publishes to NATS; other gateways fan out to
   their sessions; every replica applies idempotently.

## Snapshots, recovery, compaction

History is the operation log; snapshots compress it. Recovery can replay
100 k operations (65.2 s p50) or import a snapshot at the 99 % boundary
plus the 1 k tail (0.964 s p50) — **98.4 %** faster, digest verified on
every run, reproduced four times (98.6 / 98.5 / 98.6 / 98.4 across the
Phase-6 and final-release campaigns). Safe compaction prunes operations
covered by a snapshot boundary (staged, crash-safe, integrity-checked,
revision boundaries preserved): after full compaction of a 50 k-op
document, **50.1 %** of durable bytes remain.

## Benchmarks (measured)

Environment, run counts, denominators, and reproduction commands for
every number: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

| Claim | Measured |
|---|---|
| Durable-ACK ingest, 25-op batch | p50 31.45 → **2.72 ms** (−91.4 %) after replacing per-op INSERT round trips with one multi-row `unnest` INSERT; ingest 771 → **8 685 ops/s** (11.3×, final-release rerun) — profiler-driven, replay digests identical |
| Multi-gateway scale-out (1→4 gateways, 200 ops/s open-loop) | final release: ack p95 13.19 → 15.23 ms, zero loss, 0.000 % errors — gateway addition costs ~2 ms |
| Snapshot+tail recovery | **98.4 %** faster than full replay (65.2 → 0.96 s p50 final-release rerun; 100 k history / 1 k tail; 5 runs; 4th consecutive reproduction) |
| Correctness campaigns | **181/181 scenarios**, 0 divergent replicas, 0 lost durable-ACKed ops; 5 M fuzz executions, 0 crashes |
| Browser WASM path | typing 0.003 ms/op; 5 k-op fanout batch 227 ms; bundle 180 KB |

## Reliability evidence

- Chaos: gateway SIGKILL/rolling restart, NATS pause/restart/
  redelivery/lag/storage-loss, Redis loss, Postgres outage, worker
  faults, compound scenarios — 27/27 green with 0 acknowledged-op loss.
- Graceful drain: SIGTERM → stop accepting sessions → finish in-flight
  durable writes → close; measured ~2.2–3 s. A production rolling
  gateway restart was verified live with both client sessions intact.
- Sanitizers: ASan+UBSan and TSan green across the native matrix; every
  fixed fuzz crash is pinned by a corpus regression.

## Security

Server-side authorization is deny-by-default with roles
(OWNER / EDITOR / COMMENTER / VIEWER), re-checked on every batch and
document read; read denial is masked as not-found. A 32-row threat model
maps every threat to a test ([`docs/SECURITY.md`](docs/SECURITY.md)).
Clerk handles identity only — all authorization is enforced against
Concord-owned data. The public surface runs a pinned CSP (including
`wasm-unsafe-eval` — WebAssembly compilation is script-src-gated in
WebKit; its omission was caught live on production silently disabling
the WASM engine), hardened headers, rate limits, and strict
frame/size budgets. Audits, revocations, and permission changes are
recorded in an append-only audit table.

## Quick start

```bash
nvm use 24                 # Node 24 (.nvmrc pins 24.20.0)
npm ci
docker compose up -d db    # PostgreSQL 18 on localhost:5433
cp .env.example .env.local # then fill Clerk keys + DATABASE_URL
npm run db:migrate
npm run dev                # http://localhost:3000
```

The editor and the local-first CRDT runtime work out of the box (Web
Worker + IndexedDB). Realtime sync additionally runs the Rust gateway —
see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Tests

```bash
npm run typecheck && npm run lint && npm test   # web suites
npm run test:realtime                          # real gateways over real WS
./scripts/verify-native.sh Release              # C++ core 64 + worker 51
./scripts/verify-wasm.sh                       # WASM parity 26 + smoke
cd rust/sync-gateway && cargo test -- --test-threads=1   # 236 tests
```

Integration tests run against the isolated `concord_test` database and
replay all migrations from an empty schema on every run
(`npm run test:db`; `npm run db:test:prepare` recreates it).

### Benchmark reproduction

Every headline number above carries its exact command, environment
snapshot, and per-run artifacts — recorded in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

### Deploy

[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): one compose stack per
environment on AWS EC2 (Graviton) behind an ALB; ECR immutable images;
SSM secret injection; staging-first migrations. This exact path
deployed the live demo above.

## Repository layout

```
cpp/      C++20 CRDT core, native worker, tests, fuzz, campaign
rust/     Rust sync gateway: auth, ingest, fanout, drain, chaos tests
src/      Next.js app, CRDT client runtime, sync session
wasm/     Emscripten build + smoke tests
scripts/  verify / benchmark / deploy tooling
tests/    web, realtime, and database test suites
docs/     architecture, protocol, consistency, security, benchmarks, …
```

Key docs: [ARCHITECTURE](docs/ARCHITECTURE.md) ·
[CONSISTENCY_MODEL](docs/CONSISTENCY_MODEL.md) ·
[PROTOCOL](docs/PROTOCOL.md) · [STORAGE](docs/STORAGE.md) ·
[RECOVERY](docs/RECOVERY.md) · [FAILURE_MODEL](docs/FAILURE_MODEL.md) ·
[SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md) ·
[BENCHMARKS](docs/BENCHMARKS.md) ·
[VERIFICATION](docs/VERIFICATION.md) ·
[DECISIONS](docs/DECISIONS.md)

## Known limitations (v1, stated honestly)

- **No TLS on the demo URL** — no domain is owned. The scripted upgrade
  path (ACM certificate, HTTPS/WSS listeners, Clerk production instance)
  is documented and ready; see `docs/SECURITY.md` §10.1.
- **Single-node data services** per environment (no HA/multi-AZ):
  gateway count scales horizontally; the data tier does not (yet).
- **Collaborative subset**: text, headings, basic formatting. Content
  outside the subset (tables, images, colors, …) degrades that session
  to whole-document save — surfaced loudly in the UI, never silent.
- **History UI and presence** are outside the frozen v1 boundary; the
  revision/restore machinery exists and is tested at the protocol layer.
- **Embedded-WebView browsers** can need the next event or a reload to
  converge the live fanout view visually (the data path is verified
  sound; standard-browser suites pass; a render watchdog bounds the
  path).

## Provenance and attribution

This project originated from the Code With Antonio "Google Docs Clone"
tutorial (Next.js/React/Clerk/Convex/Liveblocks) and was deliberately
rebuilt into an original engineering project: only the tutorial's
product shell survives as a derivative — the synchronization stack,
wire protocol, CRDT, gateways, and data layer are original to this
repository. The pristine tutorial baseline is preserved at the git tag
`antonio-original-baseline`; attribution is retained, and upstream
licensing remains under review before any public release
(see [`docs/DECISIONS.md`](docs/DECISIONS.md)).

## License

Not yet licensed for redistribution; licensing is resolved before
public release (see Provenance above).
