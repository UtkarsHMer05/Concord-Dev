# Concord — Local Operation Protocol (Phase 2)

Status: Authoritative (implemented — native + WASM parity-tested)
Version: protocol v1
Last updated: 2026-09-06

This document specifies the canonical operation and document model for
Concord's local-first CRDT core (DEC-023). It is implementation-neutral: an
engineer could build a compatible local engine from this spec alone. The
network transport, framing, and gateway protocol are **out of scope here**
(Phase 3 will extend, not replace, this schema).

Related: [CONSISTENCY_MODEL.md](CONSISTENCY_MODEL.md) (invariants),
[DECISIONS.md](DECISIONS.md) DEC-023.

---

## 1. Identity model

| Concept | Definition |
|---|---|
| `ReplicaId` | unsigned 64-bit integer, nonzero. Generated randomly per replica session by the embedding layer; uniqueness across concurrently-editing replicas is the embedding layer's responsibility. |
| `Counter` | unsigned 64-bit, monotonic per replica, starts at 1, never reused, no gaps for generated ops. |
| `OpId` / `ItemId` | the pair `(ReplicaId, Counter)`. An insert operation's OpId is the identity of the item it creates. Total order on identities (used for integration tie-breaks and attribute ordering with Lamport): lexicographic `(ReplicaId, Counter)` — see §4. |
| `LamportClock` | unsigned 64-bit per replica: `max(local, received) + 1` on every operation. Used only for attribute register ordering. |
| Protocol version | unsigned 8-bit, currently `1`. |

Correctness never consults wall-clock time.

## 2. Document model

The document is a single ordered sequence of **items**. Each item is one of:

- **Text item** — one Unicode scalar value plus a mark set
  (`bold`, `italic`, `underline`, `strikethrough`: boolean registers).
- **Block-delimiter item** — starts a new block; carries block attributes
  (`type`: `paragraph` | `heading-1` … `heading-6`; `align`: left/center/right/justify).

Derived structure:

- A **block** is a maximal run of text items following one delimiter item.
- The document root has an implicit start delimiter (the first block exists
  before any user-visible delimiter; the root delimiter may itself carry
  attributes — e.g. the title-block heading).
- Empty blocks (a delimiter with no following text items before the next
  delimiter) are legal and preserved.

Items are either **live** or **tombstoned** (deleted). Tombstones remain in
the sequence for correctness (no reclamation in Phase 2 — see
[CONSISTENCY_MODEL.md](CONSISTENCY_MODEL.md) §4).

## 3. Operations

Four operation types. Every operation carries:

- `version` (u8, = 1),
- `type` (u8),
- `origin` `(ReplicaId, Counter)` — the generating replica and its counter,
- `lamport` (u64).

### 3.1 `insert` — create an item

Fields: `itemId` (= origin identity), `left` (ItemId or null = sequence
start), `right` (ItemId or null = sequence end), `kind`
(`text` | `delimiter`), and either `scalar` (a single Unicode scalar, for
text) or `blockAttrs` (initial delimiter attributes).

The generating replica anchors the insert between its current left and right
neighbors (which may be tombstones). Concurrent inserts sharing a neighbor
are ordered deterministically by the integration rules (§4) using item
identities.

### 3.2 `delete` — tombstone an item

Fields: `target` (ItemId). Applying delete marks the target tombstoned. It
is idempotent. A `delete` may arrive before its target's `insert` (deliveries
are asynchronous); the delete is retained and applied upon target integration.

### 3.3 `setAttr` — write a register

Fields: `target` (ItemId), `name` (string), `value` (string or null = clear).
Register winner: highest `(lamport, originReplicaId)`; ties impossible
(replica ids are unique). Validation restricts names per item kind (§5).

### 3.4 `batch`

A batch is an ordered list of operations from a **single** replica with
consecutive counters, applied in order as one unit by local consumers.
Batches are a convenience; delivery systems may split them — convergence
never depends on batch boundaries.

## 4. Integration rules (normative summary)

When integrating `insert` on a replica that has already integrated its
anchors:

1. Locate `left` and `right` anchor items in the sequence (tombstones count;
   null = sequence start/end).
2. Resolve conflicts with items lying between the anchors using the
   YATA-style rules: direct siblings of the left anchor whose identity
   compares greater than the incoming item are placed before it; deeper
   (non-sibling) items recursively shift the scan boundary; identities use
   the total order `(ReplicaId, Counter)` unless overridden by the
   Lamport-based attribute rules.
3. The full algorithm, including its proof obligations, is documented in the
   core source (`cpp/crdt`) and validated by: concurrent-insert unit tests,
   seeded randomized convergence suites, and the deterministic multi-replica
   simulator (native and WASM parity vectors).

An `insert` whose anchors have not yet been integrated is **pending**: it is
buffered (bounded — see §5) and retried when a referenced item appears.
After delivery of all operations, no op remains pending.

## 5. Validation and limits

An operation is rejected (structured error, no state mutation) unless:

- `version` is supported;
- `type` is known;
- `originReplicaId` ≠ 0; `counter` ∈ [1, 2⁶³−1]; `lamport` ∈ [1, 2⁶³−1];
- text scalars are valid Unicode scalar values (no surrogates), and are not
  U+0000;
- `name`/`value` strings are valid UTF-8; `name` ≤ 64 bytes; `value` ≤ 256
  bytes; `name` is in the allowed registry for the item kind
  (text marks vs block attributes);
- `blockAttrs.type` is an allowed block type;
- serialized size ≤ 64 KiB per operation;
- a replica's pending-op buffer holds ≤ 100 000 operations (local resource
  limit; exceeding it is a surfaced degraded state, not silent data loss).

Counter overflow on generation is a programming error surfaced as a
structured failure (the replica refuses further generation).

## 6. State summary (version vector)

A summary maps `ReplicaId → highest contiguous counter known from that
replica`. Summaries can compare (less/eq/greater/mixed), detect the set of
potentially missing operations, and serialize canonically. Gaps (received
counter > summary+1) are tracked explicitly, never silently collapsed.

## 7. Canonical serialization

- Versioned byte format, explicit little-endian integers, length-prefixed
  UTF-8 strings — no host-endianness or native memory-layout dependence.
- Deterministic: the same state always yields the same canonical bytes
  (used for hashing and golden vectors).
- Operation encoding starts with `version:u8`; snapshot encoding is a
  separate versioned container (see PROTOCOL evolution below).
- Forward evolution: unknown op types in a *higher* version are rejected;
  new optional fields are added in a backward-compatible manner with the
  version bump and documented decode rules. Snapshot format carries its own
  version byte; v1 readers reject unknown snapshot versions.

## 8. Deliberate Phase 2 limitations

- One item per `insert` (no run encoding) — simplicity over size; measured
  in benchmarks and revisited with evidence.
- Supported block types: `paragraph`, `heading-1`…`heading-6`. Lists, tables,
  images, and other tree structures are **not** collaboratively modeled in
  Phase 2 (documented in PRD capability status; they remain usable
  non-collaboratively through the existing editor path where applicable).
- Tombstone garbage collection: not implemented (deferred, see consistency
  model).
