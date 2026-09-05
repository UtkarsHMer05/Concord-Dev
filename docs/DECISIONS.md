# Concord — Architectural Decision Log

Status: Authoritative
Version: 1.0 (bootstrap)
Last updated: 2026-09-05

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
