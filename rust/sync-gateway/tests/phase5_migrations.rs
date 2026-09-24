//! Phase 5 migration tests (P5-M011).
//!
//! Runs against `DATABASE_TEST_URL` (defaulting to the repository's
//! `concord_test` test DB); skipped when the DB is unreachable. The
//! phase-4-shaped migration case uses a disposable schema so it never resets
//! shared database state. Verifies:
//! - v2 tables/columns/indexes/constraints exist after apply;
//! - application is idempotent and version-stable;
//! - applies cleanly on a "Phase 4-shaped" database (only migration 1
//!   recorded, i.e. simulated pre-Phase-5 state);
//! - CHECK constraints reject invalid values (status enums, ranges);
//! - documents gains the compaction-floor columns additively.

use sync_gateway::config::Config;
use sync_gateway::db::migrations::{current_version, run_migrations};
use sync_gateway::db::pool::Db;

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

fn test_config(database_url: String) -> Config {
    Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url,
        clerk_issuer: "https://fun-blowfish-5798.clerk.accounts.dev".into(),
        clerk_audience: None,
        clerk_authorized_party: None,
        require_internal_services: false,
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: std::time::Duration::from_secs(30),
        idle_timeout: std::time::Duration::from_secs(120),
        db_pool_size: 4,
        jwks_file: None,
        nats_url: None,
        nats_subject_prefix: "concord.test".to_string(),
        gateway_id: 1,
        redis_url: None,
        otel_enabled: false,
        otel_endpoint: "http://127.0.0.1:4317".into(),
        otel_sample_ratio: 1.0,
        otel_exporter: "otlp".into(),
        debug_op_ids: false,
        worker_binary: None,
    }
}

fn test_database_url() -> String {
    std::env::var("DATABASE_TEST_URL").unwrap_or_else(|_| TEST_URL.into())
}

async fn test_db_at(database_url: String) -> Option<Db> {
    match Db::connect(&test_config(database_url)).await {
        Ok(db) => Some(db),
        Err(_) => {
            eprintln!("SKIP: DATABASE_TEST_URL database unreachable");
            None
        }
    }
}

async fn test_db() -> Option<Db> {
    test_db_at(test_database_url()).await
}

async fn table_exists(client: &tokio_postgres::Client, name: &str) -> bool {
    let row = client
        .query_one(
            "SELECT COUNT(*) AS n FROM information_schema.tables
             WHERE table_schema = current_schema() AND table_name = $1",
            &[&name],
        )
        .await
        .expect("information_schema query");
    let n: i64 = row.get("n");
    n == 1
}

#[tokio::test]
async fn phase5_tables_and_columns_exist() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let client = db.get().await.expect("pool");

    for table in ["crdt_snapshots", "crdt_revisions", "maintenance_jobs"] {
        assert!(table_exists(&client, table).await, "{table} missing");
    }

    // documents floor columns (additive, nullable).
    for column in ["compaction_floor_seq", "compaction_floor_snapshot_id"] {
        let row = client
            .query_one(
                "SELECT COUNT(*) AS n FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND table_name = 'documents' AND column_name = $1",
                &[&column],
            )
            .await
            .expect("column query");
        let n: i64 = row.get("n");
        assert_eq!(n, 1, "documents.{column} missing");
    }

    // Lifecycle + queue indexes.
    let row = client
        .query_one(
            "SELECT COUNT(*) AS n FROM pg_indexes
             WHERE indexname IN ('crdt_snapshots_lifecycle_idx',
                                 'crdt_revisions_boundary_idx',
                                 'crdt_revisions_listing_idx',
                                 'maintenance_jobs_queue_idx',
                                 'maintenance_jobs_document_idx')",
            &[],
        )
        .await
        .expect("index query");
    let n: i64 = row.get("n");
    assert_eq!(n, 5, "phase5 indexes missing (found {n})");

    // Attempt uniqueness + public-id uniqueness.
    let row = client
        .query_one(
            "SELECT COUNT(*) AS n FROM pg_indexes
             WHERE indexname IN ('crdt_snapshots_attempt_uq',
                                 'crdt_snapshots_public_id_uq',
                                 'crdt_revisions_public_id_uq',
                                 'maintenance_jobs_public_id_uq')",
            &[],
        )
        .await
        .expect("unique index query");
    let n: i64 = row.get("n");
    assert_eq!(n, 4, "unique indexes missing (found {n})");
}

#[tokio::test]
async fn gateway_migration_version_is_five_and_idempotent() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("first apply");
    let v1 = current_version(&db).await.expect("version");
    assert_eq!(v1, 5, "all gateway migrations must be applied");
    run_migrations(&db).await.expect("re-apply");
    let v2 = current_version(&db).await.expect("version after re-apply");
    assert_eq!(v1, v2, "re-apply must be a no-op");
}

#[tokio::test]
async fn phase5_applies_on_phase4_shaped_database() {
    let base_url = test_database_url();
    let Some(admin) = test_db_at(base_url.clone()).await else {
        return;
    };
    let schema = format!("phase4_migration_{}", uuid::Uuid::new_v4().simple());
    let schema_url = format!(
        "{base_url}{}options=-csearch_path%3D{schema}%2Cpublic",
        if base_url.contains('?') { '&' } else { '?' }
    );
    let Some(db) = test_db_at(schema_url).await else {
        return;
    };
    let document = uuid::Uuid::new_v4();
    let owner = uuid::Uuid::new_v4();
    let client = admin.get().await.expect("admin connection");
    client
        .batch_execute(&format!(
            "CREATE SCHEMA {schema};
             CREATE TABLE {schema}.users (id UUID PRIMARY KEY);
             CREATE TABLE {schema}.documents (
                 id UUID PRIMARY KEY,
                 compaction_floor_snapshot_id UUID);
             CREATE TABLE {schema}.crdt_operations (
                 id BIGSERIAL PRIMARY KEY,
                 document_id UUID NOT NULL REFERENCES {schema}.documents(id) ON DELETE CASCADE,
                 operation_id TEXT NOT NULL,
                 replica_id BIGINT NOT NULL,
                 replica_sequence BIGINT NOT NULL,
                 payload BYTEA NOT NULL,
                 payload_version SMALLINT NOT NULL DEFAULT 1,
                 payload_checksum TEXT NOT NULL,
                 accepted_at TIMESTAMPTZ NOT NULL DEFAULT now());
             CREATE TABLE {schema}.gateway_schema_migrations (
                 version INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
             INSERT INTO {schema}.gateway_schema_migrations (version, name)
                 VALUES (1, 'crdt_operations operation log');
             INSERT INTO {schema}.users (id) VALUES ('{owner}');
             INSERT INTO {schema}.documents (id) VALUES ('{document}');"
        ))
        .await
        .expect("seed disposable phase-4-shaped schema");

    run_migrations(&db).await.expect("apply on phase-4 shape");
    let client = db.get().await.expect("pool");
    let version = current_version(&db).await.expect("version");
    let tables_exist = ["users", "documents", "crdt_operations"];
    for table in tables_exist {
        assert!(
            table_exists(&client, table).await,
            "{table} missing after apply"
        );
    }
    let fk_count: i64 = client
        .query_one(
            "SELECT COUNT(*) FROM information_schema.table_constraints
             WHERE constraint_schema = current_schema()
               AND constraint_type = 'FOREIGN KEY'
               AND constraint_name = 'documents_floor_snapshot_fk'",
            &[],
        )
        .await
        .expect("fk query")
        .get(0);
    admin
        .get()
        .await
        .expect("admin connection")
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .expect("cleanup disposable schema");
    assert_eq!(version, 5);
    assert_eq!(fk_count, 1, "floor snapshot FK missing after apply");
}

#[tokio::test]
async fn phase5_check_constraints_reject_invalid_values() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let mut client = db.get().await.expect("pool");

    // A real document to satisfy FKs (Phase 1 columns).
    let tx = client.transaction().await.expect("tx");
    let org = uuid::Uuid::new_v4();
    let owner = uuid::Uuid::new_v4();
    let doc = uuid::Uuid::new_v4();
    tx.batch_execute(&format!(
        "INSERT INTO organizations (id, clerk_organization_id, name)
           VALUES ('{org}', 'org_{org}', 'p5-mig-test');
         INSERT INTO users (id, clerk_user_id)
           VALUES ('{owner}', 'p5_mig_owner_{owner}');
         INSERT INTO documents (id, owner_user_id, title)
           VALUES ('{doc}', '{owner}', 'p5-mig');"
    ))
    .await
    .expect("fixture");
    tx.commit().await.expect("commit fixture");

    // Invalid snapshot status.
    {
        let c = db.get().await.expect("pool");
        let r = c
            .batch_execute(&format!(
                "INSERT INTO crdt_snapshots (snapshot_id, document_id, format_version,
                 coverage_seq, covered_op_count, state_digest, state_summary, payload,
                 payload_size, payload_checksum, status)
                 VALUES ('{}', '{}', 1, 5, 5, 'd', '{{}}', E'\\\\x00', 1,
                         repeat('0', 64), 'bogus_status')",
                uuid::Uuid::new_v4(),
                doc
            ))
            .await;
        assert!(r.is_err(), "invalid snapshot status must be rejected");
    }
    // payload_size must equal OCTET_LENGTH(payload).
    {
        let c = db.get().await.expect("pool");
        let r = c
            .batch_execute(&format!(
                "INSERT INTO crdt_snapshots (snapshot_id, document_id, format_version,
                 coverage_seq, covered_op_count, state_digest, state_summary, payload,
                 payload_size, payload_checksum, status)
                 VALUES ('{}', '{}', 1, 5, 5, 'd', '{{}}', E'\\\\x00', 999,
                         repeat('0', 64), 'building')",
                uuid::Uuid::new_v4(),
                doc
            ))
            .await;
        assert!(r.is_err(), "payload_size != octet_length must be rejected");
    }
    // Invalid revision kind.
    {
        let c = db.get().await.expect("pool");
        let r = c
            .batch_execute(&format!(
                "INSERT INTO crdt_revisions (revision_id, document_id, target_seq, kind)
                 VALUES ('{}', '{}', 1, 'keystroke')",
                uuid::Uuid::new_v4(),
                doc
            ))
            .await;
        assert!(r.is_err(), "invalid revision kind must be rejected");
    }
    // 'named' revision without label.
    {
        let c = db.get().await.expect("pool");
        let r = c
            .batch_execute(&format!(
                "INSERT INTO crdt_revisions (revision_id, document_id, target_seq, kind, label)
                 VALUES ('{}', '{}', 1, 'named', NULL)",
                uuid::Uuid::new_v4(),
                doc
            ))
            .await;
        assert!(r.is_err(), "named revision without label must be rejected");
    }
    // Running job without owner/lease.
    {
        let c = db.get().await.expect("pool");
        let r = c
            .batch_execute(&format!(
                "INSERT INTO maintenance_jobs (job_id, kind, state) VALUES
                 ('{}', 'snapshot_build', 'running')",
                uuid::Uuid::new_v4()
            ))
            .await;
        assert!(r.is_err(), "running job without lease must be rejected");
    }
    // Invalid job kind.
    {
        let c = db.get().await.expect("pool");
        let r = c
            .batch_execute(&format!(
                "INSERT INTO maintenance_jobs (job_id, kind, state) VALUES
                 ('{}', 'reindex', 'pending')",
                uuid::Uuid::new_v4()
            ))
            .await;
        assert!(r.is_err(), "invalid job kind must be rejected");
    }
    // Attempt uniqueness: two attempts with same (document, boundary, attempt).
    {
        let c = db.get().await.expect("pool");
        let sid = uuid::Uuid::new_v4();
        let sql = format!(
            "INSERT INTO crdt_snapshots (snapshot_id, document_id, format_version,
             coverage_seq, covered_op_count, state_digest, state_summary, payload,
             payload_size, payload_checksum, status, attempt)
             VALUES ('{sid}', '{doc}', 1, 7, 7, 'd', '{{}}', E'\\\\x00', 1,
                     repeat('0', 64), 'building', 1)"
        );
        c.batch_execute(&sql).await.expect("first attempt");
        let sid2 = uuid::Uuid::new_v4();
        let sql2 = sql.replace(&sid.to_string(), &sid2.to_string());
        let c = db.get().await.expect("pool");
        let r = c.batch_execute(&sql2).await;
        assert!(
            r.is_err(),
            "duplicate (document, boundary, attempt) must be rejected"
        );
    }

    // Cleanup fixture rows (op-log style: dedicated data per test).
    let c = db.get().await.expect("pool");
    c.batch_execute(&format!(
        "DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
         DELETE FROM crdt_revisions WHERE document_id = '{doc}';
         DELETE FROM maintenance_jobs WHERE document_id = '{doc}';
         DELETE FROM documents WHERE id = '{doc}';
         DELETE FROM users WHERE id = '{owner}';
         DELETE FROM organizations WHERE id = '{org}';"
    ))
    .await
    .expect("cleanup");
}
