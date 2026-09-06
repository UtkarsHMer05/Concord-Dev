//! Embedded migration runner for gateway-owned schema (P3-M016/M017).
//!
//! Design (SA-DATA audit, `.agent/subagents/phase-3/postgres-authz-audit.md`):
//! - The gateway owns exactly ONE new table family: `crdt_operations` and
//!   its `gateway_schema_migrations` registry. Phase 1 tables are NEVER
//!   altered — the gateway only reads them.
//! - Registry is separate from Drizzle's `__drizzle_migrations`; the two
//!   migration systems are independent and must not collide.
//! - Application is idempotent: applied versions are skipped; each
//!   migration runs inside a transaction WITH the registry insert, so a
//!   crashed apply leaves no partial state.
//!
//! `crdt_operations` (the durable operation log, P3-M016):
//! - `id BIGSERIAL` — server sequence, storage/fetch cursor ONLY; never
//!   defines CRDT conflict semantics (non-negotiable #7).
//! - `UNIQUE (document_id, operation_id)` — the durable idempotency key
//!   (non-negotiable #5).
//! - `INDEX (document_id, id)` — bounded per-document catch-up.
//! - `payload BYTEA` — Phase 2 canonical op bytes verbatim
//!   (`payload_version = 1`); `payload_checksum` SHA-256 hex.

use tokio_postgres::Transaction;

use super::pool::PoolError;

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error(transparent)]
    Db(#[from] PoolError),
    #[error("migration {version} failed: {message}")]
    Failed { version: u32, message: String },
}

/// One embedded migration: version + statement. Statements are static
/// strings in this file — no untrusted input ever reaches them.
struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "crdt_operations operation log",
    sql: r#"
        CREATE TABLE IF NOT EXISTS crdt_operations (
            id               BIGSERIAL PRIMARY KEY,
            document_id      UUID NOT NULL,
            operation_id     TEXT NOT NULL,
            replica_id       BIGINT NOT NULL,
            replica_sequence BIGINT NOT NULL,
            payload          BYTEA NOT NULL,
            payload_version  SMALLINT NOT NULL DEFAULT 1,
            payload_checksum TEXT NOT NULL,
            accepted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT crdt_operations_document_fk
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
            CONSTRAINT crdt_operations_identity_uq
                UNIQUE (document_id, operation_id),
            CONSTRAINT crdt_operations_sequence_range
                CHECK (replica_sequence >= 1 AND replica_sequence <= 9223372036854775807)
        );
        CREATE INDEX IF NOT EXISTS crdt_operations_document_catchup_idx
            ON crdt_operations (document_id, id);
        CREATE INDEX IF NOT EXISTS crdt_operations_replica_idx
            ON crdt_operations (document_id, replica_id, replica_sequence);
    "#,
}];

/// Applies all pending migrations idempotently. Safe to run on an empty
/// database, on a Phase 1 database, and repeatedly (verified by tests).
pub async fn run_migrations(db: &super::Db) -> Result<(), MigrationError> {
    let mut client = db.get().await?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| MigrationError::Failed {
            version: 0,
            message: e.to_string(),
        })?;
    tx.batch_execute(
        "CREATE TABLE IF NOT EXISTS gateway_schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )",
    )
    .await
    .map_err(|e| MigrationError::Failed {
        version: 0,
        message: e.to_string(),
    })?;

    for migration in MIGRATIONS {
        let version = migration.version as i32;
        let applied = tx
            .query_opt(
                "SELECT version FROM gateway_schema_migrations WHERE version = $1",
                &[&version],
            )
            .await
            .map_err(|e| MigrationError::Failed {
                version: migration.version,
                message: e.to_string(),
            })?;
        if applied.is_some() {
            continue;
        }
        apply_one(&tx, migration).await?;
    }

    tx.commit().await.map_err(|e| MigrationError::Failed {
        version: 0,
        message: e.to_string(),
    })?;
    Ok(())
}

async fn apply_one(tx: &Transaction<'_>, migration: &Migration) -> Result<(), MigrationError> {
    // DDL + registry row in one transaction: a crashed apply leaves no
    // partial state (PostgreSQL transactional DDL).
    tx.batch_execute(migration.sql)
        .await
        .map_err(|e| MigrationError::Failed {
            version: migration.version,
            message: e.to_string(),
        })?;
    let version = migration.version as i32;
    tx.execute(
        "INSERT INTO gateway_schema_migrations (version, name) VALUES ($1, $2)",
        &[&version, &migration.name],
    )
    .await
    .map_err(|e| MigrationError::Failed {
        version: migration.version,
        message: e.to_string(),
    })?;
    tracing::info!(
        migration_version = migration.version,
        migration_name = migration.name,
        "applied gateway migration"
    );
    Ok(())
}

/// Current applied version (for diagnostics + tests).
pub async fn current_version(db: &super::Db) -> Result<u32, MigrationError> {
    let client = db.get().await?;
    let row = client
        .query_opt(
            "SELECT COALESCE(MAX(version), 0) AS v FROM gateway_schema_migrations",
            &[],
        )
        .await
        .map_err(|e| MigrationError::Failed {
            version: 0,
            message: e.to_string(),
        })?;
    let v: i32 = row.map(|r| r.get("v")).unwrap_or(0);
    Ok(v as u32)
}
