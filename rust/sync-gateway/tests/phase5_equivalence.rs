//! P5-M032: end-to-end compaction equivalence over SEEDED rich
//! histories. For each seed: build history via CMD_GENERATE_OPS →
//! ingest → build/verify/finalize snapshot at a mid boundary → run the
//! differential verifier → prune → re-verify from the post-prune
//! recovery path (snapshot+tail; the pruned log cannot full-replay) →
//! assert stale-client-style reconstruction equals the pre-prune
//! full-replay digest.
//!
//! This suite is the GATE for enabling automatic pruning (DEC-040):
//! green here is the evidence that pruning preserves semantics.

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::{wrapper, SnapshotRepo};
use sync_gateway::maintenance::{prune_to_boundary, RecoverySelector, SnapshotPipeline};
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::worker::WorkerPool;
use uuid::Uuid;

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

async fn test_db() -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_URL.into(),
        clerk_issuer: "https://seed-eq.clerk.accounts.dev".into(),
        allowed_origins: vec![],
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

/// Splits the generator's serialize_batch frames into per-op payloads
/// (each DB row stores one raw op).
fn split_frames(frames: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut ops = Vec::new();
    for frame in frames {
        let mut offset = 0usize;
        let count = u32::from_le_bytes(frame[0..4].try_into().unwrap()) as usize;
        offset += 4;
        for _ in 0..count {
            let len = u32::from_le_bytes(frame[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            ops.push(frame[offset..offset + len].to_vec());
            offset += len;
        }
    }
    ops
}

/// One seeded history through the full compaction pipeline.
async fn seeded_compaction_equivalence(
    db: &Db,
    workers: &WorkerPool,
    seed: u64,
    total_ops: usize,
    snapshot_frac: f64,
    batch: i64,
) {
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers.clone());

    // Fixture.
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'seed_{seed}_{org}', 'p5-eq');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'seed_{seed}_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-eq-{seed}');"
        ))
        .await
        .expect("fixture");

    // Deterministic rich history (unique seed per run; 3 replicas,
    // uniform mix). Op count kept modest per seed for suite runtime;
    // the 100k+ scale evidence lives in the benchmark, not here.
    let generated = workers
        .generate_ops(seed, total_ops as u32, 3, 0)
        .await
        .expect("generate");
    let ops = split_frames(&generated.batches);
    assert_eq!(ops.len(), total_ops);

    // Ingest the full history as the gateway would (cursor comes from
    // the per-op boundary lookup below, not the ingest return).
    for chunk in ops.chunks(512) {
        let envelopes = chunk
            .iter()
            .map(|p| validate_op(p).expect("generated op validates"))
            .collect::<Vec<_>>();
        repo.ingest_batch(UserId(owner), doc, &envelopes)
            .await
            .expect("ingest");
    }

    // Oracle BEFORE any pruning: TRUE full replay of the whole log.
    let full_before = selector.recover_current(doc).await.expect("recover before");
    let (full_digest, source_before) = full_before;
    assert_eq!(
        source_before,
        sync_gateway::maintenance::RecoverySource::FullReplay
    );
    let _ = source_before;

    // Snapshot at a mid-history boundary.
    let snap_at = (total_ops as f64 * snapshot_frac) as usize;
    let boundary = {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT id FROM crdt_operations WHERE document_id = $1
                 ORDER BY id ASC LIMIT 1 OFFSET $2",
                &[&doc, &(snap_at as i64)],
            )
            .await
            .expect("boundary");
        row.get::<_, i64>("id")
    };

    let job = Uuid::new_v4();
    let (snapshot_id, _digest, _v) = pipeline
        .build_at_boundary(doc, boundary, job, 1)
        .await
        .expect("build");
    assert!(snapshots
        .transition_building_to_verifying(snapshot_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(doc, snapshot_id).await.expect("verify");
    assert!(pipeline
        .finalize(snapshot_id, None)
        .await
        .expect("finalize"));

    // Differential verifier gate pre-prune.
    selector
        .verify_equivalence(doc)
        .await
        .expect("pre-prune equivalence");

    // PRUNE the covered prefix.
    let deleted = prune_to_boundary(db, &snapshots, doc, boundary, batch)
        .await
        .expect("prune");
    assert!(deleted > 0, "seed {seed}: expected deletions");

    // Post-prune: the log cannot full-replay; recovery MUST select the
    // covering snapshot and still produce the pre-prune digest — the
    // compaction preserved the document state exactly.
    let (digest_after, source_after) = selector
        .recover_current(doc)
        .await
        .expect("recover after prune");
    assert_eq!(
        digest_after, full_digest,
        "seed {seed}: post-prune recovery diverged from pre-prune full replay"
    );
    match source_after {
        sync_gateway::maintenance::RecoverySource::SnapshotPlusTail {
            snapshot_id: sid,
            boundary: b,
            ..
        } => {
            assert_eq!(sid, snapshot_id);
            assert_eq!(b, boundary);
        }
        other => panic!("seed {seed}: recovery must use snapshot+tail, got {other:?}"),
    }
    // And the differential verifier's floor-aware oracle agrees.
    selector
        .verify_equivalence(doc)
        .await
        .expect("post-prune equivalence");

    // Stale-client reconstruction: import the snapshot + replay the
    // tail (what a resynced client holds) == the original state.
    let row = snapshots
        .get_by_snapshot_id(snapshot_id)
        .await
        .expect("fetch")
        .expect("row");
    let parts = wrapper::decode_wrapper(&row.payload).expect("wrapper");
    let mut tail = Vec::new();
    let mut cursor = boundary;
    loop {
        let page = repo.catchup_page(doc, cursor, 1024).await.expect("page");
        if page.ops.is_empty() {
            break;
        }
        tail.extend(page.ops.into_iter().map(|(_, _, p)| p));
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
    }
    let stale_recovery = workers
        .digest_after(&parts.inner, &tail)
        .await
        .expect("stale-client fold");
    assert_eq!(
        stale_recovery.digest, full_digest,
        "seed {seed}: stale-client snapshot+tail diverged"
    );

    // Cleanup.
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
             DELETE FROM maintenance_jobs WHERE document_id = '{doc}';
             DELETE FROM crdt_operations WHERE document_id = '{doc}';
             UPDATE documents SET compaction_floor_seq = NULL,
                 compaction_floor_snapshot_id = NULL WHERE id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{owner}';
             DELETE FROM organizations WHERE id = '{org}';"
        ))
        .await;
}

#[tokio::test]
async fn compaction_equivalence_multiple_seeded_histories() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };

    // Multiple deterministic histories: varied seeds, boundaries, and
    // prune batch sizes (batched vs single-batch pruning paths).
    for (seed, ops, frac, batch) in [
        (11u64, 600usize, 0.5f64, 64i64),
        (12, 400, 0.25, 7),   // small batches force multi-batch pruning
        (73, 800, 0.75, 500), // single large batch
        (941, 300, 0.5, 3),   // many tiny batches
    ] {
        seeded_compaction_equivalence(&db, &workers, seed, ops, frac, batch).await;
    }
}
