# Concord — Roadmap

Status: Authoritative historical delivery plan; current implementation state
and release evidence are recorded in the final hardening report.
Version: 1.1
Last updated: 2026-09-13

Concord was organized and delivered through eight high-level phases. The
phase table preserves that historical plan; later-phase implementation work
is intentionally reflected in the current v1 state and final report.

**Detailed milestone definitions are authoritative only when supplied by the
corresponding phase master prompt.** This roadmap records each phase's
objective, deliverables, prerequisites, forbidden work, and completion gate —
not its milestones.

---

## Phase 0 — Bootstrap, modernization, original baseline, Liveblocks extraction

**Status: COMPLETE (2026-09-06).** Verified modernized baseline tagged
`phase-0-modernized-baseline`; Liveblocks fully removed; `phase-0-complete`
tag at the phase gate. See `docs/DECISIONS.md` DEC-016/017/018 for the
transitional architecture decisions.

- **Objective: Turn the aging tutorial repository into a clean, modern,
  verified working foundation — without starting Concord's distributed
  backend.
- **Major deliverables:** Repository and dependency audit; deliberate
  dependency modernization (stable React, supported Next, pinned Node via
  `.nvmrc`); local Convex + Clerk + Liveblocks configuration; verified
  original application behavior (auth, documents, editing, collaboration,
  presence, comments); modernized-baseline checkpoint; Liveblocks removal with
  a clean collaboration seam; transitional persistence if required; verified
  core document UI.
- **Prerequisites:** This governance bootstrap; `.env.local` secrets present.
- **Forbidden:** PostgreSQL migration; CRDT core; Rust gateway; NATS; Redis;
  production deployment.
- **Completion gate:** Clean build + app verification on the modernized
  baseline; Liveblocks fully absent with UI still functional on the seam;
  clean Git state; phase report + tag.

## Phase 1 — PostgreSQL control plane / Convex removal / authorization

**Status: COMPLETE (2026-09-06).** PostgreSQL 18 (Docker Compose) with
tracked Drizzle migrations; server-only data layer with Clerk→Concord
principal projection; server-side authorization (OWNER/EDITOR/COMMENTER/
VIEWER); optimistic-concurrency content persistence; audit events; Convex
fully removed after a verified data migration; unit/integration/adversarial
test suites green. See `docs/DATABASE.md`, `docs/AUTHORIZATION.md`,
`docs/MIGRATION_CONVEX_TO_POSTGRES.md`, and DEC-019…DEC-021.

- **Objective:** Remove Convex and establish Concord-owned durable
  foundations and authorization.
- **Major deliverables:** PostgreSQL via Docker Compose; schema + migrations;
  documents/users/organizations/memberships; document ACLs with
  OWNER/EDITOR/COMMENTER/VIEWER enforced server-side; repository/data layer;
  Clerk identity integration; audit events; Convex migration with CRUD/search
  parity; security tests.
- **Prerequisites:** Phase 0 gate.
- **Forbidden:** CRDT/WASM work; gateway work; multi-node anything.
- **Completion gate:** Convex fully absent; authorization tests green;
  migrations verified; app feature-parity on the new backend.

## Phase 2 — C++ CRDT core + WASM + local-first client

**Status: COMPLETE (2026-09-06).** C++20 sequence CRDT engine (native +
WASM, one semantic core, golden-vector parity), deterministic simulator
and seeded property suites, fuzz targets with a standalone driver,
ASan/UBSan/TSan clean, Web Worker runtime with IndexedDB durable op log
and reload restoration, TipTap reconciliation adapter over the
collaborative subset with honest fallback, multi-replica convergence and
offline-first flow proven in the worker-level harness. See DEC-023…DEC-026
and docs/TESTING.md / docs/BENCHMARKS.md for the full verification surface.

- **Objective:** Build the collaboration algorithm foundation.
- **Major deliverables:** C++20/23 library (CMake/Ninja); deterministic CRDT
  representation (replicas, operations, dedup, merge, clock/vector concepts);
  serialization + state hashing; native tests incl. property/randomized and
  sanitizer-clean builds; Emscripten/WASM build; TypeScript bindings; TipTap
  integration; IndexedDB persistence; Web Worker where justified; offline
  single-client correctness; deterministic tests.
- **Prerequisites:** Phase 1 gate.
- **Forbidden:** Multi-gateway complexity; server-side sync logic.
- **Completion gate:** WASM core passes convergence/determinism suites;
  browser client edits offline and persists locally; full builds green.

## Phase 3 — Rust realtime sync gateway + custom protocol + basic durability

**Status: COMPLETE (2026-09-07).** Rust/Tokio/Axum single-gateway with
wire protocol v1 (hybrid JSON control + binary op frames, cross-language
golden parity), Clerk RS256 verification (JWKS rotation), one canonical
authz policy with per-batch write recheck, durable `crdt_operations`
op-log with DB-enforced idempotency, bounded queues + slow-consumer
containment, heartbeats/idle reaping, graceful drain; browser sync layer
(transport/backoff/outbox/session); two-client E2E incl. offline
reconciliation, live downgrade, duplicate resends, kill-9 recovery;
adversarial security suite; honest benchmarks. See DEC-028/029,
docs/PROTOCOL.md §9, docs/SECURITY.md, docs/BENCHMARKS.md.

- **Objective:** Multiple browsers synchronize through a self-hosted backend.
- **Major deliverables:** Rust/Tokio service (Axum or justified equivalent);
  WebSocket protocol with framing; authentication + ACL authorization;
  connection lifecycle; bounded queues/backpressure foundations;
  heartbeat/reconnect; update deduplication; durable update persistence;
  multi-client + offline-reconnect synchronization; graceful shutdown;
  protocol tests.
- **Prerequisites:** Phase 2 gate.
- **Forbidden:** NATS/Redis; multi-node routing; production deployment.
- **Completion gate:** Multi-browser convergence through the gateway across
  restarts; protocol + concurrency tests green; no unbounded queues in
  critical paths.

## Phase 4 — Distributed multi-gateway architecture

**Status: COMPLETE (2026-09-07).** Three gateways behind a local nginx
round-robin LB (no sticky sessions); NATS JetStream cross-gateway events
(batch-granular, msg-id-deduped, post-commit publish, poison-terminated);
Redis ephemeral tier (TTL presence + distributed rate limiting with local
fallback; FLUSHALL-safe); broadcast+filter routing (DEC-034, no sharding);
crash isolation, reconnect storms, slow consumers, lag drain, broker
restart, and compound gateway+broker failure all E2E-proven; 1v2v3-gateway
scaling baselines measured honestly (zero loss; ack p50 16.1→18.4 ms);
distributed security audited (SA-SEC4: no high-severity findings). See
DEC-031..034, docs/OPERATIONS.md, docs/SECURITY.md §6.

- **Objective:** Move from one sync process to distributed service operation.
- **Major deliverables:** Multiple gateways; NATS JetStream; Redis for
  justified ephemeral state; cross-gateway collaboration; document routing /
  sharding (consistent hashing if justified); presence separation; load
  balancing; slow consumers; backpressure; rate limiting; retry/backoff with
  reconnect jitter; thundering-herd handling; load shedding; failure
  isolation; service health.
- **Prerequisites:** Phase 3 gate.
- **Forbidden:** Scalability claims without benchmarks.
- **Completion gate:** Cross-gateway convergence verified; chaos-grade
  interruption tests (broker, gateway loss) green with durable-update
  integrity.

## Phase 5 — Recovery, snapshots, compaction, history, performance workers — COMPLETE

- **Status:** COMPLETE (all 50 milestones; see docs/STORAGE.md,
  docs/RECOVERY.md, docs/HISTORY.md, docs/BENCHMARKS.md Phase 5 tables,
  and .agent private evidence per the completion gate).
- **Objective:** Build the serious persistence/recovery side.
- **Major deliverables:** Append-only update lifecycle; snapshot policy;
  recovery path; compaction; version history with revision reconstruction and
  restore; native C++ workers/worker pools where justified; checksums; storage
  consistency; concurrent maintenance jobs; large-document handling;
  profiling; recovery benchmarks.
- **Prerequisites:** Phase 4 gate.
- **Forbidden:** Public metric claims without reproducible evidence.
- **Completion gate:** Snapshot+tail recovery demonstrated and measured
  (recorded in the private ledger first); history/restore functional;
  benchmarks reproducible.

## Phase 6 — Verification, security, observability, chaos, CI/CD, benchmarking

- **Objective:** Prove the system rather than claim it works.
- **Major deliverables:** Deterministic distributed simulator (seeded,
  reproducible faults); randomized/property/convergence tests; fuzzing;
  ASan/UBSan/TSan; Rust fmt/clippy/test gates; protocol fuzzing;
  authorization/security tests (malformed frames, replay, rate limits);
  chaos scenarios (partitions, duplication, reordering, gateway crashes,
  dependency failures, PostgreSQL restart, NATS interruption, Redis loss);
  OpenTelemetry/Prometheus/Grafana observability; structured logs/tracing;
  CI (PR + nightly chaos/fuzz/bench + sanitizer matrices); performance
  regression gates; release artifacts; supply-chain scanning.
- **Prerequisites:** Phase 5 gate. **PASSED 2026-09-09**
  (`phase-6-complete`; evidence index: `docs/VERIFICATION.md`, full gate
  report in the private checkpoints).
- **Forbidden:** Feature growth; deployment. (Both held: no feature
  scope added; images built and smoke-tested locally only.)
- **Completion gate:** Hard evidence produced: simulator + chaos + security
  suites green; CI enforced; observability live; benchmark gates wired.
  **Met:** 181/181 correctness scenarios (0 lost durable-ACKed ops,
  0 divergent replicas within the defined fault model); 27/27 chaos;
  sanitizer matrix + 5M fuzz execs clean; threat model 32/32 rows mapped
  to controls with executable or explicitly planned-fuzz coverage recorded;
  secret scan clean (tree + full history); five
  phase-6 CI workflows + regression comparator; Prometheus/Grafana +
  OTel live; benchmark schema + baselines wired (98.6% recovery,
  +6.9 % ack-p95 at 4 gateways, 50.1 % compaction bytes, −91.4 % ack
  p50 profiling-driven optimization — all MEASURED, environments
  recorded).

## Phase 7 — Product polish, productionization, deployment, final metrics

The Phase 7 deployment topology and smoke path were exercised historically
and are preserved as reproducible runbooks. The AWS stack is intentionally
torn down in the current repository state, so a live deployment remains an
owner action rather than a current product claim.

- **Objective:** Turn the verified system into a polished deployable product.
- **Major deliverables:** UX polish, accessibility, responsive/browser
  compatibility; documentation; staging → production; production Docker
  images; cloud/platform + managed PostgreSQL decisions; secrets management;
  TLS; health checks; rolling/blue-green deployment; graceful WebSocket
  draining; backward-compatible migrations; rollback; smoke tests; production
  telemetry; deployment runbook; final benchmark reruns; final four headline
  metrics; final architecture diagrams; public README; attribution/licensing
  resolution; demo script; interviewer deep-dive material.
- **Prerequisites:** Phase 6 gate.
- **Forbidden:** Claiming unmeasured performance; skipping the licensing
  audit.
- **Completion gate:** Deployable, observable, documented product with
  reproducible final metrics and clean provenance; a live cloud deployment
  remains an owner-operated step.

---

## Cross-phase standing rules

- Verification tiers: Level A (targeted), Level B (milestone), Level C (phase
  gate — never skipped).
- Every phase ends with a completion report (milestones, tests, benchmarks,
  decisions changed, branch/tag, memory/state updates) before the next begins.
- Tags such as `phase-0-complete` are created only after their gates pass.
- The `antonio-original-baseline` tag is immutable (DEC-015).
- Deployment decisions stay out of Phases 0–6 (DEC-010).
