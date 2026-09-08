# Concord — Architectural Decision Log

Status: Authoritative
Version: 1.0 (bootstrap)
Last updated: 2026-09-07 (Phase 5: DEC-035..041)

Rules:

- Every material architectural decision is recorded here with its ID.
- An accepted decision is never silently reversed. Superseding requires: mark
  the old decision `Superseded`, add the replacement, and state the evidence.
- Decision format: ID, Status, Decision, Context, Alternatives, Rationale,
  Consequences, Evidence, Revisit conditions.

---

## DEC-001 — TypeScript/Next.js remains the product/frontend layer

- **Status:** Accepted
- **Decision:** The product and client layer remains TypeScript on Next.js,
  React, TipTap, and the existing Radix/shadcn component kit.
- **Context:** The bootstrap repository is a Next.js App Router application
  with a complete editor UX. Rebuilding the UI in another stack would discard
  a working product shell without strengthening the systems thesis.
- **Alternatives:** Rewriting the frontend in another language/framework;
  adopting a thinner JS shell with native clients.
- **Rationale:** The project thesis is the synchronization stack, not the UI
  framework. TypeScript/React is the right tool for browser product code
  (IndexedDB, Web Workers, WebSocket client, WASM interop).
- **Consequences:** Frontend modernization debt (React RC, Next 15, Tailwind 3)
  must be paid down in Phase 0 before new architecture work.
- **Evidence:** Repository baseline inspection (2026-09-05).
- **Revisit conditions:** If browser-side WASM interop proves inadequate for
  latency budgets, revisit the client runtime boundary — not the product stack.

## DEC-002 — Liveblocks is temporary bootstrap infrastructure

- **Status:** Accepted
- **Decision:** Liveblocks remains only until the modernized original baseline
  is verified; it is then fully removed and replaced by Concord's own
  collaboration stack (CRDT core, sync gateway, presence, comments,
  persistence).
- **Context:** Liveblocks currently provides realtime editing, presence,
  threads, inbox notifications, margins-in-storage, and experimental offline
  support (`offlineSupport_experimental`), authorized via
  `src/app/api/liveblocks-auth/route.ts` with `FULL_ACCESS` room grants.
- **Alternatives:** Keeping Liveblocks long-term (rejected: the thesis is to
  own the sync stack); removing it before verifying the baseline (rejected:
  would conflate dependency drift with architecture regressions).
- **Rationale:** Sequenced removal preserves a known-good reference and
  isolates failures to the new architecture.
- **Consequences:** Phase 0 must implement a collaboration seam and
  transitional persistence; collab/presence/comments degrade gracefully
  during the transition and are restored by later phases.
- **Evidence:** Baseline code inspection; removal scheduled in Phase 0
  (post-baseline-verification gate).
- **Revisit conditions:** None — this is a roadmap commitment, not a design
  preference.

## DEC-003 — Convex is temporary bootstrap persistence

- **Status:** Accepted
- **Decision:** Convex remains through the Liveblocks-removal stage and is
  removed in Phase 1 in favor of Concord-owned PostgreSQL persistence.
- **Context:** Convex currently holds the `documents` table and serves
  queries/mutations/server-side preload; changing database + collaboration +
  dependencies simultaneously would create unattributable regressions.
- **Alternatives:** Migrating Convex and Liveblocks out simultaneously
  (rejected: debugging ambiguity).
- **Rationale:** One substitution at a time with verification gates.
- **Consequences:** Phase 1 delivers schema/migrations, repository layer,
  CRUD/search parity, and Convex removal; interim code is marked transitional.
- **Evidence:** Baseline code inspection (2026-09-05).
- **Revisit conditions:** Only via an explicit superseding decision with user
  authorization.

## DEC-004 — PostgreSQL is the durable source of truth

- **Status:** Accepted
- **Decision:** PostgreSQL owns durable state: document/organization metadata,
  memberships, ACLs, the append-only collaboration update log, snapshot
  metadata, version history, audit events.
- **Context:** Concord needs transactionally consistent security metadata and
  a durable update log compatible with snapshot+tail recovery.
- **Alternatives:** Convex (temporary), a purpose-built log store first
  (deferred), document databases (rejected: transactional ACL needs).
- **Rationale:** Mature transactions, indexing, migrations, and operational
  familiarity; supports expand/contract migration discipline.
- **Consequences:** Docker Compose dependency from Phase 1; migration testing
  becomes a CI concern in later phases.
- **Evidence:** Product requirements (PRD §14); Phase 1 scope.
- **Revisit conditions:** If update-log throughput measurements justify a
  specialized store, it can be added behind the same durable interfaces.

## DEC-005 — Clerk for identity; Concord owns authorization

- **Status:** Accepted
- **Decision:** Clerk remains the identity provider ("who is this user?").
  Authorization ("what can this user do?") is enforced by Concord services
  against Concord-owned ACL data — never by frontend identity state.
- **Context:** The baseline grants Liveblocks rooms `FULL_ACCESS` to any
  owner-or-org-member and has no role granularity; `documents.getById` lacks
  an ownership check entirely.
- **Alternatives:** Self-managed auth from scratch (rejected for now: no
  product value); trusting Clerk organization roles as authorization
  (rejected: insufficient granularity, client-side trust).
- **Rationale:** Clear trust boundary; RBAC (OWNER/EDITOR/COMMENTER/VIEWER)
  implemented server-side in Phase 1+.
- **Consequences:** Authorization gaps in the bootstrap are tracked (PRD
  R4/R5) and fixed during modernization/Phase 1; permission changes must
  propagate to active sessions.
- **Evidence:** Baseline inspection of `liveblocks-auth` route and Convex
  functions.
- **Revisit conditions:** If Clerk organization primitives prove insufficient
  for the ACL model, move identity integration behind a narrower interface.

## DEC-006 — C++20/23 owns the collaboration core and native/WASM compute

- **Status:** Accepted
- **Decision:** The CRDT algorithm core (replica state, operations, clocks,
  merge, dedup, deterministic serialization, hashing, snapshot encoding, the
  deterministic simulator, fuzz targets) is a C++20/23 library built with
  CMake, compiled natively for validation/worker use and to WebAssembly via
  Emscripten for the browser client.
- **Alternatives:** Rust core compiled to WASM (rejected: the project already
  assigns Rust to the network edge; a second Rust role would concentrate both
  language budgets in one ecosystem); TypeScript-only CRDT (rejected:
  performance headroom and native testing/sanitizer tooling).
- **Rationale:** One core, two compilation targets; native sanitizers/fuzzing
  for correctness; WASM for browser local-first execution.
- **Consequences:** Emscripten toolchain discipline; JS bindings layer;
  no premature FFI into latency paths — protocol boundaries first.
- **Evidence:** Constitution Section 10.2; Phase 2 scope.
- **Revisit conditions:** Measured evidence that the two-target build cost
  outweighs its benefits.

## DEC-007 — Rust owns the realtime synchronization gateway

- **Status:** Accepted
- **Decision:** The WebSocket sync gateway (Tokio async runtime, connection
  lifecycle, framing, authn/authz enforcement, bounded queues, backpressure,
  rate limiting, graceful shutdown, telemetry) is implemented in Rust.
- **Alternatives:** Node.js gateway (rejected: weak story for the required
  concurrency guarantees); C++ gateway (rejected: async networking ergonomics
  and safety); Go (rejected: adds a third server language without need).
- **Rationale:** Rust/Tokio fits high-concurrency, long-lived connections with
  strict resource bounds — the heart of the distributed thesis.
- **Consequences:** Phase 3 introduces the gateway single-node; Phase 4
  distributes it; protocol compatibility discipline begins there.
- **Evidence:** Constitution Section 10.3; Phase 3–4 scope.
- **Revisit conditions:** None foreseen.

## DEC-008 — Redis is ephemeral infrastructure, never durable truth

- **Status:** Accepted
- **Decision:** Redis may hold presence, short-lived caches, rate-limit
  counters, active-connection metadata, and temporary room state. Losing all
  Redis data must never lose durable documents.
- **Alternatives:** Redis as primary store (rejected); in-memory-only gateway
  state (viable single-node; revisited at Phase 4 when multi-node presence
  fanout requires shared ephemeral state).
- **Rationale:** Clean separation of durability guarantees.
- **Consequences:** Failure tests must include Redis data loss with zero
  durable impact.
- **Evidence:** Constitution Section 10.5; Phase 4 scope.
- **Revisit conditions:** None.

## DEC-009 — NATS JetStream for multi-gateway messaging

- **Status:** Accepted
- **Decision:** Inter-gateway document fanout and durable/streamed events use
  NATS JetStream once the system becomes multi-node (Phase 4). NATS is not
  introduced before a phase requires it.
- **Alternatives:** Direct gateway-to-gateway mesh (rejected: routing
  complexity); Redis pub/sub for fanout (rejected: mixes ephemeral infra into
  the durable event path); Kafka (rejected: operational weight for this scope).
- **Rationale:** Lightweight durable streams with the fanout semantics the
  routing design needs.
- **Consequences:** Phase 4 adds NATS to Docker Compose; partition/duplication
  semantics feed the at-least-once + idempotent-handler model.
- **Evidence:** Constitution Section 10.6; Phase 4 scope.
- **Revisit conditions:** If measured broker behavior contradicts latency
  budgets, re-evaluate transport — not the multi-node model.

## DEC-010 — Deployment is postponed to the final phase

- **Status:** Accepted
- **Decision:** All cloud/production deployment work, including hosting
  selection, TLS, domains, and rollout machinery, occurs in Phase 7.
  Phases 0–6 are local-first (Docker Compose).
- **Alternatives:** Deploy early to catch operational issues (rejected:
  early cloud decisions distort architecture; thesis is local correctness
  first).
- **Rationale:** Constitution Sections 33/57.
- **Consequences:** No deployment workflows in CI before Phase 7; local
  compose stack is the integration target until then.
- **Evidence:** Constitution; ROADMAP Phase 7 gate.
- **Revisit conditions:** User instruction only.

## DEC-011 — Performance claims require reproducible before/after measurement

- **Status:** Accepted
- **Decision:** No resume/public performance or reliability claim exists
  without: before value, after value, workload/denominator, methodology,
  environment, run count, and distribution (median + percentiles). Private
  ledger (`.agent/METRICS_LEDGER.md`) precedes any public promotion.
- **Alternatives:** Publishing target-style numbers as achievements
  (forbidden).
- **Rationale:** Benchmark integrity and interview defensibility.
- **Consequences:** Metrics arrive late (Phases 5–6); documentation labels
  TARGET vs MEASURED strictly.
- **Evidence:** Constitution Sections 30/31/55.
- **Revisit conditions:** None.

## DEC-012 — Private AI/agent orchestration is git-ignored

- **Status:** Accepted
- **Decision:** All agent prompts, memory, session logs, and experiment
  scaffolding live under `.agent/` and prompt-glob patterns, all ignored by
  Git and never staged. Public docs are written impersonally.
- **Alternatives:** Committing process docs (rejected: public repo must show
  engineering, not orchestration); keeping context in chat only (rejected:
  cross-session continuity requirement).
- **Rationale:** Professional public presentation + durable agent context.
- **Consequences:** `.gitignore` carries explicit rules (verified 2026-09-05
  via `git check-ignore`); commit checks must exclude `.agent/`.
- **Evidence:** `.gitignore` section "Private local agent orchestration".
- **Revisit conditions:** None.

## DEC-013 — Phase isolation is mandatory

- **Status:** Accepted
- **Decision:** Work is organized into exactly eight phases; no milestone from
  a future phase is implemented while an earlier phase is open, and no
  "get-ahead" work is allowed even when trivial.
- **Alternatives:** Opportunistic parallel implementation (rejected: dependency
  drift, untraceable regressions, incomplete subsystems).
- **Rationale:** Preserves attribution of failures to single causes.
- **Consequences:** Later-phase interfaces appear only when the current phase
  requires them (e.g., collaboration seam in Phase 0).
- **Evidence:** Constitution Sections 18/19.
- **Revisit conditions:** User instruction with documented supersession.

## DEC-014 — Complexity is introduced only after measurement

- **Status:** Accepted
- **Decision:** Optimization and architectural complexity (lock-free
  structures, caching layers, batching, compression, FFI) enter the codebase
  only after a baseline, profile, bottleneck identification, and a
  before/after comparison on the same workload.
- **Alternatives:** Speculative sophistication (rejected: unverifiable,
  unmaintainable).
- **Rationale:** Evidence must drive complexity; every subsystem must survive
  the interviewability questions (constitution Section 51).
- **Consequences:** First implementations are deliberately plain; profiling
  artifacts are recorded in the metrics ledger.
- **Evidence:** Constitution Sections 16/50.
- **Revisit conditions:** None.

## DEC-015 — The baseline tag `antonio-original-baseline` is immutable

- **Status:** Accepted
- **Decision:** Git tag `antonio-original-baseline` (→ `942035c`) is a
  permanent reference to the pristine tutorial import. It is never rewritten,
  moved, deleted, or force-updated; history before it is never rebased.
- **Alternatives:** Branch-only references (rejected: tags are immutable
  anchors); deleting after modernization (rejected: provenance/regression
  value).
- **Rationale:** Permanent provenance, comparison anchor, and regression aid.
- **Consequences:** Modernization happens forward on `main` (and later phase
  branches); the tag is untouched.
- **Evidence:** Tag verified 2026-09-05 (`git rev-parse` == `942035c` == main).
- **Revisit conditions:** None.

## Provenance note (recorded, not a decision)

The bootstrap originates from the Code With Antonio Google Docs tutorial. No
official public upstream repository or license has been identified (community
rebuilds exist and are themselves largely unlicensed). This is tracked as risk
R1 in the PRD and must be resolved (audit terms, attribution, or rewriting of
derived material) before public release or deployment. In-repo attribution is
retained and will not be removed.

---

## Phase 0 additions (2026-09-06)

## DEC-016 — Collaboration seam and honest deferred capabilities

- **Status:** Accepted
- **Decision:** After Liveblocks removal, the product UI consumes a
  vendor-neutral document session interface
  (`src/lib/collaboration/types.ts`, `provider.tsx`). Realtime collaboration,
  presence, comments/threads, and notifications report an explicit
  `unavailable` state instead of being faked or partially simulated.
- **Context:** Phase 0 required removing Liveblocks while the Concord CRDT
  core (Phase 2) and sync gateway (Phase 3) do not exist yet.
- **Alternatives:** Keeping a hosted SaaS layer (contradicts the project
  thesis); simulating realtime locally (dishonest UI, misleading
  verification); tightly coupling UI to future implementation details
  (re-coupling risk).
- **Rationale:** A clean seam lets later phases land capabilities without UI
  rewrites and keeps every visible behavior truthful.
- **Consequences:** Liveblocks-era features (presence avatars, anchored
  comments, inbox notifications) are absent from the UI until Phases 2–3.
- **Evidence:** Phase 0 verification matrix; zero-reference audit (2026-09-06).
- **Revisit conditions:** Phase 2 may reshape the interface when the CRDT
  document model lands; changes require a superseding decision.

## DEC-017 — Transitional whole-document Convex persistence

- **Status:** Accepted
- **Decision:** Until the CRDT update log exists (Phase 2), durable editor
  content is stored in Convex as a versioned TipTap JSON envelope
  (`{ v: 1, doc }`) on the `documents` table, saved with debounced
  whole-document writes (last write wins, single active editor per document
  assumed), plus per-browser localStorage for page margins.
- **Context:** The editor must remain genuinely usable after Liveblocks
  removal; Convex is itself transitional until Phase 1.
- **Alternatives:** Local-only persistence (loses durability across machines);
  building the final CRDT log early (violates phase isolation).
- **Rationale:** Simplest durable path that preserves single-user workflows;
  explicitly marked TRANSITIONAL in code and docs to prevent it becoming the
  final design.
- **Consequences:** Concurrent multi-client editing is unsupported in this
  state (last write wins); margins are per-browser, not shared. Content
  previously held in Liveblocks room storage is not migrated.
- **Evidence:** Persistence verified end-to-end (create → edit → save →
  reload) on 2026-09-06.
- **Revisit conditions:** Superseded by the Phase 2 update log; the envelope
  helper is the only allowed touchpoint.

## DEC-018 — Dependency holds recorded at Phase 0 completion

- **Status:** Accepted
- **Decision:** TypeScript is held at 5.9.x (TypeScript 7 native compiler is
  new; ecosystem verification pending) and ESLint at 9.x
  (`eslint-config-next@16`'s bundled `eslint-plugin-react` crashes under
  ESLint 10). react-color (unmaintained) is retained only through the
  transitional toolbar with replacement scheduled during Phase 7 polish.
- **Context:** Phase 0 modernization policy requires documented holds with
  evidence.
- **Alternatives:** Forcing latest majors (build/lint breakage, no benefit
  within this phase).
- **Rationale:** Reproducibility over version vanity.
- **Consequences:** Revisit when `eslint-config-next` supports ESLint 10 and
  the TypeScript 7 ecosystem stabilizes.
- **Evidence:** ESLint 10 crash reproduced during Phase 0 (`getReactVersionFromContext`).
- **Revisit conditions:** Next.js minor releases; TypeScript 7 tooling adoption.

---

## Phase 1 additions (2026-09-06)

## DEC-019 — PostgreSQL data stack: Drizzle ORM + node-postgres, Docker Compose local runtime

- **Status:** Accepted
- **Decision:** Concord's durable application data lives in PostgreSQL 18
  (pinned `postgres:18.6-alpine` image), run locally via Docker Compose. The
  typed schema is expressed with Drizzle ORM 0.45.x; schema changes ship as
  reviewed SQL migrations generated with Drizzle Kit 0.31.x and applied by the
  Drizzle migrator at startup/test time. The runtime driver is
  `node-postgres` (`pg` 8.x) behind a server-only connection pool. Zod 4
  validates environment configuration and mutation input boundaries.
- **Context:** Phase 1 replaces temporary Convex persistence with
  Concord-owned durable storage (DEC-004). The default stack from the Phase 1
  plan (PostgreSQL + Drizzle + `pg` + Docker Compose) was verified compatible
  with the modernized Next.js 16 / Node 24 repository; no compatibility
  blocker was found.
- **Alternatives:** Prisma (heavier abstraction; weaker fit for explicit SQL
  review); Supabase/Neon hosted Postgres (unnecessary hosted dependency for
  local-first development; deployment decisions deferred to Phase 7);
  `drizzle push` as schema management (rejected: migrations must be
  authoritative and replayable); postgres.js driver (fine, but `pg` is the
  default pairing with Drizzle's documented node-postgres support and keeps
  the pool explicit).
- **Rationale:** Explicit typed SQL with reviewed migration files; mature
  transactions/indexing; no hosted service required in Phases 1–6 (DEC-010);
  Drizzle 1.x remains beta, so stable 0.45.x is pinned.
- **Consequences:** Docker Compose is required for local development and
  tests; schema changes must go through tracked migrations replayable from an
  empty database; application-layer authorization is used (RLS considered and
  deferred — see DEC-020).
- **Evidence:** npm registry version checks (2026-09-06); clean install;
  empty-database migration replay (Phase 1 gate).
- **Revisit conditions:** Drizzle 1.x stable adoption; production hosting
  decisions in Phase 7.

## DEC-020 — Application-layer authorization now; Row Level Security deferred

- **Status:** Accepted
- **Decision:** Resource authorization (owner/organization/ACL resolution) is
  enforced in Concord's server services against PostgreSQL data. PostgreSQL
  Row Level Security is NOT enabled in Phase 1.
- **Context:** The app connects through a single server-side service
  credential pool, not per-user database roles; RLS with one shared role adds
  complexity without adding a second enforcement layer that maps to real
  principals.
- **Alternatives:** RLS keyed on session variables (rejected for Phase 1: the
  connection pool is shared; policy duplication with no per-user DB identity).
- **Rationale:** One authoritative authorization layer, testable at the
  service boundary; RLS can be added later as defense-in-depth without schema
  changes if per-request database identities are introduced.
- **Consequences:** Authorization correctness is proven by the service-level
  test suite (unit + integration + adversarial) rather than by database
  policy.
- **Evidence:** Phase 1 authorization test suite.
- **Revisit conditions:** Introduction of per-user database credentials or a
  second service writing to the same tables.

## DEC-021 — Phase 1 authorization and audit policy choices

- **Status:** Accepted
- **Decision:** (a) Document deletion is OWNER-only — an intentional
  tightening over the Phase 0 bootstrap where any organization member could
  delete organization documents. (b) Rename requires effective EDITOR
  (owner or organization member), preserving verified Phase 0 product
  behavior. (c) Title search is case-insensitive substring matching
  (parameterized ILIKE with escaped wildcards) — a superset of the Phase 0
  token-prefix search. (d) Audit events cover document create/rename/delete
  and ACL grant/update/revoke; per-save editor content writes are NOT
  audited (per-keystroke volume would create pathological audit growth);
  audit metadata carries titles/roles/ids, never document bodies or secrets.
- **Context:** Phase 1 replaced function-level owner-or-org checks with a
  role model; each parity difference and the audit scope needed an explicit,
  testable decision.
- **Alternatives:** Org-member delete (rejected: over-permissive); owner-only
  rename (rejected: product regression without security benefit); auditing
  content saves (rejected: volume); keeping token-prefix search (rejected:
  substring is the natural Postgres primitive and a strict superset).
- **Rationale:** Least privilege where it matters (delete, ACL management);
  honest, bounded audit scope; user-visible behavior preserved.
- **Consequences:** Deletion is restricted to owners (UI hides Remove for
  non-owners and the server enforces it); search may return more matches than
  the bootstrap for the same query (documented in the migration plan).
- **Evidence:** tests/authorization.test.ts, tests/db/*.test.ts; migration
  verification (docs/MIGRATION_CONVEX_TO_POSTGRES.md).
- **Revisit conditions:** Product feedback on delete semantics; sharing UI
  design in later phases; audit consumers requiring save-level events.

## DEC-022 — Transitional optimistic concurrency for document content

- **Status:** Accepted
- **Decision:** Until the CRDT update log exists (Phase 2), editor content
  saves and metadata renames use optimistic concurrency: clients submit the
  version they loaded; updates apply conditionally
  (`UPDATE ... WHERE version = expected`), increment the counter atomically,
  and stale writers receive a typed conflict (HTTP 409 on the save route)
  with autosave paused and an explicit reload prompt. This replaces the
  Phase 0 last-write-wins behavior, which could silently discard edits.
- **Context:** Phase 1 data model stores whole-document TipTap JSONB; two
  tabs editing concurrently must not silently overwrite each other.
- **Alternatives:** Last-write-wins (rejected: silent data loss); pessimistic
  locking (rejected: unnecessary complexity for a transitional path).
- **Rationale:** Data safety without premature CRDT complexity; the conflict
  UX is honest about what happened.
- **Consequences:** Concurrent editors see an explicit conflict instead of
  silent loss; Phase 2's CRDT replaces this model entirely.
- **Evidence:** tests/db/content-save.test.ts (incl. concurrent same-version
  saves), browser two-tab verification (2026-09-06).
- **Revisit conditions:** Superseded by the Phase 2 CRDT document model.

---

## Phase 2 additions (2026-09-06)

## DEC-024 — CRDT concurrency boundary: single-writer engine, bounded offload executor

- **Status:** Accepted
- **Decision:** The CRDT `Doc` is single-writer — all mutation flows through
  one thread per replica (the Web Worker on the browser; the native test
  harness in tests). No synchronization is added to the engine API.
  CPU-bound auxiliary work (future compaction, batch snapshot hashing) may
  offload to a bounded worker pool (`TaskExecutor`: fixed threads, bounded
  queue, stop-token cancellation, exception containment, deterministic
  shutdown — infrastructure, not a performance claim). TSan runs on the
  executor suite.
- **Context:** M027 required an explicit concurrency boundary before any
  threading; casual multi-writer engines are a classic CRDT bug source.
- **Alternatives:** Synchronized multi-writer Doc (rejected: lock discipline
  across 8 mutation paths for no Phase 2 benefit); lock-free structures
  (rejected: complexity without a measured bottleneck).
- **Rationale:** One replica = one writer matches the deployment model (one
  worker per document per browser) and keeps the engine's invariants
  testable; offloading needs are isolated in a tested primitive.
- **Consequences:** The embedding layer must serialize engine access (the
  worker message loop does); native embedders get the same contract.
- **Evidence:** tests/crdt + executor tests; TSan suite green.
- **Revisit conditions:** Phase 3+ gateway sharing an engine across sessions.

## DEC-025 — Phase 2 TipTap integration: reconciliation adapter over the collaborative subset

- **Status:** Accepted
- **Decision:** The editor connects to the CRDT through a diff/reconcile
  adapter: local TipTap transactions are diffed against the canonical CRDT
  blocks and emitted as stream-space operations; remote (harness/future
  transport) updates render through `setContent(emitUpdate=false)` so
  remote-applied changes never re-enter the op pipeline (feedback-loop
  prevention). The collaborative subset is paragraphs, headings 1–6, and
  bold/italic/underline/strikethrough. Documents containing unsupported
  node types (images, tables, lists, blockquote, code) are detected and the
  session falls back to the Phase 1 persistence path. Undo/redo rides
  TipTap's local history — the reconciliation emits the inverse operations
  (scoped local-inverse model).
- **Context:** M038–M042; a tree CRDT mapping the full TipTap node model was
  rejected for Phase 2 scope (DEC-023 alternatives), so the subset must be
  explicit and the fallback honest.
- **Alternatives:** Disable unsupported features in the editor (rejected for
  Phase 2: would regress the working product); map tables/images into
  opaque CRDT blobs (deferred: no convergence semantics to test).
- **Rationale:** The product keeps its full editing surface; collaborative
  guarantees apply where the model can represent content truthfully.
- **Consequences:** Cross-device sync covers the subset; unsupported content
  remains single-device (Phase 1 mirror) until later phases extend the
  model. paste of plain text and formatted subset content works via the
  same diff path; selection replacement is a multi-char diff.
- **Evidence:** tests/crdt/adapter.test.ts (mapping, reconciliation, marks,
  splits, heading changes); pm-model unsupported detection.
- **Revisit conditions:** Later-phase tree-CRDT adoption or per-feature
  model extensions.

## DEC-026 — WASM ABI and browser runtime boundary

- **Status:** Accepted
- **Decision:** The browser consumes the CRDT core through (a) a narrow C ABI
  over the Emscripten build — opaque handles, explicit grow-and-retry
  output buffers, structured error codes, no STL exposure; (b) a TypeScript
  runtime wrapper (`src/lib/crdt/runtime.ts`) that owns memory and hides
  all Emscripten details; (c) a Web Worker (`CrdtWorkerCore`) holding the
  engine + IndexedDB persistence; (d) the editor bridge on the main thread.
  Generating calls stash their serialized op (`concord_last_op`) so sizing
  retries never create duplicate operations.
- **Context:** M030–M034; the C++ core must power native and WASM with
  identical semantics (validated by golden vectors), and heavy CRDT work
  must never block the UI thread.
- **Alternatives:** Emscripten's WebIDL/bindings generator (rejected: broad
  surface, harder memory discipline); running the engine on the main thread
  (rejected: blocks the UI); Comlink-style RPC (rejected: another layer
  over an already-typed protocol).
- **Rationale:** The smallest boundary that keeps ownership explicit;
  worker isolation gives the UI thread freedom from CRDT work entirely.
- **Consequences:** Engine access is single-threaded per worker (DEC-024);
  the ABI is versioned with the protocol.
- **Evidence:** parity tests (native vs WASM golden vectors); worker
  latency baselines (metrics ledger: 0.003 ms/op insert).
- **Revisit conditions:** ABI extensions for Phase 3 transport features.

## DEC-023 — CRDT model: operation-based sequence CRDT (YATA-style ordering) over a flat item stream with block-delimiter items

- **Status:** Accepted
- **Decision:** Concord's collaborative document model is a single
  **operation-based sequence CRDT**. The document is one totally-ordered
  stream of *items*; an item is either a **text item** (one Unicode scalar
  plus a mark set) or a **block-delimiter item** (starts a new block and
  carries the block type/attributes). Blocks are a derived view: the item
  stream partitioned at delimiters.
  - Item identity: `(ReplicaId: u64, counter: u64)` — unique, monotonic per
    replica, never reused.
  - Ordering: each insert records its **left and right origin anchors**
    (YATA-style). Integration resolves concurrent insertions at the same
    position by comparing item identities — the first-seen placement wins
    ties consistently across replicas regardless of arrival order.
  - Deletion: tombstone flag on the item; deletes are idempotent and
    converge under duplication/reorder. A delete of a delimiter is a block
    merge; deleting characters inside a block never merges blocks.
  - Marks/attributes: per-element last-writer-wins registers ordered by
    `(lamportClock, ReplicaId)` — logical order only, never arrival time.
  - Causal summary: per-replica highest contiguous counter (state vector),
    used by tests and later by the Phase 3 transport.
- **Context:** Phase 2 requires a self-engineered C++ core whose semantics
  can faithfully represent the current TipTap feature set (paragraphs,
  headings, inline text, bold/italic/underline, block attributes), work
  offline, survive reload via snapshots + logs, compile identically to native
  and WASM targets, and be verifiable by deterministic simulation before any
  network exists.
- **Alternatives:**
  - *Per-block RGA composition* (a sequence CRDT of blocks, each containing
    its own text CRDT): split/merge requires moving elements across CRDT
    containers, making concurrent split/merge semantics divergent or lossy —
    rejected.
  - *Logoot/LSEQ positional identifiers*: ordering by identifier comparison is
    elegant and integration is a binary search, but identifier-size management
    (allocation strategies, interleaving behavior) adds subtlety without
    removing complexity from the properties that actually matter here —
    rejected in favor of origin-anchored ordering with fixed-size identities.
  - *Tree CRDT over the ProseMirror node tree*: most faithful structurally,
    but dramatically larger implementation surface (node identity, split,
    move, attribute placement) for features Phase 2 does not need (tables
    stay non-collaborative — see M041 capability notes) — deferred.
  - *State-based (CRDTPayload) approach*: shipping full state per update
    duplicates content; operation-based with state-vector summaries gives the
    same convergence with smaller payloads — chosen.
  - *Adopting an existing CRDT library* (Yrs, Automerge, diamond-types):
    contradicts the project thesis of owning the synchronization core — not
    allowed; only the published *algorithms* were studied, no code copied.
- **Rationale:** The flat delimiter model makes Enter/Backspace ordinary
  insert/delete operations (concurrent split + merge compose naturally), maps
  1:1 onto ProseMirror block structure, keeps item identities fixed-size, and
  concentrates all ordering complexity in one well-specified integration
  rule that deterministic simulation can hammer. Origin-anchored
  (two-neighbor) integration is proven in the literature and its failure
  modes are testable.
- **Consequences:** Tombstones are retained until a future compaction design
  (safe reclamation needs stronger causal knowledge — deferred, measured in
  benchmarks); memory grows with total edits, not visible size. Concurrent
  inserts at the same position get a deterministic but arbitrary order (a
  user may see their text land after a peer's). Delete-wins is not global:
  a concurrent insert adjacent to a deleted range survives — accepted.
- **Evidence:** algorithm selection analysis (SA-CRDT review, private report);
  convergence established by the native unit suite, property/randomized
  seeds, and the deterministic multi-replica simulator (Phase 2 test suites);
  native/WASM golden parity.
- **Revisit conditions:** If TipTap mapping cannot represent a required
  product feature (e.g., collaborative tables) the tree-CRDT alternative is
  revisited in a later phase with its own decision.

## DEC-027 — Phase 2 final-gate corrections: seed emission, attr registry, snapshot import validation, ABI sizing probe

- **Status:** Accepted
- **Decision:** Four final-gate corrections to the Phase 2 collaboration
  runtime, each pinned by a regression test:
  1. **Seed emission (editor bridge).** The first open of a document with
     server content must emit the seed into the durable CRDT replica. The
     original guard (`seedIsNew && !crdtIsEmpty`) was dead code — `seedIsNew`
     is only ever true when the replica was empty — so the engine stayed
     empty while the editor displayed content, and later diffs emitted
     out-of-range operations (browser `InvalidArgument` failures). The
     reconciliation baseline is the replica's ACTUAL canonical state, never
     the seed. Start/transaction coordination serializes against seed
     restore without self-deadlock: the seed emission reconciles directly,
     not through the awaiting public entry point.
  2. **Attribute registry completion (`lineHeight`).** The product editor's
     line-height control (fixed set: `normal`, `1`, `1.15`, `1.5`, `2`) is
     part of the canonical block-attribute registry on both sides (C++
     `AllowedAttrs`, TypeScript `pm-model`); documents using it no longer
     fail with `UnknownAttributeName` and degrade to the Phase 1 fallback.
  3. **Snapshot import re-validation.** Snapshot attribute names/values are
     re-validated against the same registry ops are validated against
     (SA-SEC3 finding F2); hostile or corrupt IndexedDB snapshots fail
     closed with `MalformedFrame` instead of restoring unregistered attrs.
  4. **ABI sizing-probe encoding.** Read-call sizing probes returned
     `-(required)` — colliding with the negative error-code range for any
     output ≥ ~900 bytes, i.e. every real document, misreading successful
     sizing as engine failures (`streamJson`/`visibleJson`/`exportSnapshot`
     threw on real content). Probes (null out-pointer) now return the
     required length as a POSITIVE value; negative values are exclusively
     errors. Generating-call recovery (real buffer, `-required`) is
     unchanged; single operations never approach the collision range.
- **Context:** Final-gate browser verification (P2-M048/M049) surfaced the
  seed and sizing defects; the security review flagged F2 for closure before
  Phase 3 exposes snapshot import to remote input.
- **Alternatives:** Silently dropping block-0 attributes (rejected:
  dishonest); tolerating the ABI collision behind a size threshold
  (rejected: ordinary documents cross it); separating the bridge baseline
  from the seed differently (rejected: the diff must describe the replica's
  real state).
- **Rationale:** One attribute registry on both sides of the ABI; untrusted
  input validated at the boundary; the content the editor displays must be
  the state the replica durably holds.
- **Consequences:** `streamJson`/`visibleJson`/`exportSnapshot` work for
  real documents; the WASM ABI probe convention changed (consumers: runtime
  wrapper + smoke harness, updated together). Block 0 — the implicit root
  block without a stored delimiter — still cannot carry block attributes;
  documents requiring them degrade loudly (logged, fallback) rather than
  silently corrupting.
- **Evidence:** `tests/crdt/bridge.test.ts` (seed emission, no-deadlock,
  stable baseline, typing, reload); `tests/crdt/adapter.test.ts` batch
  regressions (multi-block seed order, mid-document paste,
  tombstone-shifted stream mapping, lineHeight registry parity);
  `cpp/crdt/tests/test_snapshot.cpp` (registry rejection + lineHeight round
  trip); updated WASM smoke (positive probe convention).
- **Revisit conditions:** Phase 3 transport must keep snapshot import
  validation for remote input; block-0 attribute support if the product
  requires attributes on the first paragraph.

---

## Phase 3 additions (2026-09-06)

## DEC-028 — Phase 3 gateway stack: Tokio + Axum + tokio-postgres + jsonwebtoken + tracing

- **Status:** Accepted
- **Decision:** The Phase 3 sync gateway uses the following Rust stack (stable
  toolchain pinned by `rust/rust-toolchain.toml`):
  - **Async runtime:** `tokio 1.x` (multi-thread runtime) — the de-facto
    standard; cancellation-safe primitives, bounded channels, graceful
    shutdown support.
  - **HTTP/WebSocket:** `axum 0.8` (its built-in `axum::extract::ws`,
    `ws` feature) — ergonomic extractors, first-class WebSocket upgrade
    handler, middleware story consistent with `tower`.
  - **PostgreSQL driver:** `tokio-postgres 0.7` (async, native) — chosen over
    `sqlx` because Phase 3 needs only prepared, parameterized queries (no
    ORM/compile-time query macros) and a small dependency surface. Runtime
    query parsing is trivially safe (all values parameterized; no string
    concatenation with untrusted input). Migration execution is a small
    embedded-SQL runner (P3-M017) rather than a CLI.
  - **Serialization:** `serde` + `serde_json` for control frames (wire
    decision see DEC-029); CRDT op payloads travel as opaque bytes.
  - **AuthN:** `jsonwebtoken 11` — `DecodingKey::from_rsa_components` /
    `TryFrom<&Jwk>`; JWKS fetched from the Clerk issuer and cached with
    iteration-based refresh (key rotation).
  - **Telemetry:** `tracing` + `tracing-subscriber` (fmt + env-filter).
  - **Test client:** `tokio-tungstenite` (dev-dependency) for WebSocket
    integration/security tests; `uuid 1` (v4) for identifiers; `sha2` +
    `hex` for payload checksums.
- **Context:** P3-M007; Phase 3 is a single-gateway architecture — no
  NATS/Redis, no multi-gateway coordination.
- **Alternatives considered:** `sqlx` (rejected: heavier, macro/offline tooling
  not needed; `tokio-postgres` matches the actual query needs);
  `tower-ws` (rejected: axum 0.8 still ships `axum::extract::ws`);
  `hyper` directly (rejected: axum adds typed routing without a second
  framework); `actix-web` (rejected: separate actor runtime model, not
  needed); `axum` for WebSocket + `tokio-tungstenite` server-side (rejected:
  axum's upgrade handler is the cleaner integration).
- **Rationale:** minimal deterministic dependency surface; every selected
  crate is stable and widely used; no framework mixing. The single-gateway
  constraint makes a native async postgres client the right size.
- **Consequences:** runtime query typing is manual (row → struct mapping in
  one repository module); `jsonwebtoken` requires feature `use_pem`/JWK
  usage rather than a hosted verify service (Clerk doesn't offer a local
  verification service).
- **Revisit conditions:** multi-gateway Phase 4 will revisit DB fanout and
  may switch to a compile-time-checked driver at that point.

## DEC-029 — Phase 3 wire protocol: versioned hybrid (JSON control frames + binary data frames)

- **Status:** Accepted
- **Decision:** Wire protocol version 1 (spec: docs/PROTOCOL.md §9) is a
  hybrid:
  - **Control frames** (`hello`, `authenticate`, `join_document`,
    `join_accepted`, `durable_ack`, `error`, `ping`/`pong`,
    `server_draining`, `sync_done`): compact typed JSON text messages with a
    `{v, type, id?, payload}` envelope.
  - **Data frames** carrying CRDT operation bytes (`client_ops`,
    `sync_batch`): binary WebSocket messages with a fixed header
    (`[version][kind][batch_id u64 BE][count u16 BE]` + length-prefixed op
    bytes).
- **Context:** P3-M006; Phase 2 defines canonical binary operation
  serialization (PROTOCOL §7) that must be preserved verbatim across the
  wire.
- **Alternatives rejected:** all-JSON with base64 ops (33% inflation plus a
  second encoding layer); all-binary (control frames become opaque and
  harder to debug/share with TS); protobuf/flatbuffers (codegen dependency
  for 15 frame types); auth token in query string (credential leakage).
- **Rationale:** ops are the high-volume, already-canonical payload → binary
  is preferred (per the Phase 3 prompt); control frames are low-volume and
  benefit from human-readable JSON in dev tooling with zero extra schema
  tooling.
- **Consequences:** two encoders/decoders (one per class), each with golden
  fixture + round-trip tests in Rust and TypeScript; version byte on both
  classes.
- **Revisit conditions:** if throughput at scale demands it, data frames may
  gain compression (e.g., zstd) inside the same framing — a Phase 4+ concern.

- **Revisit conditions:** benchmark evidence under Phase 4 distribution.

## DEC-030 — Phase 3 runtime decisions: recheck-per-write authz, server-seq catch-up cursor, sync-first browser layer

- **Status:** Accepted
- **Decision:** Three Phase 3 implementation policies:
  1. **Write authorization is rechecked on every batch, inside the
     ingestion transaction** (not cached per connection). Correctness over
     micro-optimization per the Phase 3 prompt; live downgrade is
     E2E-proven (a mid-session ownership transfer denies the next batch).
  2. **Catch-up uses the server-sequence cursor** (`crdt_operations.id`,
     BIGSERIAL) as the fetch primitive — bounded, deterministic paging —
     while the client state summary accompanies joins as a coverage
     signal. Server sequence NEVER defines CRDT order (non-negotiable #7):
     op bytes are stored and fanned out verbatim; the CRDT core alone
     integrates them.
  3. **The browser sync layer ships ahead of the product cutover**:
     transport + outbox + session are implemented and E2E-proven this
     phase; the document UI migrates onto `SyncSession` in later phases
     (the Phase 1 mirror remains the active save path in the product
     shell meanwhile — an explicitly transitional state).
- **Context:** P3-M020/M037/M031 decisions surfaced during implementation.
- **Alternatives:** authorization cache with TTL (rejected: stale-grant
  windows); state-vector-only catch-up (rejected: sets are hard to page
  deterministically); forcing the UI cutover into Phase 3 (rejected:
  milestone scope discipline — E2E proves the layer; UI wiring is product
  work).
- **Rationale:** Every denial-of-risk is eliminated at the cheapest layer;
  paging semantics stay simple and testable; UI cutover lands with
  presence/threads in a later phase where it can be verified as a product
  behavior.
- **Consequences:** Per-batch authz adds one SQL join per ingest (measured
  p50 ≈ 22 ms end-to-end — acceptable); summary is informational until a
  future phase uses it for delta sync; docs carry the transitional-state
  note.
- **Evidence:** e2e.test.ts (live downgrade, catch-up convergence);
  repo.rs (recheck inside the transaction); benchmarks (BENCHMARKS.md).
- **Revisit conditions:** Phase 4 distribution changes authz caching
  economics; delta sync design revives the state vector.

---

## Phase 4 additions (2026-09-07)

## DEC-031 — Phase 4 inter-gateway event envelope: full-payload, versioned, idempotent

- **Status:** Accepted
- **Decision:** One binary event envelope published per accepted durable
  BATCH (not per op): `[schema_version u8=1][origin_gateway u64][document_id
  uuid 16B][event_id u64 (origin's batch counter)][server_cursor u64]
  [payload_sha256 32B][count u16][op bytes]*` — reusing the wire client_ops
  framing for the op list. Full payload (not DB reference) so peer gateways
  fan out without a Postgres round-trip; the server_cursor is advisory.
- **Alternatives:** reference-only events (peer must query DB per event —
  adds a read amplification per fanout); per-op events (broker message
  overhead ×N for a batch committed atomically). Hybrid (payload + cursor)
  rejected as complexity without Phase 4 benefit.
- **Rationale:** Batches commit atomically, so batch-granular events
  preserve atomicity semantics; full payload keeps the realtime path
  off the DB; identity idempotency (document + operation ids) makes
  redelivery safe by the SAME mechanisms as Phase 3.
- **Consequences:** Broker messages are batch-sized (bounded by the
  protocol batch caps); checksum guards integrity; origin id enables
  loop suppression.
- **Evidence:** P4-M005 spec; hardening tests (M015).

## DEC-032 — NATS JetStream topology: one stream, one subject, pull consumer per gateway

- **Status:** Accepted
- **Decision:**
  - Stream `CONCORD_OPS` (namespaced `concord.<env>.ops`), subjects
    `concord.<env>.ops.doc` — ONE subject for all operation events (no
    per-document subjects, no per-gateway consumers explosion).
  - File storage, `WorkQueueRetention`? — NO: `LimitsPolicy/InterestRetention`
    would drop events for absent gateways. Chosen: **`Interest`-based
    retention is unsafe across gateway restarts; use explicit retention
    `Limits` with max_age 10m + duplicate window 2m** (events are
    ephemeral transport, NOT durable truth — PostgreSQL is; a gateway that
    misses the window recovers via DB catch-up by design).
  - Consumer: ONE durable PULL consumer **per gateway**
    (`gw-<gateway-id>`), ExplicitAck, AckWait 30s, MaxDeliver 5, ordered
    consumption; poison messages (5 failed deliveries) are NATS-terminated
    (MaxDeliver) and logged — never retried forever, never crash the
    gateway; the DB catch-up floor makes event loss safe.
  - Max ack pending bounded (e.g. 256) to cap in-flight event memory.
- **Alternatives:** per-document subjects (subject explosion with document
  count — explicitly warned against); push consumers (delivery control
  belongs to the consumer); WorkQueue (single-consumer semantics prevent
  multi-gateway fanout); Core NATS at-least-only (no redelivery/ack
  semantics); streams per environment×gateway (consumer metadata growth).
- **Rationale:** One stream + one subject + N pull consumers is the
  minimal topology that gives every gateway every event with independent
  ack/redelivery positions; short retention keeps JetStream lean BECAUSE
  PostgreSQL is the durable floor (documented, not assumed).
- **Consequences:** Every gateway sees every batch event (filters by
  local room interest before fanout — cheap in-memory check); broker
  traffic scales O(gateways × accepted batches); lag observability via
  consumer ack-pending (M040).
- **Evidence:** P4-M006 spec; stream provisioning test (M012); redelivery
  tests (M018/M036/M038).

## DEC-033 — Redis scope: ephemeral-only keymap with namespacing + TTLs + fail-open rate limiting

- **Status:** Accepted
- **Decision:** Redis keys (namespace `concord:<env>:`):
  - `presence:<doc>:<user>` → hash {gateway, replica, last_seen}, TTL 60s
    (expiry is the authority; cleanup best-effort).
  - `ratelimit:<scope>:<principal>` → token-bucket state for connects,
    write-ops, malformed-frames (per-user / per-IP as configured).
  - `gw:<id>` liveness hints, TTL 30s.
  - NO document content, NO ACLs, NO operation payloads — forbidden by
    design (code-reviewed + wipe test).
  - Redis loss: rate limiting degrades to PER-GATEWAY LOCAL token buckets
    (fail-open for limits — availability over strictness — with local
    caps still bounding abuse per gateway); presence degrades to absent;
    durable paths never consulted Redis (M024).
- **Alternatives:** fail-closed rate limiting (a Redis outage would then
  block all writes — unacceptable: durable correctness must not depend on
  an ephemeral tier); Redis as fanout transport (mixes ephemeral infra
  into the durable event path — rejected in DEC-009).
- **Rationale:** The ephemeral tier must be able to vanish without
  coordinated recovery; the wipe test (M037) proves it empirically.
- **Consequences:** A determined abuser landing on different gateways
  during a Redis outage gets N×local limits (documented residual risk,
  bounded); presence is eventually-expired, never manually swept.
- **Evidence:** P4-M007 spec; M022–M024, M037 tests.

## DEC-034 — Phase 4 routing: broadcast fan-out with local room filtering (no sharding, no consistent hashing)

- **Status:** Accepted
- **Decision:** Every gateway subscribes to ONE subject and receives every
  accepted-batch event; each gateway filters by local room membership before
  fanout (in-memory check, no DB read). No per-document subjects, no shard
  subjects, no consistent hashing, no dynamic per-room subscriptions.
- **Context:** P4-M034 requires an evidence-based comparison. Analysis:
  - *Per-document / dynamic room subscriptions*: subscription count grows
    with active documents × gateways; NATS per-subscription overhead and
    re-subscription churn on room churn; unbounded metadata growth — the
    prompt explicitly warns against subject explosion.
  - *Shard subjects (document → shard → owner gateway)*: introduces
    routing state, shard reassignment on gateway failure, and a
    cross-shard delivery path — distributed complexity with no measured
    bottleneck to justify it at Concord's scale (one host, 3 gateways,
    measured 1085 ops/s ingest with fanout p50 ≈ 2 ms).
  - *Broadcast + local filter*: O(gateways) delivery per batch; gateway
    cost per irrelevant event = one UUID set-membership check (~ns).
  - *Consistent hashing*: solves a load-skew problem we have not
    demonstrated (benchmark M042/M044 evidence pending; hot-doc fairness
    M044 measures whether skew exists at all).
- **Rationale:** Minimal moving parts; correctness is already global
  (every gateway can serve any document from PostgreSQL); broadcast keeps
  the failure model trivial (no routing state to repair after crashes).
  Message amplification is O(gateways), which is 3 locally and modest at
  realistic Phase 4 scale.
- **Consequences:** Broker traffic scales with (accepted batches ×
  gateways); irrelevant-event filtering is per-gateway CPU, bounded and
  cheap. Revisit with evidence if gateway count or document fanout cost
  makes amplification measurable (Phase 5/6 benchmarks decide).
- **Evidence:** P4-M034 analysis; multi_gateway tests (all convergence
  paths through the broadcast consumer); M042/M044 benchmark runs.
- **Revisit conditions:** measured broker/CPU amplification at scale.

## DEC-035 — Phase 5 snapshot payload: unchanged C++ v1 inner format inside a versioned server wrapper, stored in PostgreSQL

- **Status:** Accepted
- **Decision:** A server snapshot = a small wrapper (wrapper format
  version, document id, durable coverage boundary, covered op count,
  inner length) + the Phase 2 `Doc::export_snapshot()` byte string
  VERBATIM, followed by a SHA-256 checksum over the exact stored
  bytes. Snapshots are stored as `BYTEA` rows in PostgreSQL
  (`crdt_snapshots`), not an external object store.
- **Context:** P5-M004 audit — the v1 inner format already carries the
  item stream (tombstones, origins, LWW registers), the applied-op-id
  dedup set, pending ops, and per-replica contiguous counters; the
  browser already imports v1 through WASM. A new inner format would
  break client compat and duplicate semantic logic.
- **Alternatives:** a new server-only snapshot format (duplicates the
  encode/decode path; no client benefit); storing snapshots in S3
  (rejected by prompt §12 unless measured DB pressure justifies it);
  storing only deltas (snapshot + tail IS the delta scheme).
- **Rationale:** zero changes to the semantic authority (C++ core);
  WASM resync reuses the exact import path; checksum boundary is the
  stored bytes (one integrity domain); PostgreSQL keeps finalization,
  metadata, and payload atomic in one database transaction.
- **Consequences:** wrapper version (currently 1) governs server
  compatibility; inner version stays 1 until the C++ core itself
  evolves. Large payloads stress TOAST — measured at M026/M040 before
  any external-store revisit.
- **Evidence:** P5-M004 audit (cpp/crdt/src/snapshot.cpp); Phase 2
  WASM parity harness; M013 corruption tests; M026 payload-size
  baseline.
- **Revisit conditions:** measured snapshot size/DB pressure justifying
  external object storage (prompt §12).

## DEC-036 — Snapshot lifecycle: guarded states with lease-owner finalization; recovery reads FINALIZED only

- **Status:** Accepted
- **Decision:** Snapshot rows move REQUESTED→BUILDING→VERIFYING→
  FINALIZED (or →FAILED); FINALIZED→SUPERSEDED is a retention marking.
  All transitions are compare-and-set SQL guarded on (status,
  claim_version of the owning job lease). Recovery NEVER reads
  non-FINALIZED rows; selection walks newest→oldest FINALIZED with
  per-candidate validation, falling back to full replay.
- **Context:** P5-M006 lifecycle design; prompt §5/§6 invariants 9–10.
- **Alternatives:** delete non-finalized attempts eagerly (loses
  diagnostic evidence; guard still needed); allow VERIFYING reads
  (breaks invariant 3 — non-verified snapshots must never be used).
- **Rationale:** immutability + state guards make "finalized" a
  durable, machine-checkable property; fallback ordering (newest→
  older→full replay) bounds worst case by the pre-Phase-5 path.
- **Consequences:** a finalized snapshot can only be superseded
  (retention), never mutated; competing builds for one boundary get
  distinct attempt numbers and deterministic winner selection.
- **Evidence:** M012 repository transition tests; M018 race tests;
  M019 fallback tests.

## DEC-037 — Maintenance-job ownership: PostgreSQL row claim with versioned lease (claim_version fence)

- **Status:** Accepted
- **Decision:** Jobs live in `maintenance_jobs` (durable truth).
  Claiming = compare-and-swap UPDATE on (state, claim_version);
  heartbeats extend `lease_expires_at` only for the current
  claim_version; every effectful transition (including snapshot
  finalization and prune batches) re-checks the claim_version in its
  WHERE clause — a stale owner whose lease was taken can never
  finalize (the fence rejects it). Expired-lease jobs are re-queued by
  the scheduler sweep (retryable classes) or failed terminally.
- **Context:** P5-M009; prompt §8 non-negotiable 15/18.
- **Alternatives:** pg advisory locks (not durable across restarts,
  cannot fence a zombie owner from DB truth); Redis locks (ephemeral
  tier must not own durability — DEC-033); no fencing (stale-owner
  finalization becomes possible — violates non-negotiable 18).
- **Rationale:** the fence lives in the same transaction as the
  effectful write, so ownership and effect commit atomically; crashes
  leave recoverable rows, not lost locks. No exactly-once claim is
  made or needed (idempotent job semantics, non-negotiable 13).
- **Consequences:** a gateway running a worker whose lease was stolen
  wastes work but cannot corrupt state; heartbeats add bounded write
  load (per active job, at lease/3).
- **Evidence:** M024 claim/lease tests; M046 stale-lease stress tests.

## DEC-038 — Native C++ worker: standalone process with structured stdin/stdout protocol

- **Status:** Accepted
- **Decision:** A dedicated worker executable wraps the C++ CRDT core,
  speaking a length-prefixed machine-readable protocol on
  stdin/stdout (commands: reconstruct-from-ops, export-snapshot,
  import-snapshot/verify, state-digest, verify-snapshot). The Rust
  adapter spawns it directly (no shell), with bounded input, bounded
  captured output, timeouts, cancellation, and child cleanup on
  shutdown. Exit codes are explicit; payloads never log secrets.
- **Context:** P5-M014/M015; prompt §8 native-worker policy ("prefer a
  clean process boundary over fragile in-process FFI").
- **Alternatives:** in-process FFI (crash domain shared with the
  gateway; sanitizer/process isolation lost); a long-lived worker
  pool service (added lifecycle complexity before a measured
  startup-cost bottleneck — M040 measures worker startup explicitly).
- **Rationale:** process boundary gives crash isolation, memory
  bounds, sanitizer-friendly testing, and the same build artifact as
  the native tests; one-shot invocation keeps the failure model
  trivial (timeout ⇒ kill ⇒ retryable job failure).
- **Consequences:** worker startup cost is paid per job — measured
  at M026/M040; revisit a pool only if startup dominates recovery
  latency at scale.
- **Evidence:** M014 worker tests; M015 orchestration tests (timeout,
  nonzero exit, malformed output, cancellation).

## DEC-039 — Version history: boundary-referencing revisions + restore-as-forward-ops under a maintenance replica

- **Status:** Accepted
- **Decision:** Revisions reference durable boundaries (`target_seq`)
  and never embed content; historical reconstruction = nearest
  covering FINALIZED snapshot + bounded replay. Restore = surgical
  forward-op batch (deletes + re-inserts computed against current
  state) ingested through the NORMAL durable path under a reserved
  maintenance replica id, recorded as an auditable restore_event
  revision. No document generation/reset primitive; no history
  rewrite.
- **Context:** P5-M008/M036; PRD FR-7; docs/HISTORY.md.
- **Alternatives:** embed per-revision content copies (storage blowup;
  duplicates snapshot machinery); generation/reset primitive (C++ core
  format change + pending-client divergence semantics — rejected until
  tombstone accumulation is a measured problem); destructive restore
  (violates prompt §7 "forward-moving, auditable").
- **Rationale:** reuses every existing safety property (durable ACK,
  broker propagation, CRDT convergence, idempotent dedup) — restore is
  'just edits'; un-delete-via-reinsert is semantically the tombstone
  model's forward equivalent.
- **Consequences:** restore leaves tombstones (bounded by compaction
  policy); two concurrent restores merge convergently; restore
  requires OWNER permission.
- **Evidence:** M036 restore tests; M037 concurrency/authorization
  tests; HISTORY.md invariants H1–H8.
- **Phase 5 final form (P5-M036 full):** implemented as worker-computed
  restore diffs (CMD_RESTORE_DIFF: two snapshots → forward-op batch of
  deletes/re-inserts/attr-syncs under the reserved REST replica,
  neighbor-anchored for order preservation) INGESTED through the normal
  durable path — restore is 'just edits'. The worker proves convergence
  internally (folds A+batch, requires visible-document equality and no
  new pendings) before returning status 0 — silent partial restore is
  impossible. Honest deviation: canonical DIGEST equality is
  CRDT-theoretically unreachable for non-empty diffs (tombstone +
  applied-set history only appends); the visible-content contract of
  HISTORY.md §5 is what convergence means, and B's digest is returned
  as the verification reference.

## DEC-040 — Compaction: staged state machine with transactional floor advance; automatic pruning gated on the M032 equivalence proof

- **Status:** Accepted
- **Decision:** Compaction is a recoverable state machine (PLANNED →
  SNAPSHOT_REQUIRED → SNAPSHOT_VERIFIED → PRUNE_READY → PRUNING →
  COMPLETED) per document, driven by maintenance jobs under DEC-037
  leases. Pruning deletes only rows `id ≤ boundary` covered by a
  FINALIZED, differentially-verified snapshot, in bounded batches,
  each batch advancing `documents.compaction_floor_seq` in the SAME
  transaction. Automatic pruning ships DISABLED until M032's seeded
  end-to-end equivalence proof passes, then enabled by configurable
  policy (M022 thresholds).
- **Context:** P5-M027/M030; prompt §6 compaction invariants.
- **Alternatives:** delete-then-verify (violates "never prune first");
  non-transactional floor updates (crash window leaves floor without
  coverage — violates §6); archive rows to a shadow table (doubles
  storage; retention policy on snapshots already bounds history).
- **Rationale:** every crash point leaves a state where recovery is
  defined (floor ≤ verified coverage always holds transactionally);
  the M032 gate makes enabling automatic pruning a measured decision,
  not a hope.
- **Consequences:** a pruned op is gone from the log (recoverable via
  snapshot+tail only for state purposes; historical reconstruction
  before the floor uses the protected covering snapshot); stale
  clients resync via M031 protocol.
- **Evidence:** M030 dry-run/staged pruning tests; M032 equivalence
  suite; M033 crash-injection matrix.

## DEC-041 — Trigger policy: configurable thresholds, evidence-based defaults (from M026 baselines)

- **Status:** Accepted
- **Decision:** Snapshot scheduling keys on (ops-since-last-snapshot,
  durable-bytes-since-snapshot) with minimum interval, cooldown, and
  bounded pending/running jobs per document and globally. Defaults
  derive from the M026 replay-cost baseline (not magic numbers) and
  are configuration-overridable; rationale documented with each
  threshold.
- **Context:** P5-M022.
- **Alternatives:** time-only triggers (idle documents with huge tails
  never snapshot); every-N-edits triggers without cooldown (snapshot
  job explosion under bursty editing).
- **Rationale:** recovery cost is a function of replay distance;
  thresholds bound that distance by the measured cost curve.
- **Consequences:** threshold changes require only config edits; the
  M043/M044 benchmark methodology quantifies the resulting recovery
  improvement.
- **Evidence:** M022 policy doc; M026 baselines; M043 headline
  benchmark.
