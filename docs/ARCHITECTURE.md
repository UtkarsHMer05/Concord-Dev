# Concord — Architecture

Status: Authoritative (bootstrap version)
Version: 1.0
Last updated: 2026-09-05

This document distinguishes three architecture states at all times:

- **CURRENT** — what exists and runs today.
- **TRANSITIONAL** — the explicitly temporary states created while moving
  between CURRENT and TARGET (each is scheduled, bounded, and documented).
- **TARGET** — the planned end state. Nothing here is claimed as implemented.

Nothing in the TARGET section should be read as an implemented capability.

---

## 1. CURRENT — bootstrap architecture (tutorial baseline)

The repository currently runs the original tutorial product: a Next.js
document editor whose realtime collaboration, presence, comments, and
notifications are provided by Liveblocks, whose persistence is Convex, and
whose authentication is Clerk.

```mermaid
flowchart TD
    subgraph Browser["Browser (client)"]
        UI["Next.js / React UI<br/>(App Router)"]
        TIPTAP["TipTap editor"]
        LBEXT["Liveblocks TipTap extension<br/>(Yjs-based, experimental offline)"]
        UI --> TIPTAP --> LBEXT
    end

    subgraph Server["Next.js server"]
        MW["clerkMiddleware()"]
        AUTHROUTE["POST /api/liveblocks-auth"]
        ACTIONS["Server actions<br/>(getUsers, getDocuments)"]
        MW --> AUTHROUTE
    end

    subgraph SaaS["Hosted services"]
        CLERK["Clerk<br/>(identity)"]
        CONVEX["Convex<br/>(documents table + queries)"]
        LIVEBLOCKS["Liveblocks Cloud<br/>(rooms, storage, threads, presence)"]
    end

    LBEXT -- "HTTPS session auth" --> AUTHROUTE
    AUTHROUTE -- "identity + owner/org check" --> CLERK
    AUTHROUTE -- "document lookup" --> CONVEX
    AUTHROUTE -- "room token (FULL_ACCESS)" --> LIVEBLOCKS
    LBEXT -- "realtime updates/presence/threads" --> LIVEBLOCKS
    UI -- "queries/mutations" --> CONVEX
    UI -- "sign-in/org switch" --> CLERK
    Server --> CLERK
```

### 1.1 Components and responsibilities

| Component | Responsibility |
|---|---|
| `src/app/(home)/*` | Document listing (paginated), title search, templates gallery, rename/remove dialogs |
| `src/app/documents/[documentId]/page.tsx` | Server component: Clerk token → Convex `preloadQuery(getById)` |
| `room.tsx` | `LiveblocksProvider` (throttle 16 ms), custom auth endpoint, user/mention/room-info resolvers |
| `editor.tsx` | TipTap instance; extension set; margins via Liveblocks Storage; `offlineSupport_experimental` |
| `toolbar.tsx` / `navbar.tsx` | Formatting commands (via Zustand editor store), export (JSON/HTML/TXT/print), document ops |
| `ruler.tsx` | Draggable page margins stored in Liveblocks room Storage |
| `threads.tsx`, `inbox.tsx`, `avatars.tsx` | Comments, notifications, presence UI |
| `convex/documents.ts` | CRUD + search + auth checks (owner or same-organization member) |
| `api/liveblocks-auth/route.ts` | Issues Liveblocks room sessions after Clerk identity + document-access check |
| `src/middleware.ts` | Clerk middleware on all app routes |

### 1.2 Current data flow (edit path)

1. Keystroke → TipTap → Liveblocks extension applies the update to the local
   Yjs document and sends it to Liveblocks Cloud over WebSocket.
2. Liveblocks fans the update out to other room members; their extensions
   apply it remotely.
3. Room Storage (margins) and Threads (comments) follow the same room
   transport; document *metadata* (title) goes through Convex mutations.
4. The initial document content is fetched from Convex once at page load and
   handed to the editor as `initialContent`.

### 1.3 Current trust boundaries

- Browser → Next.js: Clerk session cookie; middleware gates routes.
- Browser → Liveblocks: session token minted by `/api/liveblocks-auth` after
  a server-side owner-or-organization check.
- Next.js → Convex: Clerk JWT (template `convex`) or server key.
- Authorization granularity today: binary (owner/org member ⇒ `FULL_ACCESS`).
  There are no EDITOR/COMMENTER/VIEWER distinctions, and `documents.getById`
  performs no ownership check.

### 1.4 Known weaknesses in the current state

- Authorization gaps and binary access model (see PRD R4, DEC-005).
- Environment-specific configuration committed in code (Clerk dev domain in
  `convex/auth.config.ts`).
- No tests, no CI, no toolchain pinning.
- Collaboration, presence, comments, and persistence are externally owned and
  not inspectable or measurable (the reason for this project).

---

## 2. TRANSITIONAL states (scheduled, bounded)

### 2.1 After Liveblocks removal (end of Phase 0)

Liveblocks is removed once the modernized original baseline is verified.
Editing remains functional through a **collaboration seam** — a UI-facing
interface decoupling the editor from any specific collaboration backend — and
**transitional persistence** (documented as temporary).

```mermaid
flowchart LR
    UI["Next.js UI + TipTap"] -- "collaboration seam<br/>(interface)" --> SEAM["Concord collaboration abstraction"]
    SEAM -- "transitional persistence<br/>(temporary, marked)" --> STORE["Local/temporary store"]
    UI -- "documents metadata" --> CONVEX["Convex (temporary)"]
    UI -- "identity" --> CLERK["Clerk"]
```

- Interface surface includes connect/disconnect, apply local update,
  subscribe remote updates, connection state, presence (illustrative names;
  Phase 0 defines the actual contract).
- Transitional persistence exists only to keep single-user editing durable and
  is clearly marked in code and docs; it must not become the final design.

### 2.2 After Convex removal (end of Phase 1)

Document metadata, ACLs, memberships, and durable application data move to
PostgreSQL behind a repository/data layer; Convex is fully removed.

```mermaid
flowchart LR
    UI["Next.js UI + TipTap"] --> SEAM["Collaboration seam"]
    SEAM --> PERSIST["Concord data layer"]
    PERSIST --> PG[("PostgreSQL")]
    UI -- "identity" --> CLERK["Clerk"]
    PERSIST -- "server-side authz" --> ACL["RBAC: OWNER/EDITOR/COMMENTER/VIEWER"]
```

- Server-side authorization against PostgreSQL ACL data becomes the single
  access-decision point (DEC-005).
- Liveblocks-era features (threads/inbox) remain degraded or locally
  implemented until the Concord collaboration stack lands (Phases 2–3).

---

## 3. TARGET — Concord architecture (planned)

```mermaid
flowchart TD
    U["Users"] --> WEB["Next.js / React product UI<br/>TipTap editor"]

    WEB --> CRDT["C++ CRDT core via WebAssembly<br/>(local-first state)"]
    CRDT --> IDB[("IndexedDB<br/>local persistence")]
    CRDT --> WK["Web Worker<br/>(sync processing)"]
    IDB --> WS
    WK --> WS

    WS["Binary WebSocket"] --> GW

    subgraph Edge["Concord control/data edge"]
        GW["Rust Sync Gateway (Tokio)<br/>authn/authz · framing · backpressure<br/>rate limits · connection lifecycle"]
    end

    GW --> PG[("PostgreSQL<br/>durable source of truth:<br/>update log · snapshots · metadata · ACLs")]
    GW --> NATS["NATS JetStream<br/>multi-gateway fanout (Phase 4+)"]
    GW --> REDIS["Redis<br/>ephemeral only: presence · caches · counters"]

    PG --> SNAP["Snapshot + append-only tail recovery<br/>(C++ native processing where justified)"]

    LB["Load balancer (Phase 4+)"] --> GW1["Gateway A"]
    LB --> GW2["Gateway B"]
    LB --> GW3["Gateway C"]
    GW1 & GW2 & GW3 --- NATS
```

### 3.1 Language responsibilities (fixed)

| Language | Owns | Does not own |
|---|---|---|
| TypeScript | Product UI, editor integration, IndexedDB, WebSocket client, WASM interop, workers | Durable state, authorization decisions |
| C++20/23 | CRDT core, merge/dedup, deterministic serialization/hashing, snapshots, simulator, fuzz targets — native + WASM | Product UI, networking services |
| Rust | Async gateway: connections, framing, authn/authz enforcement, bounded queues, backpressure, rate limiting, telemetry | CRDT algorithm core |
| SQL (PostgreSQL) | Durable truth: metadata, ACLs, update log, snapshots metadata, history, audit | Ephemeral presence |
| Redis | Ephemeral presence/caches/counters only | Anything whose loss is unacceptable |

### 3.2 Durable vs ephemeral state

- **Durable (PostgreSQL):** document/organization metadata, memberships, ACLs,
  append-only update log, snapshot metadata, version history, audit events.
- **Ephemeral (Redis/in-memory):** presence, active connection metadata,
  rate-limit counters, temporary room state. Loss is acceptable and tested.
- **Browser-local (IndexedDB):** offline replica state; reconciled via CRDT.

### 3.3 Consistency model (per data class)

| Data class | Guarantee |
|---|---|
| Document contents | Eventually consistent; CRDT convergence; duplicate-safe; offline-capable |
| Security metadata (ownership, membership, ACLs, security config) | Transactionally consistent (PostgreSQL) |
| Presence | Ephemeral, best-effort, latest-wins |

No distributed locks for normal text editing. Leases are reserved for
single-owner maintenance operations (e.g., compaction) if the design needs one.

### 3.4 Delivery model

At-least-once transport with idempotent handlers and deduplication at the
CRDT identity level (`replica id` + monotonic sequence or equivalent).
Duplicate packets never corrupt document state. Durable edits and cursor
motion have different delivery priorities (P0 vs P3 classes per the
backpressure model).

### 3.5 Control plane vs data plane

- **Data plane:** client↔gateway WebSocket updates, gateway→storage log
  appends, cross-gateway document fanout.
- **Control plane:** identity/authorization, document routing/sharding
  decisions, membership/ACL changes, maintenance (snapshot/compaction
  scheduling), health/telemetry aggregation.

### 3.6 Trust boundaries (target)

1. Browser ↔ Gateway: authenticated session (Clerk identity), per-document
   authorization enforced inside the gateway against durable ACL data.
2. Gateway ↔ PostgreSQL: service credentials; the database trusts no client.
3. Gateway ↔ NATS/Redis: service-scoped credentials; ephemeral data only in
   Redis; NATS carries events, never authorization decisions.
4. Client authorization state is advisory UI only.

### 3.7 Failure assumptions (target direction)

- Any single gateway may crash or be drained at any time; clients reconnect.
- PostgreSQL may restart; acknowledged durable updates survive.
- NATS may be interrupted; the system degrades and recovers without durable
  loss (per the documented failure model in later-phase docs).
- Redis data may vanish; presence/metrics degrade; documents are unaffected.
- Clients may be offline for arbitrary periods; convergence on reconnect.

### 3.8 Deployment direction

Local development is Docker Compose (PostgreSQL, Redis, NATS, observability
stack as phases introduce them). Production deployment — hosting, TLS,
secrets, staging, rollout/draining, rollback — is designed and executed in
Phase 7 based on the final architecture (DEC-010).

---

## 4. Document lifecycle (target view)

1. **Create** — metadata row + ACL (PostgreSQL); document opens locally.
2. **Edit offline** — updates applied to local CRDT replica (WASM), persisted
   to IndexedDB.
3. **Sync online** — updates exchanged via binary WebSocket; deduplicated by
   identity; appended to the durable log.
4. **Snapshot/compact** — at policy thresholds, snapshot materializes state;
   tail replays shrink; recovery time stays bounded (Phase 5).
5. **History/restore** — reconstruct revisions from log + snapshots.

## 5. Reading guide

- Implemented behavior: Section 1 (CURRENT).
- Temporary, scheduled states: Section 2 (each is gated by a phase).
- Planned behavior: Sections 3–4 — never presented as existing.
- Decisions behind this structure: [DECISIONS.md](DECISIONS.md).
