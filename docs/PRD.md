# Concord — Product Requirements Document

Status: Authoritative (Phase 7 — v1 scope frozen in §25a)
Version: 1.2
Last updated: 2026-09-09

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
  comment notifications. STATUS (Phase 3): the CRDT convergence core AND the
  realtime transport are implemented — two-client live collaboration,
  offline/reconnect reconciliation, and duplicate/retry safety are proven
  against the self-hosted Rust gateway (E2E). Presence/comments remain
  `unavailable` until later phases.
- FR-5 Offline: document editing works with no network connection; state is
  persisted locally; reconnection replays/converges. STATUS (Phase 3):
  implemented for the collaborative content subset with durable ACK
  tracking (pending → sent → durably_acked) and identity-stable resends
  through the gateway; documents with unsupported content continue via the
  server-mirror path until later phases extend the model.
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
| R2 | ~~Baseline pins React 19 RC → permanent `--legacy-peer-deps` installs.~~ RESOLVED in Phase 0: React 19.2 stable; `npm ci` clean without compatibility flags. | Technical | — |
| R3 | ~~Liveblocks removal regressions~~ RESOLVED in Phase 0: verified baseline frozen at `phase-0-modernized-baseline` before removal; removal verified (features intentionally deferred per DEC-016). | Technical | — |
| R4 | ~~Baseline `getById` lacks ownership check~~ RESOLVED in Phase 0: `getById`/`getByIds` enforce identity + owner-or-organization checks; full RBAC lands in Phase 1. | Security | — |
| R5 | ~~Hardcoded Clerk dev domain in Convex auth config~~ RESOLVED in Phase 0: auth config reads `CLERK_JWT_ISSUER_DOMAIN` from the deployment environment. | Security/Hygiene | — |
| R6 | Large dependency majors outstanding (Next 15→16, TipTap 2→3, Tailwind 3→4, Liveblocks 2→3). | Technical | Phase 0 upgrades in compatibility groups with official migration docs. |
| R7 | Node version drift (22 active vs 24 expected). | Process | Pin via `.nvmrc` in Phase 0 after confirming supported LTS. |
| R8 | WASM/C++ toolchain learning curve; deterministic sim complexity. | Execution | Small measured experiments before committing designs (Section 64 rules). |

## 24. Dependencies

- Product shell: Next.js, React, TipTap, Radix/shadcn UI, Tailwind.
- Identity: Clerk (authentication only).
- Collaboration core (Phase 2): C++20 CRDT engine (native + WebAssembly),
  Web Worker runtime, IndexedDB local durability, TipTap reconciliation
  adapter.
- Removed: Liveblocks (Phase 0), Convex (Phase 1).
- Infrastructure: PostgreSQL 18 (control plane + transitional content mirror,
  via Docker Compose locally), Drizzle ORM + tracked SQL migrations.
- External services: Clerk (identity); object storage if needed (Phase 7).

## 25. Phase mapping

Requirements map to the eight authoritative phases defined in
[ROADMAP.md](ROADMAP.md): Phase 0 bootstrap/modernization; Phase 1 PostgreSQL
control plane; Phase 2 C++ CRDT + WASM local-first client; Phase 3 Rust sync
gateway; Phase 4 distributed multi-gateway; Phase 5 snapshots/recovery/compaction;
Phase 6 verification/security/observability/chaos/CI; Phase 7
productionization/deployment.

## 25a. Concord v1 verified scope (Phase 7 boundary freeze)

This section is the authoritative, truthful statement of what the v1 release
does and does not include. It supersedes any aspirational wording elsewhere
in this document for release purposes. No feature listed as unsupported may
be implied by product UI, docs, or demo scripts.

### A. Verified v1 features (with test evidence)

| Feature | User surface | Evidence |
|---|---|---|
| Email sign-in/sign-out, organizations | Clerk-authenticated home page; org switcher scopes document lists server-side | `tests/db/acl.test.ts`, `tests/db/idor-matrix.test.ts` |
| Document create (blank/template), rename, delete (owner-only), title search, paginated listing | Home dashboard; inline rename + dialogs; row menu | `tests/db/documents.test.ts`, `tests/db/hardening.test.ts`, `tests/authorization.test.ts` |
| Rich-text editing (TipTap 3) | Headings, bold/italic/underline/strikethrough, font family/size, line height, alignment, lists, tasks, tables, images (URL/blob), links, colors/highlight, undo/redo, print/export (JSON/HTML/TXT/print-to-PDF), ruler margins | `tests/templates.test.ts`, `tests/content.test.ts`, manual product QA |
| Local-first durable editing | CRDT replica in a Web Worker; snapshot + op-log durability in IndexedDB; editing works offline and survives reload | `tests/crdt/worker.test.ts`, `tests/crdt/harness.test.ts`, `tests/crdt/parity.test.ts`, `tests/crdt/bridge.test.ts` |
| Transitional server content mirror | Debounced whole-document save with optimistic concurrency (409 conflict path, not silent overwrite) | `tests/db/content-save.test.ts` |
| CRDT sync engine + realtime gateway | SyncSession/SyncTransport against the self-hosted Rust gateway: two-client collaboration, offline/reconnect reconciliation, duplicate-safe resends, gateway restart recovery, graceful drain, snapshot resync — **verified at library/protocol level in the test harness** (see B.1 for the v1 product boundary) | `tests/realtime/e2e.test.ts`, `tests/realtime/reliability.test.ts`, `tests/sync/*.test.ts` |
| Permission model | OWNER/EDITOR/COMMENTER/VIEWER enforced server-side on every request; revoked access surfaces honestly ("no longer have permission") | `tests/db/acl.test.ts`, `tests/db/idor-matrix.test.ts`, realtime role tests |
| Status truthfulness | Save/duability status UI states local-saved vs mirror-saved truthfully; never claims server/cloud save before the durable-ack point | Phase 7 product audit (SA-PRODUCT7) + unit tests for status mapping |

### B. Intentionally unsupported in v1 (do not demo, do not imply)

1. **Live multi-user collaboration in the shipped web UI.** The sync stack
   (SyncSession + Rust gateway) is implemented and verified against real
   WebSockets in the test harness, but the shipped document page does not
   open a gateway session. The v1 product surface runs the local CRDT replica
   plus the transitional content mirror. Realtime multi-user editing ships
   when the editor→gateway wiring lands in a later release; the collaboration
   seam (`src/lib/collaboration/`) and SyncSession API exist for exactly that.
2. **Real-time cursors and presence UI.** No presence components exist;
   presence is honestly reported as "unavailable" by the session provider.
3. **Comments/threads and notifications.** No components; reported as
   "unavailable" (Phase 1 seam retained).
4. **History browsing / revision restore UI.** The durable update log,
   snapshots, and WS protocol support revisions, but no web UI exists for
   browsing or restoring revisions in v1. (Documented boundary, not a gap in
   the sync stack.)
5. **Image uploads to a server/object store in collaborative text.** Images
   embed by URL or local blob only; no upload backend exists. Inserting an
   image (or any content outside the collaborative subset) degrades the
   session loudly to the non-collaborative save path (see C.1).
6. **Mobile native apps, offline PWA install, share links, inline @mentions,
   export to DOCX/PDF server-side** (print-to-PDF only), **any admin UI**.

### C. Known limitations (shipped, honestly surfaced)

1. **Collaborative content subset.** The CRDT model supports paragraphs and
   headings-1..6, text with bold/italic/underline/strikethrough marks, and
   block-level align/lineHeight attributes (per
   [CONSISTENCY_MODEL.md](CONSISTENCY_MODEL.md) and `src/lib/crdt/pm-model.ts`).
   Any other content (tables, images, task/bullet/ordered lists, colors,
   highlights, font family/size, links, hard breaks) disables the
   collaborative path **for that session** and the document continues on the
   transitional whole-document save path. The v1 UI states this switch
   truthfully (collaborative-mode indicator); it never silently pretends both
   paths are equivalent.
2. **Transitional content mirror.** Whole-document, version-checked saves
   (not per-keystroke op sync) power cross-device freshness on the v1 surface.
   Two tabs editing concurrently produce an explicit conflict toast, not a
   merge.
3. **Single-gateway durability.** ACK_DURABLE means PostgreSQL-local,
   single-node commit (FAILURE_MODEL §1.1); multi-region/multi-broker
   replication is a Phase 4 target, not a v1 claim.
4. **Browser support.** Modern evergreen browsers with WebAssembly
   (bulk-memory), module Web Workers, IndexedDB, and WebSockets required —
   full matrix in [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md).
5. **Desktop-first responsive range.** The document page uses a fixed
   816px-page metaphor; below tablet widths the content area scrolls
   horizontally by design (the page is the unit of layout), with responsive
   chrome around it.

### D. Deferred ideas (post-v1 backlog, no commitment)

- Presence avatars and live cursors on the shared canvas.
- Comments/threads anchored to text ranges; comment inbox.
- Revision history browser with restore (the protocol already speaks it).
- Image upload service + storage quota management.
- Full offline PWA (installable, background sync when the gateway returns).
- Share links with role pickers; per-document sharing panel UI.
- Multi-gateway/region deployment with broker fanout (Phase 4 architecture).

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
