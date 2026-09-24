# Concord — Production configuration contract

Status: Authoritative (Phase 7, P7-M013)
Version: 1.0
Last updated: 2026-09-09

This document is the **complete, public contract** for every environment
variable a Concord deployment needs. The executable half of the contract is
[`scripts/config/validate-env.mjs`](../scripts/config/validate-env.mjs):

```bash
node scripts/config/validate-env.mjs --env-file .env.local --scope dev --service web
node scripts/config/validate-env.mjs --scope prod --json   # CI-friendly
```

`--service` accepts `web`, `gateway`, or `all` (the default). JSON output
includes the selected `service` alongside `scope`, `checked`, `missing`,
`malformed`, and `result`.

It checks **presence + format only — never values**. It exits non-zero and
names every missing/malformed variable.

Source-of-truth code (when this doc and code disagree, code wins and this
doc must be fixed):

| Component | Contract source |
|---|---|
| Web app | `src/server/env.ts` (zod schema, `getServerEnv()`) |
| Sync gateway | `rust/sync-gateway/src/config.rs` (`Config::from_env()`, exit code 2 on config error, exit code 3 on DB/migration failure) |
| Connect-rate override | `rust/sync-gateway/src/ephemeral/ratelimit.rs` |
| Native worker | binary path contract via `GATEWAY_WORKER_BINARY` (validated by config.rs) |

## Scope conventions

- **dev** — a developer machine (docker compose infra, `.env.local`).
  Gateway infra env (`GATEWAY_NATS_URL`, `GATEWAY_REDIS_URL`) is supplied by
  `scripts/gateway-cluster.sh`, not `.env.local`.
- **staging / prod** — a real deployment. More variables become required
  (bind host, allowed origins, NATS, worker binary in prod).

## The two fail-fast families

1. **Web** (`src/server/env.ts`): zod validation on first server-side
   `getServerEnv()` call → throws with a message naming the failed fields.
   The app does not start serving data with a broken env.
2. **Gateway** (`rust/sync-gateway/src/config.rs`): `Config::from_env()` at
   process start → prints `gateway configuration error: …` and **exits 2**
   (missing/invalid). DB connect or migration failure later in `main.rs`
   → **exits 3**. The gateway never runs in a surprising state.

---

## Web app

| Variable | Required | Kind | Format / example | Failure when missing/invalid |
|---|---|---|---|---|
| `DATABASE_URL` | all scopes | secret | `postgres://…` | `getServerEnv()` throws on first data access |
| `CLERK_SECRET_KEY` | all scopes | secret | `sk_test_…` / `sk_live_…` | zod min(1) fails; Clerk backend calls fail |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | all scopes | **public** (browser-visible by design) | `pk_test_…` / `pk_live_…` | ClerkProvider cannot initialize |
| `DATABASE_TEST_URL` | test harnesses only | secret | `postgres://…` | `npm run db:migrate:test` and integration suites refuse to run |

Build-time note: the image build (`docker/web.Dockerfile`) does NOT need real
secrets — dummy values are baked in at build and real env is supplied at run
time (`--env-file`/orchestrator env). Never bake real values into an image.

## Sync gateway (`GATEWAY_*`)

### Required gateway settings — gateway refuses to start without these (exit 2)

| Variable | Kind | Notes |
|---|---|---|
| `GATEWAY_DATABASE_URL` | secret | Durable op log. Unreachable DB → exit 3 during startup. |
| `GATEWAY_CLERK_ISSUER` | public | `https://<instance>.clerk.accounts.dev` (dev) or the production issuer domain. Must match the Clerk instance that signs client JWTs — a mismatch fails verification (auth rejected). |

### Optional claim policies — required by the hosted deployment contract

`GATEWAY_CLERK_AUDIENCE` and `GATEWAY_CLERK_AUTHORIZED_PARTY` are optional
for local development and existing test tokens. When set, the signed token
must carry the exact matching claim; missing or wrong values are rejected.
The hosted/cloud bundle must set both to the values configured in the Clerk
instance before it is published.

The web middleware accepts `CONCORD_APP_ORIGIN` as an exact origin (scheme,
host, optional port; no path or trailing slash). When configured, Clerk
checks the session token's authorized party against that origin. Cloud
bundles set it to the same ALB app URL as the gateway's `azp` policy. Set
it explicitly for other hosted web deployments; local development leaves
it unset until its app origin is known.

### Required in staging/prod deployments

| Variable | Why |
|---|---|
| `GATEWAY_BIND_HOST` | Containers MUST set `0.0.0.0` — the default `127.0.0.1` is unreachable outside the container. Must be an **IP literal**; a hostname (e.g. `localhost`) is a config error, exit 2 (not a panic). |
| `GATEWAY_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to open WebSockets. Missing in prod = only `http://localhost:3000` accepted → real origins rejected on upgrade. Trailing `/` is trimmed; empty entries dropped. |
| `GATEWAY_NATS_URL` | Distributed mode. Absent ⇒ single-gateway mode (no cross-gateway fanout). Expected set in staging/prod (multi-gateway topology). |
| `GATEWAY_WORKER_BINARY` | prod: the native maintenance worker must run (snapshots/verify/compaction jobs would otherwise only enqueue). Path must point to a **readable file** — an invalid path is a config error, exit 2. Absent ⇒ scheduler OFF (documented dev/test posture). |

### Optional with defaults (all validated, exit 2 on malformed)

| Variable | Default | Validation |
|---|---|---|
| `GATEWAY_BIND_PORT` | `8787` | numeric port; non-numeric → exit 2. (Local cluster convention: 8791–8793.) |
| `GATEWAY_MAX_FRAME_SIZE` | `8388608` (8 MiB) | must be ≥ 1024 bytes; applies to inbound and outbound WebSocket frames, including catch-up and snapshots |
| `GATEWAY_QUEUE_CAPACITY` | `512` | must be ≥ 1 |
| `GATEWAY_HEARTBEAT_INTERVAL_SECS` | `30` | seconds |
| `GATEWAY_IDLE_TIMEOUT_SECS` | `120` | seconds |
| `GATEWAY_DB_POOL_SIZE` | `8` | must be ≥ 1 |
| `GATEWAY_NATS_SUBJECT_PREFIX` | `concord.dev` | namespace for the JetStream stream `CONCORD_OPS_<ns>` + subjects `<ns>.…`. **All gateways in one deployment MUST share one prefix.** |
| `GATEWAY_ID` | generated (nonzero u64) | logs/origin-suppression/metrics identity only — never a correctness input. u64. |
| `GATEWAY_JWKS_FILE` | unset | **dev/E2E ONLY** — local JWKS file instead of HTTPS issuer fetch. Never set in production. |
| `GATEWAY_RATE_CONNECT_PER_MIN` | `240` | connect attempts per minute per resolved client IP; integer in `[1, 10000]`, otherwise startup fails. |
| `GATEWAY_TRUSTED_PROXY_CIDRS` | unset (trust no proxy) | comma-separated IPv4/IPv6 CIDRs of proxy peers allowed to supply `X-Forwarded-For` (max 16, no `/0` catch-all); invalid values fail startup. Include only ranges from which the gateway can actually receive a trusted proxy connection. With a trusted peer, the gateway walks a valid, single forwarded chain from right to left and chooses the first untrusted address; missing or malformed chains fall back to the TCP peer. The ingress proxy must append the address it observes, and untrusted peers' headers are ignored. |
| `GATEWAY_REDIS_URL` | unset | Redis-backed ephemeral tier. Absent ⇒ local-only rate limiting + presence disabled. Unreachable ⇒ fail-soft (same degraded posture). Redis holds NO durable data (see docs/OPERATIONS.md DR section). |

### Observability (Phase 6)

| Variable | Default | Validation / meaning |
|---|---|---|
| `GATEWAY_OTEL_ENABLED` | `false` | zero behavior change when off. boolean. |
| `GATEWAY_OTEL_ENDPOINT` | `http://127.0.0.1:4317` | OTLP collector endpoint. In staging/prod point at the collector service URL. |
| `GATEWAY_OTEL_SAMPLE_RATIO` | `1.0` | must be within `[0.0, 1.0]`; outside → exit 2. |
| `GATEWAY_OTEL_EXPORTER` | `otlp` | one of `otlp` \| `stdout` \| `memory` (tests); anything else → exit 2. |
| `GATEWAY_DEBUG_OP_IDS` | `false` | debug op-id attribution in spans (bounded cardinality). boolean. |
| `RUST_LOG` | `info` | tracing filter, e.g. `sync_gateway=debug`. |

## Native worker

The worker is not env-configured — it is a **binary path contract**:

- Built by the cmake flow: `cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build/native` → `build/native/worker/concord-worker`.
- The gateway spawns it per maintenance request (fixed argv, bounded
  stdin/stdout, wall-clock timeouts, kill-on-drop).
- `GATEWAY_WORKER_BINARY` must point at a file readable by the **gateway
  process user** (uid 10001 in the image). Inside the gateway container the
  binary must exist in the image or on a mounted volume — the path is
  validated at gateway startup (exit 2 if not a file).
- The worker protocol is deterministic frame-based (commands 1–7); see
  docs/OPERATIONS.md § "Native recovery worker".

## Infrastructure

| Service | Variables | Notes |
|---|---|---|
| PostgreSQL 18.6 | `DATABASE_URL` (web), `GATEWAY_DATABASE_URL` (gateway) | Same instance, two roles. The **migration user needs CREATE on the schema** (see docs/MIGRATIONS.md). Loopback dev port is 5433 (native 5432 is occupied). |
| NATS 2.12 (JetStream) | `GATEWAY_NATS_URL` (`nats://…`) | Live transport only — never truth (see DR). Subject prefix via `GATEWAY_NATS_SUBJECT_PREFIX`. |
| Redis 8.8 | `GATEWAY_REDIS_URL` (`redis://…`) | Ephemeral only: presence, rate-limit counters. No persistence by design — a wipe is never a data event. |
| Clerk | `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (web); `GATEWAY_CLERK_ISSUER` (gateway) | The issuer is where the gateway fetches JWKS over HTTPS (unless `GATEWAY_JWKS_FILE` overrides in dev). |

## Observability endpoints (scrape targets)

| Endpoint | Exposed by | Path |
|---|---|---|
| Liveness | gateway | `GET /api/v1/health/live` |
| Readiness (Postgres-aware) | gateway | `GET /api/v1/health/ready` |
| Prometheus text metrics | gateway | `GET /metrics` (also `/api/v1/metrics` for JSON counters) |
| Web health | web app | `GET /api/health` (checks Postgres; 503 when DB unreachable) |

Prometheus scrape config lives at
`scripts/observability/prometheus.yml`; point `static_configs.targets` at
your gateway instances (the local config uses `host.docker.internal:8791…`).
A deployment provider wires the equivalent scrape jobs (SA-CLOUD7 owns
provider-specific wiring).

## Checking a deployment before start

```bash
# staging/prod: gate the deploy on the contract
node scripts/config/validate-env.mjs --scope prod
```

CI/deploy pipeline usage: `--json` emits `{scope, service, envFile, checked,
missing[], malformed[], result}` for machine consumption; exit code 1 on any
finding.

## Secret hygiene rules

1. Secrets are provided at **run time** (env-file / orchestrator secret
   manager) — never baked into images, never committed.
2. `.env.local` is git-ignored; `.env.example` carries names + placeholders
   only.
3. The gateway logs configuration errors with **variable names only** —
   secret values are never logged (config.rs is content-silent by design).
4. `NEXT_PUBLIC_*` values are public by design; treat everything else as
   secret.
