# Concord — Security Model (Phase 3 + 4)

Status: Authoritative (Phase 4 current; later-phase items marked TARGET)
Version: 1.1
Last updated: 2026-09-07

## 1. Trust boundaries (CURRENT)

1. **Browser ↔ Rust gateway**: WebSocket at `/api/v1/sync`. Authentication
   = Clerk session JWT verified SERVER-SIDE (RS256 via JWKS, issuer/exp/nbf,
   algorithm pinned — HS256-with-public-JWKS style attacks rejected). The
   token travels in the `authenticate` frame after upgrade — never in a URL
   query string (browser WebSocket APIs cannot set headers; the tradeoff
   is documented in PROTOCOL §9.5).
2. **Gateway ↔ PostgreSQL**: service credentials; every query is a static
   parameterized statement (no concatenation of untrusted input anywhere
   in `rust/.../db`).
3. **Client identity state is advisory only** — the verified token `sub`
   is the sole principal source; client-supplied user ids/roles are never
   trusted (non-negotiable #14).

## 2. Authorization (CURRENT)

- ONE canonical policy layer (`rust/.../db/authz.rs`): SQL join resolves
  the Phase 1 effective role (owner > direct ACL > org-member EDITOR >
  deny); capabilities: read = all roles; content-write = OWNER/EDITOR.
- Join-time check gates room entry; **write authorization is rechecked on
  every batch inside the ingestion transaction** (live downgrade denied —
  E2E-proven).
- Nonexistent and no-access documents are indistinguishable (`forbidden`)
  — no existence oracle. Document ids must be UUIDs; SQLi-shaped values
  are rejected as malformed.

## 3. Protocol input hardening (CURRENT)

- All frames are untrusted: strict decoders with bounded limits (8 MiB
  frame, 1024 ops/batch, 64 KiB/op, 32 KiB token) — enforced at decode
  before allocation; oversized frames severed at the transport cap.
- Unknown versions/types → safe errors; fatal errors close the socket.
- Envelope validation mirrors the C++ core rules (identity ranges,
  bounded strings, exact-consume) — structurally invalid ops are never
  persisted.
- Error frames carry vocabulary codes + safe messages only: no SQL, table
  names, stack traces, or token material (banned-substring sweep tested).

## 4. Resource bounds (CURRENT)

- Per-connection outbound queue is bounded (config; slow consumers are
  disconnected and recover via catch-up — durable ops never silently
  dropped).
- DB pool bounded; JWKS refresh attempts bounded (rotation without
  unbounded fetch loops); heartbeat/idle timeouts reap dead sockets
  (verified: the M021-M030 deadlock fix — every connection now reaps).

## 5. Known accepted limitations

- `rate_limited` is a reserved protocol code, not yet enforced (TARGET
  Phase 4 edge rate limiting).
- SIGKILL skips the drain notice (by design; durability is never at risk
  since ACK requires PostgreSQL commit).
- FileJwks (`GATEWAY_JWKS_FILE`) is an explicit dev/E2E-only source;
  production always verifies against the live issuer over HTTPS.

See docs/AUTHORIZATION.md (Phase 1 product-layer policy) and
docs/FAILURE_MODEL.md (durability/failure contract).


---

## 6. Phase 4 distributed security (CURRENT)

### 6.1 Broker trust boundary
NATS is an INTERNAL transport, but its payloads are treated as UNTRUSTED
input: every event passes the same strict envelope validation as hostile
client frames (schema version, size caps, checksum, per-op structure —
M015). The consumer:
- never persists received events (durable rows ONLY flow through the
  authenticated client-ingest path — forged events die in RAM);
- routes only to connections already joined to that exact document
  (no cross-tenant delivery);
- terminates poisoned messages (`+TERM`, bounded deliveries) with
  structured class-only logging.

### 6.2 Redis trust boundary
Ephemeral by contract (DEC-033): presence, rate-limit counters, hints —
namespaced `concord:<env>:` with TTLs; wipe-tested. No document content,
ACLs, or operations EVER touch Redis (keyspace audit + FLUSHALL test).
Redis loss degrades to local per-gateway limits (documented fail-open)
and absent presence — never to a durable error.

### 6.3 Distributed authorization
Authorization is re-evaluated on EVERY gateway from PostgreSQL: join check
+ per-batch write recheck inside the ingest transaction. No gateway holds
cached grants; there is no "alternate gateway" bypass. Sticky sessions
are NOT used — reconnecting to a different instance re-runs the same
server-side checks.

### 6.4 Rate limiting + abuse
Fixed-window budgets per (scope, principal) shared through Redis when
available (connect 240/min/peer default — GATEWAY_RATE_CONNECT_PER_MIN
override; writes 2000/min; malformed 50/min). Gateway-hopping cannot
evade the global budget (cross-instance test). Local fallback keeps
per-gateway bounds during Redis outages (accepted N× residual, bounded).

### 6.5 Findings (all documented, none high-severity)
F4-1 local-fallback N× budgets during Redis outage (accepted; DEC-033).
F4-2 local NATS without authn (dev-only, loopback; Phase 7 hardening).
F4-3 forged broker events may transiently fan out to already-joined
clients before dying unpersisted (never durable; signing = later phase).

## 7. Phase 5 storage integrity (CURRENT as of 2026-09-07)

### 7.1 Snapshot integrity (fail-closed)
Every snapshot consumer path validates BEFORE trust: format version →
document association → declared size → SHA-256 over exact stored bytes →
state-digest shape → wrapper structure → wrapper/row metadata agreement
(the row/payload-swap defense). Only `finalized` (immutable) rows are
ever served; corrupt candidates fail closed and recovery falls back to
older snapshots, then full replay — corruption never aborts recovery
and never silently serves bad state.

### 7.2 Snapshot serving (WS resync)
`fetch_snapshot` rechecks document READ access, document association,
integrity, and FINALIZED status before sending base64 payload; errors
are uniform (unavailable) — no existence oracle across tenants. The
client independently re-validates (checksum over wrapper bytes,
document/coverage agreement) before import — defense in depth.

### 7.3 Maintenance-job ownership
Claims are compare-and-swap on (state, claim_version) with leases
computed in PostgreSQL (one clock for all gateways). Heartbeats,
completions, failures, and snapshot finalizations all carry the
claim_version and are rejected for stale owners — a gateway that lost
its lease can never act again on that job (DEC-037; race-tested, M046).

### 7.4 Native worker boundary (DEC-038)
The worker is a local trusted binary (fixed argv, no shell, bounded
stdin/stdout/stderr, wall-clock timeouts, kill-on-drop). Its outputs
are never trusted blindly: every persisted snapshot passes the build
verification oracles (fresh-instance import + independent re-fold) and
the M013 integrity matrix before finalization; a worker under operator
control is inside the trust boundary (local deployment), and the
pipeline's verify stages would refuse inconsistent output regardless.

### 7.5 History/restore authorization
Listing/viewing history requires document READ; creating named
revisions requires EDITOR+; restore requires OWNER. Restores are
forward-moving auditable events; acknowledged concurrent edits are
never silently discarded (restores merge as ordinary CRDT batches).

### 7.6 Findings (P5-M045 audit: see runbook disposition)
Recorded in the private audit report; any HIGH/CRITICAL finding is
fixed before the release gate (none outstanding at gate time — the
final-gate checkpoint records the audit verdict).
