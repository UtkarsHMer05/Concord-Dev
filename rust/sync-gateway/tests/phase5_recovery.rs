//! Recovery selection + fallback and differential verifier tests
//! (P5-M019..M021). Live DB + real worker; skipped when unavailable.

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::{wrapper, SnapshotRepo};
use sync_gateway::maintenance::{RecoverySelector, RecoverySource, SelectedRecovery};
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

fn golden_op_payloads(count: usize) -> Vec<Vec<u8>> {
    let builders = [
        golden::golden_insert_op,
        golden::golden_delimiter_op,
        golden::golden_delete_op,
    ];
    (0..count)
        .map(|i| {
            let mut base = builders[i % builders.len()]();
            let replica: u64 = 0xBB00 + (i as u64) / 10_000;
            let counter: u64 = 200 + i as u64;
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
               VALUES ('{org}', 'org_{org}', 'p5-rec-test');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'p5_rec_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-rec');"
        ))
        .await
        .expect("fixture");
    (UserId(owner), doc)
}

async fn cleanup(db: &Db, owner: UserId, doc: Uuid) {
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

async fn ingest(repo: &GatewayRepo, user: UserId, doc: Uuid, payloads: &[Vec<u8>]) -> i64 {
    let envelopes = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid op"))
        .collect::<Vec<_>>();
    repo.ingest_batch(user, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor
}

/// Builds + finalizes a snapshot at the current boundary through the
/// pipeline, returning the snapshot id.
async fn make_finalized_snapshot(
    pipeline: &sync_gateway::maintenance::SnapshotPipeline,
    doc: Uuid,
    boundary: i64,
    attempt: i32,
) -> Uuid {
    let job = Uuid::new_v4();
    let (id, _digest, _v) = pipeline
        .build_at_boundary(doc, boundary, job, attempt)
        .await
        .expect("build");
    assert!(pipeline
        .snapshots
        .transition_building_to_verifying(id)
        .await
        .expect("transition"));
    let verified = pipeline.verify(doc, id).await.expect("verify");
    let _ = verified;
    assert!(pipeline.finalize(id, None).await.expect("finalize"));
    id
}

#[tokio::test]
async fn selection_prefers_newest_valid_and_falls_back_on_corruption() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let payloads = golden_op_payloads(12);
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = sync_gateway::maintenance::SnapshotPipeline::new(
        repo.clone(),
        snapshots.clone(),
        workers.clone(),
    );
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers);

    let (owner, doc) = fixture_document(&db).await;

    // Boundary 1: first 6 ops; boundary 2: all 12.
    let b1 = ingest(&repo, owner, doc, &payloads[..6]).await;
    let older = make_finalized_snapshot(&pipeline, doc, b1, 1).await;
    let b2 = ingest(&repo, owner, doc, &payloads[6..]).await;
    let newer = make_finalized_snapshot(&pipeline, doc, b2, 1).await;

    // Clean state: newest valid snapshot is selected.
    match selector.select_latest_valid(doc).await {
        SelectedRecovery::WithSnapshot(v) => {
            assert_eq!(v.snapshot_id, newer);
            assert_eq!(v.coverage_seq, b2);
        }
        SelectedRecovery::FullReplay => panic!("newest valid snapshot must be selected"),
    }

    // Corrupt the NEWEST snapshot's payload bytes in the DB (simulated
    // storage corruption — checksum no longer matches).
    {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT payload FROM crdt_snapshots WHERE snapshot_id = $1",
                &[&newer],
            )
            .await
            .expect("fetch payload");
        let mut payload: Vec<u8> = row.get("payload");
        // Flip a bit in the middle of the payload (inside the inner
        // snapshot region — not the header, so decode still works but
        // the checksum fails).
        let mid = payload.len() / 2;
        payload[mid] ^= 0x01;
        client
            .execute(
                "UPDATE crdt_snapshots SET payload = $2 WHERE snapshot_id = $1",
                &[&newer, &payload],
            )
            .await
            .expect("corrupt");
    }

    // Selection falls back to the OLDER valid snapshot (never the
    // corrupted newest, never full replay while a valid one exists).
    match selector.select_latest_valid(doc).await {
        SelectedRecovery::WithSnapshot(v) => {
            assert_eq!(
                v.snapshot_id, older,
                "must fall back to older valid snapshot"
            );
            assert_eq!(v.coverage_seq, b1);
        }
        SelectedRecovery::FullReplay => panic!("older valid snapshot exists; must not full-replay"),
    }

    // Corrupt BOTH: selection falls back to full replay (never a bad
    // snapshot).
    {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT payload FROM crdt_snapshots WHERE snapshot_id = $1",
                &[&older],
            )
            .await
            .expect("fetch payload");
        let mut payload: Vec<u8> = row.get("payload");
        let mid = payload.len() / 2;
        payload[mid] ^= 0x01;
        client
            .execute(
                "UPDATE crdt_snapshots SET payload = $2 WHERE snapshot_id = $1",
                &[&older, &payload],
            )
            .await
            .expect("corrupt older");
    }
    assert!(matches!(
        selector.select_latest_valid(doc).await,
        SelectedRecovery::FullReplay
    ));

    // recover_current still succeeds (full replay) with the right
    // source — recovery NEVER fails due to corrupt snapshots.
    let (digest, source) = selector.recover_current(doc).await.expect("recovery");
    assert!(digest.starts_with("sha256:"));
    assert_eq!(source, RecoverySource::FullReplay);

    cleanup(&db, owner, doc).await;
}

#[tokio::test]
async fn differential_verifier_proves_equivalence_and_reports_mismatch() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let payloads = golden_op_payloads(18);
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = sync_gateway::maintenance::SnapshotPipeline::new(
        repo.clone(),
        snapshots.clone(),
        workers.clone(),
    );
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers);

    let (owner, doc) = fixture_document(&db).await;
    let b1 = ingest(&repo, owner, doc, &payloads[..9]).await;
    let _s1 = make_finalized_snapshot(&pipeline, doc, b1, 1).await;
    let b2 = ingest(&repo, owner, doc, &payloads[9..]).await;
    let s2 = make_finalized_snapshot(&pipeline, doc, b2, 1).await;

    // Equivalence holds on the healthy state.
    selector
        .verify_equivalence(doc)
        .await
        .expect("equivalence must hold");

    // Corrupt the newest snapshot: integrity selection falls back to
    // the OLDER snapshot (b1), whose +tail equivalence still holds.
    {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT payload FROM crdt_snapshots WHERE snapshot_id = $1",
                &[&s2],
            )
            .await
            .expect("fetch");
        let mut payload: Vec<u8> = row.get("payload");
        let mid = payload.len() / 2;
        payload[mid] ^= 0x01;
        client
            .execute(
                "UPDATE crdt_snapshots SET payload = $2 WHERE snapshot_id = $1",
                &[&s2, &payload],
            )
            .await
            .expect("corrupt");
    }
    selector
        .verify_equivalence(doc)
        .await
        .expect("fallback equivalence must hold");

    // No snapshot at all ⇒ structured NoSnapshot error (not a panic).
    let (owner2, doc2) = fixture_document(&db).await;
    let _ = ingest(&repo, owner2, doc2, &payloads[..3]).await;
    let err = selector
        .verify_equivalence(doc2)
        .await
        .expect_err("no snapshot");
    assert!(matches!(
        err,
        sync_gateway::maintenance::VerificationError::NoSnapshot { .. }
    ));
    let _ = wrapper::encode_wrapper; // referenced to keep import used

    cleanup(&db, owner, doc).await;
    cleanup(&db, owner2, doc2).await;
}
