# Concord — Operations (local dev; Phase 4 current)

Status: Authoritative (local operations only — production is Phase 7)
Version: 1.0
Last updated: 2026-09-07

## Local stack

| Service | Start | Ports | Notes |
|---|---|---|---|
| PostgreSQL 18.6 | `docker compose up -d db` | 127.0.0.1:5433 | durable truth (docs, ACLs, op log) |
| NATS 2.11 (JetStream) | `docker compose up -d nats` | 4222 / 8222 (monitor) | cross-gateway events; file storage |
| Redis 8.8 | `docker compose up -d redis` | 6379 | ephemeral: presence, rate limits |
| Gateway cluster | `./scripts/gateway-cluster.sh start` | gw 8791-8793; LB 8890 | 3 host processes + nginx LB |
| Web app | `npm run dev` | 3000 | Next.js (Phase 1 product) |

## Gateway configuration (env; all documented, no secrets committed)

- `GATEWAY_DATABASE_URL` (required), `GATEWAY_CLERK_ISSUER` (required)
- `GATEWAY_BIND_HOST/PORT` (default 127.0.0.1:8787)
- `GATEWAY_NATS_URL` — absent ⇒ single-gateway Phase 3 mode
- `GATEWAY_NATS_SUBJECT_PREFIX` (default `concord.dev`; namespaces the
  JetStream stream + subjects)
- `GATEWAY_REDIS_URL` — absent ⇒ local-only rate limiting, presence off
- `GATEWAY_ID` — stable per-process identity (logs/origin/metrics only)
- `GATEWAY_JWKS_FILE` — dev/E2E-only local JWKS (never in production)
- `GATEWAY_RATE_CONNECT_PER_MIN` — connect-budget override (default 240)
- `GATEWAY_QUEUE_CAPACITY`, `GATEWAY_MAX_FRAME_SIZE`,
  `GATEWAY_HEARTBEAT_INTERVAL_SECS`, `GATEWAY_IDLE_TIMEOUT_SECS`,
  `GATEWAY_DB_POOL_SIZE` — bounded-resource knobs

## Health, readiness, metrics

- `/api/v1/health/live` — process liveness
- `/api/v1/health/ready` — Postgres-aware readiness
- `/api/v1/metrics` — text counters: connections, ops, durable acks,
  duplicates, denies, malformed, slow-consumer disconnects, sync batches,
  broker publish/consume/poison, rate-limited

## Shutdown + failure behavior (tested)

- SIGTERM/SIGINT: drain notice → write cutoff → bounded grace → exit 0.
- Gateway crash: clients reconnect (backoff+jitter) to any healthy
  instance and rebuild from PostgreSQL (multi-gateway tests prove it).
- NATS outage: durable writes + same-gateway fanout continue; cross-
  gateway realtime degrades until restore (catch-up floor guarantees
  convergence).
- Redis outage/wipe: presence degrades/rebuilds; rate limiting falls
  back to local windows; NOTHING durable is affected (FLUSHALL-tested).

## JetStream quick facts (DEC-032)

Stream `CONCORD_OPS_<ns>`; subject `<ns>.ops.doc`; Limits retention;
max age 10m; duplicate window 2m; one durable pull consumer
(`gw-<gateway_id>`) per gateway; ExplicitAck after local processing;
MaxDeliver 5 (poison ⇒ terminate); max_ack_pending 256. The broker is
transport, never truth: PostgreSQL catch-up is the correctness floor.

## Runbook: full gate before handing off

```bash
./scripts/verify-gateway.sh   # exit 0 = all suites green
```
