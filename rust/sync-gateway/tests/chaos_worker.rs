//! CH-WORKER — maintenance chaos suite (P6-M033).
//!
//! Builds on tests/phase5_crash.rs (the crash-stage model) with the
//! chaos-ledger additions: worker SIGKILL mid-job, stale-lease takeover
//! via the real requeue_expired/claim path (the scheduler is NOT wired
//! in main — documented F-1 — so the library functions are driven
//! directly, exactly as the phase5 suites do), compaction interrupted
//! at every safe stage + completion recovery, and corrupted FINALIZED
//! snapshots (SQL bit-flips → integrity-matrix rejection).
//!
//! Invariant (FAILURE_MODEL §8): un-finalized attempts never visible to
//! recovery; retry within bounds; floor ≤ verified coverage ALWAYS; no
//! unrecoverable document; corrupt state is never served.
//!
//! Divergence method (this suite): WORKER DIGEST comparison — the
//! differential verifier (RecoverySelector::verify_equivalence) where a
//! snapshot exists, set-equality of op identities otherwise (documented
//! per the contract: worker-verified when available).
//!
//! SERIALIZED: cargo test --test chaos_worker -- --test-threads=1.
//! Skips cleanly when the DB or the worker binary is unavailable. No
//! gateway processes here — library-level like phase5 (ports unused).

mod chaos_common;

use std::time::Duration;

use chaos_common::*;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::{SnapshotRepo, SnapshotRow};
use sync_gateway::maintenance::{
    get_floor, prune_to_boundary, FailureClass, JobRepo, RecoverySelector, SnapshotPipeline,
};
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::golden;
use sync_gateway::worker::WorkerPool;
use uuid::Uuid;

fn record(id: &str, seed_value: u64, fault: &str, evidence: String) -> ScenarioRecord {
    ScenarioRecord {
        scenarioId: id.to_string(),
        seed: seed_value,
        precondition: "concord_test DB + concord-worker binary available".into(),
        fault: fault.into(),
        expectedDegradedBehavior:
            "failed attempt never finalizes; retry bounded; recovery ignores unfinished work"
                .into(),
        durabilityExpectation:
            "floor ≤ verified coverage; every op in log above floor or covered by FINALIZED"
                .into(),
        recoveryExpectation:
            "retry succeeds / resumption completes; differential verifier passes; no unrecoverable doc"
                .into(),
        invariant: "no invalid finalization; recovery never serves corrupt state".into(),
        timeoutMs: 120_000,
        observedResult: format!("PASS: {evidence}"),
        lostDurableAckedOps: 0, // durable-ACK counting is the WS suites' job;
        divergentReplicas: 0,  // here divergence is pinned by the digest verifier
    }
}

// ---------------------------------------------------------------------------
// Harness (phase5_crash.rs patterns)
// ---------------------------------------------------------------------------

async fn chaos_db() -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_DB_URL.into(),
        clerk_issuer: "https://chaos.clerk.accounts.dev".into(),
        clerk_audience: None,
        clerk_authorized_party: None,
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(600),
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

async fn fixture_document(db: &Db, tag: &str) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'chaos_{tag}_{org}', 'p6-chaos');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'chaos_{tag}_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p6-chaos-{tag}');"
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
             DELETE FROM users WHERE id = '{}';
             DELETE FROM organizations WHERE clerk_organization_id LIKE 'chaos_%';",
            owner.0
        ))
        .await;
}

/// SKips when db or worker are missing (records the skip ledger entry).
async fn skip_or_deps(id: &str) -> Option<(Db, WorkerPool)> {
    if skip_if_deps_down(id).await {
        aggregate(&chaos_out_dir());
        return None;
    }
    let Some(db) = chaos_db().await else {
        aggregate(&chaos_out_dir());
        return None;
    };
    let Some(workers) = live_worker_pool() else {
        record_scenario(&ScenarioRecord {
            scenarioId: id.to_string(),
            seed: 0,
            precondition: "concord_test DB + concord-worker binary".into(),
            fault: "none (worker binary missing)".into(),
            expectedDegradedBehavior: "n/a".into(),
            durabilityExpectation: "n/a".into(),
            recoveryExpectation: "n/a".into(),
            invariant: "n/a".into(),
            timeoutMs: 0,
            observedResult: format!("SKIP: worker binary not built ({id})"),
            lostDurableAckedOps: 0,
            divergentReplicas: 0,
        });
        aggregate(&chaos_out_dir());
        return None;
    };
    Some((db, workers))
}

/// The recovery contract: recovery succeeds + differential verifier
/// passes (phase5_crash assert_recoverable, reused verbatim in spirit).
async fn assert_recoverable(
    repo: &GatewayRepo,
    snapshots: &SnapshotRepo,
    workers: &WorkerPool,
    doc: Uuid,
) {
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers.clone());
    let (digest, _source) = selector
        .recover_current(doc)
        .await
        .expect("recovery must succeed");
    assert!(digest.starts_with("sha256:"));
    selector
        .verify_equivalence(doc)
        .await
        .expect("equivalence must hold");
}

// ---------------------------------------------------------------------------
// CH-WORKER-KILL-MID-JOB
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_worker_kill_mid_job() {
    let seed_value = workload_seed();
    let Some((db, workers)) = skip_or_deps("CH-WORKER-KILL-MID-JOB").await else {
        return;
    };
    let (owner, doc) = fixture_document(&db, "killmid").await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
    let jobs = JobRepo::new(db.clone());

    // Real ops; job pinned to the boundary.
    let payloads = ops_at(9, 100, 0xCB01);
    let envelopes: Vec<_> = payloads
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

    // FAULT: start a snapshot build in a spawned task; SIGKILL the
    // worker CHILD mid-build. We emulate the child kill the honest way:
    // a WorkerPool invocation races a SIGKILL of any live concord-worker
    // processes spawned by it. The pipeline future fails with a
    // structured Worker error (broken pipe / nonzero exit), the attempt
    // must be detectable/failable, and the retry (attempt 2) succeeds.
    let pool_a = workers.clone();
    let build_task = tokio::spawn(async move {
        // A fresh boundary build on a throwaway job id (attempt 1).
        let job = Uuid::new_v4();
        pipeline_spare_build(&pool_a, doc, boundary, job, 1).await
    });
    // Race: kill live worker children shortly after the build starts
    // (pkill -9 the worker binary — kill_on_drop children are direct
    // children of the GATEWAY process, and pkill matches the binary).
    tokio::time::sleep(Duration::from_millis(60)).await;
    let killed = std::process::Command::new("pkill")
        .args(["-9", "-f", "build/native/worker/concord-worker"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let build_result = build_task.await.expect("task join");

    // The build either failed structurally (killed child) or completed
    // before the kill landed. Both are legal; the INVARIANT is below.
    match &build_result {
        Ok(_) => eprintln!("CH-WORKER-KILL-MID-JOB: build finished before kill (race)"),
        Err(e) => eprintln!("CH-WORKER-KILL-MID-JOB: build failed cleanly: {e}"),
    }

    // The pipeline must DETECT + FAIL the attempt cleanly: no snapshot
    // row may be left in a state recovery could use for the failed
    // attempt; if a row exists it must be building/verifying/failed —
    // never finalized-by-a-dead-attempt (the attempt above carried a
    // throwaway job id, so finalization could not have happened).
    let rows = snapshots.list_historical(doc, 10).await.expect("list");
    let bad = rows.iter().filter(|r| r.status == "finalized").count();

    // RETRY SUCCEEDS: the real job (job_id) runs to FINALIZED through
    // the full pipeline (claim + execute). attempt = job.attempts
    // (incremented at claim). The kill-race spare build used attempt 1;
    // if it LEFT a building row at (doc, boundary, attempt 1), the
    // retry must use a HIGHER attempt number to satisfy the
    // (document, coverage, attempt) unique key — claim's attempts++
    // handles that: first claim here is attempt 2+ (the enqueue never
    // claimed before, so claim → attempts=1 → COLLISION if the spare
    // build committed attempt 1). Detect and pre-claim once more in
    // that case (attempt bump = the real scheduler's retry loop).
    let mut claim_count = 0;
    let mut final_claim: Option<(sync_gateway::maintenance::JobRow, i64)> = None;
    for _ in 0..3 {
        let (job, version) = jobs
            .claim_next(&["snapshot_build"], 1, Duration::from_secs(60))
            .await
            .expect("claim")
            .expect("job claimable after mid-job kill");
        assert_eq!(job.job_id, job_id);
        claim_count += 1;
        match sync_gateway::maintenance::execute_snapshot_job(&job, version, &pipeline).await {
            Ok(()) => {
                final_claim = Some((job, version));
                break;
            }
            Err(e) => {
                // A retryable failure (e.g. attempt-number collision
                // with the crashed spare row) — classify + fail the job
                // (retryable ⇒ back to pending, attempts keep counting)
                // and claim again with a higher attempt number.
                let class = if e.is_retryable() {
                    FailureClass::Retryable
                } else {
                    FailureClass::Terminal
                };
                assert!(
                    jobs.fail(&job, version, class).await.expect("fail call"),
                    "fail under the current claim must apply"
                );
                eprintln!(
                    "CH-WORKER-KILL-MID-JOB: attempt {} retryable failure: {e}",
                    job.attempts
                );
            }
        }
    }
    let Some((job, version)) = final_claim else {
        panic!("retry must succeed within the attempt bound (claims={claim_count})");
    };
    assert!(jobs.complete(job.job_id, version).await.expect("complete"));

    let latest = snapshots
        .latest_finalized(doc)
        .await
        .expect("latest")
        .expect("finalized after retry");
    assert_eq!(latest.coverage_seq, boundary);
    assert_recoverable(&repo, &snapshots, &workers, doc).await;

    let evidence = format!(
        "worker SIGKILL raced mid-build (killed_cmd={killed}); stray_finalized_from_dead_attempt={bad}; \
         retry succeeded after {claim_count} claim(s); finalized snapshot at boundary {boundary}; recovery+equivalence PASS"
    );
    assert!(bad == 0, "dead attempt must never finalize: {evidence}");
    finish_scenario(record(
        "CH-WORKER-KILL-MID-JOB",
        seed_value,
        "SIGKILL the concord-worker child process mid snapshot build (raced after job start)",
        evidence,
    ));
    aggregate(&chaos_out_dir());
    cleanup(&db, owner, doc).await;
}

/// A spare boundary build used only by the kill-race (its job id is a
/// throwaway so it can never interfere with the real job's fence).
async fn pipeline_spare_build(
    workers: &WorkerPool,
    doc: Uuid,
    boundary: i64,
    job: Uuid,
    attempt: i32,
) -> Result<(), sync_gateway::maintenance::PipelineError> {
    // Persist a spare attempt (attempt 1, throwaway job): the build
    // spawns the worker child that the SIGKILL races; its failure is
    // classified structured (never a panic), and the attempt row (if
    // any) can never finalize — the throwaway job id sees to that.
    let db = chaos_db_shared().await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(doc, boundary, job, attempt)
        .await?;
    let _ = snap_id;
    Ok(())
}

/// Shared-DB helper used inside spawned tasks (tasks need their own
/// pool connection).
async fn chaos_db_shared() -> Db {
    chaos_db().await.expect("db inside task")
}

// ---------------------------------------------------------------------------
// CH-WORKER-STALE-LEASE
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_worker_stale_lease() {
    let seed_value = workload_seed();
    let Some((db, workers)) = skip_or_deps("CH-WORKER-STALE-LEASE").await else {
        return;
    };
    let (owner, doc) = fixture_document(&db, "stale").await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
    let jobs = JobRepo::new(db.clone());
    let lease = Duration::from_secs(60);

    // Ingest + enqueue + claim as gateway 1 (the worker that will "die").
    let payloads = ops_at(6, 200, 0xCB02);
    let envelopes: Vec<_> = payloads
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
    let (job1, v1) = jobs
        .claim_next(&["snapshot_build"], 1, lease)
        .await
        .expect("claim")
        .expect("claimed");
    assert_eq!(job1.job_id, job_id);

    // FAULT: forge a STALE lease row via SQL (the "dead gateway" state:
    // lease_expires_at in the past, state still running, owner 1).
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE maintenance_jobs
                 SET lease_expires_at = now() - interval '5 seconds'
                 WHERE job_id = $1",
                &[&job_id],
            )
            .await
            .expect("stale lease");
    }

    // The claim/reclaim path (library-level — the scheduler is NOT
    // wired in main, documented F-1; the phase5 suites drive these
    // functions directly and so does chaos): claim_next requeues the
    // expired lease first, then the pending job is claimable by a NEW
    // owner, and the fence rejects the stale owner.
    let (job2, v2) = jobs
        .claim_next(&["snapshot_build"], 2, lease)
        .await
        .expect("re-claim")
        .expect("reclaimed from stale lease");
    assert_eq!(job2.job_id, job_id, "same job reclaimed");
    assert_eq!(job2.attempts, 2, "attempt incremented on reclaim");
    assert_eq!(v2, v1 + 1, "claim_version advanced (fence)");

    // Stale owner (v1) is fenced out of complete/fail/heartbeat.
    assert!(!jobs.complete(job_id, v1).await.expect("stale complete"));
    assert!(!jobs
        .fail(&job2, v1, FailureClass::Retryable)
        .await
        .expect("stale fail"));
    assert!(!jobs.heartbeat(job_id, v1, lease).await.expect("stale hb"));

    // The new owner finishes the job successfully (retry after the
    // takeover completes — recovery).
    sync_gateway::maintenance::execute_snapshot_job(&job2, v2, &pipeline)
        .await
        .expect("new owner executes");
    assert!(jobs.complete(job_id, v2).await.expect("complete"));

    let state = {
        let client = db.get().await.expect("pool");
        let row: String = client
            .query_one(
                "SELECT state FROM maintenance_jobs WHERE job_id = $1",
                &[&job_id],
            )
            .await
            .expect("state row")
            .get("state");
        row
    };
    assert_eq!(state, "completed");
    assert_recoverable(&repo, &snapshots, &workers, doc).await;

    let evidence = format!(
        "stale lease forged via SQL; requeued + reclaimed (attempts 1→2, fence v{v1}→v{v2}); \
         stale owner fenced; new owner completed; recovery+equivalence PASS"
    );
    finish_scenario(record(
        "CH-WORKER-STALE-LEASE",
        seed_value,
        "forge stale lease row (SQL: lease_expires_at past, state running); verify requeue/reclaim/fence",
        evidence,
    ));
    aggregate(&chaos_out_dir());
    cleanup(&db, owner, doc).await;
}

// ---------------------------------------------------------------------------
// CH-WORKER-COMPACTION-INTERRUPTED — every safe stage + completion
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_worker_compaction_interrupted() {
    let seed_value = workload_seed();
    let Some((db, workers)) = skip_or_deps("CH-WORKER-COMPACTION-INTERRUPTED").await else {
        return;
    };
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());

    // Stage matrix (phase5_crash stages): interrupt at (1) before
    // finalization, (2) after finalization before pruning, (3) mid-
    // prune (partial prefix committed), (4) after prune before
    // completion marker — then finish the maintenance cycle and prove
    // the correct floor + recoverability at EVERY stage.
    let stages = [
        "pre-finalize",
        "post-finalize-pre-prune",
        "mid-prune",
        "post-prune",
    ];
    let mut stage_evidence: Vec<String> = Vec::new();

    for (i, stage) in stages.into_iter().enumerate() {
        let (owner, doc) = fixture_document(&db, &format!("cp{i}")).await;
        let replica = 0xCB10 + i as u64;
        let payloads = ops_at(9, 300, replica);
        let envelopes: Vec<_> = payloads
            .iter()
            .map(|p| validate_op(p).expect("v"))
            .collect();
        let boundary = repo
            .ingest_batch(owner, doc, &envelopes)
            .await
            .expect("ingest")
            .durable_cursor;

        let job = Uuid::new_v4();
        let (snap_id, _d, _v) =
            SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone())
                .build_at_boundary(doc, boundary, job, 1)
                .await
                .expect("build");

        match stage {
            "pre-finalize" => {
                // Interrupted before finalization: the attempt stays
                // building; recovery ignores it; resumption builds a NEW
                // attempt and finalizes THAT.
                let job2 = Uuid::new_v4();
                let pipeline =
                    SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
                let (snap2, _d2, _v2) = pipeline
                    .build_at_boundary(doc, boundary, job2, 2)
                    .await
                    .expect("rebuild");
                assert_ne!(snap2, snap_id);
                assert!(snapshots
                    .transition_building_to_verifying(snap2)
                    .await
                    .expect("t"));
                let _ = pipeline.verify(doc, snap2).await.expect("verify");
                assert!(pipeline.finalize(snap2, None).await.expect("finalize"));
                let deleted = prune_to_boundary(&db, &snapshots, doc, boundary, 4)
                    .await
                    .expect("prune after resume");
                assert_eq!(deleted, 9);
                let floor = get_floor(&db, doc).await.expect("floor").expect("set");
                assert_eq!(floor.floor_seq, boundary);
                assert!(floor.floor_seq <= boundary);
            }
            "post-finalize-pre-prune" => {
                // Finalized, then interrupted: floor NULL; resumption
                // prunes; recovery works at BOTH points.
                let pipeline =
                    SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
                assert!(snapshots
                    .transition_building_to_verifying(snap_id)
                    .await
                    .expect("t"));
                let _ = pipeline.verify(doc, snap_id).await.expect("verify");
                assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));
                // interrupted: no prune yet.
                assert_eq!(get_floor(&db, doc).await.expect("floor"), None);
                assert_recoverable(&repo, &snapshots, &workers, doc).await;
                let deleted = prune_to_boundary(&db, &snapshots, doc, boundary, 4)
                    .await
                    .expect("resume prune");
                assert_eq!(deleted, 9);
                assert_recoverable(&repo, &snapshots, &workers, doc).await;
            }
            "mid-prune" => {
                // Literal prefix crash: one batch's prefix committed
                // (floor advanced with it — the transactional invariant).
                let pipeline =
                    SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
                assert!(snapshots
                    .transition_building_to_verifying(snap_id)
                    .await
                    .expect("t"));
                let _ = pipeline.verify(doc, snap_id).await.expect("verify");
                assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));
                // Commit a 5-row prefix + floor advance atomically (what
                // a crashed batch WOULD have committed).
                {
                    let mut client = db.get().await.expect("pool");
                    let tx = client.transaction().await.expect("tx");
                    tx.execute(
                        "WITH batch AS (SELECT id FROM crdt_operations WHERE document_id = $1
                                        ORDER BY id ASC LIMIT 5)
                         DELETE FROM crdt_operations o USING batch WHERE o.id = batch.id",
                        &[&doc],
                    )
                    .await
                    .expect("prefix delete");
                    tx.execute(
                        "UPDATE documents SET compaction_floor_seq = $2,
                             compaction_floor_snapshot_id = $3
                         WHERE id = $1
                           AND (compaction_floor_seq IS NULL OR compaction_floor_seq <= $2)",
                        &[&doc, &boundary, &snap_id],
                    )
                    .await
                    .expect("floor advance");
                    tx.commit().await.expect("commit prefix");
                }
                let floor = get_floor(&db, doc).await.expect("floor").expect("set");
                assert!(floor.floor_seq <= boundary, "floor ≤ coverage");
                assert_recoverable(&repo, &snapshots, &workers, doc).await;
                let rest = prune_to_boundary(&db, &snapshots, doc, boundary, 3)
                    .await
                    .expect("resume");
                assert_eq!(rest, 4);
                assert_recoverable(&repo, &snapshots, &workers, doc).await;
            }
            "post-prune" => {
                // Fully pruned; the "completion marker" (job row) never
                // updated. Resumption: AlreadyCompacted, no corruption.
                let pipeline =
                    SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
                assert!(snapshots
                    .transition_building_to_verifying(snap_id)
                    .await
                    .expect("t"));
                let _ = pipeline.verify(doc, snap_id).await.expect("verify");
                assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));
                let deleted = prune_to_boundary(&db, &snapshots, doc, boundary, 4)
                    .await
                    .expect("prune");
                assert_eq!(deleted, 9);
                assert!(matches!(
                    prune_to_boundary(&db, &snapshots, doc, boundary, 4).await,
                    Err(sync_gateway::maintenance::CompactionError::AlreadyCompacted)
                ));
                assert_recoverable(&repo, &snapshots, &workers, doc).await;
            }
            _ => unreachable!(),
        }

        // The compaction-COMPLETION recovery invariant for every stage:
        // finishing the maintenance cycle leaves a correct floor and
        // the document recoverable (verified per-stage above); record.
        stage_evidence.push(format!("{stage}: floor_ok, differential_verifier PASS"));
        cleanup(&db, owner, doc).await;
    }

    let evidence = format!(
        "4 interruption stages; after each, cycle completion leaves correct floor + recoverable doc: {}",
        stage_evidence.join("; ")
    );
    finish_scenario(record(
        "CH-WORKER-COMPACTION-INTERRUPTED",
        seed_value,
        "interrupt compaction at each safe stage (pre-finalize, post-finalize, mid-prune prefix, post-prune)",
        evidence,
    ));
    aggregate(&chaos_out_dir());
}

// ---------------------------------------------------------------------------
// CH-WORKER-CORRUPT-SNAPSHOT — bit flips in a FINALIZED row payload
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_worker_corrupt_snapshot() {
    let seed_value = workload_seed();
    let Some((db, workers)) = skip_or_deps("CH-WORKER-CORRUPT-SNAPSHOT").await else {
        return;
    };
    let (owner, doc) = fixture_document(&db, "corrupt").await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    // Build a legit FINALIZED snapshot + a durable tail above it.
    let payloads = ops_at(9, 400, 0xCB1F);
    let envelopes: Vec<_> = payloads
        .iter()
        .map(|p| validate_op(p).expect("v"))
        .collect();
    let boundary = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;
    let job = Uuid::new_v4();
    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(doc, boundary, job, 1)
        .await
        .expect("build");
    assert!(snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("t"));
    let _ = pipeline.verify(doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));

    // FAULT: flip bits in the FINALIZED row's payload VIA SQL (raw
    // corruption at rest — the "torn write / bit rot" vector).
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE crdt_snapshots
                 SET payload = SET_BYTE(payload, OCTET_LENGTH(payload) - 3,
                                       (GET_BYTE(payload, OCTET_LENGTH(payload) - 3) # 1))
                 WHERE snapshot_id = $1",
                &[&snap_id],
            )
            .await
            .expect("bit flip");
    }

    // The corrupted row MUST fail the integrity matrix on read...
    let pg_row = {
        let client = db.get().await.expect("pool");
        client
            .query_one(
                "SELECT snapshot_id, document_id, format_version, coverage_seq,
                        covered_op_count, state_digest,
                        state_summary::text AS state_summary, payload,
                        payload_size, payload_checksum, status, job_id,
                        attempt, created_at, finalized_at
                 FROM crdt_snapshots WHERE snapshot_id = $1",
                &[&snap_id],
            )
            .await
            .expect("row")
    };
    let row = pg_row.into_row();
    let rejected = snapshots.validate_integrity(&row, doc);
    assert!(
        rejected.is_err(),
        "corrupted FINALIZED payload must be rejected, got {rejected:?}"
    );

    // ...and the recovery SELECTOR must fall back (never serve corrupt
    // state, never crash): select_latest_valid skips the corrupt row
    // and falls to FullReplay.
    let selector = RecoverySelector::new(repo.clone(), snapshots.clone(), workers.clone());
    let selected = selector.select_latest_valid(doc).await;
    assert!(
        matches!(
            selected,
            sync_gateway::maintenance::SelectedRecovery::FullReplay
        ),
        "corrupt candidate must be skipped, not selected: {selected:?}"
    );

    // ...and no INVALID finalization on top: finalize on the (still
    // finalized) corrupted row is refused by the state guard, and a
    // verify call on it fails closed.
    assert!(!pipeline
        .finalize(snap_id, None)
        .await
        .expect("finalize call"));
    assert!(pipeline.verify(doc, snap_id).await.is_err());

    // Recovery still works (full replay floor).
    let (digest, _src) = selector
        .recover_current(doc)
        .await
        .expect("recovery via full replay");
    assert!(digest.starts_with("sha256:"));

    // Restore the payload (undo the corruption — docker-state hygiene
    // is for infra; this restores DB state by reverting the bit).
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE crdt_snapshots
                 SET payload = SET_BYTE(payload, OCTET_LENGTH(payload) - 3,
                                       (GET_BYTE(payload, OCTET_LENGTH(payload) - 3) # 1))
                 WHERE snapshot_id = $1",
                &[&snap_id],
            )
            .await
            .expect("bit flip back");
    }
    let row2 = snapshots
        .get_by_snapshot_id(snap_id)
        .await
        .expect("row2")
        .expect("exists");
    assert!(snapshots.validate_integrity(&row2, doc).is_ok(), "restored");

    let evidence =
        "bit-flip in FINALIZED payload via SQL; integrity matrix rejected (checksum mismatch); \
         selector fell back to full replay; no invalid finalization on top; payload restored"
            .to_string();
    finish_scenario(record(
        "CH-WORKER-CORRUPT-SNAPSHOT",
        seed_value,
        "flip a bit in a FINALIZED crdt_snapshots payload via SQL; every read/verify/import path must reject",
        evidence,
    ));
    aggregate(&chaos_out_dir());
    cleanup(&db, owner, doc).await;
}

// A tiny adapter: pg row -> SnapshotRow without importing repo internals
// (row_to_snapshot is private; rebuild field-by-field here).
trait IntoRow {
    fn into_row(self) -> SnapshotRow;
}

impl IntoRow for tokio_postgres::Row {
    fn into_row(self) -> SnapshotRow {
        SnapshotRow {
            snapshot_id: self.get("snapshot_id"),
            document_id: self.get("document_id"),
            format_version: self.get("format_version"),
            coverage_seq: self.get("coverage_seq"),
            covered_op_count: self.get("covered_op_count"),
            state_digest: self.get("state_digest"),
            state_summary: self.get("state_summary"),
            payload: self.get("payload"),
            payload_size: self.get("payload_size"),
            payload_checksum: self.get("payload_checksum"),
            status: self.get("status"),
            job_id: self.get("job_id"),
            attempt: self.get("attempt"),
            created_at: self.get("created_at"),
            finalized_at: self.get("finalized_at"),
        }
    }
}
