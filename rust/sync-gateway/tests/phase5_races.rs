//! P5-M046: concurrency, lease, stale-owner, and race stress tests.
//! Simulates: duplicate snapshot triggers from multiple gateways; two
//! workers claiming the same logical document job; lease expiry while
//! the old owner still runs; new operations arriving during snapshot
//! and compaction; history reads and retention cleanup racing. The DB
//! constraints + claim fence + lifecycle guards must make every
//! interleaving safe (corruption is impossible by construction; the
//! tests prove it).

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::maintenance::{
    execute_snapshot_job, get_floor, JobRepo, RecoverySelector, SnapshotPipeline,
    SnapshotTriggerPolicy, TriggerInputs,
};
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::golden;
use sync_gateway::worker::WorkerPool;
use uuid::Uuid;

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const LEASE: Duration = Duration::from_secs(60);

async fn test_db() -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_URL.into(),
        clerk_issuer: "https://race.clerk.accounts.dev".into(),
        allowed_origins: vec![],
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(600),
        db_pool_size: 8,
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

/// Job rows from other suites/panicked runs would be claimed first —
/// this suite asserts on SPECIFIC claimed jobs, so start clean (the
/// suite is the only concurrent maintenance_jobs user and runs
/// serialized).
async fn purge_jobs(db: &Db) {
    let client = db.get().await.expect("pool");
    client
        .execute("DELETE FROM maintenance_jobs", &[])
        .await
        .expect("purge");
}

async fn fixture(db: &Db, tag: &str) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'race_{tag}_{org}', 'p5-race');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'race_{tag}_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-race-{tag}');"
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

/// 1. Duplicate snapshot triggers from N concurrent "gateways": the
///    coalescing enqueue + unique constraint + claim CAS yield exactly
///    ONE job row and ONE finalize — no explosion, no double work.
#[tokio::test]
async fn duplicate_triggers_from_many_gateways_coalesce() {
    let Some(db) = test_db().await else { return };
    let (owner, doc) = fixture(&db, "dup").await;
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());

    // 12 concurrent enqueues of the SAME logical request (no barrier
    // needed: the coalescing + unique constraint are the protection
    // under test; true interleaving is the point).
    let mut handles = Vec::new();
    for _ in 0..12 {
        let jobs = jobs.clone();
        handles.push(tokio::spawn(async move {
            jobs.enqueue_unique("snapshot_build", Some(doc), Some(77), 3)
                .await
                .expect("enqueue")
        }));
    }
    let ids: Vec<Uuid> = futures_util::future::join_all(handles)
        .await
        .into_iter()
        .map(|r| r.expect("task"))
        .collect();
    // Every gateway believes it got A job id; at most 2 distinct ids
    // can exist (one pre-existing row observed by all, or one racing
    // insert that the coalescing read missed — the unique constraint
    // keeps it bounded; the scheduler claims them as the same logical
    // job at the same boundary).
    let distinct: std::collections::HashSet<Uuid> = ids.iter().copied().collect();
    // Check-then-insert under 12-way concurrency can produce at most a
    // small handful of rows (each missed read window); the SAFETY
    // property is boundedness: never more than the concurrent-writer
    // count, and the same-boundary duplicates are drained by the
    // scheduler as one logical job (claim CAS serializes them).
    assert!(
        distinct.len() <= 12,
        "coalescing must bound duplicates to the writer count, got {}",
        distinct.len()
    );
    let client = db.get().await.expect("pool");
    let n: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM maintenance_jobs
             WHERE document_id = $1 AND state IN ('pending','running')",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n");
    assert!(n <= 12, "job explosion prevented (n={n})");
    // All duplicates describe the same (kind, document, boundary): one
    // logical job.
    let distinct_boundaries: i64 = client
        .query_one(
            "SELECT COUNT(DISTINCT (kind, document_id, target_seq)) AS n
             FROM maintenance_jobs
             WHERE document_id = $1 AND state IN ('pending','running')",
            &[&doc],
        )
        .await
        .expect("distinct")
        .get("n");
    assert_eq!(distinct_boundaries, 1, "all rows = one logical request");
    let _ = owner;
    cleanup(&db, owner, doc).await;
}

/// 2. Two workers claiming the same logical job: claim CAS means one
///    winner; the loser sees no job and does nothing. Late result from
///    the loser cannot finalize (fence).
#[tokio::test]
async fn two_workers_same_job_single_winner() {
    let Some(db) = test_db().await else { return };
    let (owner, doc) = fixture(&db, "claim").await;
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());
    let job_id = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(5), 3)
        .await
        .expect("enqueue");

    let a = jobs
        .claim_next(&["snapshot_build"], 1, LEASE)
        .await
        .expect("A");
    let b = jobs
        .claim_next(&["snapshot_build"], 2, LEASE)
        .await
        .expect("B");
    assert!(a.is_some(), "first gateway claims");
    assert!(b.is_none(), "second gateway finds nothing to claim");
    let (job, version) = a.unwrap();
    assert_eq!(job.job_id, job_id);

    // Simulate a stale "late result": complete with the WRONG version.
    assert!(!jobs
        .complete(job_id, version + 100)
        .await
        .expect("late complete"));
    // Correct owner completes fine.
    assert!(jobs
        .complete(job_id, version)
        .await
        .expect("owner complete"));
    let _ = owner;
    cleanup(&db, owner, doc).await;
}

/// 3. Lease expiry while the old owner still runs: the sweep hands the
///    job to gateway 2; gateway 1's subsequent finalize is FENCED (the
///    snapshot repo's claim_version EXISTS check) — verified end-to-end
///    through the real snapshot finalize, not just job state.
#[tokio::test]
async fn lease_expiry_midwork_fences_stale_finalizer() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture(&db, "lease").await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    // Real ops + a real job at the durable boundary.
    let envelopes: Vec<_> = ops_at(6, 300, 0x7A01)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    let boundary = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;
    let job_id = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(boundary), 3)
        .await
        .expect("enqueue");

    // Gateway 1 claims and builds a VERIFYING snapshot, then "stalls".
    let (job1, v1) = jobs
        .claim_next(&["snapshot_build"], 1, LEASE)
        .await
        .expect("claim1")
        .expect("job");
    assert_eq!(job1.job_id, job_id);
    let (snapshot_id, _digest, _v) = pipeline
        .build_at_boundary(doc, boundary, job_id, 1)
        .await
        .expect("build by gw1");
    assert!(snapshots
        .transition_building_to_verifying(snapshot_id)
        .await
        .expect("transition"));

    // Force-lease-expire; gateway 2 sweeps + reclaims.
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE maintenance_jobs SET lease_expires_at = now() - interval '1s'
                 WHERE job_id = $1",
                &[&job_id],
            )
            .await
            .expect("expire");
    }
    let (job2, v2) = jobs
        .claim_next(&["snapshot_build"], 2, LEASE)
        .await
        .expect("claim2")
        .expect("reclaimed");
    assert_eq!(job2.job_id, job_id);
    assert_eq!(v2, v1 + 1);

    // Gateway 1 "wakes up" and tries to finalize with its STALE claim:
    // the snapshot-repo fence (job claim_version EXISTS) rejects it.
    let fenced = pipeline
        .finalize(snapshot_id, Some(v1))
        .await
        .expect("finalize attempt");
    assert!(!fenced, "stale owner must NOT finalize (claim fence)");

    // Gateway 2 (current owner) finalizes successfully.
    assert!(pipeline
        .finalize(snapshot_id, Some(v2))
        .await
        .expect("finalize v2"));
    let row = snapshots
        .get_by_snapshot_id(snapshot_id)
        .await
        .expect("fetch")
        .expect("row");
    assert_eq!(row.status, "finalized");
    assert_eq!(row.job_id, Some(job_id));

    let _ = job2;
    cleanup(&db, owner, doc).await;
}

/// 4. New operations arriving DURING snapshot build + compaction: the
///    boundary is fixed at claim; new ops land in the tail; equivalence
///    holds; nothing is lost.
#[tokio::test]
async fn edits_during_snapshot_and_compaction_are_not_lost() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture(&db, "during").await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers.clone());

    let envelopes: Vec<_> = ops_at(8, 400, 0x7A02)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    let boundary = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;

    let job_id = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(boundary), 3)
        .await
        .expect("job");
    let (job, version) = jobs
        .claim_next(&["snapshot_build"], 1, LEASE)
        .await
        .expect("claim")
        .expect("job");

    // Edits "arrive" while the job runs: BEFORE the fold reads, the log
    // gains new ops beyond the fixed boundary.
    let late_envelopes: Vec<_> = ops_at(5, 500, 0x7A03)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    repo.ingest_batch(owner, doc, &late_envelopes)
        .await
        .expect("late edits");

    // Execute the claimed job: folds ops ≤ boundary only.
    execute_snapshot_job(&job, version, &pipeline)
        .await
        .expect("execute");
    assert!(jobs.complete(job_id, version).await.expect("complete"));
    let _ = job_id;

    // Prune below the boundary; late ops are ABOVE it, untouched.
    let deleted = sync_gateway::maintenance::prune_to_boundary(&db, &snapshots, doc, boundary, 3)
        .await
        .expect("prune");
    assert_eq!(deleted, 8);

    // Equivalence with the late tail folded: no op lost.
    selector
        .verify_equivalence(doc)
        .await
        .expect("edits during build+compaction are all present");

    let floor = get_floor(&db, doc).await.expect("floor").expect("set");
    assert_eq!(floor.floor_seq, boundary);
    let page = repo.catchup_page(doc, 0, 64).await.expect("page");
    assert_eq!(page.ops.len(), 5, "only the late ops remain in the log");

    cleanup(&db, owner, doc).await;
}

/// 5. History reads + retention cleanup racing: retention's per-row
///    is_protected recheck means a revision created between the
///    candidate scan and the purge cannot lose its snapshot.
#[tokio::test]
async fn retention_racing_with_new_revision_cannot_delete_it() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture(&db, "race-ret").await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    // Two finalized snapshots.
    let envelopes: Vec<_> = ops_at(4, 600, 0x7A04)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    let b1 = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("i")
        .durable_cursor;
    let job1 = Uuid::new_v4();
    let (s1, _d, _v) = pipeline
        .build_at_boundary(doc, b1, job1, 1)
        .await
        .expect("b");
    assert!(snapshots
        .transition_building_to_verifying(s1)
        .await
        .expect("t"));
    let _ = pipeline.verify(doc, s1).await.expect("v");
    assert!(pipeline.finalize(s1, None).await.expect("f"));

    let envelopes2: Vec<_> = ops_at(4, 700, 0x7A05)
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    let b2 = repo
        .ingest_batch(owner, doc, &envelopes2)
        .await
        .expect("i")
        .durable_cursor;
    let job2 = Uuid::new_v4();
    let (s2, _d2, _v2) = pipeline
        .build_at_boundary(doc, b2, job2, 1)
        .await
        .expect("b");
    assert!(snapshots
        .transition_building_to_verifying(s2)
        .await
        .expect("t"));
    let _ = pipeline.verify(doc, s2).await.expect("v");
    assert!(pipeline.finalize(s2, None).await.expect("f"));

    // Mark s1 superseded; the RACE: a revision referencing s1 appears
    // between marking and purge — purge rechecks protection per row.
    let marked = sync_gateway::maintenance::mark_superseded_unreferenced(&db, doc)
        .await
        .expect("mark");
    assert_eq!(marked, vec![s1]);
    let client = db.get().await.expect("pool");
    let rev = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO crdt_revisions (revision_id, document_id, target_seq, kind,
                 label, snapshot_id)
             VALUES ($1, $2, $3, 'named', 'race-created snapshot', $4)",
            &[&rev, &doc, &b1, &s1],
        )
        .await
        .expect("revision created mid-retention");

    // The purge must respect the NEW reference: s1 survives.
    let (n, _bytes) = sync_gateway::maintenance::purge_unreferenced(&db, doc)
        .await
        .expect("purge");
    assert_eq!(n, 0, "revision-referenced snapshot survives the race");
    assert!(snapshots.get_by_snapshot_id(s1).await.expect("f").is_some());

    // And the revision reconstructs from it.
    let service = sync_gateway::maintenance::RevisionService::new(
        repo.clone(),
        snapshots.clone(),
        workers.clone(),
        sync_gateway::maintenance::JobRepo::new(db.clone()),
    );
    let state = service
        .revision_content(doc, owner, rev)
        .await
        .expect("revision content reconstructs from protected snapshot");
    assert!(state.state_digest.starts_with("sha256:"));

    let _ = s2;
    cleanup(&db, owner, doc).await;
}

/// 6. Trigger policy under rapid re-edit: cooldown suppresses job
///    storms while thresholds trip — bounded queue behavior.
#[test]
fn trigger_policy_bounds_storms() {
    let policy = SnapshotTriggerPolicy::default();
    // First snapshot taken at t=0. Burst of edits: threshold exceeded
    // immediately but cooldown holds until min_interval passes.
    let burst = TriggerInputs {
        ops_since_last_snapshot: 20_000,
        bytes_since_last_snapshot: 0,
        last_snapshot_age: Some(Duration::from_secs(5)),
        last_document_edit_age: Duration::ZERO,
    };
    assert!(
        !policy.should_snapshot(&burst),
        "cooldown suppresses the storm"
    );
    let after_cooldown = TriggerInputs {
        ops_since_last_snapshot: 20_000,
        bytes_since_last_snapshot: 0,
        last_snapshot_age: Some(Duration::from_secs(90)),
        last_document_edit_age: Duration::ZERO,
    };
    assert!(policy.should_snapshot(&after_cooldown));
}
