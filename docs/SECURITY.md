# Concord — Security Model (Phase 3 + 4)

Status: Authoritative (Phase 6 threat model current; Phase 4 §1–6 and
Phase 5 §7 remain in force as described below)
Version: 2.0
Last updated: 2026-09-09

> **Document structure.** §1–§5 record the Phase 3 posture, §6 the Phase 4
> distributed additions, §7 the Phase 5 storage-integrity additions, and
> §8 the Phase 6 formal threat model (P6-M020), which supersedes nothing
> below it but sits above it as the systematic map: every named threat is
> traced to either an existing executable test (file/suite named) or a
> planned Phase 6 test (marked `PLANNED → P6-Mxxx`). §9 records the
> Phase 6 scanning tooling (P6-M024 secret scanning, P6-M025 supply-chain
> scanning).

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

- `rate_limited` is enforced for the connect upgrade and all snapshot
  read paths (the `fetch` scope); the `write`/`malformed` scopes remain
  policy-defined but not yet enforced at the frame layer (documented
  target for the Phase 6 edge work).
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
override; writes 2000/min; malformed 50/min; snapshot reads 30/min per
connection — the `fetch` scope covering `fetch_snapshot` and the
`sync_request` resync decision). Gateway-hopping cannot evade the global
budget (cross-instance test). Local fallback keeps per-gateway bounds
during Redis outages (accepted N× residual, bounded).

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

### 7.6 Findings (P5-M045 audit: fixed; see disposition)
The adversarial audit found 2 MEDIUM + 1 MEDIUM-latent + several LOW/INFO
findings, zero HIGH/CRITICAL. All MEDIUMs are fixed and regression-pinned
(`phase5_security.rs`):

- **SEC5-1 (fixed)** — `fetch_snapshot` was unthrottled (each fetch = full
  payload read + SHA-256 + base64 serve): an authenticated VIEWER could
  generate unbounded read/bandwidth amplification. Fix: a `fetch`
  rate-limit scope (30/min/connection, shared with the `sync_request`
  resync path — both snapshot read paths bounded by one budget); bursts
  beyond it get `rate_limited` errors.
- **SEC5-2 (fixed)** — compaction eligibility ignored `crdt_revisions`:
  pruning could delete a live revision's op basis (silent history
  degradation). Fix: pruning refuses boundaries above the lowest revision
  target (`RetentionProtected`), re-checked inside every prune transaction
  under the documents row lock; revision creation validates its boundary
  against the floor and the durable high-water at insert time.
- **SEC5-3 (fixed)** — the `snapshot_payload` frame omitted the declared
  payload size, leaving the client's `size_mismatch` defense unexercised
  on the WS path. Fix: `payloadSize` is now a wire field, and the server
  refuses to serve any snapshot whose base64 form would exceed the frame
  cap (`payload_too_large`, never a truncated/undeliverable frame).
- LOW/INFO (documented in the audit): oversize-serve guard (now fixed via
  SEC5-3), `write`/`malformed` scopes still unenforced at frame level
  (documented target), lease-expiry re-queue class reset (fixed),
  `enqueue_unique` coalescing race (documented, tolerable), uniform
  not-found refusal for malformed snapshot ids (accepted — no existence
  oracle), `token_head` logging (JWT header prefix only, public by
  construction).

---

## 8. Phase 6 formal threat model (P6-M020, CURRENT as of 2026-09-09)

This section is the systematic map over everything §1–§7 state pointwise.
Conventions:

- **Boundary numbering (B1–B7)** is used only in this section.
- **Mapping column** names the executable evidence. `rust/…` paths are
  under `rust/sync-gateway/tests/`. A row mapped to an existing test is
  enforced today; a `PLANNED → P6-Mxxx` row is a declared gap with a
  named owner milestone (M021 IDOR/authorization matrix, M022 revocation,
  M023 internal NATS/Redis trust, M017/M018 fuzzing). No threat row is
  left unmapped — that is the acceptance criterion of this model.
- Severity = worst-case impact if the threat materialized *given the
  control exists* (residual), or "exposure" where the control is planned.

### 8.1 Trust boundary diagram

```mermaid
flowchart TB
    subgraph HOST["Developer/operator host (loopback: dev posture)"]
        NGINX["nginx LB container<br/>127.0.0.1:8890 (P4-M027, no TLS, no sticky)"]
        GW1["Rust gateway :8791"]
        GW2["Rust gateway :8792"]
        GW3["Rust gateway :8793"]
        WORKER["C++ concord-worker<br/>(spawned per request, stdio, same host)"]
        subgraph DOCKER["docker-compose services (loopback-bound, dev-only creds)"]
            PG[("PostgreSQL<br/>127.0.0.1:5433")]
            NATS[("NATS JetStream<br/>127.0.0.1:4222, no authn")]
            REDIS[("Redis<br/>127.0.0.1:6379")]
        end
    end
    BR["Browser (Next.js client + WASM CRDT)"] -- "B1: Clerk session (cookie + JWT)" --> CLERK["Clerk (external IdP)"]
    BR -- "B2: HTTPS app traffic" --> NEXT["Next.js server (Clerk auth, PostgreSQL authorization)"]
    BR -- "B3: WS /api/v1/sync<br/>(wss in prod; authenticate frame carries the JWT)" --> NGINX
    NGINX -- B4 --> GW1 & GW2 & GW3
    NEXT -- B5: service credential --> PG
    GW1 & GW2 & GW3 -- B5: service credential --> PG
    GW1 & GW2 & GW3 -- B6: internal events (untrusted payloads) --> NATS
    GW1 & GW2 & GW3 -- B6: ephemeral keys (no document data) --> REDIS
    GW1 & GW2 & GW3 -- B7: fixed argv, length-prefixed stdin/stdout --> WORKER
    WORKER -- "no network; no secrets passed" --> WORKER
```

Boundary-by-boundary reading (dev loopback posture noted where it is the
actual control):

- **B1 Browser ↔ Clerk**: the browser holds a Clerk session; Concord never
  sees the Clerk password. The gateway verifies only the resulting JWT
  (RS256, issuer/exp/nbf, pinned algorithm).
- **B2 Browser ↔ Next.js**: Clerk session cookie; `proxy.ts` gates routes.
  All HTTP authorization is PostgreSQL-backed (`src/server/`); client state
  is advisory (§1.3).
- **B3 Browser ↔ gateway cluster**: WebSocket, `authenticate` frame with
  the JWT (never a query string — PROTOCOL §9.5). `wss://` is a deployment
  configuration; the dev nginx LB terminates plain `ws://` on loopback.
- **B4 nginx LB ↔ gateways**: round-robin, deliberately no sticky sessions
  (reconnect-any-gateway must be safe — §6.3). Dev-only: no TLS, no
  mTLS between LB and gateways.
- **B5 Gateway/Next.js ↔ PostgreSQL**: one service credential per
  process family; static parameterized SQL only; RLS deferred (DEC-020).
  Dev credential `concord_local_dev` is documented and loopback-bound.
- **B6 Gateways ↔ NATS/Redis**: NATS carries inter-gateway events whose
  payloads are validated as hostile input (§6.1); Redis holds only
  namespaced ephemeral keys (§6.2). Dev NATS has no authn (F4-2) —
  loopback is the boundary control; production hardening is Phase 7.
- **B7 Gateway ↔ native worker**: same-host process, fixed argv (no
  shell), bounded stdio framing, wall-clock timeouts, kill-on-drop
  (§7.4). The worker receives no tokens, DSNs, or other secrets.

### 8.2 Assets and attacker models

**Assets** (per boundary crossing):

| Asset | Where it lives |
|---|---|
| A1 Document content and CRDT op streams | PostgreSQL `documents`, `crdt_operations`; NATS (transient copies); gateway RAM; browser WASM heap |
| A2 Authorization state (roles, org membership, ACLs) | PostgreSQL tables; resolved per-join/per-batch in gateway RAM |
| A3 Identity credentials | Clerk JWT (short-lived, in browser and `authenticate` frame); Clerk secret key + DB DSN in server env only |
| A4 Snapshot/history artifacts | PostgreSQL `crdt_snapshots`, `crdt_revisions`; worker RAM during build |
| A5 Ephemeral coordination state | Redis (presence, rate counters) — declared non-authoritative (DEC-033) |
| A6 Service credentials | Server/gateway environment variables; docker-compose dev values |
| A7 Availability | Bounded queues, pools, and budgets in the gateway; DB write throughput |

**Attacker models** (what each actor can and cannot do):

| Attacker | Capabilities | Non-capabilities |
|---|---|---|
| AT1 Unauthenticated network client | Open sockets to exposed ports; send arbitrary bytes/frames | No valid JWT; cannot read TLS-protected traffic in production posture |
| AT2 Authenticated low-privilege user (VIEWER/COMMENTER) | Valid JWT; join permitted docs; send protocol frames; guess document UUIDs | Cannot sign tokens; cannot edit content (policy-enforced) |
| AT3 Malicious org member (EDITOR) | Everything AT2 can, plus content writes and protocol-shaped abuse from inside the tenant | Cannot grant/escalate own role (OWNER-only ACL mutations); cannot reach other tenants' docs |
| AT4 Compromised peer gateway / internal infra (NATS publisher, Redis writer, another gateway process) | Publish arbitrary broker events; write arbitrary Redis keys; read NATS streams | Cannot write PostgreSQL durable rows (no ingest path); cannot forge JWTs; every published event is re-validated (§6.1) |
| AT5 Loopback network observer (dev machine local user/process) | Sniff loopback traffic (dev: plaintext ws/pg/nats); read docker-compose values | Not a production threat model — the loopback dev posture is documented, and production hardening (TLS everywhere, broker authn) is Phase 7 |

### 8.3 Threat catalog (each row maps to a test or a planned milestone)

Boundary key: B1–B7 (§8.1). Existing-test rows are enforced today; rows
ending in `PLANNED → P6-Mxxx` declare the gap and its owner milestone.

#### B2/B3 — HTTP + WebSocket edge (unauthenticated and low-priv clients)

| # | Threat | Attacker | Control | Mapping |
|---|---|---|---|---|
| T1 | Forged/expired/wrong-issuer JWT replayed at `authenticate` | AT1 | RS256 via JWKS, issuer/exp/nbf, algorithm pinned | `src/auth/mod.rs` unit tests (`forged_signature_rejected`, `expired_token_rejected`, `wrong_issuer_rejected`, `malformed_and_empty_rejected`, `unknown_kid…`, `jwks_refresh_resolves_rotated_kid`); `ws_integration::unauthorized_and_forged_tokens_rejected` |
| T2 | JWT replay beyond expiry / cross-service token reuse | AT1/AT2 | Short-lived Clerk session tokens; exp enforced server-side; no refresh path in gateway | Same auth unit tests as T1. Note: the WS session itself lives as long as the socket; revocation semantics for live sockets → row T9 |
| T3 | Client-supplied identity/role claims honored (identity spoofing) | AT1/AT2 | Verified `sub` is the only principal source (§1.3) | `ws_integration::adversarial_forged_identity_claims_never_trusted` |
| T4 | IDOR — guessed or cross-tenant `documentId` at join/read/write/snapshot/history/restore | AT2/AT3 | PostgreSQL join resolves effective role; no-access == nonexistent (`forbidden`); UUID shape gate | `ws_integration::join_no_access_is_forbidden_without_leak`; `phase5_history::revision_lifecycle_and_acl_matrix`, `::restore_requires_owner_and_anchors_the_target`; `phase5_restore_concurrency::restore_authorization_matrix_and_concurrent_edits`; `phase5_security::sec5_clean_cross_document_fetch_refused_uniformly`; `tests/authorization.test.ts` (product layer); full cross-role/cross-org matrix `PLANNED → P6-M021` |
| T5 | Tenant cross-talk through fan-out (ops delivered to wrong room/connection) | AT4 | Route only to connections joined to that exact document id | `broker_integration::publish_and_cross_gateway_delivery`; wrong-document/forged event routing `PLANNED → P6-M023` |
| T6 | Malformed/oversized frames (header bombs, hostile binary layouts, truncated ops) | AT1/AT2 | Bounded decoders (8 MiB frame, 1024 ops/batch, 64 KiB/op, 32 KiB token), reject-before-allocate | `src/protocol/tests.rs` (`control_decode_rejects_hostile_shapes`, `control_decode_rejects_oversized_token`, `data_decode_rejects_hostile_inputs`, `data_encode_enforces_limits`); `ws_integration::malformed_frames_are_safe_errors`, `::adversarial_oversized_frame_is_rejected_and_closed`; continuous fuzzing of decoders `PLANNED → P6-M018` |
| T7 | Protocol-state abuse (frames out of order, second join, ops before READY) | AT1/AT2 | Connection state machine rejects illegal transitions (PROTOCOL §9.13) | `ws_integration::state_machine_rejects_out_of_order_frames` |
| T8 | Op replay/duplication (resent batches double-apply or double-ACK) | AT2 | SQL-layer idempotency on op identities; deterministic ACK | `ws_integration::duplicate_resend_yields_single_durable_row_and_deterministic_ack`; `tests/realtime/e2e.test.ts` "duplicate resend across the network boundary"; `broker_integration::replayed_event_is_idempotent_at_every_layer` |
| T9 | Stale permissions — role downgraded/revoked while a session is live | AT3/AT4 | Write authorization rechecked per batch inside the ingest transaction (live downgrade denied) | `tests/realtime/e2e.test.ts` "live downgrade"; multi-gateway/revocation propagation matrix `PLANNED → P6-M022` |
| T10 | Resource exhaustion — connect storms, fetch spam, slow consumers, oversized snapshots | AT1/AT2 | Rate scopes (connect 240/min/peer, fetch 30/min/conn), bounded outbound queue + slow-consumer disconnect, `payload_too_large` serve refusal | `multi_gateway::reconnect_storm_is_contained_by_admission_control`, `::slow_consumer_does_not_stall_global_collaboration`; `ws_integration::adversarial_rapid_reconnects_are_contained`, `::slow_consumer_disconnected_not_blocking_writer`; `phase5_security::sec5_1_fetch_snapshot_spam_is_throttled`, `::sec5_1_fetch_scope_exists_and_limits`; residual: `write`/`malformed` scopes defined but unenforced at frame layer (§5) — enforcement `PLANNED → P6-M021` edge work |
| T11 | Error/message/log leakage (SQL text, stack traces, token material in errors) | any | Safe error vocabulary; banned-substring sweep; token logging is header prefix only | `ws_integration::adversarial_error_messages_never_leak_internals`; `token_head` documented LOW/INFO in §7.6; log redaction sweep `PLANNED → P6-M023` (log-surface assertions) |
| T12 | Existence oracle via differentiated errors (found vs forbidden) | AT2 | Uniform `forbidden`/`unavailable`/not-found outcomes | `ws_integration::join_no_access_is_forbidden_without_leak`; `phase5_security::sec5_clean_cross_document_fetch_refused_uniformly`; uniform-refusal regression in IDOR matrix `PLANNED → P6-M021` |

#### B5 — PostgreSQL service boundary

| # | Threat | Attacker | Control | Mapping |
|---|---|---|---|---|
| T13 | SQL injection via document ids, token material, snapshot ids | AT1/AT2 | Static parameterized statements everywhere; UUID/document-id shape gates reject SQLi-shaped values | `ws_integration::malformed_frames_are_safe_errors`; hardening tests `tests/db/hardening.test.ts`; injection-shaped corpus into decoders+DB `PLANNED → P6-M021` |
| T14 | Durable-ACK forgery — acking ops that were not durably committed | AT4 (or crash timing) | ACK is emitted only after the PostgreSQL commit (FAILURE_MODEL contract); DB outage never fakes ACK | `ws_integration::db_outage_never_fakes_durable_ack_and_readiness_flips`; `phase5_crash::crash_matrix_leaves_documents_recoverable` |
| T15 | Durable state corruption via forged broker-originated "ops" | AT4 | Durable rows only originate from the authenticated client-ingest path; broker events are never persisted | `broker_integration::forged_broker_cannot_fabricate_durable_state` |
| T16 | Maintenance-job hijack — stale worker finalizes/steals snapshot jobs | AT4 | Lease fencing: CAS on (state, claim_version), one clock, stale-owner rejection (§7.3) | `phase5_races::two_workers_same_job_single_winner`, `::lease_expiry_midwork_fences_stale_finalizer`, `::duplicate_triggers_from_many_gateways_coalesce` |
| T17 | Silent history degradation — pruning deletes live revision basis | AT3/AT4 (timing) | Prune eligibility refuses below revision floor, rechecked inside the prune transaction (SEC5-2) | `phase5_security::sec5_2_prune_refuses_past_live_revision`; `phase5_compaction::prune_refuses_when_revision_created_below_boundary_concurrently`, `::prune_reevaluates_eligibility_inside_transaction`; `phase5_races::retention_racing_with_new_revision_cannot_delete_it`; `phase5_retention::retention_cannot_mark_or_purge_the_floor_or_below` |

#### B6 — NATS / Redis internal trust boundary

| # | Threat | Attacker | Control | Mapping |
|---|---|---|---|---|
| T18 | Forged/malformed/oversized broker events crash or poison consumers | AT4 | Same strict envelope validation as client frames; `+TERM` bounded deliveries | `broker_integration::malformed_event_is_rejected_without_crash`, `::oversized_broker_payload_is_contained` |
| T19 | Replayed broker events re-fan-out or double-apply | AT4 | Msg-id dedup + idempotency at every layer | `broker_integration::duplicate_publish_is_deduped_by_msg_id`, `::replayed_event_is_idempotent_at_every_layer` |
| T20 | Redis key collision/prefix manipulation across tenants or scopes | AT4 | `concord:<env>:` namespacing, TTLs; no document data in Redis (DEC-033) | `redis_integration::presence_upsert_count_remove_with_ttl`, `::full_wipe_loses_nothing_durable_and_presence_rebuilds`; cross-tenant key collision corpus `PLANNED → P6-M023` |
| T21 | Rate-limit evasion via gateway hopping or Redis outage fail-open | AT1/AT2 | Shared Redis budgets across instances; bounded local fallback | `redis_integration::distributed_rate_limit_across_instances`, `::local_fallback_when_redis_is_down` (accepted N× residual, F4-1); no-authn NATS in dev (F4-2, Phase 7) |

#### B7 — Native worker boundary

| # | Threat | Attacker | Control | Mapping |
|---|---|---|---|---|
| T22 | Worker input injection (argv/shell interpolation, oversized stdin frames) | AT4 (compromised peer writing to the pipeline) | Fixed argv, no shell, bounded stdin/stdout/stderr, 256 MiB frame cap, wall-clock timeout, kill-on-drop (§7.4) | `rust/…/src/worker/mod.rs` framing limits + `phase5_pipeline` suite (worker invocation paths); adversarial worker-input fuzzing `PLANNED → P6-M017` |
| T23 | Malicious/buggy worker output persisted as truth | AT4/accidental | Build verification oracles: fresh-instance import + independent re-fold + M013 integrity matrix before finalize; only `finalized` rows served | `phase5_recovery::differential_verifier_proves_equivalence_and_reports_mismatch`, `::selection_prefers_newest_valid_and_falls_back_on_corruption`; `phase5_snapshots::stored_row_validates_end_to_end`, `::finalized_rows_are_immutable` |
| T24 | Corrupted snapshot rows served to clients (row/payload swap, bitrot) | AT4/accidental | Full consumer-path validation chain: version → association → size → SHA-256 → digest shape → wrapper structure → metadata agreement (§7.1) | `phase5_snapshots::guards_reject_illegal_transitions`, `::create_attempt_rejects_metadata_mismatch_before_insert`, `::duplicate_document_boundary_attempt_is_rejected`; corruption corpus `PLANNED → P6-M017` |

#### Snapshot/history/restore ACLs (cross-boundary, per §7.2/§7.5)

| # | Threat | Attacker | Control | Mapping |
|---|---|---|---|---|
| T25 | Snapshot read bypass (`fetch_snapshot` for a foreign doc) | AT2 | Read recheck + document association + integrity + FINALIZED gate; uniform `unavailable` | `phase5_security::sec5_clean_cross_document_fetch_refused_uniformly`, `::sec5_1_fetch_scope_exists_and_limits`; `tests/realtime/e2e.test.ts` resync E2E |
| T26 | Client-side import of a tampered snapshot (defense in depth) | AT4 | Client re-validates checksum over wrapper bytes, declared size, document/coverage agreement before import | `tests/sync/snapshot-resync.test.ts` (decode/validation suite incl. hostile-length/truncation cases) |
| T27 | Revision/history privilege escalation (list/create/restore role bypass) | AT2/AT3 | History read = VIEWER, revision create = EDITOR, restore = OWNER; boundary validated against floor and durable high-water | `phase5_history::revision_lifecycle_and_acl_matrix`, `::restore_requires_owner_and_anchors_the_target`, `::create_revision_rejects_boundary_above_high_water`, `::create_revision_rejects_boundary_at_or_below_compaction_floor`; `phase5_restore_concurrency::restore_authorization_matrix_and_concurrent_edits` |
| T28 | Restore discards concurrent acknowledged edits (integrity under concurrency) | AT3 | Restores merge as ordinary CRDT batches; forward-moving auditable events | `phase5_restore_concurrency::restore_authorization_matrix_and_concurrent_edits`; `phase5_history::reconstruction_survives_pruning_when_covered` |

#### Secrets and supply chain (cross-cutting)

| # | Threat | Attacker | Control | Mapping |
|---|---|---|---|---|
| T29 | Secret leakage into git history, logs, docs, or client bundle (`NEXT_PUBLIC_`) | any (opsec) | Multi-pattern secret scanner over tree + full git history with redacted reporting (§9.1) | `scripts/security/secret-scan.sh` (this phase, P6-M024); CI wiring `PLANNED → P6-M043/M045` (workflows owned by SA-CI6) |
| T30 | Vulnerable dependencies (npm prod/dev, Rust crates, container base images) | supply chain | Per-ecosystem audit scripts with severity classification and exact scanner versions (§9.2) | `scripts/security/dep-scan.sh` (this phase, P6-M025); SBOM generation `PLANNED → P6-M026`; image hardening `PLANNED → P6-M027` |
| T31 | Dev-loopback exposure (compose ports, plaintext ws/pg in dev) | AT5 | All compose services bind 127.0.0.1 only; documented non-production credentials; `.env*` gitignored | `docker-compose.yml` (loopback binds are reviewable config); posture documented §8.1; production TLS/broker-authn is Phase 7 (ROADMAP) |
| T32 | C/C++ third-party supply chain | supply chain | The CRDT core and worker vendor no third-party libraries (CMake confirms header-only stdlib usage; no fetch/find_package of externals) | Verified in P6-M025 review — see `scripts/security/dep-scan.sh` header note and the CMake audit trail in `cpp/CMakeLists.txt` |

### 8.4 Durable-ACK authorization semantics (in scope of this model)

The ACK is the security-critical promise: `durable_ack` is emitted only
after the batch has committed in PostgreSQL **and** the per-batch write
authorization recheck inside that same transaction passed. Consequences
that this model pins:

- A client that receives `durable_ack` holds proof of (a) durability and
  (b) that the *then-current* role permitted the write. Revocation that
  lands after the commit cannot retroactively invalidate an ACK — the
  next batch is denied (T9).
- The DB-outage path never fakes an ACK (T14) and readiness flips so
  clients and LBs stop trusting the instance.
- Duplicate resends of an ACKed batch are single-row idempotent and return
  the same deterministic ACK (T8) — replay cannot inflate durable state.

### 8.5 Coverage accounting

Threat rows: 32. Mapped to existing executable tests: **24**.
`PLANNED → P6-Mxxx` gaps (some rows carry both an existing partial test
and a planned deepening): T4 (P6-M021), T5 (P6-M023), T6 (P6-M018),
T9 (P6-M022), T10 (P6-M021), T11 (P6-M023), T12 (P6-M021), T13 (P6-M021),
T20 (P6-M023), T22 (P6-M017), T24 (P6-M017), T29 (P6-M043/M045),
T30 (P6-M026/M027). Rows T2 and T31 are documented posture statements
(T2: WS-session lifetime vs token lifetime — revocation behavior is
owned by T9/P6-M022; T31: dev loopback posture with Phase 7 hardening).

---

## 9. Phase 6 scanning tooling (P6-M024 / P6-M025, CURRENT)

### 9.1 Secret scanning (P6-M024)

`scripts/security/secret-scan.sh` scans the tracked working tree and the
full git history (`git log -p --all`) for high-confidence secret shapes:
Clerk secret keys, Liveblocks keys, AWS access keys, private-key PEM
blocks, password-bearing `postgres://` URLs (beyond the documented dev
credential), JWTs, `NEXT_PUBLIC_`-prefixed secret variables, and Convex
deploy keys. Findings print file + line + pattern name with the matched
value redacted (first 4 characters + length only). `--json` emits a
machine-readable array; exit is non-zero on any non-allowlisted finding.

Allowlist entries (each justified inline in the script; never a
wholesale file exclusion):

- `docker-compose.yml` / `.env.example`: documented loopback dev
  credential `concord_local_dev` and `*_replace_me` placeholders.
- `rust/sync-gateway/src/auth/test_rsa_key{,2}.der`: TEST-ONLY keys
  compiled into the binary solely as the local JWKS fixture for unit
  and integration tests (referenced by `src/auth/mod.rs` tests and
  `ws_integration`/`phase5_*` suites). They are not used for any
  production signing path; production verifies against the live issuer
  over HTTPS.
- `fixtures/protocol/v1/golden.json` and
  `rust/sync-gateway/src/protocol/golden.rs`: a two-segment wire-fixture
  token (`eyJhbGciOiJSUzI1NiJ9.test-token`) — a header-only JWT shape
  with no signature or claims; protocol golden-vector data, not a
  credential.

Run it as `bash scripts/security/secret-scan.sh` (see `--help` for the
history-bounded mode). CI wiring is deferred to the Phase 6 CI milestones
(P6-M043/M045).

### 9.2 Dependency / supply-chain scanning (P6-M025)

`scripts/security/dep-scan.sh` aggregates, classifies, and reports per
ecosystem, with the exact scanner versions in every run. Exit policy:
non-zero only for critical/high findings not covered by a documented
acceptance; medium/low are reported for triage.

- **npm** (`npm audit --omit=dev` + `npm audit` + `npm ls` critical
  paths): 0 critical / 0 high / 4 moderate / 0 low, production and full
  tree identical. All four moderates are the one known chain:
  drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils →
  esbuild 0.18.20 (GHSA-67mh-4wv8-2f99, esbuild ≤0.24.2 dev-server
  request-forgery advisory). ACCEPTED (documented, not hidden): Concord
  invokes drizzle-kit exclusively as a local CLI (`drizzle-kit
  generate` / `studio`); no esbuild dev server is ever started or
  reachable, so the advisory's vector is not exposed. The suggested
  `npm audit fix --force` would downgrade drizzle-kit to a breaking
  version — not taken (schema-tooling regression risk outweighs an
  unreachable dev-server advisory). Residual risk: moderate, dev-only,
  unreachable vector. Note drizzle-kit is currently declared in
  `dependencies` (not devDependencies) — moving it is a package.json
  change deferred to the CI/wiring milestone owner; the scanner
  classifies the chain honestly regardless.
- **Rust** (`cargo audit 0.22.2` over Cargo.lock; installed this phase
  via `cargo install cargo-audit --locked`): 0 critical / 0 high /
  0 medium / 0 low — no RustSec advisories against the locked crate set.
- **Containers** (`docker scout v1.24.0` over the four pinned dev
  images; all loopback-bound per docker-compose.yml):

  | Image | Critical | High | Medium | Low | Top critical/high packages |
  |---|---:|---:|---:|---:|---|
  | postgres:18.6-alpine (PG 18.6, alpine 3.24.1) | 6 | 38 | 21 | 5 | golang stdlib(22), alpine base(22), openssl(9), curl(9) |
  | nats:2.11.6-alpine (nats 2.11.6, alpine 3.22.1) | 13 | 52 | 46 | 7 | alpine base(30), openssl(29), golang stdlib(22), go crypto(13) |
  | redis:8.8.2-alpine (redis 8.8.2, alpine 3.23.5) | 2 | 10 | 2 | 0 | alpine base(12), openssl(9), util-linux(3) |
  | nginx:1.29-alpine (nginx 1.29.8, alpine 3.23.4) | 8 | 35 | 24 | 8 | alpine base(43), openssl(18), curl(18), util-linux(3) |

  ACCEPTED for Phase 6 (documented residual): zero of the critical/high
  findings are in the database/server applications themselves
  (postgresql, nats-server, redis-server, nginx packages are clean);
  every critical/high sits in base-image OS packages (openssl, curl,
  util-linux, musl) or in the images' embedded Go toolchain artifacts.
  These images are dev-only, loopback-bound (`127.0.0.1` port maps),
  never exposed to unauthenticated networks in this phase's posture
  (§8.1 B5/B6; attacker AT5 only), and the upstream tags are the current
  stable pins (upgrades probed: postgres 18.x is the newest tag family
  with identical counts; nats 2.12-alpine reduces criticals to 3 but is
  a feature-release jump not validated against the Phase 4/5 suites).
  Remediation of base-image packages is release-image work: P6-M027
  (harden images) and Phase 7 productionization own the rebuild-on-
  patched-base pass with gateway test-matrix validation. The scanner
  fails the run on these counts by design — the acceptance lives in
  this document, not in a hidden flag.
- **C/C++**: no third-party C or C++ dependencies exist (verified
  against `cpp/CMakeLists.txt`, `cpp/crdt/CMakeLists.txt`,
  `cpp/worker/CMakeLists.txt`: C++20 standard library only; no
  FetchContent / ExternalProject / find_package of externals; no
  vendored sources), so the native audit surface is the toolchain
  itself, covered by the P6-M016/M017 sanitizer and fuzz matrices.

Scan-of-record (2026-09-09): npm 11.19.0 / node v24.20.0; cargo-audit
0.22.2 (cargo 1.98.1); docker scout v1.24.0 (docker 29.7.2). Re-run any
time with `bash scripts/security/dep-scan.sh` (`--json` for
machine-readable). CI wiring is deferred to the Phase 6 CI milestones
(P6-M043/M045).
