# Concord — Security Model (Phase 3)

Status: Authoritative (Phase 3 current; Phase 4+ items marked TARGET)
Version: 1.0
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
