# Concord — Consistency Model (Phase 2)

Status: Authoritative
Version: 1.0 (implemented)
Last updated: 2026-09-06

This document defines the correctness contract for Concord's collaborative
document core. Phase 2 established the local replica semantics (C++20 CRDT,
native + WASM). **Phase 3 adds the realtime transport** (Rust gateway) under
the SAME assumptions — the network layer preserves them rather than replacing
them (section 6).

Companion documents: [PROTOCOL.md](PROTOCOL.md) (operation schema),
[ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md) (DEC-023).

---

## 1. Replication model

- Each browser replica holds a full copy of the document CRDT state plus an
  operation log.
- Replicas produce **operations** locally (offline-capable, no network).
- Operations are delivered between replicas **at least once**, in **any
  order**, with **arbitrary delay, duplication, and reordering**. (In Phase 2
  this delivery is simulated in tests; the real transport arrives in Phase 3
  and must satisfy the same assumptions.)
- Correctness depends only on the **set** of operations each replica has
  eventually received — never on arrival order or wall-clock time.

## 2. Core invariants

The engine must satisfy each of these; each maps to deterministic tests:

1. **Convergence.** Replicas that have applied the same set of valid
   operations hold semantically equivalent documents (identical canonical
   state digest).
2. **Idempotency.** Re-applying an already-applied operation is a no-op.
3. **Determinism.** The resulting document is a pure function of the operation
   set; delivery order, timing, and duplication cannot change it.
4. **Stable identity.** Every operation and every element has a globally
   unique, deterministic identity: `(ReplicaId, counter)`. Identities are
   never reused.
5. **Delete-before-insert tolerance.** A delete may arrive before the insert
   it targets has been integrated; the tombstone is retained and applied when
   the insert arrives. (Delete-wins semantics over concurrent insert-at-
   deleted-position: the insert survives, the deletion of a *neighbor* never
   resurrects.)
6. **Offline safety.** Every local edit can be generated with no network
   connection whatsoever; nothing in the generation path consults remote
   state.
7. **Snapshot parity.** Export → destroy → import yields the same visible
   document and CRDT metadata; operations replayed after import remain
   idempotent.
8. **Canonical serialization.** Equivalent states serialize to identical
   bytes (used for state hashing and golden vectors).
9. **Malformed input safety.** Invalid, truncated, or hostile frames fail
   closed: structured rejection, no crash, no undefined behavior, no silent
   state mutation.
10. **No wall-clock correctness dependency.** Logical clocks (per-replica
    counters, Lamport clocks for attribute ordering) are the only time
    sources the CRDT consults.

## 3. Attribute and mark semantics

Marks (bold/italic/underline) and block attributes (heading level, block
type) use **last-writer-wins registers keyed by (element, attribute)** where
"last" is defined by the logical order `(lamportClock, ReplicaId)` — a total
order that is independent of arrival time. Concurrent conflicting writes
converge to the winner of that order on every replica.

## 4. Failure scope for Phase 2

Handled within Phase 2 guarantees:

- duplicate delivery of any operation,
- arbitrary reordering and delay,
- temporary partitions between replicas (heal → full delivery → converge),
- browser/page reload (IndexedDB snapshot + operation log restore),
- malformed or truncated payloads (fail closed),
- partially persisted local state (durable log + snapshot recovery).

Explicitly **out of Phase 2 scope** (later phases):

- server-side durable storage of the operation stream (Phase 3+),
- gateway crash/restart with in-flight sessions (Phase 3+),
- multi-gateway routing, broker loss (Phase 4+),
- tombstone garbage collection (deferred; safe reclamation requires causal
  knowledge beyond Phase 2 — tombstones are retained, growth is measured in
  benchmarks),
- authorization/ACL semantics for operations (metadata remains governed by
  the Phase 1 PostgreSQL control plane; document metadata is authoritative
  there — see [DATABASE.md](DATABASE.md)).

## 5. State summaries

Replicas expose a **state summary** (highest contiguous operation counter
seen per replica) used by tests and, later, by the Phase 3 transport to
identify missing operations. Summaries are deterministic, comparable, and
serialize canonically. Gaps are representable and reported.

## 6. Storage authority split

| Data | Authoritative store (Phase 2, implemented) |
|---|---|
| Document metadata, ownership, ACLs, audit | PostgreSQL (Phase 1 control plane) |
| Collaborative document content (local replica state) | IndexedDB (snapshot + durable operation log, per document) |
| PostgreSQL `documents.content` (Phase 1 JSONB envelope) | Transitional server mirror of the visible content (kept updated by the existing debounced save); becomes the server-side reconciliation source for the Phase 3 update log |

Implementation status: every invariant in §2 is enforced by the engine and
exercised by automated tests (native unit suite, seeded property corpus,
deterministic simulator, native/WASM parity, worker durability/reload,
multi-replica harness, offline-first flow). The delivery assumptions in §1
are exercised through the in-memory test transport; the real transport
arrives in Phase 3.


---

## 6. Phase 3 transport consistency (CURRENT)

The gateway extends the Phase 2 contract; nothing about local semantics
changed:

1. **Delivery assumptions preserved.** The gateway provides at-least-once,
   unordered delivery — exactly what §1 requires. Server sequence
   (`crdt_operations.id`) is a storage/fetch cursor ONLY; the CRDT never
   consumes it for ordering (non-negotiable #7, enforced by design: op bytes
   are stored and fanned out verbatim).
2. **ACK_DURABLE** (FAILURE_MODEL §1): authentication + authorization +
   envelope validation + PostgreSQL commit under
   `(document_id, operation_id)`, atomic per batch. Not peer-delivery, not
   broker replication (Phase 4 vocabulary), not multi-region.
3. **Idempotency chain**: client retries use stable identities →
   `INSERT ... ON CONFLICT DO NOTHING` → duplicates resolve to existing
   rows → CRDT application is idempotent. Each link is independently
   tested (Rust unit, db integration with a concurrent race, E2E verbatim
   resends).
4. **Reconnect convergence**: authenticate → join (state summary) →
   catch-up (cursor-paged) → resend unacked (same identities) — replicas
   converge with no manual refresh (E2E-proven including a page-reload-
   equivalent fresh replica and a SIGKILL'd gateway).
5. **Authorization is per-batch**, not per-connection: downgrades take
   effect on the next write (live-downgrade E2E).
