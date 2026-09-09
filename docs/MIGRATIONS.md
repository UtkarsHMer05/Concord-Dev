# Concord — Database migration runbook

Status: Authoritative (Phase 7, P7-M018)
Version: 1.0
Last updated: 2026-09-09

Every command below was executed against the real stack before being
written down. Deployment topology: `docs/DEPLOYMENT.md`; day-to-day ops
reference: `docs/OPERATIONS.md`; schema design rationale: `docs/DATABASE.md`.

## The TWO-FAMILY rule (read this first)

Concord has **two independent migration families** that share one
PostgreSQL instance and MUST be applied in order:

| Family | Owner | Registry | Applied by |
|---|---|---|---|
| App schema (users, documents, ACLs, orgs, audit) | drizzle (`drizzle/` dir) | `drizzle.__drizzle_migrations` (id + hash rows) | `node scripts/db/migrate.mjs` |
| Gateway schema (`crdt_operations`, snapshots, revisions, maintenance jobs, floor columns) | Rust gateway (`rust/sync-gateway/src/db/migrations.rs`) | `public.gateway_schema_migrations` (version + name + applied_at) | `run_migrations()` at every gateway boot |

**ORDER: drizzle FIRST, gateway second.** The gateway's first migration
creates `crdt_operations` with `FOREIGN KEY (document_id) REFERENCES
documents(id)` — the drizzle-owned `documents` table must exist before
the gateway family can apply. A gateway boot against an empty database
WITHOUT the drizzle family fails its migration transaction (exit 3):
the honest fail-fast, never a half-migrated schema.

The two registries are deliberately separate (SA-DATA audit,
`.agent/subagents/phase-3/postgres-authz-audit.md`): the systems never
collide, and each is idempotent in its own transaction — PostgreSQL
transactional DDL means a crashed apply leaves NO partial state.

## Current schema version inventory

### Drizzle family (drizzle/)

| Migration | What it does |
|---|---|
| `0000_mean_ogun` | Initial app schema: `users`, `organizations`, `organization_memberships`, `documents` (+title/version checks), `document_user_permissions` (+role enum `EDITOR|COMMENTER|VIEWER`), `audit_events`; all FKs; indexes incl. unique `clerk_user_id`; `pg_trgm` extension + GIN trigram index on lower(title) for ILIKE search. |

Registry check after apply:

```sql
SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id;
-- 1 row per applied migration (id 1 = 0000_mean_ogun today)
```

### Gateway family (rust/sync-gateway/src/db/migrations.rs)

| Version | Name | What it does |
|---|---|---|
| 1 | `crdt_operations operation log` | The durable op log: `crdt_operations` (BIGSERIAL id = server cursor only — NEVER CRDT semantics; UNIQUE(document_id, operation_id) = the idempotency key; payload BYTEA + checksum), catch-up + replica indexes. Additive only. |
| 2 | `phase5 snapshots revisions jobs` | Storage lifecycle: `crdt_snapshots` (verified snapshots + status lifecycle + size checks), `crdt_revisions` (auto_checkpoint/named/restore_event), `maintenance_jobs` (leases, claim_version fencing); documents gains nullable `compaction_floor_seq`/`compaction_floor_snapshot_id` via ADD COLUMN IF NOT EXISTS. Phase 1 tables are never altered destructively. |
| 3 | `phase5 floor fk + indexes` | `documents_floor_snapshot_fk` FK on the floor snapshot pointer (DROP IF EXISTS + ADD — the idempotent form, since PostgreSQL lacks ADD CONSTRAINT IF NOT EXISTS; safe because the definition is identical every run). Backstop so retention can never leave documents dangling. |

Registry check after apply:

```sql
SELECT version, name, applied_at FROM gateway_schema_migrations ORDER BY version;
-- expect 1, 2, 3 today
```

## Exact commands (staging / prod)

Staging-first rule: run EVERY migration on staging, verify, THEN prod.
Both environments use the same commands against different URLs
(docs/DEPLOYMENT.md env matrix; the cloud stack runs compose Postgres on
the instance — commands run there over SSH, or `docker exec concord-<env>-db`).

```bash
# 0. Pre-flight: validate the environment contract first (never migrate
#    with a broken env):
node scripts/config/validate-env.mjs --scope prod

# 1. BACKUP FIRST (see docs/OPERATIONS.md § Backup for the full runbook):
docker exec concord-prod-db pg_dump -U concord -d concord > concord-pre-migration-$(date +%Y%m%d-%H%M).sql

# 2. Check current versions (both families) BEFORE:
docker exec concord-prod-db psql -U concord -d concord -c \
  "SELECT (SELECT max(id) FROM drizzle.__drizzle_migrations) drizzle,
          (SELECT max(version) FROM gateway_schema_migrations) gateway;"

# 3. Apply the DRIZZLE family (explicit URL — never trust ambient env):
node scripts/db/migrate.mjs postgresql://user:pass@127.0.0.1:5432/concord
# (local dev: `npm run db:migrate` [concord] / `npm run db:migrate:test`
#  [concord_test] read .env.local)

# 4. Apply the GATEWAY family: restart (or start) ONE gateway —
#    run_migrations() runs at boot, in a transaction, idempotently:
docker compose -f docker-compose.cloud.yml restart gw1
# then check the log line per applied version, or the registry query.

# 5. Roll the remaining gateways (gw2, gw3) — their boots re-run
#    run_migrations, which is a no-op via the version registry.
```

## Expand → deploy → backfill → verify → contract

Concord's migrations follow the expand-contract style (the STORAGE-era
migrations are the in-repo example):

- **Expand**: new tables/columns are ADDITIVE (`CREATE TABLE IF NOT
  EXISTS`, `ADD COLUMN IF NOT EXISTS`). Gateway v2 is the pattern: new
  tables + nullable columns — the pre-migration gateway keeps running.
- **Deploy**: the binary that USES the new shape ships after the schema
  is present (gateway boots run migrations before serving — ordering
  enforced by the boot sequence itself).
- **Backfill**: Concord has needed none yet (nullable columns default
  NULL; floors are populated lazily by compaction, not a migration
  backfill). If a future migration needs one: add the column nullable,
  ship code that writes both shapes, backfill in batches OUTSIDE the
  boot transaction (run_migrations is sized for DDL, not data moves).
- **Contract**: drop the old shape only after N releases of dual-read.
  Gateway v3's DROP CONSTRAINT IF EXISTS + ADD is the idempotent
  constraint-swap idiom, not a destructive contract step.
- **Contract (hard rule)**: Phase 1 tables are NEVER altered
  destructively by the gateway family (audit-enforced design).

## Pre-migration checklist

1. **Backup taken and restorable** — take the dump, restore it into a
   scratch DB, verify counts (the rehearsal below is the proof
   pattern; do not skip the restore-verify step, an unverified backup
   is hope, not a backup).
2. **Schema version check** — both registry queries above; write down
   the numbers.
3. **Staging-first rule** — same commands, staging URL, verify
   everything below, THEN prod.
4. **Permissions**: the migration user needs `CREATE` on the schema
   (new tables) and ownership (or ALTER) for ALTER TABLE on documents.
   The compose `concord` superuser trivially has this; a managed
   provider user must be granted:
   ```sql
   -- one-time, by the instance admin:
   GRANT CREATE ON SCHEMA public TO concord_app;   -- migrations create tables
   -- app tables are owned by the migration user; readers need SELECT +
   -- INSERT/UPDATE/DELETE per the app's role split.
   ```
5. **Gateways are restartable** — migrations run at boot; plan the
   rolling restart window (drain is ~2.2 s per gateway —
   docs/OPERATIONS.md § Graceful shutdown).

## Verification queries post-migration

```sql
-- Both registries at expected versions:
SELECT (SELECT max(id) FROM drizzle.__drizzle_migrations) AS drizzle,   -- expect 1
       (SELECT max(version) FROM gateway_schema_migrations) AS gateway; -- expect 3
-- Table inventory (11 public tables today):
SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;
-- v3 FK presence:
SELECT conname FROM pg_constraint WHERE conname = 'documents_floor_snapshot_fk';
-- Gateway log lines (if booting a gateway): "applied gateway migration
-- migration_version=N" per applied version; zero lines = already current.
```

Plus one functional check: run the WS smoke
(`node scripts/release/ws-smoke.mjs` pattern / any realtime suite) —
auth + join + catch-up all read the migrated schema.

## Rollback path (honest statement)

**drizzle-kit has no auto-down.** The repo's rollback strategy is
forward-fix or restore:

1. **Preferred: forward-fix.** Every migration so far is additive — a
   bad migration is fixed by another migration (the v3
   DROP+ADD-constraint pattern is the in-repo example of correcting a
   prior migration's shape).
2. **Data loss / corruption: restore from the pre-migration backup.**
   This is the ONLY true rollback and exactly why the checklist
   demands a verified backup. Restoring = replay the dump into a fresh
   database (never over live), verify, swap. Anything committed to the
   OLD database after the backup is lost — that is the RPO cost, and
   why backups are nightly at minimum.
3. **Never**: hand-DROP migration registry rows to "re-run" a migration
   — the registries are the truth of what is applied; faking them
   breaks the idempotency contract.

## Backup→restore rehearsal (executed 2026-09-09)

The full drill, against `concord_test` (seeded: 2 users, 1 document,
1 ACL, 5 durable ops, 1 finalized floor snapshot, 1 revision, 1 audit
event — both families applied):

```bash
# Backup:
docker exec concord-db pg_dump -U concord -d concord_test > /tmp/concord_test_backup.sql
# Scratch target:
docker exec concord-db psql -U concord -d postgres -c "DROP DATABASE IF EXISTS concord_restore_rehearsal;"
docker exec concord-db psql -U concord -d postgres -c "CREATE DATABASE concord_restore_rehearsal;"
docker exec -i concord-db psql -U concord -d concord_restore_rehearsal -v ON_ERROR_STOP=1 < /tmp/concord_test_backup.sql
```

Observed results:

- Restore completed with `-v ON_ERROR_STOP=1` — zero errors.
- Row counts across ALL table families identical to source.
- `gateway_schema_migrations` restored at v3; `drizzle.__drizzle_migrations`
  restored with its 1 entry. **A restored DB needs no migration re-run.**
- FK `documents_floor_snapshot_fk` present; cross-family joins
  (documents → floor snapshot → ops → revisions → ACL) all correct.
- Gateway boot against the restored DB: `health/ready` OK, **zero**
  migrations re-applied (idempotency via the version registry —
  only the `CREATE TABLE IF NOT EXISTS ... skipping` NOTICE appears).

The drill is repeatable on any environment with the same commands and
the verification queries above.
