//! Phase 5 migration tests (P5-M011).
//!
//! Runs against the isolated `concord_test` database (same convention
//! as db_integration.rs); skipped when the DB is unreachable. Verifies:
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

async fn test_db() -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_URL.into(),
        clerk_issuer: "https://fun-blowfish-5798.clerk.accounts.dev".into(),
        allowed_origins: vec![],
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
    };
    match Db::connect(&config).await {
        Ok(db) => Some(db),
        Err(_) => {
            eprintln!("SKIP: concord_test DB unreachable");
            None
        }
    }
}

async fn table_exists(client: &tokio_postgres::Client, name: &str) -> bool {
    let row = client
        .query_one(
            "SELECT COUNT(*) AS n FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = $1",
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
async fn phase5_migration_version_is_two_and_idempotent() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("first apply");
    let v1 = current_version(&db).await.expect("version");
    assert_eq!(v1, 2, "both gateway migrations must be applied");
    run_migrations(&db).await.expect("re-apply");
    let v2 = current_version(&db).await.expect("version after re-apply");
    assert_eq!(v1, v2, "re-apply must be a no-op");
}

#[tokio::test]
async fn phase5_applies_on_phase4_shaped_database() {
    let Some(db) = test_db().await else { return };
    // Ensure the registry + all current tables exist first (fresh DBs
    // and post-audit resets both land here).
    run_migrations(&db).await.expect("initial apply");
    let mut client = db.get().await.expect("pool");
    // Simulate a Phase 4 database: only migration 1 recorded (the
    // pre-Phase-5 state). Rolling the registry back is only safe in
    // the isolated test DB; tables from v2 are dropped so the apply
    // truly recreates them.
    let tx = client.transaction().await.expect("tx");
    tx.batch_execute(
        "DELETE FROM gateway_schema_migrations WHERE version = 2;
         DROP TABLE IF EXISTS crdt_snapshots, crdt_revisions, maintenance_jobs;
         ALTER TABLE documents
           DROP COLUMN IF EXISTS compaction_floor_seq,
           DROP COLUMN IF EXISTS compaction_floor_snapshot_id;",
    )
    .await
    .expect("reset to phase-4 shape");
    tx.commit().await.expect("commit reset");

    run_migrations(&db).await.expect("apply on phase-4 shape");
    let client = db.get().await.expect("pool");
    let v = current_version(&db).await.expect("version");
    assert_eq!(v, 2);
    // Phase 1/3/4 tables untouched by the apply.
    for table in ["users", "organizations", "documents", "crdt_operations"] {
        assert!(table_exists(&client, table).await);
    }
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
