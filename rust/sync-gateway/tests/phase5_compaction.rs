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
    dry_run, get_floor, prune_to_boundary, CompactionError, JobRepo, RecoverySelector,
    RevisionService, SnapshotPipeline,
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

/// P5-M045 SEC5-2 race closure: a revision created below the prune
/// boundary between `eligibility` and the batch DELETE must be caught
/// by the in-transaction recheck. True interleaving is
/// nondeterministic to stage, so the test pins the OBSERVABLE the
/// recheck enforces: with a revision at target 6 present, pruning to
/// 12 refuses (RetentionProtected) and ops below 6 survive; pruning
/// AT 6 (boundary == min target — the covered-prefix rule) succeeds
/// and the revision still reconstructs.
#[tokio::test]
async fn prune_refuses_when_revision_created_below_boundary_concurrently() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture_document(&db).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    // Ops 1..12, one finalized snapshot covering the full boundary.
    // NOTE: server sequence ids are GLOBAL (BIGSERIAL across documents),
    // so "boundary 12" is the 12th op's absolute id — compute the
    // mid-log revision target (the 6th op's id) the same way, never as
    // a literal.
    let payloads = ops_at(12, 800, 0xDD10);
    let boundary12 = ingest(&repo, owner, doc, &payloads).await;
    let boundary6 = {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT id FROM crdt_operations
                 WHERE document_id = $1 ORDER BY id ASC OFFSET 5 LIMIT 1",
                &[&doc],
            )
            .await
            .expect("6th op id");
        let id: i64 = row.get("id");
        id
    };
    let job = Uuid::new_v4();
    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(doc, boundary12, job, 1)
        .await
        .expect("build");
    assert!(snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));

    // A covering snapshot AT the revision's target too: eligibility's
    // coverage check requires coverage_seq >= boundary, so a covered-
    // prefix prune AT boundary6 needs a snapshot that covers exactly
    // it (the head snapshot covers MORE, which is not enough —
    // latest_finalized_before(6) skips it). This mirrors the history
    // suite's snapshot-at-revision-boundary setup.
    let job_mid = Uuid::new_v4();
    let (snap_mid, _dm, _vm) = pipeline
        .build_at_boundary(doc, boundary6, job_mid, 1)
        .await
        .expect("build at revision boundary");
    assert!(snapshots
        .transition_building_to_verifying(snap_mid)
        .await
        .expect("transition mid"));
    let _ = pipeline.verify(doc, snap_mid).await.expect("verify mid");
    assert!(pipeline
        .finalize(snap_mid, None)
        .await
        .expect("finalize mid"));

    // "In-flight" revision creation at the mid-log target (the 6th
    // op's seq), materialized directly via SQL under a held documents
    // FOR UPDATE lock — the deterministic equivalent of a revision
    // racing the prune (the recheck's guarantee is that the row is
    // VISIBLE at statement time).
    {
        let mut client = db.get().await.expect("pool");
        let tx = client.transaction().await.expect("lock tx");
        tx.execute("SELECT id FROM documents WHERE id = $1 FOR UPDATE", &[&doc])
            .await
            .expect("documents lock");
        tx.execute(
            "INSERT INTO crdt_revisions (revision_id, document_id, target_seq,
                 kind, label, snapshot_id)
             VALUES ($1, $2, $3, 'named', 'concurrent checkpoint', $4)",
            &[&Uuid::new_v4(), &doc, &boundary6, &snap_id],
        )
        .await
        .expect("revision at mid-log boundary");
        tx.commit().await.expect("commit revision");
    }

    // Prune to the full boundary: BOTH eligibility (pre-read) and the
    // in-tx recheck (statement time) must refuse — the revision's
    // target sits strictly below the prune edge, so pruning would
    // destroy the ops its reconstruction depends on.
    assert!(matches!(
        prune_to_boundary(&db, &snapshots, doc, boundary12, 4).await,
        Err(CompactionError::RetentionProtected { .. })
    ));
    let page = repo.catchup_page(doc, 0, 100).await.expect("page");
    assert_eq!(
        page.ops.len(),
        12,
        "refused prune must leave the op log intact"
    );
    assert!(get_floor(&db, doc).await.expect("floor").is_none());

    // The covered-prefix rule: boundary == min revision target is
    // allowed. The single snapshot covers boundary12 ≥ boundary6 and
    // eligibility is inclusive, so pruning to boundary6 (== the
    // revision's target) may only delete the covered prefix ≤ it —
    // the revision at boundary6 keeps its reconstruction basis (floor
    // snapshot at coverage ≤ boundary6 plus ops (boundary6, target] =
    // none; its basis is exactly the snapshot itself).
    let deleted = prune_to_boundary(&db, &snapshots, doc, boundary6, 10)
        .await
        .expect("prune at the revision's own boundary is the covered prefix");
    assert_eq!(deleted, 6, "ops 1..6 pruned");
    let floor = get_floor(&db, doc)
        .await
        .expect("floor")
        .expect("floor set at the revision target");
    assert_eq!(floor.floor_seq, boundary6);
    // The revision's basis: ops (boundary6..] are all present (7..12).
    let tail = repo.catchup_page(doc, boundary6, 100).await.expect("tail");
    assert_eq!(
        tail.ops.len(),
        6,
        "ops above the pruned prefix survive for the revision's tail"
    );
    // The revision still reconstructs EXACTLY at its boundary: history
    // folds the covering snapshot plus ops (coverage, target] — with
    // the floor at exactly the revision's target, that tail is empty
    // and the fold is the snapshot alone (M013-validated). This is the
    // durability promise the recheck defends.
    let service = RevisionService::new(
        repo.clone(),
        snapshots.clone(),
        workers,
        JobRepo::new(db.clone()),
    );
    let rev_row = {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT revision_id FROM crdt_revisions WHERE document_id = $1 LIMIT 1",
                &[&doc],
            )
            .await
            .expect("revision row");
        let id: Uuid = row.get("revision_id");
        id
    };
    let state = service
        .revision_content(doc, owner, rev_row)
        .await
        .expect("revision reconstructs post-prune");
    assert!(state.state_digest.starts_with("sha256:"));

    cleanup(&db, owner, doc).await;
}

/// P5-M045 eligibility/coverage race: retention flipping the covering
/// snapshot to superseded between the eligibility read and the batch
/// DELETE must be caught INSIDE the transaction (the in-tx recheck
/// row-locks the snapshot and requires status = finalized). The test
/// flips the status via SQL after a healthy prune setup, then proves
/// prune_to_boundary fails NoCoverage with the op log intact.
#[tokio::test]
async fn prune_reevaluates_eligibility_inside_transaction() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture_document(&db).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);

    // Two boundaries → two finalized snapshots, so the older one at 6
    // is the eligibility winner for a boundary-6 prune and the newer
    // one at 12 keeps the document recoverable for the aftermath.
    let payloads = ops_at(6, 900, 0xDD20);
    let boundary6 = ingest(&repo, owner, doc, &payloads).await;
    let s6 = {
        let job = Uuid::new_v4();
        let (id, _d, _v) = pipeline
            .build_at_boundary(doc, boundary6, job, 1)
            .await
            .expect("build s6");
        assert!(snapshots
            .transition_building_to_verifying(id)
            .await
            .expect("transition s6"));
        let _ = pipeline.verify(doc, id).await.expect("verify s6");
        assert!(pipeline.finalize(id, None).await.expect("finalize s6"));
        id
    };
    let payloads2 = ops_at(6, 950, 0xDD21);
    let boundary12 = ingest(&repo, owner, doc, &payloads2).await;
    let s12 = {
        let job = Uuid::new_v4();
        let (id, _d, _v) = pipeline
            .build_at_boundary(doc, boundary12, job, 1)
            .await
            .expect("build s12");
        assert!(snapshots
            .transition_building_to_verifying(id)
            .await
            .expect("transition s12"));
        let _ = pipeline.verify(doc, id).await.expect("verify s12");
        assert!(pipeline.finalize(id, None).await.expect("finalize s12"));
        id
    };

    // A healthy prune path first: eligibility for boundary 6 would pick
    // s6 (latest finalized with coverage ≥ 6 … the newest finalized is
    // s12; latest_finalized_before is inclusive, so s12 covers 6 too —
    // whichever row eligibility returns, the flip below targets THAT
    // row to simulate retention racing the prune).
    let report = dry_run(&db, &snapshots, doc, boundary6)
        .await
        .expect("dry-run healthy");
    let covering = report.snapshot_id;
    assert!(covering == s6 || covering == s12);

    // Simulate the race: retention marks the covering snapshot
    // superseded AFTER eligibility but BEFORE the prune's batch (a
    // concurrent mark_superseded_unreferenced would take the documents
    // lock and win or lose deterministically against a real prune;
    // the deterministic equivalent is the direct flip between the two
    // calls).
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE crdt_snapshots SET status = 'superseded'
                 WHERE snapshot_id = $1",
                &[&covering],
            )
            .await
            .expect("flip covering status");
    }

    // The in-tx recheck must notice: the batch transaction row-locks
    // the snapshot, sees it is no longer finalized, and refuses with
    // NoCoverage — the log is untouched, the floor not advanced.
    assert!(matches!(
        prune_to_boundary(&db, &snapshots, doc, boundary6, 10).await,
        Err(CompactionError::NoCoverage { .. })
    ));
    let page = repo.catchup_page(doc, 0, 100).await.expect("page");
    assert_eq!(page.ops.len(), 12, "refused prune must not delete");
    assert!(get_floor(&db, doc).await.expect("floor").is_none());

    // Restore the snapshot and verify the same prune now succeeds (the
    // failure was the race, not a permanent no-op).
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE crdt_snapshots SET status = 'finalized'
                 WHERE snapshot_id = $1",
                &[&covering],
            )
            .await
            .expect("restore status");
    }
    let deleted = prune_to_boundary(&db, &snapshots, doc, boundary6, 10)
        .await
        .expect("prune succeeds once coverage is back");
    assert_eq!(deleted, 6);
    assert_eq!(
        get_floor(&db, doc)
            .await
            .expect("floor")
            .expect("floor set")
            .floor_seq,
        boundary6
    );

    let _ = boundary12;
    cleanup(&db, owner, doc).await;
}
