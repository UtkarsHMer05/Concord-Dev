# Concord — Failure Model and Durability Contract (Phase 3 history + current v1)

Status: Authoritative · §1–§4 preserve the Phase 3 boundary history; §7 onward
records the current v1 distributed/storage contract.

This document defines what Concord's synchronization layer does under every
failure it can suffer, and precisely what an acknowledgement means. It is the
basis for the fault tests in `tests/realtime/**`.

## 1. The durability contract

### 1.1 `ACK_DURABLE`

An operation delivered by the gateway as **durably acknowledged
(`ACK_DURABLE`)** means exactly:

> the operation has passed server-side authentication, server-side
> authorization, envelope validation, and has been committed to PostgreSQL
> under its stable operation identity (`(document_id, operation_id)`),
> atomically with the rest of its batch.

`ACK_DURABLE` does **not** mean:

- every connected peer has already applied it (fanout is asynchronous),
- a future Phase 4 broker replicated it,
- a production multi-region database replicated it,
- the operation is visible in any client (CRDT application is the client's job),
- any server-side "ordering" was assigned that defines CRDT conflict semantics.

The durability level of an ACK is therefore: **PostgreSQL-local, single-node,
durable under process crash** (a committed transaction survives the gateway
restarting). It is a *receive-and-store* guarantee toward the server, not a
*peer-delivery* guarantee.

### 1.2 Batch rule

A `client_ops` batch is **all-or-nothing**: either every operation in the batch
is committed under its stable identity and one `durable_ack` is emitted naming
the batch, or the batch fails with a `database_unavailable`/`internal_error`
and NO durable ack is emitted. Partial acceptance never happens at the SQL
transaction boundary in this phase (a misbehaving batch can be rejected
wholesale; there is no per-op partial ack).

### 1.3 No "exactly once" claim anywhere

Delivery is **at-least-once, idempotent**: retries are expected, duplicates are
safe, PostgreSQL uniqueness prevents a second durable row, and the CRDT core
makes duplicate application a no-op.

## 2. Failure cases (each must be tested)

### 2.1 Duplicate client send
Client resends the same `client_ops` batch (same operation identities).
- Server: authz/validate → `INSERT … ON CONFLICT (document_id,operation_id)
  DO NOTHING`; duplicates resolve to the existing durable row; the batch is
  ACKed deterministically. **No second durable row.**
- Test: `duplicate resend` (P3-M038).

### 2.2 Delayed client send
A client that was offline sends ops that are causally older than ops already
on the server.
- Server: accepts and persists under stable identities (no causal requirement);
  the CRDT core merges them in any arrival order. `durable_ack` still emitted.
- Test: offline-edit-then-reconnect (P3-M036).

### 2.3 Gateway crash before DB commit
The process dies while persisting a batch.
- The batch may be lost (never ACKed); the client's ops remain **pending**
  locally and are retried with the SAME identities on reconnect. No durable
  state is corrupt.
- Test: kill/restart (P3-M039).

### 2.4 Gateway crash after DB commit before ACK
Committed rows exist; the ACK frame was never sent.
- Client keeps ops pending and retries; inserts resolve to the existing rows
  (2.1). One durable row per operation identity. This is why the ACK contract
  must not be used to infer client state — the client MUST resent until ACK.

### 2.6 Browser reconnect
- Client authenticates → joins with its state summary → server catches it up
  (bounded sync batches) → client resends still-pending local ops → server
  idempotently persists + ACKs → convergence (P3-M034).

### 2.7 PostgreSQL temporarily unavailable
- The gateway does NOT emit `durable_ack`. Write attempts fail with
  `database_unavailable` (safe error frame; the pending batch stays client-
  side). Readiness endpoint flips to "not ready". The gateway keeps serving
  authenticated frames and heartbeats; it must not buffer an unbounded
  durable backlog in memory (bounded queues only). On DB recovery, clients
  retry and converge (P3-M040).

### 2.8 Malformed frame
- Decode failure → `malformed_frame` error; the frame is dropped; the
  connection state machine is unchanged (or closes only if the frame was a
  state violation). Oversized frames → `payload_too_large` + close.
  Nothing is persisted. (P3-M030/P3-M045)

### 2.9 Token expiration / revoked permission
- `authenticate` with an expired/malformed token → `unauthorized`. An open
  connection whose write permission is revoked mid-session: **write
  authorization is rechecked on every batch** (the Phase 3 policy: recheck
  per write — correctness over micro-optimization, P3-M037). A VIEWER or
  COMMENTER sending content ops → `forbidden`; durable rows never appear.
  Read-only members remain joined for reads.

### 2.10 Slow consumer
- Per-connection outbound queue is bounded (capacity N). A peer that does not
  drain: durable document updates are never silently dropped → the connection
  is disconnected when its queue is full for a bounded stall (slow-consumer
  disconnect), and the peer recovers via catch-up after reconnect. Control
  frames (draining/error/ping) take a priority path. (P3-M026/P3-M028)

### 2.11 Graceful server drain
- On SIGTERM/SIGINT: stop accepting → send `server_draining` → stop new
  writes at the cutoff → let in-flight batches finish within a bounded grace
  window (they may still ACK — committed before the close) → close → exit.
  A client that never got the ACK retries after reconnect (2.4) — safe.

### 2.12 Accepted-but-lost-in-memory states
- By contract there is no "ACKed but not persisted" state (1.2). The in-memory
  room registry holds NO durable truth (P3-M025): a restart rebuilds rooms
  from client joins + the PostgreSQL op log only.

## 3. What the Phase 3 server did NOT do (historical boundary)
- It does not reorder operations into a CRDT-conflict-correct order.
- It does not assign arrival-time semantics to operations.
- Phase 3 did not garbage-collect or snapshot; current v1 adds both in the
  Phase 5 storage/recovery plane described below.
- It never trusts a client-supplied role/user id.

## 4. Phase 4 boundary (historical planning note)
The Phase 4 design was initially a target; it is implemented in §7. Broker
fanout adds transport freshness but never changes `ACK_DURABLE`: PostgreSQL
local commit remains the durability floor and the broker is not an authority.
---

## 7. Phase 4 distributed failure contract (CURRENT as of Phase 4)

Non-negotiable invariant (I-1):

> Every operation for which the client received `durable_ack` is committed
> in PostgreSQL. Any replica can reconstruct full document state from
> PostgreSQL alone. Broker and Redis are accelerants, never authorities:
> losing both simultaneously degrades realtime freshness but never durable
> correctness — every client converges via the Phase 3 catch-up path.

### 7.1 Gateway crash
One gateway dies (kill -9): its rooms vanish (in-process only); the load
balancer stops routing to it; clients reconnect with backoff+jitter to any
healthy gateway and converge via state-summary catch-up. Other gateways
are unaffected. Tested: M030, M039.

### 7.2 NATS outage / redelivery
Publish failure never falsifies `ACK_DURABLE` (publish is strictly
after-commit, best-effort: M013). During outage: local writes + same-
gateway fanout + durable ACKs continue; cross-gateway realtime degrades
(pull-based catch-up on demand). On restore: subscriptions resume without
duplication; redelivered events are deduped by stable operation identity
(the same (document_id, operation_id) key — DB-enforced; client CRDT is
additionally idempotent). NATS never defines CRDT order. Tested: M019,
M020, M036, M038.

### 7.3 Redis outage / full wipe
Redis holds only presence, rate-limit counters, and hints (M007 keymap).
Outage: rate limiting falls back to a documented local mode (M024);
presence degrades (absent ≠ incorrect); durable paths never touch Redis.
Wipe (FLUSHALL): documents, ACLs, and the operation log are untouched
(PostgreSQL); presence rebuilds from heartbeats; counters reset to zero
(re-accumulating). Tested: M037.

### 7.4 Reconnect to a different gateway
No sticky sessions anywhere: all client state is local (IndexedDB) or
durable (PostgreSQL). A reconnect lands on any gateway; authorization is
re-verified; catch-up uses the persisted server cursor; unacked ops
resend under original identities. Tested: M029.

### 7.5 Broker lag
A lagging gateway drains its backlog in bounded batches; duplicate
tolerance makes replay safe; if the backlog is superseded by a room
catch-up, clients still converge (PostgreSQL floor). Tested: M036.

### 7.6 DB outage (unchanged from §2.7)
No false ACK; retryable errors; readiness flips. Multi-gateway changes
nothing — every gateway applies the same rule.

### 7.7 Compound gateway + broker failure
Both may fail concurrently: acknowledged ops are already in PostgreSQL;
unacknowledged ops remain client-pending and resend after recovery;
replicas converge on restore. Tested: M039.

### 7.8 Feedback loops
Broker-received events enter a SEPARATE ingress path (no re-publish of
consumer traffic; origin-gateway suppression); duplicate DB rows are
impossible (unique identity). Tested: M017.

## 8. Phase 5 storage failure contract (CURRENT as of 2026-09-07)

1. **Worker crash/timeout/nonzero exit**: classified retryable vs
   terminal; the maintenance job retries within bounds; un-finalized
   snapshot attempts are never visible to recovery. No document state
   is affected.
2. **Corrupt snapshot (bit rot, torn writes)**: fails the M013 matrix
   per candidate; recovery walks newest→older FINALIZED and falls back
   to full replay. Never serves corrupt state; never aborts recovery.
3. **Gateway crash mid-job**: lease expires; the sweep re-queues
   (retryable) or terminally fails (exhausted). The claim fence makes
   the dead gateway's late actions no-ops.
4. **Crash mid-compaction**: every prune batch commits with its floor
   advance in one transaction (floor ≤ verified coverage ALWAYS);
   resumption completes idempotently; the crash matrix (M033) proves
   each crash point recoverable. Durable-ACKed ops are either in the
   log above the floor or covered by the FINALIZED floor snapshot.
5. **Stale client below the floor**: served `snapshot_resync_required`
   + the covering snapshot; pending local ops re-apply after import
   (applied-set dedup makes server-known duplicates no-ops). No
   legitimate client is ever unrecoverable.
6. **Restore of a pruned boundary**: refused with a structured error
   (`RestoreTargetPruned`) — history retention protects revision-
   referenced snapshots; unpruned restores re-apply as forward ops
   through the durable path.
