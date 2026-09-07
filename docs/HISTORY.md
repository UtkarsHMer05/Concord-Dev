# Concord — History and Restore

Status: Authoritative
Version: 1.0 (Phase 5)
Last updated: 2026-09-07

The version-history model: what a revision is, how historical state is
reconstructed, and how restore works without rewriting history.

---

## 1. Three distinct layers (never conflated)

| Layer | What it is | Unit |
|---|---|---|
| Raw CRDT operations | every durable edit | `crdt_operations` rows |
| Internal snapshots | maintenance artifacts at a durable boundary | `crdt_snapshots` rows |
| User-visible revisions | named/auto checkpoints + restore events | `crdt_revisions` rows |

Not every keystroke is a revision. Revisions reference a durable
boundary (`target_seq`), not embedded content — reconstruction always
derives state from the snapshot + operation log.

## 2. Revision kinds

- **auto_checkpoint**: created by policy (e.g., every N durable
  operations or M minutes of activity) — labels like "auto @ 12:04".
- **named**: created by a user with OWNER/EDITOR permission
  (e.g., "Before refactor"); triggers (does not block on) a snapshot
  build at the current boundary.
- **restore_event**: created by a restore; records actor, source
  revision, and the boundary restored from.

## 3. Listing and viewing

- Listing a document's revisions requires document READ access
  (OWNER/EDITOR/COMMENTER/VIEWER); ACL denial is indistinguishable
  from not-found (deny-by-default, consistent with the rest of
  Concord).
- Creating a named revision requires EDITOR or OWNER.
- Viewing a historical reconstruction requires READ access.
- Restoring requires OWNER (destructive-to-current-state action; see
  §5) — verified by IDOR/cross-tenant tests (M034/M037).

## 4. Historical reconstruction (read-only, deterministic)

Given revision boundary `B`:

1. Select the newest FINALIZED snapshot with `coverage_seq ≤ B`
   (validated: format, document, checksum); else start empty.
2. Replay operations with `id > snapshot.coverage_seq AND id ≤ B`.
3. Return the canonical read-only content and digest.

Same boundary ⇒ same digest, always (R8). Targets before the first
snapshot, exactly on a snapshot boundary, between snapshots, and at
the current head are all valid reconstruction points (tested M035).

## 5. Restore semantics (forward-moving, auditable)

Restore NEVER deletes or rewrites durable operation history. A
restore at revision boundary `B`:

1. Reconstructs the target state at `B` (as in §4).
2. Computes a **surgical forward-op batch** against the current
   converged state: delete-ops for items visible now but not visible
   at `B`; insert-ops re-creating items visible at `B` but tombstoned
   now (un-delete is impossible in a tombstone CRDT — re-insertion is
   the forward equivalent; DEC-023 tombstone model).
3. Ingests that batch through the normal durable path (transaction,
   durable ACK, broker publish, fanout) under a reserved
   **maintenance replica id** — so restore participates in the exact
   durability and propagation contract as any edit.
4. Records a `restore_event` revision (actor, source revision,
   boundary).

### 5.1 Concurrency semantics (explicit)

- Acknowledged concurrent edits are never silently discarded: any op
  already in the log stays there; a concurrent insert landing after
  the restore diff computation may survive visible (if outside deleted
  ranges) — the CRDT merge decides, consistently, on every replica.
- Active clients receive the restore batch as a normal fanout batch —
  they apply it and converge; no special resync is required (a client
  offline across the restore catches up via the normal delta path,
  since restore does not compact anything).
- Two concurrent restores: both batches merge CRDT-safely; the last
  writer's inserts win textually per YATA integration; outcome is
  convergent (and both events are auditable).

### 5.2 Why no generation/reset primitive

A document-generation reset would require a C++ core format change
(pending-client divergence, new invariants, WASM compat) and buys
nothing correctness-wise: the surgical forward-op batch is itself
CRDT-safe, convergent, and auditable. Revisit only if restore
frequency makes tombstone accumulation a measured problem
(Phase 5 benchmarks decide).

## 6. Revision invariants (each maps to an automated test)

| # | Invariant | Test |
|---|---|---|
| H1 | Revision rows never embed payload; reconstruction derives state | schema test |
| H2 | Historical reconstruction deterministic per boundary | seeded digest tests |
| H3 | History listing enforces document READ ACL | IDOR matrix |
| H4 | Named revision creation enforces EDITOR+ | permission matrix |
| H5 | Restore requires OWNER; recorded with actor + source | authz test |
| H6 | Restore appends only; op-log rows before restore unchanged | log-immutability test |
| H7 | Active collaborators converge after restore batch | concurrency E2E |
| H8 | Restore of a restore is just another restore event | composition test |
