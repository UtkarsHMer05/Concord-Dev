//! Compaction tests (P5-M029/M030): floor metadata, dry-run, staged
//! transactional pruning with the never-prune-first guarantee, and
//! post-prune recoverability. Live DB + real worker.

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::maintenance::{
    dry_run, get_floor, prune_to_boundary, CompactionError, RecoverySelector, SnapshotPipeline,
};
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

async fn fixture_document(db: &Db) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'org_{org}', 'p5-comp-test');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'p5_comp_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-comp');"
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
             DELETE FROM maintenance_jobs WHERE document_id = '{doc}';
             DELETE FROM crdt_operations WHERE document_id = '{doc}';
             UPDATE documents SET compaction_floor_seq = NULL,
                 compaction_floor_snapshot_id = NULL WHERE id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{}';",
            owner.0
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

async fn ingest(repo: &GatewayRepo, user: UserId, doc: Uuid, payloads: &[Vec<u8>]) -> i64 {
    let envelopes = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect::<Vec<_>>();
    repo.ingest_batch(user, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor
}

#[tokio::test]
async fn pruning_refuses_without_coverage_and_respects_staging() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture_document(&db).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    let payloads = ops_at(12, 400, 0xDD01);
    let boundary = ingest(&repo, owner, doc, &payloads).await;

    // 1. NEVER PRUNE FIRST: no snapshot exists → dry-run AND prune
    //    refuse with NoCoverage.
    assert!(matches!(
        dry_run(&db, &snapshots, doc, boundary).await,
        Err(CompactionError::NoCoverage { .. })
    ));
    assert!(matches!(
        prune_to_boundary(&db, &snapshots, doc, boundary, 4).await,
        Err(CompactionError::NoCoverage { .. })
    ));
    // …and nothing was deleted.
    let ops_left = repo.catchup_page(doc, 0, 100).await.expect("page");
    assert_eq!(ops_left.ops.len(), 12, "refused prune must not delete");

    // 2. A non-finalized (building) snapshot does NOT count as coverage.
    let job = Uuid::new_v4();
    let (building_id, _d, _v) = pipeline
        .build_at_boundary(doc, boundary, job, 1)
        .await
        .expect("build");
    let _ = building_id;
    assert!(matches!(
        dry_run(&db, &snapshots, doc, boundary).await,
        Err(CompactionError::NoCoverage { .. })
    ));

    // 3. Finalize → dry-run now reports the candidates without
    //    deleting anything.
    assert!(snapshots
        .transition_building_to_verifying(building_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(doc, building_id).await.expect("verify");
    assert!(pipeline
        .finalize(building_id, None)
        .await
        .expect("finalize"));

    let report = dry_run(&db, &snapshots, doc, boundary)
        .await
        .expect("dry-run");
    assert_eq!(report.boundary, boundary);
    assert_eq!(report.snapshot_id, building_id);
    assert_eq!(report.candidate_rows, 12);
    assert!(report.candidate_bytes > 0);
    assert_eq!(report.floor_seq, None, "floor unset before first prune");
    let after_dry = repo.catchup_page(doc, 0, 100).await.expect("page");
    assert_eq!(after_dry.ops.len(), 12, "dry-run must not delete");
    assert!(get_floor(&db, doc).await.expect("floor").is_none());

    // 4. Staged pruning in batches of 4: floor advances WITH deletes;
    //    post-prune recovery (snapshot+tail) still reconstructs.
    let deleted = prune_to_boundary(&db, &snapshots, doc, boundary, 4)
        .await
        .expect("prune");
    assert_eq!(deleted, 12, "all covered rows pruned across batches");
    let floor = get_floor(&db, doc)
        .await
        .expect("floor")
        .expect("floor set");
    assert_eq!(floor.floor_seq, boundary);
    assert_eq!(floor.snapshot_id, building_id);

    // Pruned rows are gone from the log…
    let remaining = repo.catchup_page(doc, 0, 100).await.expect("page");
    assert_eq!(remaining.ops.len(), 0, "covered rows deleted");
    // …but the state is fully recoverable via the snapshot.
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers);
    let (digest, source) = selector.recover_current(doc).await.expect("recover");
    assert!(digest.starts_with("sha256:"));
    assert_eq!(
        source,
        sync_gateway::maintenance::RecoverySource::SnapshotPlusTail {
            snapshot_id: building_id,
            boundary,
            tail_ops: 0,
        },
        "recovery must use the covering snapshot after pruning"
    );
    // The differential verifier still proves equivalence post-prune.
    selector.verify_equivalence(doc).await.expect("equivalence");

    // 5. Idempotence: re-pruning to the same boundary is a no-op signal.
    assert!(matches!(
        prune_to_boundary(&db, &snapshots, doc, boundary, 4).await,
        Err(CompactionError::AlreadyCompacted)
    ));

    // 6. A HIGHER boundary without coverage above the old floor is
    //    still refused (floor advance can never outrun coverage).
    let more = ops_at(6, 600, 0xDD02);
    let higher = ingest(&repo, owner, doc, &more).await;
    assert!(matches!(
        prune_to_boundary(&db, &snapshots, doc, higher, 4).await,
        Err(CompactionError::NoCoverage { .. })
    ));
    let floor_after = get_floor(&db, doc).await.expect("floor").expect("floor");
    assert_eq!(floor_after.floor_seq, boundary, "floor unchanged");

    cleanup(&db, owner, doc).await;
}
