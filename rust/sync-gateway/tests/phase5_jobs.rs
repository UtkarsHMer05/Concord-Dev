//! Maintenance job scheduler tests (P5-M023..M025): coalescing
//! enqueue, claim CAS, lease heartbeat, stale-owner fencing, expired
//! lease recovery, bounded retry, and trigger policy. Live DB.

use std::sync::Arc;
use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::maintenance::{
    execute_snapshot_job, BoundedRunner, FailureClass, JobRepo, MaintenanceLimits, Scheduler,
    SnapshotPipeline, SnapshotTriggerPolicy, TriggerInputs,
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
        clerk_audience: None,
        clerk_authorized_party: None,
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
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

/// The job tests assert on specific claimed jobs; earlier-suite debris
/// (rows orphaned by panicked runs) would be claimed first. This suite
/// is the only maintenance_jobs user and runs serialized, so each test
/// starts from a clean queue (test-DB-only helper).
async fn purge_jobs(db: &Db) {
    let client = db.get().await.expect("pool");
    client
        .execute("DELETE FROM maintenance_jobs", &[])
        .await
        .expect("purge jobs");
}

async fn fixture_document(db: &Db) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'org_{org}', 'p5-job-test');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'p5_job_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-jobs');"
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
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{}';",
            owner.0
        ))
        .await;
}

fn ops_at(count: usize, counter_base: u64) -> Vec<Vec<u8>> {
    let builders = [
        golden::golden_insert_op,
        golden::golden_delimiter_op,
        golden::golden_delete_op,
    ];
    (0..count)
        .map(|i| {
            let mut base = builders[i % builders.len()]();
            base[2..10].copy_from_slice(&(0xCC00u64).to_le_bytes());
            base[10..18].copy_from_slice(&(counter_base + i as u64).to_le_bytes());
            validate_op(&base).expect("valid");
            base
        })
        .collect()
}

#[allow(dead_code)]
fn ops(count: usize) -> Vec<Vec<u8>> {
    let builders = [
        golden::golden_insert_op,
        golden::golden_delimiter_op,
        golden::golden_delete_op,
    ];
    (0..count)
        .map(|i| {
            let mut base = builders[i % builders.len()]();
            base[2..10].copy_from_slice(&(0xCC00u64).to_le_bytes());
            base[10..18].copy_from_slice(&(300 + i as u64).to_le_bytes());
            validate_op(&base).expect("valid");
            base
        })
        .collect()
}

#[tokio::test]
async fn coalescing_enqueue_deduplicates_same_document_boundary() {
    let Some(db) = test_db().await else { return };
    let (owner, doc) = fixture_document(&db).await;
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());

    let a = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(42), 3)
        .await
        .expect("enqueue 1");
    let b = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(42), 3)
        .await
        .expect("enqueue 2");
    let c = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(43), 3)
        .await
        .expect("enqueue different boundary");
    assert_eq!(a, b, "duplicate request must coalesce to the same job");
    assert_ne!(a, c, "different boundary = different job");
    // Count pending jobs scoped to THIS document (the suite shares the
    // test DB; global counts would be flaky against parallel fixtures).
    let client = db.get().await.expect("pool");
    let row = client
        .query_one(
            "SELECT COUNT(*) AS n FROM maintenance_jobs
             WHERE document_id = $1 AND kind = 'snapshot_build'
               AND state = 'pending'",
            &[&doc],
        )
        .await
        .expect("count");
    let n: i64 = row.get("n");
    assert_eq!(n, 2, "two pending jobs (boundaries 42 and 43), not more");

    cleanup(&db, owner, doc).await;
}

#[tokio::test]
async fn claim_cas_heartbeat_and_stale_owner_fence() {
    let Some(db) = test_db().await else { return };
    let (owner, doc) = fixture_document(&db).await;
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());
    let lease = Duration::from_secs(60);

    let job_id = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(10), 3)
        .await
        .expect("enqueue");

    // Gateway 1 claims.
    let (job, v1) = jobs
        .claim_next(&["snapshot_build"], 1, lease)
        .await
        .expect("claim")
        .expect("job claimed");
    assert_eq!(job.job_id, job_id);
    assert_eq!(job.attempts, 1);
    assert_eq!(v1, 1);

    // Gateway 2 cannot claim while pending is empty (the job is running).
    assert!(jobs
        .claim_next(&["snapshot_build"], 2, lease)
        .await
        .expect("claim")
        .is_none());

    // Heartbeat extends only for the current claim_version.
    assert!(jobs.heartbeat(job_id, v1, lease).await.expect("hb"));
    // Stale heartbeat (version 0) is fenced out.
    assert!(!jobs
        .heartbeat(job_id, v1 - 1, lease)
        .await
        .expect("hb stale"));

    // Simulate lease theft: force-expire and re-claim as gateway 2.
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE maintenance_jobs SET lease_expires_at = now() - interval '1 second'
                 WHERE job_id = $1",
                &[&job_id],
            )
            .await
            .expect("expire");
    }
    let (job2, v2) = jobs
        .claim_next(&["snapshot_build"], 2, lease)
        .await
        .expect("re-claim")
        .expect("expired lease job re-claimable");
    assert_eq!(job2.job_id, job_id);
    assert_eq!(v2, v1 + 1, "claim_version must advance on re-claim");
    assert_eq!(job2.attempts, 2, "attempt count increments per claim");

    // THE FENCE: gateway 1 (stale owner) cannot complete or heartbeat.
    assert!(!jobs.complete(job_id, v1).await.expect("stale complete"));
    assert!(!jobs.heartbeat(job_id, v1, lease).await.expect("stale hb"));
    assert!(!jobs
        .fail(&job2, v1, FailureClass::Retryable)
        .await
        .expect("stale fail"));
    // The new owner can.
    assert!(jobs.complete(job_id, v2).await.expect("complete v2"));

    cleanup(&db, owner, doc).await;
}

#[tokio::test]
async fn bounded_retry_classification_and_exhaustion() {
    let Some(db) = test_db().await else { return };
    let (owner, doc) = fixture_document(&db).await;
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());
    let lease = Duration::from_secs(60);

    let job_id = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(7), 2)
        .await
        .expect("enqueue");
    let (j1, v1) = jobs
        .claim_next(&["snapshot_build"], 1, lease)
        .await
        .expect("claim")
        .expect("job");
    // Retryable failure (attempts 1 < max 2) → back to pending.
    assert!(jobs
        .fail(&j1, v1, FailureClass::Retryable)
        .await
        .expect("fail retryable"));
    // Re-claim (attempt 2).
    let (j2, v2) = jobs
        .claim_next(&["snapshot_build"], 1, lease)
        .await
        .expect("re-claim")
        .expect("job again");
    assert_eq!(j2.attempts, 2);
    // Retryable again → attempts (2) ≥ max (2) ⇒ terminally failed.
    assert!(jobs
        .fail(&j2, v2, FailureClass::Retryable)
        .await
        .expect("fail exhausted"));
    let client = db.get().await.expect("pool");
    let state: String = client
        .query_one(
            "SELECT state FROM maintenance_jobs WHERE job_id = $1",
            &[&job_id],
        )
        .await
        .expect("state")
        .get("state");
    assert_eq!(state, "failed");
    // Terminal classification fails immediately on first attempt.
    let j2b = jobs
        .enqueue_unique("verify", Some(doc), Some(9), 3)
        .await
        .expect("enqueue");
    let _ = j2b;
    let (j3, v3) = jobs
        .claim_next(&["verify"], 1, lease)
        .await
        .expect("claim")
        .expect("job");
    assert!(jobs
        .fail(&j3, v3, FailureClass::Terminal)
        .await
        .expect("terminal fail"));
    let state: String = client
        .query_one(
            "SELECT state FROM maintenance_jobs WHERE job_id = $1",
            &[&j3.job_id],
        )
        .await
        .expect("state")
        .get("state");
    assert_eq!(state, "failed");

    cleanup(&db, owner, doc).await;
}

#[tokio::test]
async fn expired_lease_jobs_requeue_or_fail_on_sweep() {
    let Some(db) = test_db().await else { return };
    let (owner, doc) = fixture_document(&db).await;
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());
    let lease = Duration::from_secs(60);

    // Job A: attempts left after expiry → pending; Job B: exhausted →
    // failed. Claim twice to exhaust B.
    let a = jobs
        .enqueue_unique("verify", Some(doc), Some(1), 3)
        .await
        .expect("a");
    let b = jobs
        .enqueue_unique("verify", Some(doc), Some(2), 1)
        .await
        .expect("b");

    let (ja, _) = jobs
        .claim_next(&["verify"], 5, lease)
        .await
        .expect("claim")
        .expect("a");
    let (jb, _) = jobs
        .claim_next(&["verify"], 5, lease)
        .await
        .expect("claim")
        .expect("b");
    assert_eq!(ja.job_id, a);
    assert_eq!(jb.job_id, b);
    assert_eq!(jb.attempts, 1);

    // Force both leases into the past, then sweep via claim_next.
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE maintenance_jobs SET lease_expires_at = now() - interval '2 seconds'
                 WHERE job_id IN ($1, $2)",
                &[&a, &b],
            )
            .await
            .expect("expire");
    }
    let (ja2, _) = jobs
        .claim_next(&["verify"], 6, lease)
        .await
        .expect("claim after sweep")
        .expect("A requeued and reclaimed");
    assert_eq!(ja2.job_id, a);
    assert_eq!(ja2.attempts, 2, "A retried with incremented attempts");
    let client = db.get().await.expect("pool");
    let state_b: String = client
        .query_one(
            "SELECT state FROM maintenance_jobs WHERE job_id = $1",
            &[&b],
        )
        .await
        .expect("b state")
        .get("state");
    assert_eq!(state_b, "failed", "exhausted job must fail on expiry sweep");

    cleanup(&db, owner, doc).await;
}

#[tokio::test]
async fn full_job_execution_produces_finalized_snapshot() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture_document(&db).await;
    purge_jobs(&db).await;
    let repo = GatewayRepo::new(db.clone());
    let jobs = JobRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);
    let lease = Duration::from_secs(60);

    // Ingest real ops; enqueue a job pinned to the durable boundary.
    let payloads = ops(9);
    let envelopes = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect::<Vec<_>>();
    let boundary = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;

    let job_id = jobs
        .enqueue_unique("snapshot_build", Some(doc), Some(boundary), 3)
        .await
        .expect("enqueue");
    let (job, version) = jobs
        .claim_next(&["snapshot_build"], 1, lease)
        .await
        .expect("claim")
        .expect("job");
    assert_eq!(job.job_id, job_id);

    // Execute through the full pipeline (build → verify → finalize
    // with the claim fence).
    execute_snapshot_job(&job, version, &pipeline)
        .await
        .expect("execute");

    // The snapshot is FINALIZED and owned by the job.
    let latest = snapshots
        .latest_finalized(doc)
        .await
        .expect("latest")
        .expect("finalized exists");
    assert_eq!(latest.coverage_seq, boundary);
    assert_eq!(latest.job_id, Some(job_id));

    // Complete under the fence.
    assert!(jobs.complete(job_id, version).await.expect("complete"));
    let client = db.get().await.expect("pool");
    let state: String = client
        .query_one(
            "SELECT state FROM maintenance_jobs WHERE job_id = $1",
            &[&job_id],
        )
        .await
        .expect("state")
        .get("state");
    assert_eq!(state, "completed");

    cleanup(&db, owner, doc).await;
}

#[test]
fn trigger_policy_decisions_are_bounded_and_documented() {
    let policy = SnapshotTriggerPolicy::default();
    let now = Duration::ZERO;

    // Ops threshold met ⇒ snapshot.
    assert!(policy.should_snapshot(&TriggerInputs {
        ops_since_last_snapshot: 5_000,
        bytes_since_last_snapshot: 0,
        last_snapshot_age: Some(Duration::from_secs(120)),
        last_document_edit_age: now,
    }));
    // Bytes threshold met (heavy ops) ⇒ snapshot.
    assert!(policy.should_snapshot(&TriggerInputs {
        ops_since_last_snapshot: 10,
        bytes_since_last_snapshot: 2 * 1024 * 1024,
        last_snapshot_age: Some(Duration::from_secs(120)),
        last_document_edit_age: now,
    }));
    // Below both thresholds ⇒ no.
    assert!(!policy.should_snapshot(&TriggerInputs {
        ops_since_last_snapshot: 4_999,
        bytes_since_last_snapshot: 2 * 1024 * 1024 - 1,
        last_snapshot_age: Some(Duration::from_secs(120)),
        last_document_edit_age: now,
    }));
    // Cooldown: fresh snapshot suppresses even above threshold.
    assert!(!policy.should_snapshot(&TriggerInputs {
        ops_since_last_snapshot: 50_000,
        bytes_since_last_snapshot: 100 * 1024 * 1024,
        last_snapshot_age: Some(Duration::from_secs(10)),
        last_document_edit_age: now,
    }));
    // Idle document: no new recovery acceleration needed.
    assert!(!policy.should_snapshot(&TriggerInputs {
        ops_since_last_snapshot: 50_000,
        bytes_since_last_snapshot: 0,
        last_snapshot_age: Some(Duration::from_secs(600)),
        last_document_edit_age: Duration::from_secs(7200),
    }));
    // First-ever snapshot (no age) triggers on thresholds.
    assert!(policy.should_snapshot(&TriggerInputs {
        ops_since_last_snapshot: 5_000,
        bytes_since_last_snapshot: 0,
        last_snapshot_age: None,
        last_document_edit_age: now,
    }));
}

#[tokio::test]
async fn bounded_runner_executes_queue_and_stops_cleanly() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture_document(&db).await;
    purge_jobs(&db).await;
    let repo = GatewayRepo::new(db.clone());
    let jobs = JobRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = Arc::new(SnapshotPipeline::new(
        repo.clone(),
        snapshots.clone(),
        workers,
    ));
    let limits = MaintenanceLimits {
        max_parallel_workers: 2,
        max_inflight_jobs: 8,
        lease: Duration::from_secs(60),
        poll_interval: Duration::from_millis(10),
    };
    let scheduler = Arc::new(Scheduler::new(jobs.clone(), pipeline, limits.clone(), 1));

    // Ingest ops at two boundaries; enqueue jobs for both.
    let payloads = ops(6);
    let envelopes = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect::<Vec<_>>();
    let b1 = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;
    let payloads2 = ops_at(4, 500); // distinct counters → distinct identities
    let envelopes2 = payloads2
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect::<Vec<_>>();
    let b2 = repo
        .ingest_batch(owner, doc, &envelopes2)
        .await
        .expect("ingest2")
        .durable_cursor;
    assert!(b2 > b1);

    jobs.enqueue_unique("snapshot_build", Some(doc), Some(b1), 2)
        .await
        .expect("j1");
    jobs.enqueue_unique("snapshot_build", Some(doc), Some(b2), 2)
        .await
        .expect("j2");

    let (tx, rx) = tokio::sync::watch::channel(true);
    let runner = BoundedRunner::new(scheduler, &limits, rx.clone());
    let executed = runner.run_bounded(Some(4)).await;
    assert!(
        executed >= 2,
        "both jobs must execute (executed {executed})"
    );

    // Both jobs completed; two snapshots finalized (boundaries b1, b2).
    let client = db.get().await.expect("pool");
    let n: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM maintenance_jobs
             WHERE document_id = $1 AND state = 'completed'",
            &[&doc],
        )
        .await
        .expect("completed count")
        .get("n");
    assert_eq!(n, 2);
    let sn: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_snapshots
             WHERE document_id = $1 AND status = 'finalized'",
            &[&doc],
        )
        .await
        .expect("snapshot count")
        .get("n");
    assert_eq!(sn, 2);

    // Graceful stop: flag clears; a fresh runner with 0-iteration cap
    // does nothing.
    tx.send(false).expect("stop");
    let runner2 = BoundedRunner::new(
        Arc::new(Scheduler::new(
            jobs.clone(),
            Arc::new(SnapshotPipeline::new(
                GatewayRepo::new(db.clone()),
                SnapshotRepo::new(db.clone()),
                live_worker_pool().unwrap(),
            )),
            limits.clone(),
            1,
        )),
        &limits,
        rx.clone(),
    );
    let none = runner2.run_bounded(Some(0)).await;
    assert_eq!(none, 0);

    cleanup(&db, owner, doc).await;
}

/// P5-M045 liveness (SEC5 audit V9): a job that expires, is re-claimed,
/// then expires again WITHOUT an intervening fail() must stay
/// requeueable. Before the fix, requeue_expired's DISTINCT guard plus a
/// sticky last_failure_class='lease_expired' stranded the second expiry
/// running forever. The fix clears the class AT CLAIM, so each claim
/// cycle starts clean and every expiry is sweepable.
#[tokio::test]
async fn reexpired_job_is_requeueable_after_reclaim() {
    let Some(db) = test_db().await else { return };
    let (owner, doc) = fixture_document(&db).await;
    purge_jobs(&db).await;
    let jobs = JobRepo::new(db.clone());
    let lease = Duration::from_secs(60);

    let job_id = jobs
        .enqueue_unique("verify", Some(doc), Some(21), 5)
        .await
        .expect("enqueue");

    // Claim #1 (v1, attempts 1, class cleared by the claim UPDATE).
    let (j1, v1) = jobs
        .claim_next(&["verify"], 1, lease)
        .await
        .expect("claim 1")
        .expect("job");
    assert_eq!(j1.job_id, job_id);
    assert_eq!(v1, 1);
    assert_eq!(
        j1.last_failure_class, None,
        "claim must clear last_failure_class"
    );

    // Expire #1 without any fail() → sweep (via claim_next) requeues it.
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE maintenance_jobs SET lease_expires_at = now() - interval '1 second'
                 WHERE job_id = $1",
                &[&job_id],
            )
            .await
            .expect("expire 1");
    }
    let (j2, v2) = jobs
        .claim_next(&["verify"], 2, lease)
        .await
        .expect("re-claim after first expiry")
        .expect("requeued");
    assert_eq!(j2.job_id, job_id);
    assert_eq!(v2, v1 + 1);
    assert_eq!(
        j2.last_failure_class, None,
        "re-claim also clears the class"
    );

    // Expire #2 WITHOUT any intervening fail() — the exact scenario that
    // used to strand the job. Force the expiry by SQL, then sweep with a
    // plain requeue_expired call (no claim interference): the job must
    // go back to pending, not stay stranded running.
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "UPDATE maintenance_jobs SET lease_expires_at = now() - interval '1 second'
                 WHERE job_id = $1",
                &[&job_id],
            )
            .await
            .expect("expire 2");
    }
    let swept = jobs
        .requeue_expired(lease)
        .await
        .expect("second sweep must run");
    assert!(
        swept >= 1,
        "re-expired job must be requeueable (swept {swept})"
    );
    let client = db.get().await.expect("pool");
    let state: String = client
        .query_one(
            "SELECT state FROM maintenance_jobs WHERE job_id = $1",
            &[&job_id],
        )
        .await
        .expect("state")
        .get("state");
    assert_eq!(state, "pending", "not stranded: pending again");

    // Terminal cleanup: claim (v3) and fail via the repo.
    let (j3, v3) = jobs
        .claim_next(&["verify"], 3, lease)
        .await
        .expect("claim 3")
        .expect("job");
    assert_eq!(j3.job_id, job_id);
    assert!(jobs
        .fail(&j3, v3, FailureClass::Terminal)
        .await
        .expect("terminal fail"));
    let state_end: String = client
        .query_one(
            "SELECT state FROM maintenance_jobs WHERE job_id = $1",
            &[&job_id],
        )
        .await
        .expect("final state")
        .get("state");
    assert_eq!(state_end, "failed");

    cleanup(&db, owner, doc).await;
}
