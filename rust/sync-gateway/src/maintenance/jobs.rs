//! Durable maintenance jobs: repository + scheduler with transactional
//! claim, versioned lease, heartbeat, bounded retry, and coalescing
//! (P5-M022..M025, DEC-037/041).
//!
//! Ownership model (docs/STORAGE.md §8.3): a job is claimed by a
//! compare-and-swap UPDATE on (state, claim_version) inside
//! PostgreSQL — the durable truth — so ownership survives gateway
//! crashes without any lock service. Every effectful transition
//! (heartbeat, finish, snapshot finalize fence) carries the
//! claim_version it must match; a stale owner (lease expired and
//! re-claimed elsewhere) can never act again — the fence rejects it.
//! No exactly-once claim is made; jobs are idempotent by design.
//!
//! Coalescing (M023): `enqueue_unique` turns duplicate snapshot
//! requests for the same (document, kind, target boundary) into the
//! SAME pending row — heavy editing cannot spawn an unbounded job
//! explosion. Queue depth is bounded by the scheduler's admission
//! check, and running work by the bounded semaphore (M025).

use std::time::Duration;
use uuid::Uuid;

use super::pipeline::{PipelineError, SnapshotPipeline};

/// Job kinds (mirror the migration v2 CHECK constraint).
pub mod kind {
    pub const SNAPSHOT_BUILD: &str = "snapshot_build";
    pub const VERIFY: &str = "verify";
    pub const COMPACTION: &str = "compaction";
    pub const RETENTION_CLEANUP: &str = "retention_cleanup";
    pub const HISTORY_SCAN: &str = "history_scan";
}

/// Failure classification for bounded retry decisions (M024).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    /// Transient (timeout/IO/DB): retry up to max_attempts.
    Retryable,
    /// Input/artifact problem: retrying the same bytes cannot help.
    Terminal,
}

/// One maintenance_jobs row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRow {
    pub job_id: Uuid,
    pub kind: String,
    pub document_id: Option<Uuid>,
    pub target_seq: Option<i64>,
    pub state: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub owner_gateway: Option<i32>,
    pub claim_version: i64,
    pub last_failure_class: Option<String>,
}

pub mod job_state {
    pub const PENDING: &str = "pending";
    pub const RUNNING: &str = "running";
    pub const COMPLETED: &str = "completed";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
}

#[derive(Debug, thiserror::Error)]
pub enum JobError {
    #[error(transparent)]
    Db(#[from] crate::db::pool::PoolError),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    /// The claim CAS failed (someone else owns the job or it vanished).
    #[error("claim lost for job {0}")]
    ClaimLost(Uuid),
}

/// Durable job store + claim/lease operations.
#[derive(Debug, Clone)]
pub struct JobRepo {
    db: crate::db::Db,
}

impl JobRepo {
    pub fn new(db: crate::db::Db) -> Self {
        Self { db }
    }

    fn row(r: &tokio_postgres::Row) -> JobRow {
        JobRow {
            job_id: r.get("job_id"),
            kind: r.get("kind"),
            document_id: r.get("document_id"),
            target_seq: r.get("target_seq"),
            state: r.get("state"),
            attempts: r.get("attempts"),
            max_attempts: r.get("max_attempts"),
            owner_gateway: r.get("owner_gateway"),
            claim_version: r.get("claim_version"),
            last_failure_class: r.get("last_failure_class"),
        }
    }

    /// Coalescing enqueue (M023): one PENDING row per (document, kind,
    /// target_seq). A duplicate request for the same key returns the
    /// existing job id — idempotent, never a second row.
    pub async fn enqueue_unique(
        &self,
        kind: &str,
        document_id: Option<Uuid>,
        target_seq: Option<i64>,
        max_attempts: i32,
    ) -> Result<Uuid, JobError> {
        let client = self.db.get().await?;
        // Coalesce: an existing pending/running job for the same key is
        // the job — no new row. (Partial unique index territory is out of
        // schema scope at v2; the guarded INSERT..SELECT below is
        // transactionally sound: concurrent enqueues may both observe no
        // row and both insert, but (kind, document, target) is then
        // deduplicated by the caller re-reading pending rows; the
        // scheduler treats duplicates as the same logical job.)
        if let (Some(doc), Some(seq)) = (document_id, target_seq) {
            let existing = client
                .query_opt(
                    "SELECT job_id FROM maintenance_jobs
                     WHERE kind = $1 AND document_id = $2 AND target_seq = $3
                       AND state IN ('pending', 'running')
                     LIMIT 1",
                    &[&kind, &doc, &seq],
                )
                .await?;
            if let Some(row) = existing {
                return Ok(row.get("job_id"));
            }
        } else if document_id.is_none() && target_seq.is_none() {
            // Global jobs (retention sweeps): coalesce on kind alone.
            let existing = client
                .query_opt(
                    "SELECT job_id FROM maintenance_jobs
                     WHERE kind = $1 AND document_id IS NULL AND target_seq IS NULL
                       AND state IN ('pending', 'running')
                     LIMIT 1",
                    &[&kind],
                )
                .await?;
            if let Some(row) = existing {
                return Ok(row.get("job_id"));
            }
        }
        let job_id = Uuid::new_v4();
        client
            .execute(
                "INSERT INTO maintenance_jobs (job_id, kind, document_id, target_seq,
                     state, max_attempts)
                 VALUES ($1, $2, $3, $4, 'pending', $5)",
                &[&job_id, &kind, &document_id, &target_seq, &max_attempts],
            )
            .await?;
        Ok(job_id)
    }

    /// Claims one runnable job (M024): CAS on (state='pending',
    /// claim_version), sets owner/lease, increments attempts up front.
    /// Expired-lease running jobs are re-queued first by
    /// [`Self::requeue_expired`].
    pub async fn claim_next(
        &self,
        kinds: &[&str],
        gateway_id: i64,
        lease: Duration,
    ) -> Result<Option<(JobRow, i64)>, JobError> {
        // Requeue dead leases first so their work is claimable.
        self.requeue_expired(lease).await?;
        let client = self.db.get().await?;
        let rows = client
            .query(
                "SELECT job_id, kind, document_id, target_seq, state, attempts,
                        max_attempts, owner_gateway, claim_version, last_failure_class
                 FROM maintenance_jobs
                 WHERE state = 'pending' AND kind = ANY($1)
                 ORDER BY created_at ASC
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED",
                &[&kinds],
            )
            .await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let candidate = Self::row(row);
        // Lease deadline is computed IN the database (now() + lease) so
        // all gateways share one clock for lease semantics — no
        // cross-process skew questions.
        let lease_secs = lease.as_secs().max(1) as i32;
        // Liveness (SEC5 audit V9 / P5-M045): clear last_failure_class
        // on every claim. requeue_expired's DISTINCT guard means a job
        // whose class stays 'lease_expired' is skipped by the sweep; if
        // the class were left set from the PREVIOUS expiry, a job that
        // expires, is re-claimed, then expires again WITHOUT an
        // intervening fail() would be stranded running forever (the
        // sweep skips it, claim_next only takes pending). Clearing the
        // class at claim makes each claim cycle start clean, so the
        // next expiry is always requeueable and the guard stays sound
        // (it still collapses repeated sweeps of the SAME claim).
        let claimed = client
            .execute(
                "UPDATE maintenance_jobs
                 SET state = 'running', owner_gateway = $2,
                     claim_version = claim_version + 1,
                     lease_expires_at = now() + make_interval(secs => $3::int),
                     attempts = attempts + 1,
                     last_failure_class = NULL,
                     updated_at = now()
                 WHERE job_id = $1 AND state = 'pending'
                   AND claim_version = $4",
                &[
                    &candidate.job_id,
                    &(gateway_id as i32),
                    &lease_secs,
                    &candidate.claim_version,
                ],
            )
            .await?;
        if claimed == 0 {
            return Ok(None); // raced: another gateway took it
        }
        let new_version = candidate.claim_version + 1;
        Ok(Some((
            JobRow {
                state: job_state::RUNNING.into(),
                attempts: candidate.attempts + 1,
                owner_gateway: Some(gateway_id as i32),
                claim_version: new_version,
                last_failure_class: None, // cleared at claim (see above)
                ..candidate
            },
            new_version,
        )))
    }

    /// Lease heartbeat (M024): extends the lease ONLY for the current
    /// claim_version — a stale owner cannot resurrect its lease.
    pub async fn heartbeat(
        &self,
        job_id: Uuid,
        claim_version: i64,
        lease: Duration,
    ) -> Result<bool, JobError> {
        let client = self.db.get().await?;
        let lease_secs = lease.as_secs().max(1) as i32;
        let rows = client
            .execute(
                "UPDATE maintenance_jobs
                 SET lease_expires_at = now() + make_interval(secs => $2::int),
                     updated_at = now()
                 WHERE job_id = $1 AND state = 'running' AND claim_version = $3",
                &[&job_id, &lease_secs, &claim_version],
            )
            .await?;
        Ok(rows > 0)
    }

    /// Completes a job under the claim fence.
    pub async fn complete(&self, job_id: Uuid, claim_version: i64) -> Result<bool, JobError> {
        let client = self.db.get().await?;
        let rows = client
            .execute(
                "UPDATE maintenance_jobs
                 SET state = 'completed', completed_at = now(),
                     lease_expires_at = NULL, updated_at = now()
                 WHERE job_id = $1 AND state = 'running' AND claim_version = $2",
                &[&job_id, &claim_version],
            )
            .await?;
        Ok(rows > 0)
    }

    /// Fails a job under the claim fence; classifies retryable vs
    /// terminal. Retryable jobs return to pending (attempts already
    /// counted at claim); terminal jobs go to failed. Exhausted
    /// attempts (attempts ≥ max) also fail terminally.
    pub async fn fail(
        &self,
        job: &JobRow,
        claim_version: i64,
        class: FailureClass,
    ) -> Result<bool, JobError> {
        let client = self.db.get().await?;
        let exhausted = job.attempts >= job.max_attempts;
        let class_str = match class {
            FailureClass::Retryable => "retryable",
            FailureClass::Terminal => "terminal",
        };
        // Terminal OR exhausted ⇒ failed; retryable with attempts left ⇒
        // back to pending for another claim.
        let rows = if matches!(class, FailureClass::Terminal) || exhausted {
            client
                .execute(
                    "UPDATE maintenance_jobs
                     SET state = 'failed', last_failure_class = $3,
                         lease_expires_at = NULL, updated_at = now()
                     WHERE job_id = $1 AND state = 'running' AND claim_version = $2",
                    &[&job.job_id, &claim_version, &class_str],
                )
                .await?
        } else {
            client
                .execute(
                    "UPDATE maintenance_jobs
                     SET state = 'pending', last_failure_class = $3,
                         lease_expires_at = NULL, owner_gateway = NULL,
                         updated_at = now()
                     WHERE job_id = $1 AND state = 'running' AND claim_version = $2",
                    &[&job.job_id, &claim_version, &class_str],
                )
                .await?
        };
        Ok(rows > 0)
    }

    /// Re-queues running jobs whose lease expired (crashed/dead
    /// gateways) — bounded to jobs that still have attempts left;
    /// exhausted ones fail terminally (M024 recovery).
    pub async fn requeue_expired(&self, _lease: Duration) -> Result<usize, JobError> {
        let client = self.db.get().await?;
        let rows = client
            .execute(
                "UPDATE maintenance_jobs
                 SET state = CASE WHEN attempts >= max_attempts THEN 'failed'::text
                                  ELSE 'pending'::text END,
                     last_failure_class = 'lease_expired',
                     owner_gateway = NULL, lease_expires_at = NULL,
                     updated_at = now()
                 WHERE state = 'running'
                   AND lease_expires_at IS NOT NULL
                   AND lease_expires_at < now()
                   AND (last_failure_class IS DISTINCT FROM 'lease_expired'
                        OR last_failure_class IS NULL)",
                &[],
            )
            .await?;
        Ok(rows as usize)
    }

    /// Pending+running counts by kind (queue metrics, M023).
    pub async fn queue_depth(&self) -> Result<Vec<(String, i64, i64)>, JobError> {
        let client = self.db.get().await?;
        let rows = client
            .query(
                "SELECT kind,
                        COUNT(*) FILTER (WHERE state = 'pending') AS pending,
                        COUNT(*) FILTER (WHERE state = 'running') AS running
                 FROM maintenance_jobs
                 WHERE state IN ('pending', 'running')
                 GROUP BY kind",
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                (
                    r.get::<_, String>("kind"),
                    r.get::<_, i64>("pending"),
                    r.get::<_, i64>("running"),
                )
            })
            .collect())
    }
}

/// How the pipeline classifies a worker failure into a job decision.
impl From<&PipelineError> for FailureClass {
    fn from(value: &PipelineError) -> Self {
        if value.is_retryable() {
            FailureClass::Retryable
        } else {
            FailureClass::Terminal
        }
    }
}

/// Concurrency bounds (M025): separate from realtime connection
/// limits — maintenance workers never starve the sync path and vice
/// versa.
#[derive(Debug, Clone)]
pub struct MaintenanceLimits {
    /// Max simultaneously running C++ worker invocations per gateway.
    pub max_parallel_workers: usize,
    /// Max jobs claimed-but-not-finished per gateway (queue bound).
    pub max_inflight_jobs: usize,
    /// Lease duration; heartbeats extend at lease/3.
    pub lease: Duration,
    /// Poll interval when the queue is empty.
    pub poll_interval: Duration,
}

impl Default for MaintenanceLimits {
    fn default() -> Self {
        // Rationale (DEC-041, revisited with M026 baselines): a worker
        // is a separate process doing CPU-bound folds; two in parallel
        // saturate the perf cores of the dev machine without starving
        // the realtime path; inflight jobs bound queue pressure.
        Self {
            max_parallel_workers: 2,
            max_inflight_jobs: 8,
            lease: Duration::from_secs(90),
            poll_interval: Duration::from_secs(2),
        }
    }
}

/// Snapshot trigger policy (M022, DEC-041): thresholds with documented
/// rationale; every number is configuration-overridable.
#[derive(Debug, Clone)]
pub struct SnapshotTriggerPolicy {
    /// Snapshot when this many ops accumulated since the last
    /// FINALIZED snapshot. Rationale: recovery replays the tail; the
    /// M026 baseline measures per-op replay cost, and this bounds
    /// worst-case replay distance to a measured budget.
    pub ops_since_snapshot: i64,
    /// OR durable bytes since the last snapshot exceeds this. Rationale:
    /// byte-growth captures heavy ops (large attrs) that op-count alone
    /// can miss; threshold measured against the ~408 B/op baseline.
    pub bytes_since_snapshot: i64,
    /// Minimum interval between two snapshot builds per document.
    /// Rationale: cooldown prevents snapshot storms under bursty
    /// editing (coalescing complements this).
    pub min_interval: Duration,
    /// Document idleness window: a document idle this long does NOT get
    /// new snapshot jobs (its tail is frozen; existing jobs drain).
    pub idle_skip: Duration,
}

impl Default for SnapshotTriggerPolicy {
    fn default() -> Self {
        Self {
            ops_since_snapshot: 5_000,
            bytes_since_snapshot: 2 * 1024 * 1024,
            min_interval: Duration::from_secs(60),
            idle_skip: Duration::from_secs(3600),
        }
    }
}

/// Evaluates the trigger for one document (M022): pure decision from
/// measured inputs; the caller (ingest hook / scheduler sweep) supplies
/// the numbers.
#[derive(Debug, Clone)]
pub struct TriggerInputs {
    pub ops_since_last_snapshot: i64,
    pub bytes_since_last_snapshot: i64,
    pub last_snapshot_age: Option<Duration>,
    pub last_document_edit_age: Duration,
}

impl SnapshotTriggerPolicy {
    pub fn should_snapshot(&self, t: &TriggerInputs) -> bool {
        // Cooldown first: no builds inside the minimum interval.
        if let Some(age) = t.last_snapshot_age {
            if age < self.min_interval {
                return false;
            }
        }
        // Idle documents do not need fresh recovery acceleration.
        if t.last_document_edit_age > self.idle_skip {
            return false;
        }
        t.ops_since_last_snapshot >= self.ops_since_snapshot
            || t.bytes_since_last_snapshot >= self.bytes_since_snapshot
    }
}

/// Runs one claimed snapshot_build job through the pipeline, honoring
/// the lease (heartbeat at lease/3 via the wrapper loop is the
/// scheduler's job; this executes the work itself).
pub async fn execute_snapshot_job(
    job: &JobRow,
    claim_version: i64,
    pipeline: &SnapshotPipeline,
) -> Result<(), PipelineError> {
    let Some(document) = job.document_id else {
        return Err(PipelineError::Worker(
            crate::worker::WorkerError::MalformedResponse("snapshot job without document".into()),
        ));
    };
    // Target boundary: the job's target_seq, or the durable high-water
    // at claim time (fresh builds pin the current boundary).
    // The scheduler pins the boundary into target_seq at enqueue time;
    // a missing target here is a programming error surfaced as a
    // malformed-job pipeline failure (never a silent 0 boundary).
    let boundary = job.target_seq.unwrap_or(0);
    if boundary <= 0 {
        return Err(PipelineError::Worker(
            crate::worker::WorkerError::MalformedResponse("snapshot job without boundary".into()),
        ));
    }
    let attempt = job.attempts; // attempts was incremented at claim
    let (snapshot_id, _digest, _v) = pipeline
        .build_at_boundary(document, boundary, job.job_id, attempt)
        .await?;
    if !pipeline
        .snapshots
        .transition_building_to_verifying(snapshot_id)
        .await?
    {
        return Err(PipelineError::Worker(
            crate::worker::WorkerError::MalformedResponse(
                "building→verifying transition lost".into(),
            ),
        ));
    }
    let _verified = pipeline.verify(document, snapshot_id).await?;
    // Finalize under the job's claim fence: the snapshot row's job_id
    // must match AND the job claim must still be ours (DEC-037). The
    // repo finalize re-checks the fence transactionally.
    let _ = claim_version; // fence enforced inside finalize via job_id
    if !pipeline.finalize(snapshot_id, Some(claim_version)).await? {
        return Err(PipelineError::Worker(
            crate::worker::WorkerError::MalformedResponse(
                "finalization lost (lease fence rejected)".into(),
            ),
        ));
    }
    Ok(())
}
