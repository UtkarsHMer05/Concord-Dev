# Concord — Storage

Status: Authoritative
Version: 1.0 (Phase 5)
Last updated: 2026-09-07

This document defines the durable storage model: what PostgreSQL owns,
how snapshots are stored and verified, the snapshot lifecycle, the
compaction floor, and the storage invariants that automated tests
enforce. Recovery procedures are in `docs/RECOVERY.md`.

---

## 1. Durable tiers (unchanged from Phase 4)

| Tier | Role | Loss tolerance |
|---|---|---|
| PostgreSQL | Durable source of truth: operation log, snapshots, revisions, maintenance jobs, compaction floor | Must never lose acknowledged data |
| Redis | Ephemeral presence/rate-limit/gateway liveness | May vanish at any time; durable paths never consult it |
| NATS JetStream | Distributed event transport between gateways | Ephemeral for correctness; PostgreSQL is the durable floor |

## 2. Operation log (existing, unchanged)

`crdt_operations` (one row per accepted CRDT operation):

- `id` — GLOBAL bigint identity (strictly increasing per document but
  with cross-document gaps); the durable server cursor.
- `(document_id, operation_id)` UNIQUE — operation identity (replica,
  counter) within a document; duplicate ingests resolve to the
  existing row, never a second row.
- `payload` bytea + `payload_version` (1) + `payload_checksum`
  (SHA-256 hex) — the canonical CRDT op bytes.
- Indexes: `(document_id, id)` catch-up; `(document_id, replica_id,
  replica_sequence)` replica scan.

Every accepted batch commits in one transaction; `durable_ack` exists
only after commit (Phase 3 contract, preserved).

## 3. Snapshots (Phase 5)

A **snapshot at durable boundary S** for document D is the full CRDT
replica state after applying exactly the operations of D with server
sequence ≤ S, produced by the C++ CRDT core (the semantic authority).

### 3.1 Payload structure

```
server snapshot wrapper (version 1)
├── wrapper format version        u8      (=1)
├── document id                   16B uuid
├── coverage boundary            u64     (server seq S)
├── op count covered              u64
├── inner payload len             u64
├── inner payload                 …       (unchanged C++ v1 snapshot)
└── wrapper checksum              32B     SHA-256 of everything above
```

The inner payload is the Phase 2 `Doc::export_snapshot()` byte string,
unchanged — it already carries the item stream (with tombstones,
origins, LWW registers), the applied-op-id dedup set, pending ops, and
per-replica contiguous counters. Because the inner format is
unchanged, the browser WASM import path continues to work for
snapshot resync.

### 3.2 Snapshot lifecycle (state machine)

```
REQUESTED → BUILDING → VERIFYING → FINALIZED
                │           │
                ▼           ▼
              FAILED ←──────┘   (attempt recorded; retryable)
FINALIZED → SUPERSEDED (retention; never mutated)
```

- **REQUESTED**: a durable job row exists; no snapshot payload.
- **BUILDING**: the owning worker fetches ops ≤ boundary and invokes
  the native worker. Payload is written as a non-finalized attempt.
- **VERIFYING**: independent verification runs (checksum, format,
  coverage, digest, import-in-fresh-replica, full-replay-differential
  where configured).
- **FINALIZED**: immutable. Payload, boundary, checksum, digest,
  format version can never change. This is the only state recovery
  may use.
- **FAILED**: terminal for the attempt; the job records the failure
  class and may retry (bounded attempts) or surface.
- **SUPERSEDED**: retention marking only; payload retained until
  retention policy allows deletion.

Transitions are guarded in SQL (a finalize must be a
`WHERE status = 'VERIFYING'` compare-and-set by the lease owner).
Recovery NEVER reads BUILDING/VERIFYING/FAILED/SUPERSEDED-for-deletion
rows.

### 3.3 Invariants (each maps to an automated test)

| # | Invariant | Test |
|---|---|---|
| S1 | Format version known and supported before any parse | corrupt/wrong-version rejection test |
| S2 | Document identity in wrapper matches the requested document | wrong-association test |
| S3 | Coverage boundary explicit and ≤ durable high-water at build time | boundary test |
| S4 | Checksum validates exact stored bytes (one-bit flip ⇒ reject) | bit-flip test |
| S5 | State digest validates expected CRDT state | digest mismatch test |
| S6 | Snapshot imports into a fresh native CRDT replica | import test |
| S7 | snapshot + tail replay == full replay (canonical digest equal) | differential verifier |
| S8 | Duplicate tail replay is harmless (applied-set dedup) | duplicate-tail test |
| S9 | FINALIZED payload/checksum/boundary immutable (repo API refuses; SQL guard) | mutation-attempt test |
| S10 | Recovery falls back: newest corrupt ⇒ older valid ⇒ full replay | fallback test |

## 4. Compaction floor (per document)

`documents.compaction_floor_seq` (nullable bigint): the oldest server
sequence from which direct delta catch-up is possible. Rows at or
below the floor may be pruned ONLY when a FINALIZED snapshot covers
them. The floor plus its snapshot reference
(`documents.compaction_floor_snapshot_id`) are updated in the SAME
transaction as prune progress so a crash can never leave a floor
without coverage.

Gateways read the floor to decide: `client_cursor >= floor` ⇒ normal
delta catch-up; `client_cursor < floor` ⇒ `snapshot_resync_required`.

## 5. Compaction safety ordering (non-negotiable)

Build → verify → finalize → mark coverage → prune. **Never prune
first.** Pruning is transactional and batched; automatic pruning stays
disabled until M032's end-to-end equivalence proof passes. A failed
compaction resumes from its recorded state-machine position.

## 6. Storage accounting (M039)

Lightweight counters/gauges only (see `docs/OPERATIONS.md`): op rows +
bytes per document, snapshot count/bytes, tail op count, latest
snapshot age, compaction floor, rows pruned, bytes reclaimed, snapshot
build duration, recovery duration, failed maintenance jobs.

## 7. Retention (M038)

Per document, at minimum: the newest FINALIZED snapshot plus every
snapshot referenced by a revision or by the compaction floor is
protected from deletion. Superseded, unreferenced snapshots become
deletion-eligible by age/count policy.

---

## 8. Phase 5 schema (gateway migration v2)

All Phase 5 tables are gateway-owned (registry
`gateway_schema_migrations`), additive only — Phase 1 tables are
never altered; `documents` gains only nullable compaction-floor
columns via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (safe on a
Phase 4-shaped database).

### 8.1 `crdt_snapshots`

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | internal row id |
| `snapshot_id` | UUID NOT NULL | public identity (opaque) |
| `document_id` | UUID NOT NULL FK→documents | ON DELETE CASCADE |
| `format_version` | SMALLINT NOT NULL | wrapper version (1) |
| `coverage_seq` | BIGINT NOT NULL | durable boundary S (ops with id ≤ S) |
| `covered_op_count` | BIGINT NOT NULL | ops represented in the snapshot |
| `state_digest` | TEXT NOT NULL | canonical CRDT digest at S |
| `state_summary` | JSONB NOT NULL | per-replica contiguous counters |
| `payload` | BYTEA NOT NULL | wrapper + inner v1 snapshot bytes |
| `payload_size` | BIGINT NOT NULL | exact payload byte length |
| `payload_checksum` | CHAR(64) NOT NULL | SHA-256 hex of payload bytes |
| `status` | TEXT NOT NULL CHECK in (building, verifying, finalized, failed, superseded) | lifecycle |
| `job_id` | UUID | creating maintenance job |
| `attempt` | INT NOT NULL DEFAULT 1 | attempt number for this boundary |
| `created_at` / `finalized_at` | TIMESTAMPTZ | lifecycle stamps |

Indexes/constraints:

- `UNIQUE (document_id, coverage_seq, attempt)` — one live attempt per
  boundary; competing attempts get distinct attempt numbers, and
  finalization deterministically keeps the lowest-attempt FINALIZED
  row (loser rows → superseded/failed by the finalize guard).
- `INDEX (document_id, status, coverage_seq)` — latest-finalized
  lookup and revision-time lookup.
- Immutability: no SQL path updates payload-bearing columns of a
  FINALIZED row; the repository API refuses; a DB trigger-style guard
  is unnecessary because updates flow only through guarded
  transitions (verified by tests).

### 8.2 `crdt_revisions`

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `revision_id` | UUID NOT NULL UNIQUE | public identity |
| `document_id` | UUID NOT NULL FK→documents | ON DELETE CASCADE |
| `target_seq` | BIGINT NOT NULL | durable boundary the revision points at |
| `kind` | TEXT NOT NULL CHECK in (auto_checkpoint, named, restore_event) | user-visible vs system |
| `label` | TEXT | user label for named revisions |
| `created_by` | UUID FK→users | actor |
| `snapshot_id` | UUID NULL | snapshot that covers target_seq (not embedded) |
| `restore_source_revision` | UUID NULL | set on restore_event rows |
| `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Indexes: `(document_id, target_seq)` lookup; `(document_id, created_at)`
listing. A revision row carries NO payload — reconstruction selects the
nearest covering snapshot at-or-before `target_seq` and replays the
delta. Named revisions may trigger (not block on) a snapshot build at
their boundary.

### 8.3 `maintenance_jobs`

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `job_id` | UUID NOT NULL UNIQUE | public identity |
| `kind` | TEXT NOT NULL CHECK in (snapshot_build, verify, compaction, retention_cleanup, history_scan) | |
| `document_id` | UUID NULL FK→documents | scoped jobs |
| `target_seq` | BIGINT NULL | boundary for snapshot/compaction jobs |
| `state` | TEXT NOT NULL CHECK in (pending, running, completed, failed, cancelled) | |
| `attempts` | INT NOT NULL DEFAULT 0 | bounded retries |
| `max_attempts` | INT NOT NULL DEFAULT 3 | |
| `owner_gateway` | INT NULL | claiming gateway id |
| `claim_version` | BIGINT NOT NULL DEFAULT 0 | optimistic lease token |
| `lease_expires_at` | TIMESTAMPTZ NULL | lease deadline |
| `last_failure_class` | TEXT NULL | retryable vs terminal classification |
| `created_at` / `updated_at` / `completed_at` | TIMESTAMPTZ | |

Claiming = `UPDATE … SET state='running', owner_gateway=$gw,
claim_version=claim_version+1, lease_expires_at=now()+interval
WHERE job_id=$j AND state='pending' AND claim_version=$expected`
— a compare-and-swap on (state, claim_version). Lease heartbeat
extends `lease_expires_at` only for the current claim_version. A stale
owner (lease expired and re-claimed by another gateway) fails every
subsequent transition because its claim_version no longer matches —
including finalization. Abandoned jobs (expired lease) return to
`pending` (retryable classes) or `failed` (terminal) on the next
scheduler sweep.

This is a **row-claim + versioned lease** model (chosen over advisory
locks, which do not survive in the DB and cannot fence a stale owner
across gateways, and over pure advisory-queue patterns which need an
extra broker). Ownership lives IN the durable truth (PostgreSQL), so
it survives gateway crashes; the claim_version fence prevents stale
finalization without any exactly-once claim (non-negotiable #13/#18).

### 8.4 `documents` additions

- `compaction_floor_seq BIGINT NULL` — oldest directly-replayable seq.
- `compaction_floor_snapshot_id UUID NULL` — the covering snapshot.
- Invariant: both NULL or both set; floor only advances inside the
  same transaction as prune batches (M029/M030).

### 8.5 Compaction state machine (M027)

Tracked per compaction job (`maintenance_jobs` + snapshot rows):

```
PLANNED → SNAPSHOT_REQUIRED → SNAPSHOT_VERIFIED → PRUNE_READY
        → PRUNING (batched, resumable) → COMPLETED
any → FAILED (classified; resumable from the recorded position)
```

- PLANNED: boundary chosen (≤ retention-protective limit).
- SNAPSHOT_REQUIRED: a FINALIZED snapshot covering the boundary must
  exist (build+verify+finalize through the snapshot pipeline).
- SNAPSHOT_VERIFIED: differential verifier confirms equivalence at
  the boundary.
- PRUNE_READY: retention/protection checks passed (no protected
  revision snapshot would lose coverage).
- PRUNING: bounded batches of `DELETE FROM crdt_operations WHERE
  document_id=$d AND id <= boundary`, each batch advancing the floor
  transactionally.
- COMPLETED: floor == boundary; job recorded.
Crash at any point: snapshot rows and floor move only via guarded
transactions; resumption re-enters at the recorded phase.
