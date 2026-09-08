# Concord — Recovery

Status: Authoritative
Version: 1.0 (Phase 5)
Last updated: 2026-09-07

How a document's converged CRDT state is reconstructed — for gateways,
for stale clients, and after corruption — with the invariants tests
enforce. Storage layout is in `docs/STORAGE.md`.

---

## 1. Recovery modes

| Mode | When used | Cost |
|---|---|---|
| Full replay | No usable snapshot; history reconstruction before first snapshot | O(ops) |
| Snapshot + tail | Normal gateway recovery once a FINALIZED snapshot exists | O(snapshot import + tail ops) |
| Snapshot resync | Client older than the compaction floor | One snapshot + pending-preserve + tail |

All three end in the same canonical state; the differential verifier
(M021) proves equality continuously.

## 2. Gateway recovery (document open / reconnect)

Unchanged from Phase 4 (join → `join_accepted{durable_cursor}` →
bounded `sync_request` pages) with one addition (M029/M031): before
serving a delta catch-up the gateway reads the document's compaction
floor:

1. `client_cursor >= floor` (or no floor): delta catch-up pages
   (`id > cursor`, ordered, bounded) — the Phase 3/4 path.
2. `client_cursor < floor`: respond `snapshot_resync_required`
   (§4); the client imports the covering snapshot then resumes delta
   catch-up from the snapshot's boundary.

Crash rule: if no FINALIZED snapshot validates, recovery falls back to
full replay — the pre-Phase 5 behavior. Snapshots are an
acceleration, never a correctness dependency.

## 3. Server-side snapshot+tail reconstruction (M020)

```
PostgreSQL op log ──ops ≤ S──▶ native worker (C++ CRDT)
                                      │ export v1 snapshot
                                      ▼
                        snapshot attempt row (non-finalized)
                                      │ verify (M017)
                                      ▼
                              FINALIZED snapshot

Recovery = import FINALIZED snapshot at boundary S
         + replay ops with id > S (idempotent; dedup by applied-set)
```

The native worker is a standalone process (bounded stdin/file input,
machine-readable protocol, timeouts) — no in-process FFI. The C++
core stays the semantic authority; Rust orchestrates I/O, jobs,
leases.

## 4. Stale-client snapshot resync (M028/M031)

1. Client sends `sync_request{cursor}` with `cursor < floor`.
2. Gateway replies `snapshot_resync_required{boundary, snapshot_id}`.
3. Client fetches the snapshot (`fetch_snapshot` → `snapshot_payload`;
   the payload frame carries the declared wrapper size — the client's
   size and checksum defenses run BEFORE import; the read path is
   rate-limited by the shared `fetch` scope) and imports it into the
   WASM CRDT while PRESERVING its own pending, not-yet-durable local
   ops (they stay in the IndexedDB outbox).
4. Client sets its cursor to the snapshot boundary and replays its
   pending ops locally (they were never in the server log), then
   requests normal delta catch-up from the boundary.
5. Pending ops resubmit under ORIGINAL identities; the server's
   unique index + the snapshot's applied-set make duplicates harmless.

The full flow (signal → fetch → validate → import → re-apply pending →
resume catch-up) is wired through the browser SyncSession and E2E-tested
against a live gateway in the realtime suite.

No legitimate client becomes permanently unrecoverable: any client can
always fall back to full snapshot resync, and any gateway can always
fall back to full replay.

## 5. Corruption and fallback (M019)

Selection walks newest→oldest FINALIZED snapshots. Each candidate is
validated (format version, document id, coverage boundary, checksum,
digest when available). First failure ⇒ next candidate. None usable ⇒
full replay. A corrupt snapshot never aborts recovery; it is quarantined
(status → FAILED-integrity or superseded) and reported.

## 6. Worker failure (M015/M033)

Worker timeout/nonzero exit/malformed output ⇒ structured job failure
(classified retryable vs terminal), bounded retry with attempt count,
lease released. Crash mid-build leaves at most a non-finalized attempt
row, which recovery ignores by definition. No crash point in the
pipeline can make a document unrecoverable: un-finalized attempts are
never used; pruning is transactionally tied to a FINALIZED snapshot.

## 7. History reconstruction and restore (M034–M037)

- **Historical read** (read-only): nearest FINALIZED snapshot at or
  before the target revision boundary → replay ops up to the revision
  boundary → canonical read-only content. Deterministic for a given
  boundary.
- **Restore** (forward-moving): restore does NOT rewrite or delete the
  durable operation log. It appends new forward operations (a
  generation-boundary restore event plus content operations derived
  from the target revision), recorded as an auditable revision with
  actor and source. Concurrent acknowledged edits are never silently
  discarded — the restore mechanism is CRDT-safe (see
  `docs/HISTORY.md`).

## 8. Recovery invariants (each maps to an automated test)

| # | Invariant | Test |
|---|---|---|
| R1 | Recovery equals full replay for seeded histories (multiple seeds, rich-text op mix) | differential verifier suite |
| R2 | Ops arriving after the snapshot build boundary are excluded from the snapshot and remain in the tail | boundary test |
| R3 | Duplicate tail replay is harmless | duplicate-tail test |
| R4 | Newest corrupt snapshot ⇒ older snapshot ⇒ full replay fallback | corruption matrix |
| R5 | Client below floor resyncs and converges (browser E2E) | resync E2E |
| R6 | No crash point (pre-finalize, post-finalize pre-prune, mid-prune, post-prune) leaves a document unrecoverable | fault-injection matrix |
| R7 | A previously durable-ACKed operation never becomes lost due to compaction | equivalence + retention tests |
| R8 | Historical reconstruction is deterministic (same boundary ⇒ same digest) | history tests |
