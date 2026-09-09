//! Snapshot pipeline integration tests (P5-M016..M020).
//!
//! Runs against the live test DB + the REAL concord-worker binary
//! (skipped when either is unavailable — documented preconditions:
//! docker compose up -d db; cmake --build build/native).
//!
//! Proves: build at an exact boundary (later ops excluded from the
//! snapshot), the M017 verification oracles, guarded finalization,
//! failed attempts never finalize, and the snapshot+tail == full-replay
//! equivalence property (M020) on a real rich op set.

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::{status, SnapshotRepo};
use sync_gateway::maintenance::SnapshotPipeline;
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
        otel_enabled: false,
        otel_endpoint: "http://127.0.0.1:4317".into(),
        otel_sample_ratio: 1.0,
        otel_exporter: "otlp".into(),
        debug_op_ids: false,
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
                return Some(WorkerPool::new(path, Duration::from_secs(120)));
            }
        }
        if !root.pop() {
            break;
        }
    }
    eprintln!("SKIP: concord-worker binary not built");
    None
}

/// Real canonical op bytes: the golden parity ops (insert, delimiter,
/// delete), each made unique by a fresh (replica, counter) identity.
/// These are the same shape clients send, re-encoded through
/// `validate_op`.
fn golden_op_payloads(count: usize) -> Vec<Vec<u8>> {
    let builders = [
        golden::golden_insert_op,
        golden::golden_delimiter_op,
        golden::golden_delete_op,
    ];
    (0..count)
        .map(|i| {
            let mut base = builders[i % builders.len()]();
            // Re-identity the op: rewrite (replica, counter) in place at
            // bytes [2..18] (version+type header is 2 bytes; then u64
            // replica, u64 counter — see golden.rs byte layout).
            let replica: u64 = 0xAA00 + (i as u64) / 10_000;
            let counter: u64 = 100 + i as u64;
            base[2..10].copy_from_slice(&replica.to_le_bytes());
            base[10..18].copy_from_slice(&counter.to_le_bytes());
            validate_op(&base).expect("re-identitied golden op validates");
            base
        })
        .collect()
}

async fn fixture_document(db: &Db) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'org_{org}', 'p5-pipe-test');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'p5_pipe_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-pipe');"
        ))
        .await
        .expect("fixture");
    (UserId(owner), doc)
}

async fn cleanup_document(db: &Db, owner: UserId, doc: Uuid) {
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
             DELETE FROM crdt_operations WHERE document_id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{}';",
            owner.0
        ))
        .await;
}

async fn ingest_payloads(repo: &GatewayRepo, user: UserId, doc: Uuid, payloads: &[Vec<u8>]) -> i64 {
    let envelopes = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid golden op"))
        .collect::<Vec<_>>();
    repo.ingest_batch(user, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor
}

/// All durable op payloads for a document from the log.
async fn all_ops(repo: &GatewayRepo, doc: Uuid) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut cursor = 0i64;
    loop {
        let page = repo.catchup_page(doc, cursor, 4096).await.expect("page");
        if page.ops.is_empty() {
            break;
        }
        out.extend(page.ops.into_iter().map(|(_, _, p)| p));
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
    }
    out
}

#[tokio::test]
async fn build_verify_finalize_lifecycle_at_exact_boundary() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let payloads = golden_op_payloads(12);
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);

    let (owner, doc) = fixture_document(&db).await;
    let cursor = ingest_payloads(&repo, owner, doc, &payloads).await;

    // BUILD at the full boundary.
    let job = Uuid::new_v4();
    let (snapshot_id, digest, validated) = pipeline
        .build_at_boundary(doc, cursor, job, 1)
        .await
        .expect("build");
    assert_eq!(validated.coverage_seq, cursor);
    assert_eq!(validated.covered_op_count, payloads.len() as i64);
    assert!(digest.starts_with("sha256:"));

    // VERIFY requires the verifying state (transition guard).
    assert!(snapshots
        .transition_building_to_verifying(snapshot_id)
        .await
        .expect("transition"));
    let verified = pipeline.verify(doc, snapshot_id).await.expect("verify");
    assert_eq!(verified.state_digest, digest);

    // FINALIZE: guarded, exactly once.
    assert!(pipeline
        .finalize(snapshot_id, None)
        .await
        .expect("finalize"));
    assert!(!pipeline
        .finalize(snapshot_id, None)
        .await
        .expect("second finalize refused"));

    let row = snapshots
        .get_by_snapshot_id(snapshot_id)
        .await
        .expect("fetch")
        .expect("row exists");
    assert_eq!(row.status, status::FINALIZED);

    let latest = snapshots
        .latest_finalized(doc)
        .await
        .expect("latest")
        .expect("must exist");
    assert_eq!(latest.snapshot_id, snapshot_id);

    // Duplicate-tail harmlessness (S8): feeding the whole covered op set
    // again through digest-after changes nothing.
    let again = pipeline
        .workers
        .digest_after(&verified.inner, &payloads)
        .await
        .expect("duplicate tail");
    assert_eq!(again.digest, digest, "duplicate tail replay is a no-op");

    cleanup_document(&db, owner, doc).await;
}

#[tokio::test]
async fn ops_after_boundary_stay_in_tail_and_equivalence_holds() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let payloads = golden_op_payloads(24);
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);

    let (owner, doc) = fixture_document(&db).await;
    // First half, then snapshot at that exact boundary.
    let half = payloads.len() / 2;
    let boundary = ingest_payloads(&repo, owner, doc, &payloads[..half]).await;

    let job = Uuid::new_v4();
    let (snapshot_id, digest_half, validated) = pipeline
        .build_at_boundary(doc, boundary, job, 1)
        .await
        .expect("build at half boundary");
    assert_eq!(validated.covered_op_count, half as i64);

    // The tail grows AFTER the build: newer ops must be excluded.
    let full_cursor = ingest_payloads(&repo, owner, doc, &payloads[half..]).await;
    assert!(full_cursor > boundary);

    assert!(snapshots
        .transition_building_to_verifying(snapshot_id)
        .await
        .expect("transition"));
    // The verify oracle re-folds ops ≤ boundary only — the second half
    // already in the log must NOT leak into the snapshot's digest.
    let verified = pipeline.verify(doc, snapshot_id).await.expect("verify");
    assert_eq!(verified.state_digest, digest_half);
    assert_eq!(verified.covered_op_count, half as i64);

    // Full replay over the whole log.
    let ops = all_ops(&repo, doc).await;
    assert_eq!(ops.len(), payloads.len());
    let full = pipeline
        .workers
        .reconstruct(&ops)
        .await
        .expect("full replay");
    assert_ne!(full.digest, digest_half, "the tail must change state");

    // Snapshot + tail == full replay (M020 equivalence, real worker).
    let tail = &ops[half..];
    let recovered = pipeline
        .workers
        .digest_after(&verified.inner, tail)
        .await
        .expect("snapshot+tail");
    assert_eq!(recovered.digest, full.digest);

    cleanup_document(&db, owner, doc).await;
}

#[tokio::test]
async fn unverified_or_failed_attempts_never_finalize() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let payloads = golden_op_payloads(6);
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);

    let (owner, doc) = fixture_document(&db).await;
    let cursor = ingest_payloads(&repo, owner, doc, &payloads).await;

    let job = Uuid::new_v4();
    let (snapshot_id, _digest, _validated) = pipeline
        .build_at_boundary(doc, cursor, job, 1)
        .await
        .expect("build");

    // Finalize straight from BUILDING (skipping verify) must be refused.
    assert!(!pipeline
        .finalize(snapshot_id, None)
        .await
        .expect("finalize from building"));
    // Fail it; finalizing after failure is also refused.
    assert!(snapshots
        .fail(snapshot_id, "test: unverified attempt")
        .await
        .expect("fail"));
    assert!(!pipeline
        .finalize(snapshot_id, None)
        .await
        .expect("finalize after fail"));

    let row = snapshots
        .get_by_snapshot_id(snapshot_id)
        .await
        .expect("fetch")
        .expect("row");
    assert_eq!(row.status, status::FAILED);

    // verify() on a failed row also refuses (wrong state).
    assert!(pipeline.verify(doc, snapshot_id).await.is_err());

    cleanup_document(&db, owner, doc).await;
}
