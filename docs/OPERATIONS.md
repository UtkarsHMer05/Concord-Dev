# Concord — Operations

Status: Authoritative (local dev + production runbooks)
Version: 2.0 (P7-M013/M016-M019: graceful shutdown, migrations, backup/DR)
Last updated: 2026-09-09

Deployment topology for staging/prod: `docs/DEPLOYMENT.md` +
`docker-compose.cloud.yml`. Environment variable contract:
`docs/CONFIGURATION.md`. Migration runbook: `docs/MIGRATIONS.md`.

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

## Phase 5 — storage lifecycle operations (2026-09-07)

### Native recovery worker

- Built by `./scripts/verify-gateway.sh` (or manually:
  `cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release &&
  cmake --build build/native`). Executable:
  `build/native/worker/concord-worker` — spawned per maintenance
  request by the gateway with fixed argv, bounded stdin/stdout, wall-
  clock timeouts, kill-on-drop (no zombies; no shell).
- Worker protocol commands (1–7): reconstruct, export, import-verify,
  digest-after, verify, generate (test streams), restore-diff. All
  responses are deterministic; errors are structured and content-free.

### Maintenance jobs & leases

- Jobs live in `maintenance_jobs` (durable; PostgreSQL is the only
  coordinator). Every gateway may claim; the compare-and-swap claim +
  versioned lease (`claim_version` + `lease_expires_at`) fences stale
  owners: a gateway that loses its lease cannot finalize, complete, or
  heartbeat. Dead-gateway jobs are re-queued by the expiry sweep.
- Queue depth is bounded by coalescing: duplicate snapshot requests for
  the same (document, boundary) collapse into the same pending job.
- Default limits (per gateway): 2 parallel native workers, 8 in-flight
  jobs, 90 s leases with heartbeat at lease/3. These are independent of
  realtime connection limits.

### Snapshot / compaction / recovery metrics (P5-M039)

`maintenance::storage_accounting(document)` exposes, per document:
op rows + bytes, snapshot count/bytes, finalized count, latest snapshot
coverage + age, compaction floor, tail op rows, revisions,
prunable-rows-remaining (nonzero after a partial prune = resumable
compaction). Gateway counters (`/api/v1/metrics`): worker timeouts,
worker failures, snapshots finalized/failed.

### Runbooks

- **Corrupt snapshot suspected**: recovery fails closed per candidate
  and falls back automatically (newest → older → full replay); the
  corrupt row is logged with its id. Quarantine by marking the row
  `superseded` (never DELETE a FINALIZED row referenced by a revision
  or the floor — retention rechecks protection).
- **Compaction stuck (prunable_rows_remaining > 0)**: safe state by
  construction — the floor equals committed prune progress. Resume by
  re-running `prune_to_boundary` (idempotent; refuses when coverage is
  missing). Investigate worker failures via `maintenance_jobs.last_failure_class`.
- **Stale client cannot sync**: a client cursor below the floor is
  served `snapshot_resync_required`; the client fetches + validates the
  snapshot and resumes delta catch-up. No operator action required;
  verify the floor snapshot row exists and is `finalized`.
- **Restore**: owner-triggered, forward-moving, auditable
  (`crdt_revisions.kind = 'restore_event'`); the restore batch is
  visible as ordinary durable ops. No history is rewritten.

---

## Graceful shutdown & rolling restarts (P7-M016/M017, 2026-09-09)

Status: Authoritative. Verified against the release containers (numbers
below are measured, not estimated). Runtime deployment topology:
`docs/DEPLOYMENT.md` + `docker-compose.cloud.yml` (3 gateway replicas,
nginx LB, ALB).

### What the containers do on SIGTERM (measured)

| Image | Signal path | Observed behavior | Exit code | Time |
|---|---|---|---|---|
| concord-gateway | exec-form ENTRYPOINT → binary is PID 1 → tokio catches SIGTERM | drain notice → write cutoff → bounded grace → clean stop | 0 | ~2.2 s |
| concord-web | exec-form CMD → node PID 1 → Next start-server closes listener | stops accepting, finishes pending requests | 143 (128+SIGTERM) | ~0.2 s |
| concord-worker | n/a — process-per-request, spawned by the gateway | nothing to drain; in-flight jobs are kill-on-drop, leases lapse, sweep requeues | — | — |

The gateway's drain sequence (from `main.rs`, mirrored by
`rust/sync-gateway/tests/lifecycle_integration.rs`):

1. SIGTERM/SIGINT received (tokio signal handler).
2. Maintenance scheduler stops claiming new jobs (in-flight workers are
   kill-on-drop; 90 s leases lapse and the expiry sweep requeues them).
3. Stop accepting new connections; `draining` flag set — new
   connections/auth/writes rejected with `server_draining`.
4. `server_draining` control frame sent to every live WebSocket session
   (best-effort, bounded queues).
5. Bounded grace window (~2 s) for in-flight persistence.
6. Process exits 0.

### Container verification (P7-M017, real WebSocket clients)

`scripts/release/drain-test.mjs` opens N=10 REAL authenticated WS
sessions against the release gateway container (JWKS-file dev posture),
writes 30 durable ops, then runs `docker stop -t 30` and measures
everything. Verified result (2026-09-09, concord-gateway image, Docker
Desktop linux/arm64):

```
10 sessions connected + joined (all Ready)
pre-drain: sent=30 acked=30 (all clients durable-acked: true)
docker stop -t 30 → container exited in 2196 ms, exit code 0
drain notices observed: 10/10; sockets closed: 10/10; close codes: 1006
durable rows: 30; acked-but-not-durable: 0
restarted instance ready: true
catch-up after restart: sync_done=true, ops replayed=30/30
DRAIN TEST: PASS
```

Operational contract proven by those numbers:

- **Every client gets the drain notice** (10/10 `server_draining`
  frames before socket close). Close code is 1006 (abnormal/none) — the
  gateway does not send WS close frames after the grace window; the
  drain notice IS the disconnect signal and clients reconnect by design.
- **Acked ⇒ durable, always**: every op that received `durable_ack`
  before the drain is a committed PostgreSQL row (30/30; zero
  acked-but-not-durable). `durable_ack` is only sent after commit, so a
  drain can never strand an acked write.
- **Restart catches up from the DB floor**: a FRESH client joining a
  restarted instance replayed 30/30 ops via normal catch-up. No operator
  action, no snapshot restore needed for this window.

Reproduce:

```bash
# gateway image must exist (scripts/release/smoke-images.sh builds
# concord-gateway:smoke; or build directly):
docker build -f docker/gateway.Dockerfile -t concord-gateway:drain .
node scripts/release/drain-test.mjs concord-gateway:drain 10
```

Prerequisites: compose `db` up; the e2e JWKS + key at
`.agent/scratch/phase-3/` (regenerated by the realtime suite's setup if
missing).

### Orchestrator guidance (timeouts for rolling restarts)

Measured drain budget: **~2.2 s** (2.0 s bounded grace + ~0.2 s notice
dispatch + teardown). Recommended settings:

- **SIGTERM grace ≥ 5 s** (drain + margin). Compose/K8s default 10 s is
  fine; `docker stop -t 30` in the smoke is deliberately generous.
- The 2 s in-flight grace is a code constant (`main.rs` shutdown
  future) — if you need longer in-flight windows, that is a code change
  (bounded on purpose), not a config.
- **Restart one gateway replica at a time** (rolling): with 3 replicas
  behind the nginx LB (no sticky sessions required — any gateway serves
  any client), a single replica draining for ~2 s is invisible to users;
  reconnects round-robin to the healthy replicas.
- **Do not SIGKILL gateways routinely**: a SIGKILLed gateway loses the
  in-flight grace window. Safety net: leases lapse (90 s) and the
  maintenance sweep requeues; un-acked client ops are simply re-sent by
  clients (idempotent by op identity). Use SIGKILL only when a process
  is wedged past the SIGTERM grace.
- The cloud compose stack (`docker-compose.cloud.yml`) uses
  `restart: unless-stopped` + healthchecks; `docker compose restart gw1`
  (or per-service `up -d` after image refresh) is the rolling-restart
  unit. Compose sends SIGTERM and waits 10 s by default — within the
  measured 2.2 s drain + margin.

---

## Backup & disaster recovery (P7-M018/M019, 2026-09-09)

Status: Authoritative. All commands below were EXECUTED and verified
(see "Verification evidence" per subsection). Provider-specific wiring
(managed backups on the cloud stack) belongs to the deployment owner
(docs/DEPLOYMENT.md); everything here is provider-agnostic.

### Data-tier responsibilities in recovery

| Tier | Role in recovery | Evidence |
|---|---|---|
| **PostgreSQL** | FULL durable truth: ops (`crdt_operations`), snapshots (`crdt_snapshots`), revisions, ACLs (`document_user_permissions`), audit (`audit_events`), maintenance jobs. The ONLY tier that must be backed up and restored. | restore rehearsal below |
| **NATS JetStream** | Live transport only. Loss is TOLERABLE: clients converge via PostgreSQL catch-up (the floor is the correctness authority). Streams auto-reprovision on gateway reconnect. | chaos CH-NATS-STORAGE-LOSS: JetStream volume destroyed → durable_rows 15/15, catchup_via_sync 15/15, lost=0, divergent=0 (fresh_gateway_provisioned=true); broker_integration `stream_and_consumer_provisioning_is_idempotent` proves get_or_create re-provisioning |
| **Redis** | NO durable document data. Presence + rate-limit counters only — wipe is never a data event. "Restore" = just start it. | chaos CH-REDIS-WIPE: FLUSHALL mid-editing → every observed durable_ack still durable, gateway alive, lost=0, divergent=0 |

### PostgreSQL backup / restore (verified commands)

Backup (plain SQL dump — restorable into any PostgreSQL 18.x, diffable,
compress-friendly):

```bash
# From the host (concord-db container, database "concord"):
docker exec concord-db pg_dump -U concord -d concord > concord-$(date +%Y%m%d-%H%M).sql

# Restore into a SCRATCH database first (never over live data):
docker exec concord-db psql -U concord -d postgres -c "DROP DATABASE IF EXISTS concord_restore_rehearsal;"
docker exec concord-db psql -U concord -d postgres -c "CREATE DATABASE concord_restore_rehearsal;"
docker exec -i concord-db psql -U concord -d concord_restore_rehearsal -v ON_ERROR_STOP=1 < concord-YYYYMMDD-HHMM.sql
```

Verification evidence (2026-09-09 rehearsal, concord_test →
concord_restore_rehearsal):

- Row counts identical across every table family (users 2, documents 1,
  ACLs 1, ops 5, snapshots 1, revisions 1, audit 1 — seeded set).
- **Both migration registries restore**: `gateway_schema_migrations`
  max version = 3; `drizzle.__drizzle_migrations` = 1 entry. A restored
  DB needs NO migration re-run.
- FK `documents_floor_snapshot_fk` present post-restore (v3 artifact).
- Cross-family joins verified: documents → floor snapshot (covered
  op count) → durable ops → revisions → ACL join.
- **Gateway boots against the restored DB** (`health/ready` OK) with
  ZERO migrations re-applied (only `CREATE TABLE IF NOT EXISTS ... skipping`
  NOTICE) — run_migrations is idempotent by the version registry.

Post-migration/restore verification queries:

```sql
-- Gateway family version (expect 3 = documents_floor_snapshot_fk):
SELECT version, name FROM gateway_schema_migrations ORDER BY version;
-- Drizzle family (schema "drizzle", table __drizzle_migrations):
SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id;
-- Table inventory (expect 11 public tables):
SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;
-- v3 FK presence:
SELECT conname FROM pg_constraint WHERE conname='documents_floor_snapshot_fk';
```

### Scheduled backups (provider-agnostic)

v1 rule — EITHER of:

1. **Managed automated backups** on the provider's PostgreSQL (if the
   deployment uses a managed instance — SA-CLOUD7 wires this), or
2. **cron pg_dump** on the instance (self-hosted compose posture):

```cron
# crontab -e (nightly 03:15, keep 14, on-instance gzip):
15 3 * * * docker exec concord-db pg_dump -U concord -d concord | gzip > /var/backups/concord/concord-$(date +\%Y\%m\%d).sql.gz && find /var/backups/concord -name 'concord-*.sql.gz' -mtime +14 -delete
```

Also keep at least one copy OFF the instance (S3/copy) — an instance
loss takes its local backups with it.

### RPO / RTO reasoning for v1 (honest, small numbers)

- **RPO = 24 h with nightly dumps** (last nightly). Ops lost in the
  window are recoverable only from clients' local CRDT state converging
  back on reconnect (the CRDT floor rebuilds from whatever durable ops
  survived). If the deployment uses managed PITR/backups instead, RPO
  improves to the provider's snapshot cadence — that is a deployment
  decision (SA-CLOUD7), not a code property.
- **RTO ≈ minutes, driven by restore size**: the drill below measured a
  full cold restart of the stack in ~30 s (data volume intact). A
  restore-from-dump adds only the psql replay time (the rehearsal DB
  replayed in seconds; production scale multiplies linearly with size).
- v1 is explicitly NOT multi-AZ (docs/DEPLOYMENT.md §4): recovery is
  "restart in order" (below), not failover.

### Recovery order after catastrophic restart (VERIFIED DRILL)

The order matters: PostgreSQL first (gateways fail-fast without it),
NATS/Redis next (gateways tolerate their absence but run degraded),
gateways, then web — clients reconnect and catch up from the DB floor.

1. **Restore PostgreSQL** (start the volume-backed container, or replay
   the latest dump into a fresh volume — see backup section).
2. **Start NATS** — streams auto-reprovision when gateways connect
   (idempotent get_or_create; no manual stream setup, ever).
3. **Start Redis** — empty is fine; presence/rate limits rebuild.
4. **Start gateways** — each boot runs `run_migrations` (idempotent —
   verified 0 re-applied) and connects broker+redis.
5. **Start web** — Next.js server needs only DATABASE_URL + Clerk env.
6. **Clients reconnect** — backoff+jitter; catch-up returns history
   from the DB floor.

Drill executed 2026-09-09 (compose stop of ALL services — volumes kept —
then restart in exactly this order, gateway on host with NATS+Redis wired):

```
1. db:            volume data intact (8/8 durable ops, gateway v3) — 1 s
2. nats:          healthy ~1-2 s (healthz initially 500 during boot —
                  wait for health, not just "started")
3. redis:         PONG after ~2 s port-accept delay
4. gateway:       health/ready OK, 0 migrations re-applied,
                  redis ephemeral tier connected, broker wired
5. client smoke:  fresh client joined 'dr-recovery' → sync_done=true,
                  ops replayed 8/8 — WS SMOKE: PASS
```

Reproduce the drill:

```bash
node scripts/release/ws-smoke.mjs 8791   # baseline against a live stack
docker compose stop                        # catastrophic stop (volumes kept)
# ... restart in the order above (db → nats → redis → gateway → web)
node scripts/release/ws-smoke.mjs 8791   # must PASS again with full history
```

### Restore-from-backup runbook (data loss / corruption)

1. Stop gateways + web (keep NATS/Redis running or stop everything).
2. Take a forensic dump of the CURRENT database before touching it.
3. `DROP DATABASE` + `CREATE DATABASE` (or restore into a scratch name
   and verify first — always preferred):
   ```bash
   docker exec -i concord-db psql -U concord -d postgres \
     -c "CREATE DATABASE concord_restored;"
   docker exec -i concord-db psql -U concord -d concord_restored \
     -v ON_ERROR_STOP=1 < concord-YYYYMMDD-HHMM.sql
   # verify counts + joins (queries above), then swap names.
   ```
4. Restart gateways (idempotent migrations are a no-op on restored data).
5. Run the WS smoke; clients converge via catch-up.
6. Post-incident: record what was lost (RPO window) in the incident doc.

---

## Release images: build, verify, reproducibility (P7-M016)

Build + smoke all three release images from a clean export:

```bash
scripts/release/smoke-images.sh
#   builds from `git archive HEAD` (clean committed tree) and verifies:
#   - gateway: health/live + uid 10001 + SIGTERM→exit 0 (~2.2 s)
#   - web:     HTTP responding + uid 1000 + SIGTERM→exit 143 (~0.2 s)
#   - worker:  generate_ops stdin probe (status 0) + uid 10001
# CONCORD_SMOKE_TREE=/path/to/export — build from a provided tree instead
# (verification helper for staged-but-uncommitted release-file changes).
```

Measured smoke results (2026-09-09, Docker Desktop linux/arm64):
gateway PASS (SIGTERM→exit 0 in 2222 ms), web PASS (exit 143 in 186 ms),
worker PASS (probe status 0). All three from a clean `git archive HEAD`
export.

Worker image note: the C++ runtime is linked statically
(`-static-libstdc++ -static-libgcc`) so the runtime stage is bare
`alpine:3.22` + the binary — no libstdc++ package needed at runtime. The
worker image HEALTHCHECK runs the same generate_ops probe the release
workflow proved ([u32 24][u32 6][u64 1][u32 10][u32 2][u32 0], expect
status 0 + 71-byte digest + ≥1 batch).

Reproducibility (measured, honest):

- **Same-day, same-input rebuilds with layer cache**: image digests are
  byte-identical (worker image rebuilt twice: identical
  `sha256:5c88592e…`).
- **Full `--no-cache` rebuilds**: image digests DIFFER (BuildKit layer
  metadata carries timestamps — 2 no-cache gateway builds produced
  `ba06875…` vs `0319383…`), BUT the **gateway binary inside is
  byte-identical** across both (sha256 `ea6f6f6a…` both times —
  Rust Release builds are deterministic here).
- **Across days**: base-tag drift (`alpine:3.22`, `node:24.20-alpine`
  are floating minor tags) means digests differ; the SBOM
  (`scripts/security/sbom.sh`) records the resolved base digest per
  build — that is the audit trail, not the image digest.

Practical rule: treat the SBOM + `SHA256SUMS` of exported artifacts as
the reproducibility record; expect image digests to match only for
cached same-day rebuilds.
