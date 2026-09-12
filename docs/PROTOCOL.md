# Concord — Protocol (Local Operation Schema + Phase 3 Wire Layer)

Status: Authoritative (implemented — native + WASM parity-tested; wire protocol v1 IMPLEMENTED and cross-language golden-tested)
Version: protocol v1 · wire protocol v1
Last updated: 2026-09-07 (Phase 3 wire layer implemented in Rust + TypeScript)

This document specifies the canonical operation and document model for
Concord's CRDT core (DEC-023) and the Phase 3 synchronization wire protocol
(DEC-029). The local model is implementation-neutral; the wire model is what
the browser runtime and the Rust gateway both speak.

Related: [CONSISTENCY_MODEL.md](CONSISTENCY_MODEL.md) (invariants),
[FAILURE_MODEL.md](FAILURE_MODEL.md) (durability/ACK contract),
[DECISIONS.md](DECISIONS.md) DEC-023 / DEC-029.

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
  (`type`: `paragraph` | `heading-1` … `heading-6`; `align`: left/center/right/justify;
  `lineHeight`: `normal` | `1` | `1.15` | `1.5` | `2` — the fixed product set).

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

## 9. Phase 3 wire protocol (sync transport)

### 9.1 Overview

- **Transport:** WebSocket. `ws://` in local dev; `wss://` is a deployment
  configuration (Phase 7) — no protocol change.
- **Gateway endpoint:** `/api/v1/sync`.
- **Wire protocol version:** `1`. The CRDT local operation protocol also has
  its own version byte (currently `1`) — the two are independent.
- **Encoding decision (DEC-029):** **control frames are compact typed JSON**
  (text WebSocket messages); **data frames that carry CRDT operation bytes
  (`client_ops`, `sync_batch`) are binary.** Rationale: Phase 2 defines
  canonical binary serialization of operations (§7), which must travel
  verbatim (no base64 inflation, no semantic fork); control frames are
  low-volume, debuggable, and trivially mirrored in TypeScript without schema
  codegen. Rejected alternatives are recorded in DEC-029.

### 9.2 Text frame envelope

```json
{ "v": 1, "type": "hello", "id": "<optional correlation id>", "payload": { ... } }
```

`id`, when present on a request, is echoed verbatim by the server in the
matching reply so the client can correlate without maintaining socket state
per frame type. Unknown `type` → `error` frame with `unknown_frame_type`.
Unknown `v` → behavior defined in §9.12.

### 9.3 Binary frame layout

All integers big-endian. `kind` byte selects the binary frame type.

```
client_ops:  [0x01] [0x20] [batch_id u64] [count u16] { [op_len u16] [op bytes] }*
sync_batch:  [0x01] [0x21] [next_cursor u64] [has_more u8] [count u16] { [op_len u16] [op bytes] }*
```

- `op bytes` are the Phase 2 canonical operation frames (§7, `payload_version
  = 1`) — the gateway stores them verbatim and never rewrites them.
- `next_cursor` is the server-sequence high-water mark of the batch (the
  highest `crdt_operations.id` included).
- `has_more`: `1` when another `sync_batch` follows.

### 9.4 Frame catalogue

| Frame | Direction | Payload |
|---|---|---|
| `hello` | c→s | `{ clientProtocolVersion: u32 }` |
| `hello_ack` | s→c | `{ protocolVersion: u32, connectionId: string }` |
| `authenticate` | c→s | `{ token: string }` (Clerk session JWT) |
| `authenticated` | s→c | `{ userId: uuid, clerkUserId: string, orgId: uuid? }` |
| `join_document` | c→s | `{ documentId: uuid, stateSummary: [{ replicaId: string, sequence: string }] }` (u64 as decimal strings) |
| `join_accepted` | s→c | `{ documentId: uuid, role: "owner"\|"editor"\|"commenter"\|"viewer", durableCursor: string }` |
| `sync_request` | c→s | `{ cursor: string }` (server-seq cursor; u64 decimal) |
| `sync_batch` | s→c | binary data frame (§9.3) |
| `sync_done` | s→c | `{ }` (marks the end of catch-up; only then READY) |
| `client_ops` | c→s | binary data frame (§9.3) |
| `durable_ack` | s→c | `{ batchId: string, opIds: [string] }` → **ACK_DURABLE** |
| `snapshot_resync_required` | s→c | `{ boundary, snapshotId, snapshotChecksum, snapshotFormatVersion, coverageOpCount }` (u64s as decimal strings; sent instead of delta pages when the client's cursor precedes the document's compaction floor) |
| `fetch_snapshot` | c→s | `{ snapshotId: uuid }` (rate-limited: `fetch` scope, 30/min/connection) |
| `snapshot_payload` | s→c | `{ snapshotId, formatVersion, coverageSeq, coveredOpCount, stateDigest, checksum, payloadBase64, payloadSize }` — base64 wrapper bytes + declared size (the client's size/checksum defenses are live on this transport) |
| `ping` | c→s | `{ nonce: u64 }` |
| `pong` | s→c | `{ nonce: u64 }` |
| `error` | both | `{ code, message, requestId? }` (§9.8) |
| `server_draining` | s→c | `{ reason: "shutdown", graceMs: u32 }` |

Role strings map from the Phase 1 effective role (`OWNER`/`EDITOR`/
`COMMENTER`/`VIEWER`, lowercased on the wire), computed server-side from
PostgreSQL — never from client input.

### 9.5 Handshake and authentication

1. Client connects to `/api/v1/sync` and sends `hello` with its
   `clientProtocolVersion`.
2. Server replies `hello_ack {protocolVersion, connectionId}`, or
   `error {unsupported_protocol_version}` followed by a close when versions
   are incompatible.
3. Client sends `authenticate {token}` with its **Clerk session JWT**. The
   token travels in-message because browser WebSocket APIs cannot set an
   Authorization header; it is never placed in a URL query string.
4. Server verifies the token server-side (signature via JWKS, issuer, expiry,
   subject) and replies `authenticated {userId, clerkUserId, orgId?}`, or
   `error {unauthorized}` + close. The verified principal is the only truth;
   client-supplied identities are never trusted.

At `client_ops` ingress, origin replica IDs `0x53595343` (`SYSC`) and
`0x52455354` (`REST`) are rejected as server-owned maintenance identities.
Older ordinary client IDs remain accepted; newly allocated browser IDs use
the upper half of the unsigned 64-bit namespace.

### 9.6 Join and initial sync

5. Client sends `join_document {documentId, stateSummary}` where
   `stateSummary` is its per-replica counter vector (§6 of the local spec) —
   used as a safety check; the **server-sequence cursor is the catch-up
   primitive** (see 9.7).
6. Server resolves the document's effective role from PostgreSQL
   (owner > direct ACL > org member EDITOR > deny) and replies:
   - `join_accepted {documentId, role, durableCursor}` — `durableCursor` is
     the server's current high-water mark (the client's starting point), or
   - `error {forbidden}` (no access; the no-access client learns nothing
     beyond the error code).
7. The server streams `sync_batch` data frames with ops whose server id is
   greater than the client's requested cursor (or its `durableCursor`), then
   `sync_done {}`. The state becomes READY only after `sync_done`.

### 9.7 Catch-up model (documented choice)

The primary fetch primitive is the **server-sequence cursor**: ops are
ordered by `crdt_operations.id` (a BIGSERIAL) and fetched in bounded,
deterministic pages (`cursor`, `limit`). The state summary is NOT the fetch
primitive — sets are harder to page deterministically — but it accompanies
joins so the server can sanity-check the client's claimed replica coverage.
A client that lost its cursor re-syncs from `0` (bounded batches). Server
order is a **storage/fetch order surrogate only**; it never defines CRDT
conflict resolution (the C++/WASM core does, by identities).

**Snapshot resync (Phase 5).** When a `sync_request` cursor precedes the
document's compaction floor, delta catch-up is impossible (the covered ops
are pruned). The server answers with `snapshot_resync_required` instead of
pages: the floor boundary + the covering FINALIZED snapshot's metadata
(validated + access-checked before the signal). The client then sends
`fetch_snapshot` and receives `snapshot_payload`, re-validates integrity
independently (checksum over the wrapper bytes, declared size, document
identity, coverage agreement with the announced signal), imports the
snapshot atomically, re-applies its own unacked ops under their original
identities, sets its cursor to the boundary, and resumes delta catch-up
from there. A client never loses its own unacked work to a resync.

### 9.8 Error codes

`unauthorized`, `forbidden`, `unsupported_protocol_version`,
`unknown_frame_type`, `invalid_state`, `malformed_frame`,
`payload_too_large`, `rate_limited` (enforced: snapshot read paths —
`fetch_snapshot` and the `sync_request` resync decision share the
`fetch` scope, 30/min/connection; `connect` is enforced at upgrade),
`database_unavailable`, `server_draining`, `internal_error`.

Error frames carry a safe `message` and never expose SQL details, stack
traces, or internal identifiers. Server logs record the full structured
context.

### 9.9 Heartbeat

The server sends `ping {nonce}` when idle past the heartbeat interval; the
client MUST reply `pong {nonce}`. The client may also ping. An idle
connection past the idle timeout is closed and its session cleaned up.
Heartbeats use control frames, not WebSocket-level ping frames, so they are
visible to the protocol layer and proxies uniformly.

### 9.10 Draining

On SIGTERM/SIGINT the server stops accepting connections, sends
`server_draining {reason:"shutdown", graceMs}`, stops accepting new
`client_ops` at the cutoff, lets in-flight batches commit within the grace
window, then closes. A client that was mid-batch reconnects and resends
(pending ops) — the contract in FAILURE_MODEL §2.4 keeps this safe.

### 9.11 Limits (wire)

- max WebSocket frame size: **8 MiB**,
- `client_ops` batch: `count ≤ 1024` ops and total payload ≤ 4 MiB,
- per-operation size ≤ 64 KiB (Phase 2 §5),
- `sync_batch` page: `count ≤ 1024` ops,
- token length cap: 32 KiB (defense-in-depth); attribute name/value caps
  from the local spec apply before anything is persisted.

Exceeding any limit → `payload_too_large`/`malformed_frame` error; oversized
frames abort the connection.

### 9.12 Unknown/unsupported version behavior

- Client sends `clientProtocolVersion > 1` → server replies
  `error {unsupported_protocol_version}` and closes.
- Server speaking a newer protocol than the client → server downgrades to the
  client's version when backward-compatible; otherwise the same error. A
  client receiving `unsupported_protocol_version` marks the gateway
  incompatible, surfaces a safe message, and retries with bounded backoff.
- Unknown frame `v` in a text frame → `error {unsupported_protocol_version}`.

### 9.13 Connection state machine (normative)

```
CONNECTING → (hello/hello_ack) → AUTHENTICATING → (authenticated) → AUTHENTICATED
→ (join_document/join_accepted) → JOINING → SYNCING → (sync_done) → READY
READY ──server_draining──▶ DRAINING ──close──▶ CLOSED
any ──protocol error / reject / close──▶ CLOSED (or REJECTED before READY)
```

Frames illegal for the current state receive `error {invalid_state}`. In
particular: `client_ops` before READY, `join_document` before
AUTHENTICATED, a second `join_document` without leaving the current
document, and any data frame after DRAINING are all rejected. The reviewer
tests these transitions (P3-M023/P3-M045).

### 9.14 Retry/replay semantics

- The client retries on the same stable operation identities (never
  regenerates IDs for resends — Phase 2 identity model).
- The server is idempotent under duplicates at the SQL layer.
- Reconnect flow: hello → authenticate → join (with state summary and last
  durable cursor) → catch-up → resend pending → READY → converge.

### 9.15 Rejected alternatives (see DEC-029 for full record)

- All-binary wire protocol (rejected: control frames are a handful of small
  variants; JSON keeps them debuggable and trivially shared with TypeScript
  without codegen).
- All-JSON with base64-encoded operation payloads (rejected: Phase 2 already
  has canonical binary op bytes — base64 inflates +33% and adds a second
  encoding layer for no correctness benefit).
- Auth token in a query string (rejected: leaks the session credential into
  logs/history).
- protobuf/flatbuffers schema (rejected: adds a codegen dependency for 15
  frame types; no cross-language tooling benefit in this phase).
