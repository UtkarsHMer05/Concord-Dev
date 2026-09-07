//! Snapshot selection + fallback and the differential recovery
//! verifier (P5-M019..M021).
//!
//! Selection walks FINALIZED snapshots newest→oldest, validating each
//! candidate (M013 matrix). First failure ⇒ next candidate; none usable
//! ⇒ full replay (docs/RECOVERY.md §5). Recovery NEVER reads
//! building/verifying/failed rows — the queries only emit `finalized`.
//!
//! The differential verifier (M021) reconstructs the same document two
//! ways — full replay vs snapshot+tail — and compares canonical
//! digests. It backs the compaction gate (M032), CI, and the benchmark
//! correctness checks, emitting seed/boundary/op-count diagnostics on
//! mismatch.

use uuid::Uuid;

use crate::db::repo::GatewayRepo;
use crate::db::snapshots::{SnapshotRepo, ValidatedSnapshot};
use crate::worker::WorkerPool;

/// How the current state of a document was reconstructed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoverySource {
    /// Full replay over the durable log (no usable snapshot).
    FullReplay,
    /// Snapshot import at `boundary` + tail replay after it.
    SnapshotPlusTail {
        snapshot_id: Uuid,
        boundary: i64,
        tail_ops: usize,
    },
}

/// Outcome of selecting a recovery source for a document.
#[derive(Debug, Clone)]
pub enum SelectedRecovery {
    /// A validated snapshot to import; the tail replays after it.
    WithSnapshot(ValidatedSnapshot),
    /// No usable snapshot — recover by full replay.
    FullReplay,
}

/// Chosen by [`RecoverySelector::select_latest_valid`] when a candidate
/// fails validation (recorded for observability; selection continues).
#[derive(Debug, Clone)]
pub struct RecoverySelector {
    pub repo: GatewayRepo,
    pub snapshots: SnapshotRepo,
    pub workers: WorkerPool,
}

impl RecoverySelector {
    pub fn new(repo: GatewayRepo, snapshots: SnapshotRepo, workers: WorkerPool) -> Self {
        Self {
            repo,
            snapshots,
            workers,
        }
    }

    /// Newest-VALID finalized snapshot, falling back older, then to
    /// full replay. Every candidate passes the full M013 integrity
    /// matrix before being returned (M019).
    pub async fn select_latest_valid(&self, document: Uuid) -> SelectedRecovery {
        // Finalized rows only, newest coverage first (list_historical is
        // coverage DESC; the status filter is applied here so the query
        // surface stays as shipped in M012).
        let rows = match self.snapshots.list_historical(document, 8).await {
            Ok(rows) => rows
                .into_iter()
                .filter(|r| r.status == crate::db::snapshots::status::FINALIZED)
                .collect::<Vec<_>>(),
            Err(e) => {
                tracing::warn!(document_id = %document, error = %e, "snapshot listing failed; full replay");
                return SelectedRecovery::FullReplay;
            }
        };
        for row in rows {
            match self.snapshots.validate_integrity(&row, document) {
                Ok(v) => return SelectedRecovery::WithSnapshot(v),
                Err(e) => {
                    // Quarantine signal: a finalized row failed
                    // integrity. Continue with older candidates; the
                    // corruption is logged for retention/repair paths.
                    tracing::warn!(
                        snapshot_id = %row.snapshot_id,
                        document_id = %document,
                        error = %e,
                        "finalized snapshot failed integrity; falling back"
                    );
                }
            }
        }
        SelectedRecovery::FullReplay
    }

    /// All op payloads strictly after `boundary` (paged, bounded).
    async fn tail_after(&self, document: Uuid, boundary: i64) -> Result<Vec<Vec<u8>>, String> {
        let mut out = Vec::new();
        let mut cursor = boundary;
        loop {
            let page = self
                .repo
                .catchup_page(document, cursor, crate::protocol::MAX_SYNC_PAGE_OPS as i64)
                .await
                .map_err(|e| format!("catchup page: {e}"))?;
            if page.ops.is_empty() {
                break;
            }
            out.extend(page.ops.into_iter().map(|(_, _, p)| p));
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        Ok(out)
    }

    /// Recovers the document's current state: snapshot+tail when a
    /// valid snapshot exists, else full replay. Returns the final
    /// digest and the source used (M019/M020 recovery path).
    pub async fn recover_current(
        &self,
        document: Uuid,
    ) -> Result<(String, RecoverySource), String> {
        match self.select_latest_valid(document).await {
            SelectedRecovery::WithSnapshot(v) => {
                let tail = self.tail_after(document, v.coverage_seq).await?;
                let n = tail.len();
                let result = self
                    .workers
                    .digest_after(&v.inner, &tail)
                    .await
                    .map_err(|e| format!("snapshot+tail replay: {e}"))?;
                Ok((
                    result.digest,
                    RecoverySource::SnapshotPlusTail {
                        snapshot_id: v.snapshot_id,
                        boundary: v.coverage_seq,
                        tail_ops: n,
                    },
                ))
            }
            SelectedRecovery::FullReplay => {
                let ops = self.tail_after(document, 0).await?;
                let result = self
                    .workers
                    .reconstruct(&ops)
                    .await
                    .map_err(|e| format!("full replay: {e}"))?;
                Ok((result.digest, RecoverySource::FullReplay))
            }
        }
    }
}

/// Differential recovery verifier (M021): proves
/// full-replay digest == snapshot+tail digest for one document.
///
/// On mismatch, the error carries seed-reproducible diagnostics
/// (document, snapshot, boundary, op counts on both sides).
#[derive(Debug, thiserror::Error)]
pub enum VerificationError {
    #[error("differential mismatch for document {document}: full={full_digest} snapshot+tail={recovered_digest} (snapshot {snapshot_id} @ boundary {boundary}, covered {covered} ops, tail {tail} ops)")]
    Mismatch {
        document: Uuid,
        snapshot_id: Uuid,
        boundary: i64,
        covered: i64,
        tail: usize,
        full_digest: String,
        recovered_digest: String,
    },
    #[error("no valid snapshot to verify (document {document})")]
    NoSnapshot { document: Uuid },
    #[error(transparent)]
    Worker(#[from] crate::worker::WorkerError),
    #[error("db: {0}")]
    Db(String),
}

impl RecoverySelector {
    /// Runs the differential equivalence check for a document:
    /// reconstructs via full replay AND via latest-valid snapshot+tail,
    /// requiring identical digests. Callable from CI and the compaction
    /// gate (M032) — one command, reproducible (M021).
    pub async fn verify_equivalence(&self, document: Uuid) -> Result<(), VerificationError> {
        let SelectedRecovery::WithSnapshot(v) = self.select_latest_valid(document).await else {
            return Err(VerificationError::NoSnapshot { document });
        };
        let tail = self
            .tail_after(document, v.coverage_seq)
            .await
            .map_err(VerificationError::Db)?;
        let recovered = self.workers.digest_after(&v.inner, &tail).await?;

        let full_ops = self
            .tail_after(document, 0)
            .await
            .map_err(VerificationError::Db)?;
        let full = self.workers.reconstruct(&full_ops).await?;

        if recovered.digest != full.digest {
            return Err(VerificationError::Mismatch {
                document,
                snapshot_id: v.snapshot_id,
                boundary: v.coverage_seq,
                covered: v.covered_op_count,
                tail: tail.len(),
                full_digest: full.digest,
                recovered_digest: recovered.digest,
            });
        }
        Ok(())
    }
}
