//! Snapshot build/verify/finalize pipeline (P5-M016..M018).
//!
//! The staged lifecycle from docs/STORAGE.md §3.2 and DEC-036:
//!
//!   1. BUILD — fix an immutable boundary `S` (the durable high-water at
//!      selection time), page `ops ≤ S` out of PostgreSQL, and hand them
//!      to the native worker (`CMD_RECONSTRUCT`), which folds them into
//!      the CRDT and returns the canonical digest + inner v1 snapshot.
//!      Persist as a `building` attempt.
//!   2. VERIFY — independent semantic verification: re-import the inner
//!      snapshot in a FRESH worker instance (`CMD_IMPORT_VERIFY`) and
//!      confirm the digest; then re-reconstruct the SAME boundary from
//!      the operation log a second time and compare digests (a real
//!      oracle: two independent folds of the same op set must agree).
//!      Transition building → verifying happens before this; on success
//!      the row is eligible for finalization.
//!   3. FINALIZE — the guarded compare-and-set transaction
//!      (`WHERE status='verifying'`); after it, payload/boundary/checksum/
//!      digest are immutable and recovery may select the row.
//!
//! Failure semantics: any worker/DB error marks the attempt failed
//! (bounded retries are the job scheduler's decision, M023/M024) and
//! NEVER advances the durable high-water or touches the op log. Ops
//! arriving after `S` stay in the tail by construction (`ops_between`
//! is bounded by `id <= S`), proven by tests.

use uuid::Uuid;

use crate::db::repo::GatewayRepo;
use crate::db::snapshots::{status, SnapshotRepo, SnapshotRepoError, ValidatedSnapshot};
use crate::telemetry::Metrics;
use crate::worker::{WorkerError, WorkerOk, WorkerPool};

/// Page size for op fetches during a build (matches MAX_SYNC_PAGE_OPS).
const BUILD_PAGE: i64 = crate::protocol::MAX_SYNC_PAGE_OPS as i64;

#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    #[error(transparent)]
    Repo(#[from] crate::db::repo::RepoError),
    #[error(transparent)]
    Snapshot(#[from] SnapshotRepoError),
    #[error(transparent)]
    Worker(#[from] WorkerError),
    /// The worker's snapshot import disagreed with its export digest —
    /// a core-format break; the attempt fails and never finalizes.
    #[error("snapshot import digest mismatch: exported {exported}, imported {imported}")]
    ImportDigestMismatch { exported: String, imported: String },
    /// Two independent reconstructions of the same boundary disagreed.
    #[error("differential reconstruction mismatch at boundary {boundary}")]
    DifferentialMismatch { boundary: i64 },
    /// The row's recorded digest disagrees with the worker's digest —
    /// metadata corruption; fail closed.
    #[error("stored digest mismatch: stored {stored}, worker {computed}")]
    StoredDigestMismatch { stored: String, computed: String },
}

impl PipelineError {
    /// Worker timeouts/IO are retryable; everything else reflects input
    /// or build artifacts and is terminal for the attempt (the scheduler
    /// may still retry the JOB with a fresh attempt row).
    pub fn is_retryable(&self) -> bool {
        match self {
            PipelineError::Worker(w) => w.is_retryable(),
            PipelineError::Repo(crate::db::repo::RepoError::Db(_))
            | PipelineError::Repo(crate::db::repo::RepoError::Pg(_)) => true,
            PipelineError::Snapshot(SnapshotRepoError::Db(_))
            | PipelineError::Snapshot(SnapshotRepoError::Pg(_)) => true,
            _ => false,
        }
    }
}

/// Orchestrates the build → verify → finalize lifecycle for one document
/// boundary. Stateless per call; the job scheduler (M023/M024) owns
/// retries, leases, and concurrency bounds.
#[derive(Debug, Clone)]
pub struct SnapshotPipeline {
    pub repo: GatewayRepo,
    pub snapshots: SnapshotRepo,
    pub workers: WorkerPool,
}

impl SnapshotPipeline {
    pub fn new(repo: GatewayRepo, snapshots: SnapshotRepo, workers: WorkerPool) -> Self {
        Self {
            repo,
            snapshots,
            workers,
        }
    }

    /// Selects the newest validated finalized snapshot at or before the
    /// boundary and loads only its retained tail. A finalized covering
    /// snapshot is required after compaction; replaying the tail from an
    /// empty replica would silently build the wrong state.
    async fn reconstruction_inputs(
        &self,
        document: Uuid,
        boundary: i64,
    ) -> Result<(Option<ValidatedSnapshot>, Vec<Vec<u8>>), PipelineError> {
        let covering = match self
            .snapshots
            .latest_finalized_before(document, boundary)
            .await?
        {
            Some(row) => Some(self.snapshots.validate_integrity(&row, document)?),
            None => None,
        };
        let mut payloads = Vec::new();
        let mut cursor = covering
            .as_ref()
            .map_or(0, |snapshot| snapshot.coverage_seq);
        loop {
            let page = self
                .repo
                .ops_between(document, cursor, boundary, BUILD_PAGE)
                .await?;
            if page.ops.is_empty() {
                break;
            }
            payloads.extend(page.ops.into_iter().map(|(_, _, payload)| payload));
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        Ok((covering, payloads))
    }

    /// BUILD: reconstruct state at `boundary` via the native worker and
    /// persist a `building` attempt. Returns the snapshot id + digest.
    /// The attempt carries the FULL wrapper payload (DEC-035).
    pub async fn build_at_boundary(
        &self,
        document: Uuid,
        boundary: i64,
        job_id: Uuid,
        attempt: i32,
    ) -> Result<(Uuid, String, ValidatedSnapshot), PipelineError> {
        let (covering, tail) = self.reconstruction_inputs(document, boundary).await?;
        let WorkerOk { digest, snapshot } = match covering.as_ref() {
            Some(covering) => self.workers.fold_after(&covering.inner, &tail).await?,
            None => self.workers.reconstruct(&tail).await?,
        };
        let inner = snapshot.ok_or_else(|| {
            PipelineError::Worker(WorkerError::MalformedResponse(
                "reconstruct/fold response omitted the snapshot bytes".into(),
            ))
        })?;

        let covered = covering
            .as_ref()
            .map_or(0, |snapshot| snapshot.covered_op_count)
            .saturating_add(tail.len() as i64);
        let wrapper = crate::db::snapshots::wrapper::encode_wrapper(
            document,
            boundary as u64,
            covered as u64,
            &inner,
        );
        let attempt_row = self
            .snapshots
            .create_attempt(
                document, boundary, covered, job_id, attempt, &digest, "{}", &wrapper,
            )
            .await?;

        // Sanity: the just-written row must pass M013 integrity checks.
        let row = self
            .snapshots
            .get_by_snapshot_id(attempt_row.snapshot_id)
            .await?
            .ok_or_else(|| {
                PipelineError::Worker(WorkerError::MalformedResponse(
                    "snapshot row vanished after insert".into(),
                ))
            })?;
        let validated = self
            .snapshots
            .validate_integrity(&row, document)
            .map_err(PipelineError::Snapshot)?;
        if validated.state_digest != digest {
            return Err(PipelineError::StoredDigestMismatch {
                stored: validated.state_digest,
                computed: digest,
            });
        }
        Ok((attempt_row.snapshot_id, digest, validated))
    }

    /// VERIFY: independent semantic verification (M017). Requires the
    /// attempt in `verifying` state; on success returns the validated
    /// row ready for finalization.
    ///
    /// Oracles:
    ///  (a) import the inner snapshot into a fresh replica ⇒ same digest
    ///      (import path is a different code path than export);
    ///  (b) re-fold the SAME boundary ops from the log a second time ⇒
    ///      same digest (two independent folds agree).
    pub async fn verify(
        &self,
        document: Uuid,
        snapshot_id: Uuid,
    ) -> Result<ValidatedSnapshot, PipelineError> {
        let row = self
            .snapshots
            .get_by_snapshot_id(snapshot_id)
            .await?
            .ok_or_else(|| {
                PipelineError::Worker(WorkerError::MalformedResponse(
                    "snapshot row missing for verify".into(),
                ))
            })?;
        if row.status != status::VERIFYING {
            // Wrong state: nothing to verify; callers must transition
            // building→verifying first. Fail closed with a wrapper error
            // that cannot be confused with byte corruption.
            return Err(PipelineError::Snapshot(SnapshotRepoError::Integrity(
                crate::db::snapshots::SnapshotIntegrityError::MalformedWrapper {
                    reason: format!("verify called on status={}", row.status),
                },
            )));
        }
        let validated = self
            .snapshots
            .validate_integrity(&row, document)
            .map_err(PipelineError::Snapshot)?;

        // (a) fresh-instance import oracle.
        let imported = self.workers.import_digest(&validated.inner).await?;
        if imported.digest != validated.state_digest {
            return Err(PipelineError::ImportDigestMismatch {
                exported: validated.state_digest.clone(),
                imported: imported.digest,
            });
        }

        // (b) differential re-fold oracle: independent second
        // reconstruction of the same boundary from the durable log.
        let (covering, tail) = self
            .reconstruction_inputs(document, validated.coverage_seq)
            .await?;
        let refold = match covering.as_ref() {
            Some(snapshot) => self.workers.digest_after(&snapshot.inner, &tail).await?,
            None => self.workers.reconstruct(&tail).await?,
        };
        if refold.digest != validated.state_digest {
            return Err(PipelineError::DifferentialMismatch {
                boundary: validated.coverage_seq,
            });
        }

        Ok(validated)
    }

    /// FINALIZE: guarded immutable transition verifying → finalized
    /// (M018). `job_claim` optionally fences the caller (the lease
    /// owner's claim_version at verify time; finalization re-checks it
    /// transactionally in M024 integration).
    pub async fn finalize(
        &self,
        snapshot_id: Uuid,
        expected_claim_version: Option<i64>,
    ) -> Result<bool, PipelineError> {
        let ok = self
            .snapshots
            .finalize(snapshot_id, expected_claim_version)
            .await?;
        if ok {
            Metrics::global()
                .snapshots_finalized_total
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(ok)
    }

    /// Marks an attempt failed (any pipeline stage). Bounded retry is a
    /// scheduler decision; the pipeline only records outcome.
    pub async fn fail_attempt(&self, snapshot_id: Uuid, reason: &str) {
        Metrics::global()
            .snapshots_failed_total
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = self.snapshots.fail(snapshot_id, reason).await;
    }
}
