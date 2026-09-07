//! Retention + storage accounting tests (P5-M038/M039): protected
//! revision snapshots can never be deleted by retention; supersession
//! marks only unreferenced non-newest rows; accounting counts match
//! the stored state. Live DB + real worker.

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::maintenance::{
    mark_superseded_unreferenced, prune_to_boundary, purge_unreferenced, storage_accounting,
    SnapshotPipeline,
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
        clerk_issuer: "https://retain.clerk.accounts.dev".into(),
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

async fn fixture(db: &Db) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'retain_{org}', 'p5-retain');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'retain_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-retain');"
        ))
        .await
        .expect("fixture");
    (UserId(owner), doc)
}

async fn cleanup(db: &Db, owner: UserId, doc: Uuid) {
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_revisions WHERE document_id = '{doc}';
             DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
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

async fn finalized_snapshot_at(
    pipeline: &SnapshotPipeline,
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
    let _ = pipeline.verify(doc, id).await.expect("verify");
    assert!(pipeline.finalize(id, None).await.expect("finalize"));
    id
}

#[tokio::test]
async fn retention_protects_referenced_and_newest_snapshots() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture(&db).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);

    // Three boundaries → three finalized snapshots.
    let b1 = {
        let envelopes: Vec<_> = ops_at(4, 100, 0x9A01)
            .iter()
            .map(|p| validate_op(p).expect("v"))
            .collect();
        repo.ingest_batch(owner, doc, &envelopes)
            .await
            .expect("i")
            .durable_cursor
    };
    let s1 = finalized_snapshot_at(&pipeline, doc, b1, 1).await;
    let b2 = {
        let envelopes: Vec<_> = ops_at(4, 200, 0x9A02)
            .iter()
            .map(|p| validate_op(p).expect("v"))
            .collect();
        repo.ingest_batch(owner, doc, &envelopes)
            .await
            .expect("i")
            .durable_cursor
    };
    let s2 = finalized_snapshot_at(&pipeline, doc, b2, 1).await;
    let b3 = {
        let envelopes: Vec<_> = ops_at(4, 300, 0x9A03)
            .iter()
            .map(|p| validate_op(p).expect("v"))
            .collect();
        repo.ingest_batch(owner, doc, &envelopes)
            .await
            .expect("i")
            .durable_cursor
    };
    let s3 = finalized_snapshot_at(&pipeline, doc, b3, 1).await;

    // Reference s1 in a revision (the protected-revision scenario).
    let client = db.get().await.expect("pool");
    let rev = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO crdt_revisions (revision_id, document_id, target_seq, kind,
                 label, snapshot_id)
             VALUES ($1, $2, $3, 'named', 'protected point', $4)",
            &[&rev, &doc, &b1, &s1],
        )
        .await
        .expect("revision");

    // Mark unreferenced: only s2 should flip (s3 = newest, s1 =
    // revision-referenced). Floor is not set yet.
    let marked = mark_superseded_unreferenced(&db, doc).await.expect("mark");
    assert_eq!(
        marked,
        vec![s2],
        "only the unreferenced non-newest snapshot is superseded"
    );
    for id in [s1, s2, s3] {
        let row = snapshots
            .get_by_snapshot_id(id)
            .await
            .expect("fetch")
            .expect("row");
        let expected = match id {
            x if x == s2 => "superseded",
            _ => "finalized",
        };
        assert_eq!(row.status, expected, "snapshot {id} status");
    }

    // Set the floor referencing s2 → the purge candidate query EXCLUDES
    // floor-referenced rows entirely (protection at selection, plus the
    // per-row is_protected recheck against reference races): s2 must
    // SURVIVE the purge with no deletion at all.
    client
        .execute(
            "UPDATE documents SET compaction_floor_seq = $2,
                 compaction_floor_snapshot_id = $3 WHERE id = $1",
            &[&doc, &b2, &s2],
        )
        .await
        .expect("floor");
    let (n, bytes) = purge_unreferenced(&db, doc)
        .await
        .expect("purge respects floor");
    assert_eq!(n, 0, "floor-referenced snapshot must not be deletable");
    assert_eq!(bytes, 0);
    assert!(snapshots.get_by_snapshot_id(s2).await.expect("f").is_some());

    // Move the floor to s3 (prune below b3 makes s3 the floor).
    let deleted = prune_to_boundary(&db, &snapshots, doc, b3, 10)
        .await
        .expect("prune");
    assert!(deleted > 0);
    // Now s2 is unprotected: purge deletes exactly s2's row.
    let (n, bytes) = purge_unreferenced(&db, doc).await.expect("purge");
    assert_eq!(n, 1);
    assert!(bytes > 0);
    assert!(snapshots.get_by_snapshot_id(s2).await.expect("f").is_none());
    // s1 (revision) and s3 (newest + floor) survive.
    assert!(snapshots.get_by_snapshot_id(s1).await.expect("f").is_some());
    assert!(snapshots.get_by_snapshot_id(s3).await.expect("f").is_some());

    // Accounting (M039) reflects the end state.
    let accounting = storage_accounting(&db, doc).await.expect("accounting");
    assert_eq!(accounting.snapshot_count, 2, "s1 + s3 remain");
    assert_eq!(accounting.finalized_snapshots, 2);
    assert_eq!(accounting.compaction_floor, Some(b3));
    assert_eq!(accounting.latest_snapshot_coverage, Some(b3));
    assert_eq!(accounting.revision_count, 1);
    assert_eq!(
        accounting.prunable_rows_remaining, 0,
        "clean prune leaves nothing below the floor"
    );
    assert!(accounting.tail_op_rows >= 0);
    assert!(accounting.op_rows >= 0);
    // Ops were pruned to zero rows above... all 12 ops were ≤ b3, so
    // the tail is empty; the accounting must agree.
    assert_eq!(accounting.tail_op_rows, 0);

    cleanup(&db, owner, doc).await;
}
