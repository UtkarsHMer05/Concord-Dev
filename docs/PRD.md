# Concord — Product Requirements Document

Status: Authoritative (bootstrap version)
Version: 1.0
Last updated: 2026-09-05

Concord is a distributed, local-first collaborative document/workspace platform
backed by a self-engineered synchronization stack: CRDT-based reconciliation,
durable update persistence, a self-hosted realtime gateway, fault testing, and
reproducible performance benchmarks.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md),
[DECISIONS.md](DECISIONS.md), [ROADMAP.md](ROADMAP.md).

Labels used throughout:

- **TARGET** — a design goal. Not yet measured; must never be quoted as an
  achieved result.
- **MEASURED** — a result reproduced by a documented benchmark against a pinned
  commit. No MEASURED values exist yet.

---

## 1. Product overview

Concord is a web application that lets users create, edit, share, and
collaborate on rich-text documents. Multiple users can edit the same document
concurrently from different devices. Editing continues while offline; when
connectivity returns, replicas exchange only the state needed to converge,
without server round trips for local keystrokes and without conflicts.

The visible product is a focused document editor. The differentiating
engineering is underneath: a self-owned replication and synchronization stack
replacing hosted collaboration services.

## 2. Problem statement

Current realtime collaborative editors that individuals and small teams can
deploy themselves typically depend on a hosted SaaS collaboration layer. That
coupling imposes limits: the synchronization algorithm, transport, persistence,
and authorization model are not owned or inspectable; offline behavior is
opaque; scaling behavior cannot be measured or tuned; and the system cannot be
studied, hardened, or extended at the protocol level.

Concord exists to build and operate that synchronization stack directly —
conflict-free replicated document state, durable persistence, a
high-concurrency realtime gateway, and multi-node fanout — with every claim
supported by reproducible measurement.

## 3. Product vision

A user opens Concord and immediately understands it: documents, editing,
sharing, collaborators' cursors and comments, version history. The same user
can disconnect from the network, keep working, reconnect, and watch all
replicas converge.

Underneath, Concord is a distributed system: a C++ CRDT core compiled to
WebAssembly in the browser, a Rust synchronization gateway on the server,
PostgreSQL as the durable source of truth, and deliberate separation between
ephemeral state (presence) and durable state (document updates).

Every subsystem must be explainable in a technical interview: why it exists,
what alternatives were rejected, how correctness is tested, what was measured.

## 4. Target users

- Individuals and small teams who want a self-hostable collaborative document
  workspace without handing edit traffic to a third-party collaboration service.
- Developers evaluating how a production-grade CRDT collaboration backend is
  built, tested, and operated.

The product surface must remain understandable to a non-technical evaluator;
the engineering depth is for technical evaluators.

## 5. User stories

1. As a user, I can sign in and see my documents and my organization's shared
   documents.
2. As a user, I can create a document from a template or blank, rename it,
   search my documents, and delete them.
3. As a user, I can edit a rich-text document with headings, styling, lists,
   tables, tasks, images, links, colors, and highlighting.
4. As a collaborator, I can see who else is in the document and their presence.
5. As a collaborator, I can comment on and discuss specific content (threads).
6. As a user, I can lose my network connection and continue editing.
7. As a user, when I reconnect, my edits and others' edits converge without
   duplication or corruption.
8. As an owner, I can share a document and grant VIEWER / COMMENTER / EDITOR
   roles; authorization is enforced server-side.
9. As a user, I can view a document's version history and restore a revision.
10. As an operator, I can deploy Concord, watch its health, and understand its
    latency and failure behavior from its telemetry.

## 6. Functional requirements

- FR-1 Identity: email-based sign-in/sign-out via an external identity
  provider; organizations supported.
- FR-2 Documents: create (blank or template), rename, delete, search (title),
  list with pagination, open.
- FR-3 Editor: rich-text editing per the extension set in the current product
  shell (headings, bold/italic/underline/strikethrough, color, highlight,
  font family/size, line height, alignment, lists, tasks, tables, images with
  resize, links, undo/redo), page margins with a draggable ruler, print/export
  (JSON, HTML, TXT, print-to-PDF).
- FR-4 Collaboration: concurrent multi-client editing of the same document with
  convergence; presence (avatars); comments/threads anchored to content;
  comment notifications.
- FR-5 Offline: document editing works with no network connection; state is
  persisted locally; reconnection replays/converges.
- FR-6 Sharing/authorization: document-level roles OWNER / EDITOR / COMMENTER /
  VIEWER; role changes take effect for active sessions.
- FR-7 History: durable update log enables revision reconstruction, viewing,
  and restore.
- FR-8 Notifications: in-product inbox for comment/thread events.

## 7. Non-functional requirements

- NFR-1 Correctness: all legitimate replicas converge to equivalent state
  (CRDT convergence); duplicate and reordered updates are safe.
- NFR-2 Performance: local edits render without server round trips
  (TARGET: sub-16 ms main-thread budget for local edit application; heavy
  synchronization work off the main thread). All performance claims require
  MEASURED evidence with workload and environment.
- NFR-3 Scalability: the gateway supports many concurrent connections with
  bounded queues and explicit backpressure behavior (TARGET values to be
  established in Phase 3/4 baselines).
- NFR-4 Reliability: durable, acknowledged updates survive gateway restarts;
  the system recovers from PostgreSQL restarts, broker interruption, and
  ephemeral-store loss without losing durable document data.
- NFR-5 Reproducibility: pinned toolchains, lockfiles, containerized
  dependencies, scripted benchmarks, seeded test randomness.
- NFR-6 Observability: structured logs with correlation IDs, metrics, and
  distributed tracing (OpenTelemetry / Prometheus / Grafana).
- NFR-7 Maintainability: language responsibilities are fixed (Section 10 of
  the project constitution); complexity must solve a measured problem.
- NFR-8 Security: see Section 8.

## 8. Security requirements

- Authorization is enforced server-side; client identity state is never
  trusted for access decisions.
- Document access requires a valid session and a server-checked role.
- WebSocket writes are authenticated and authorized per document; forged or
  unauthorized writes are rejected and observable.
- Replayed updates are idempotent-safe; malformed and oversized frames are
  rejected with bounded resource usage.
- Cross-tenant isolation: organization and personal document scopes cannot be
  read or written across boundaries, including via guessed document IDs.
- Stale permissions propagate: revoked access ends effective write ability for
  active sessions.
- Secrets never appear in code, logs, docs, tests, or images.
- Dependency and container vulnerability scanning in CI before release.

## 9. Reliability requirements

- At-least-once delivery with idempotent, deduplicated handlers for durable
  updates; no "exactly once" claims.
- Defined failure model per dependency (documented in later phases).
- Zero lost acknowledged updates within the controlled failure scenarios of
  the test suite (MEASURED claim only, with scenario count and definition).
- Graceful degradation: presence loss is acceptable; document update loss is
  not.

## 10. Performance requirements

- All performance requirements are TARGETs until reproduced in
  `docs/BENCHMARKS.md` with methodology (hardware, versions, workload, warmup,
  run count, median + percentiles).
- Headline metric families to be measured in later phases:
  synchronization throughput/concurrency, recovery time for large update logs,
  correctness/fault-tolerance evidence, and a profile-driven optimization.
- Benchmark integrity rules apply: no cherry-picked runs; exclusions documented.

## 11. Offline-first requirements

- Local-first execution: the browser applies local edits immediately from
  local state; no network dependency for local display.
- Local persistence in the browser (IndexedDB).
- Reconnection exchanges only necessary state (delta, not full replay).
- Heavy synchronization processing must not block the UI main thread
  (Web Worker / WASM boundaries where justified).

## 12. Collaboration requirements

- Document contents: eventually consistent via CRDT convergence; offline
  capable; duplicate-safe.
- Security-sensitive metadata (ownership, membership, permissions, security
  configuration): transactionally consistent in the durable store.
- Presence: ephemeral, best-effort; latest state wins; loss acceptable.
- No distributed locks for normal text editing.

## 13. Authorization requirements

- Roles: OWNER, EDITOR, COMMENTER, VIEWER (minimum).
- Identity (authentication) may be external; authorization decisions are
  Concord-owned, enforced in services and durable ACL data.
- Authorization changes propagate to active sessions (eventual; bound defined
  during implementation).
- Audit trail for authorization-relevant events.

## 14. Data durability requirements

- Durable model: latest snapshot + append-only updates after the snapshot;
  recovery = load snapshot + replay tail.
- Update identity: stable per-replica identity with monotonic sequence or
  equivalent CRDT identity; duplicates never corrupt state.
- Storage consistency: checksums; transactional boundaries for metadata and
  ACLs; documented write/storage amplification characteristics (MEASURED in
  later phases).

## 15. Observability requirements

- Structured logs (no secrets, no tokens, no private document content).
- Correlation/request IDs across client→gateway→storage.
- Metrics at minimum: active connections, updates/s, sync latency percentiles,
  queue depth, reconnect duration, auth denials, snapshot duration/size,
  recovery duration.
- OpenTelemetry traces; Prometheus metrics; Grafana dashboards.

## 16. Testing requirements

- TypeScript: lint, typecheck, unit, Playwright E2E including offline/reconnect.
- C++: CMake/Ninja unit + deterministic + property tests; ASan/UBSan/TSan;
  fuzzing where justified.
- Rust: fmt, clippy, tests, protocol/integration/concurrency/shutdown tests.
- PostgreSQL: migration up tests, schema validation, authorization query tests.
- Distributed: convergence, reconnect, duplicate/reordered messages, partition,
  restart, slow consumer, queue saturation, dependency interruption.
- Deterministic simulator with seeded, reproducible failure scenarios.

## 17. CI/CD requirements

- PR CI: TypeScript, C++, Rust, migrations, protocol compatibility, Docker
  build, integration tests, security checks.
- Nightly: chaos, randomized convergence, fuzzing, sanitizer matrices,
  performance regression gates.
- CD: staged deployment, health checks, migration safety, graceful draining,
  rollback.
- CI/CD implementation follows the phase roadmap, not before.

## 18. Deployment requirements

- Deployment is a final-phase activity (Phase 7). Local development uses Docker
  Compose for all infrastructure dependencies.
- Production requirements at that time: TLS, secrets management, health checks,
  staging environment, backward-compatible (expand/contract) migrations,
  graceful WebSocket draining, rollback, smoke tests, telemetry.
- Cloud target selection occurs in Phase 7 based on the final architecture.

## 19. Browser/platform support

- Development targets current evergreen Chromium and Safari on macOS; Firefox
  compatibility is desired and verified where feasible.
- WebAssembly + IndexedDB + WebSocket + Web Worker capable browsers required
  for the local-first client (final support matrix fixed in Phase 7).
- Responsive behavior for the document UI; desktop-first.

## 20. Accessibility expectations

- Keyboard operability for core editing and document management flows.
- Semantic HTML/ARIA consistent with the component library in use.
- Full audit and conformance pass scheduled in Phase 7 (product polish);
  not deferred silently — tracked as roadmap work.

## 21. Success metrics

- All eight phase gates passed with their verification evidence.
- Four headline metrics measured with before/after evidence (Section 10).
- Deterministic simulation suite green across seeded scenarios.
- Public documentation accurately distinguishes implemented vs planned.
- Deployable production build with runbook and telemetry.

## 22. Non-goals

- Not a Google Docs/Notion/Figma/Slack feature generalization; no scope creep
  beyond the distributed local-first collaboration thesis.
- No billing/payments, no marketing site, no mobile native apps, no realtime
  spreadsheets/presentations.
- No Kubernetes, autoscaling, or paid infrastructure during Phases 0–6.
- No claim of "exactly once" delivery semantics.
- No integrations catalog; depth over breadth.

## 23. Risks

| ID | Risk | Class | Mitigation |
|----|------|-------|------------|
| R1 | Upstream tutorial provenance: no official upstream repo/license identified; tutorial is a commercial product. Legal review required before public release/deployment. | Legal (BLOCKING for public release only) | Recorded in DECISIONS/ATTRIBUTION; attribution retained; audit before publication; rewrite/replace derived assets if required. |
| R2 | Baseline pins React 19 RC → permanent `--legacy-peer-deps` installs. | Technical | Phase 0 modernization to stable React; document any residual exceptions. |
| R3 | Liveblocks removal (Phase 0) must preserve collaboration, presence, comments, offline behavior without regressions. | Technical | Verify original baseline first; collaboration seam abstraction; transitional persistence documented as temporary. |
| R4 | Baseline `getById` lacks ownership check (authorization gap inherited from bootstrap). | Security | Fix during Phase 0 modernization; server-side authorization enforced from Phase 1 onward. |
| R5 | Environment-specific config committed in code (hardcoded Clerk dev domain in Convex auth config). | Security/Hygiene | Move to environment configuration during Phase 0. |
| R6 | Large dependency majors outstanding (Next 15→16, TipTap 2→3, Tailwind 3→4, Liveblocks 2→3). | Technical | Phase 0 upgrades in compatibility groups with official migration docs. |
| R7 | Node version drift (22 active vs 24 expected). | Process | Pin via `.nvmrc` in Phase 0 after confirming supported LTS. |
| R8 | WASM/C++ toolchain learning curve; deterministic sim complexity. | Execution | Small measured experiments before committing designs (Section 64 rules). |

## 24. Dependencies

- Product shell: Next.js, React, TipTap, Radix/shadcn UI, Tailwind.
- Identity: Clerk (authentication only).
- To be removed: Liveblocks (Phase 0), Convex (Phase 1).
- Planned infrastructure: PostgreSQL (durable truth), Rust/Tokio gateway,
  C++20/23 CRDT core (native + WASM), Redis (ephemeral only), NATS JetStream
  (multi-gateway), OpenTelemetry/Prometheus/Grafana, Docker Compose.
- External services: Clerk (identity); object storage if needed (Phase 7).

## 25. Phase mapping

Requirements map to the eight authoritative phases defined in
[ROADMAP.md](ROADMAP.md): Phase 0 bootstrap/modernization; Phase 1 PostgreSQL
control plane; Phase 2 C++ CRDT + WASM local-first client; Phase 3 Rust sync
gateway; Phase 4 distributed multi-gateway; Phase 5 snapshots/recovery/compaction;
Phase 6 verification/security/observability/chaos/CI; Phase 7
productionization/deployment.

## 26. Final acceptance criteria

- PRODUCT: polished editor, real collaboration, offline editing, reconnect,
  sharing with server-enforced roles, history, deployable UI.
- SYSTEMS: C++ CRDT core, WASM client runtime, Rust realtime gateway,
  PostgreSQL durability, multi-node communication, concurrency with bounded
  resources, snapshot/recovery.
- QUALITY: unit/integration/E2E, fuzz/property, deterministic simulation,
  chaos, security testing, CI/CD, observability, reproducible benchmarks.
- PRODUCTION: containerization, staged deployment, health checks, graceful
  shutdown/draining, migration safety, rollback, documentation.
- Every public claim traceable to reproducible evidence; no fabricated metrics.
