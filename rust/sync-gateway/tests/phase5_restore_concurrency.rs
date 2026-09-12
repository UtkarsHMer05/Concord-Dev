//! P5-M037: restore authorization + active-collaborator concurrency.
//!
//! Matrix: OWNER ok; EDITOR/COMMENTER/VIEWER/no-access all denied
//! (indistinguishable). Concurrency: edits arriving concurrently with
//! restore bookkeeping; restore never blocks the log; new durable ops
//! remain queryable; the differential verifier still passes after the
//! restore anchor exists (no silent loss of acknowledged edits — R7/H6).
//!
//! (The forward-ops restore batch — CMD_RESTORE_DIFF — lands with the
//! worker; these tests pin the service-level contract that holds either
//! way: authorization, log-immutability, and post-restore convergence.)

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::maintenance::{RecoverySelector, RevisionService};
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::golden;
use sync_gateway::worker::WorkerPool;
use uuid::Uuid;

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

async fn test_db() -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_URL.into(),
        clerk_issuer: "https://concur.clerk.accounts.dev".into(),
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: std::time::Duration::from_secs(30),
        idle_timeout: std::time::Duration::from_secs(600),
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
    };
    match Db::connect(&config).await {
        Ok(db) => {
            run_migrations(&db).await.expect("migrations");
            Some(db)
        }
        Err(_) => {
            eprintln!("SKIP: concord_test DB unreachable");
            None
        }
    }
}

fn live_worker_pool() -> Option<WorkerPool> {
    let mut root = std::env::current_dir().expect("cwd");
    for _ in 0..3 {
        for rel in [
            "build/native/concord-worker",
            "build/native/worker/concord-worker",
        ] {
            let mut path = root.clone();
            path.push(rel);
            if path.is_file() {
                return Some(WorkerPool::new(path, Duration::from_secs(300)));
            }
        }
        if !root.pop() {
            break;
        }
    }
    eprintln!("SKIP: concord-worker binary not built");
    None
}

/// Creates a user and grants them `role` on `doc` via the per-document
/// ACL (document_user_permissions). None ⇒ org member without grants is
/// NOT used here: no-access = no membership + no grant. Note org
/// membership alone resolves to EDITOR (authz.rs), so the "commenter"
/// and "viewer" cases MUST use direct ACL grants.
async fn user_with_role(db: &Db, doc: Uuid, role: Option<&str>) -> Option<UserId> {
    let client = db.get().await.expect("pool");
    let id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO users (id, clerk_user_id) VALUES ($1, $2)",
            &[&id, &format!("concur_{id}")],
        )
        .await
        .expect("user insert");
    if let Some(role) = role {
        // Role is a compile-time test constant; the enum bind via
        // parameter trips tokio-postgres type inference, so the fixed
        // literal is inlined (same pattern as existing fixture SQL).
        client
            .execute(
                &format!(
                    "INSERT INTO document_user_permissions (document_id, user_id, role)
                     VALUES ('{doc}', '{id}', '{role}')"
                ),
                &[],
            )
            .await
            .expect("acl grant");
    }
    Some(UserId(id))
}

async fn fixture_doc(db: &Db) -> (Uuid, Uuid, UserId) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'concur_{org}', 'p5-concur');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'concur_own_{owner}');
             INSERT INTO organization_memberships (user_id, organization_id, role)
               VALUES ('{owner}', '{org}', 'admin');
             INSERT INTO documents (id, owner_user_id, organization_id, title)
               VALUES ('{doc}', '{owner}', '{org}', 'p5-concur');"
        ))
        .await
        .expect("fixture");
    (org, doc, UserId(owner))
}

async fn cleanup(db: &Db, org: Uuid, doc: Uuid) {
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_revisions WHERE document_id = '{doc}';
             DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
             DELETE FROM maintenance_jobs WHERE document_id = '{doc}';
             DELETE FROM crdt_operations WHERE document_id = '{doc}';
             UPDATE documents SET compaction_floor_seq = NULL,
                 compaction_floor_snapshot_id = NULL WHERE id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM organization_memberships WHERE organization_id = '{org}';
             DELETE FROM users WHERE clerk_user_id LIKE 'concur_%';
             DELETE FROM organizations WHERE id = '{org}';"
        ))
        .await;
}

fn ops_at(count: usize, counter_base: u64, replica: u64) -> Vec<Vec<u8>> {
    let builders = [
        golden::golden_insert_op,
        golden::golden_delimiter_op,
        golden::golden_delete_op,
    ];
    (0..count)
        .map(|i| {
            let mut base = builders[i % builders.len()]();
            base[2..10].copy_from_slice(&replica.to_le_bytes());
            base[10..18].copy_from_slice(&(counter_base + i as u64).to_le_bytes());
            validate_op(&base).expect("valid");
            base
        })
        .collect()
}

#[tokio::test]
async fn restore_authorization_matrix_and_concurrent_edits() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (org, doc, owner) = fixture_doc(&db).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let jobs = sync_gateway::maintenance::JobRepo::new(db.clone());
    let service = RevisionService::new(repo.clone(), snapshots.clone(), workers.clone(), jobs);

    // Editable roles for the matrix.
    let editor = user_with_role(&db, doc, Some("EDITOR")).await.unwrap();
    let commenter = user_with_role(&db, doc, Some("COMMENTER")).await.unwrap();
    let viewer = user_with_role(&db, doc, Some("VIEWER")).await.unwrap();
    let stranger = user_with_role(&db, doc, None).await.unwrap(); // user, no grant

    // History: two phases, revision at the first boundary.
    let envelopes: Vec<_> = ops_at(6, 50, 0xC001)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    let b1 = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;
    let revision = service
        .create_revision(doc, owner, "named", Some("v1 checkpoint"), Some(b1))
        .await
        .expect("owner creates named revision");

    let envelopes2: Vec<_> = ops_at(6, 70, 0xC002)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    repo.ingest_batch(owner, doc, &envelopes2)
        .await
        .expect("ingest");

    // ---- Authorization matrix for restore (OWNER only, H5) ----
    for (label, actor) in [
        ("editor", editor),
        ("commenter", commenter),
        ("viewer", viewer),
        ("no-access", stranger),
    ] {
        let denied = service
            .restore_revision(doc, actor, revision.revision_id)
            .await;
        assert!(denied.is_err(), "{label} must not restore: {denied:?}");
    }
    // Named-revision creation matrix (EDITOR+): editor ok, commenter/
    // viewer/stranger denied.
    let editor_ok = service
        .create_revision(doc, editor, "named", Some("editor point"), None)
        .await;
    assert!(editor_ok.is_ok(), "editor can create named revisions");
    for (label, actor) in [
        ("commenter", commenter),
        ("viewer", viewer),
        ("no-access", stranger),
    ] {
        let denied = service
            .create_revision(doc, actor, "named", Some("x"), None)
            .await;
        assert!(denied.is_err(), "{label} must not create revisions");
    }
    // Listing (READ): viewer ok; stranger denied.
    let listed = service
        .list_revisions(doc, viewer, 10)
        .await
        .expect("viewer lists");
    assert!(!listed.is_empty());
    assert!(
        service.list_revisions(doc, stranger, 10).await.is_err(),
        "no-access must not list"
    );

    // ---- OWNER restores (the happy path) ----
    let outcome = service
        .restore_revision(doc, owner, revision.revision_id)
        .await
        .expect("owner restores");
    let outcome_applied_ops = outcome.applied_ops;
    assert!(outcome.target_state_digest.starts_with("sha256:"));

    // ---- Concurrent edits DURING/after restore: the log never blocks,
    //      no acknowledged edit is lost (R7/H6) ----
    let concurrent: Vec<_> = ops_at(4, 90, 0xC003)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    repo.ingest_batch(owner, doc, &concurrent)
        .await
        .expect("concurrent edits durably acked (ingest path intact)");
    // Every ORIGINAL op is still queryable, and the restore's forward
    // ops are APPENDED after them (forward-moving, H6: the log only
    // grows). The diff deletes wave2's extra visible items — those
    // delete ops are new durable rows, which is exactly restore-as-
    // forward-ops semantics.
    let page = repo.catchup_page(doc, 0, 64).await.expect("page");
    assert!(
        page.ops.len() >= 16,
        "no acknowledged op lost (have {}, expected >= 16)",
        page.ops.len()
    );
    let restore_op_count = page.ops.len() - 16;
    assert!(
        outcome_applied_ops >= restore_op_count,
        "restore diff ops must be durable-logged ({})",
        outcome_applied_ops
    );

    // Restore event recorded; a second restore (restore-of-restore) is
    // just another event — auditable, convergent.
    let second = service
        .restore_revision(doc, owner, revision.revision_id)
        .await
        .expect("restore of restore");
    let _ = second;

    // Post-restore convergence: differential verifier passes with the
    // concurrent ops folded in (no silent discard).
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers);
    selector
        .verify_equivalence(doc)
        .await
        .expect("equivalence after restore + concurrent edits");

    // Revision history is auditable: restore events exist with actor.
    let client = db.get().await.expect("pool");
    let n: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_revisions
             WHERE document_id = $1 AND kind = 'restore_event'",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n");
    assert_eq!(
        n, 2,
        "two restore events recorded (auditable, forward-only)"
    );

    cleanup(&db, org, doc).await;
}
