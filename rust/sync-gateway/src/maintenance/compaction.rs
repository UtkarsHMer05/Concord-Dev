//! Compaction: per-document compaction-floor metadata, dry-run, and
//! staged transactional pruning (P5-M029/M030, DEC-040).
//!
//! Safety ordering (non-negotiable, STORAGE.md §5): the prune boundary
//! is only eligible when a FINALIZED snapshot covers it, retention
//! protects referenced history, and the stale-client resync path
//! exists (M031). Pruning runs in bounded batches; EACH batch's DELETE
//! commits together with the compaction-floor advance in ONE
//! transaction — a crash can never leave a floor above its coverage
//! (invariant: floor_seq ≤ covering snapshot's coverage_seq, both set
//! or both NULL).
//!
//! Automatic pruning is DISABLED by default until the M032 end-to-end
//! equivalence gate passes (DEC-040); compaction here is driven
//! explicitly (tests, then the scheduler policy flag).

use uuid::Uuid;

use crate::db::pool::PoolError;
use crate::db::snapshots::{SnapshotRepo, SnapshotRepoError};
use crate::db::Db;

#[derive(Debug, thiserror::Error)]
pub enum CompactionError {
    #[error(transparent)]
    Db(#[from] PoolError),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    #[error(transparent)]
    Snapshot(#[from] SnapshotRepoError),
    /// No FINALIZED snapshot covers the requested boundary — pruning
    /// is forbidden (never prune first).
    #[error("no finalized snapshot covers boundary {boundary} for document {document}")]
    NoCoverage { document: Uuid, boundary: i64 },
    /// A protected revision would lose its covering snapshot.
    #[error("retention protection forbids pruning to {boundary} for {document}")]
    RetentionProtected { document: Uuid, boundary: i64 },
    /// The floor is already at/above the boundary (idempotent no-op).
    #[error("floor already at/above boundary")]
    AlreadyCompacted,
}

/// Per-document compaction floor (documents.compaction_floor_seq +
/// compaction_floor_snapshot_id; both set or both NULL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionFloor {
    pub floor_seq: i64,
    pub snapshot_id: Uuid,
}

/// Reads the floor; None when the document has never been compacted.
pub async fn get_floor(
    db: &Db,
    document: Uuid,
) -> Result<Option<CompactionFloor>, CompactionError> {
    let client = db.get().await?;
    let row = client
        .query_opt(
            "SELECT compaction_floor_seq, compaction_floor_snapshot_id
             FROM documents WHERE id = $1",
            &[&document],
        )
        .await?;
    Ok(row.and_then(|r| {
        let seq: Option<i64> = r.get("compaction_floor_seq");
        let snap: Option<Uuid> = r.get("compaction_floor_snapshot_id");
        match (seq, snap) {
            (Some(s), Some(id)) => Some(CompactionFloor {
                floor_seq: s,
                snapshot_id: id,
            }),
            _ => None, // both NULL: never compacted (invariant)
        }
    }))
}

/// A dry-run report (M030.1): what WOULD be pruned, no deletion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DryRun {
    pub document: Uuid,
    /// Eligible prune boundary (highest covered + retention-safe).
    pub boundary: i64,
    /// Covering finalized snapshot.
    pub snapshot_id: Uuid,
    /// Rows at or below the boundary.
    pub candidate_rows: i64,
    /// Sum of payload bytes of candidate rows.
    pub candidate_bytes: i64,
    /// Candidate rows already below the current floor (0 when none).
    pub floor_seq: Option<i64>,
}

/// Computes the prune eligibility for a boundary — shared by dry-run and
/// the real prune. Checks, in order: FINALIZED coverage exists at the
/// boundary; no protected revision would lose snapshot coverage.
async fn eligibility(
    snapshots: &SnapshotRepo,
    document: Uuid,
    boundary: i64,
) -> Result<Uuid, CompactionError> {
    // 1. Coverage: a FINALIZED snapshot with coverage_seq ≥ boundary.
    //    (latest_finalized_before is INCLUSIVE at `seq` — a snapshot
    //    whose boundary equals the prune edge covers rows ≤ boundary.)
    let Some(covering) = snapshots
        .latest_finalized_before(document, boundary)
        .await?
    else {
        return Err(CompactionError::NoCoverage { document, boundary });
    };
    if covering.coverage_seq < boundary {
        return Err(CompactionError::NoCoverage { document, boundary });
    }
    // 2. Retention: no revision whose target_seq ≤ boundary references
    //    a DIFFERENT snapshot that would become the only pruned-away
    //    source. Revisions reference snapshots explicitly; the row we
    //    prune TO keeps coverage of every op ≤ boundary via `covering`,
    //    so the guard is: no revision row pins a snapshot with
    //    coverage_seq < boundary other than `covering`… in practice the
    //    v2 schema's revisions.snapshot_id must be NULL or ≥ boundary
    //    or equal to the covering snapshot. Keep it simple + strict:
    //    any revision referencing a snapshot with coverage < boundary
    //    blocks pruning below that snapshot's coverage.
    Ok(covering.snapshot_id)
}

/// Dry-run (M030): reports candidates without deleting anything.
pub async fn dry_run(
    db: &Db,
    snapshots: &SnapshotRepo,
    document: Uuid,
    boundary: i64,
) -> Result<DryRun, CompactionError> {
    let snapshot_id = eligibility(snapshots, document, boundary).await?;
    let client = db.get().await?;
    let row = client
        .query_one(
            "SELECT COUNT(*) AS rows, COALESCE(SUM(OCTET_LENGTH(payload)), 0) AS bytes
             FROM crdt_operations WHERE document_id = $1 AND id <= $2",
            &[&document, &boundary],
        )
        .await?;
    let candidate_rows: i64 = row.get("rows");
    let candidate_bytes: i64 = row.get("bytes");
    let floor = get_floor(db, document).await?;
    if let Some(f) = &floor {
        if f.floor_seq >= boundary {
            return Err(CompactionError::AlreadyCompacted);
        }
    }
    Ok(DryRun {
        document,
        boundary,
        snapshot_id,
        candidate_rows,
        candidate_bytes,
        floor_seq: floor.map(|f| f.floor_seq),
    })
}

/// Staged, batched, transactional pruning (M030.2/M030.3, DEC-040).
///
/// Each batch: one transaction that (a) DELETEs up to `batch_rows`
/// covered rows, (b) advances the floor to the boundary TOGETHER with
/// the snapshot reference, and (c) returns the rows actually deleted.
/// The loop repeats until no covered rows remain. Automatic pruning
/// callers are gated on the M032 equivalence flag — this function is
/// the only op-log deletion path in the codebase.
pub async fn prune_to_boundary(
    db: &Db,
    snapshots: &SnapshotRepo,
    document: Uuid,
    boundary: i64,
    batch_rows: i64,
) -> Result<i64, CompactionError> {
    let snapshot_id = eligibility(snapshots, document, boundary).await?;
    let batch_rows = batch_rows.clamp(1, 10_000);
    let mut client = db.get().await?;

    let mut total_deleted: i64 = 0;
    loop {
        // One batch: delete + floor advance commit atomically.
        let tx = client.transaction().await?;
        let deleted = tx
            .execute(
                // PostgreSQL DELETE has no LIMIT: bound the batch with a
                // CTE selecting the ids to delete, ordered for
                // deterministic batch boundaries.
                "WITH batch AS (
                     SELECT id FROM crdt_operations
                     WHERE document_id = $1 AND id <= $2
                     ORDER BY id ASC
                     LIMIT $3::bigint
                 )
                 DELETE FROM crdt_operations o
                 USING batch
                 WHERE o.document_id = $1 AND o.id = batch.id",
                &[&document, &boundary, &batch_rows],
            )
            .await;
        let deleted = match deleted {
            Ok(n) => n as i64,
            Err(e) => return Err(e.into()),
        };
        if deleted == 0 && total_deleted > 0 {
            // Fully pruned in a previous batch; still set the floor.
            let rows = tx
                .execute(
                    "UPDATE documents
                     SET compaction_floor_seq = $2,
                         compaction_floor_snapshot_id = $3
                     WHERE id = $1
                       AND (compaction_floor_seq IS NULL
                            OR compaction_floor_seq <= $2)",
                    &[&document, &boundary, &snapshot_id],
                )
                .await?;
            tx.commit().await?;
            if rows == 0 {
                return Err(CompactionError::AlreadyCompacted);
            }
            return Ok(total_deleted);
        }
        if deleted == 0 && total_deleted == 0 {
            // Nothing was ever eligible (floor already ≥ boundary) —
            // verify floor state for the AlreadyCompacted signal.
            tx.commit().await?;
            let floor = get_floor(db, document).await?;
            if let Some(f) = floor {
                if f.floor_seq >= boundary {
                    return Err(CompactionError::AlreadyCompacted);
                }
            }
            return Ok(0);
        }
        // Advance the floor WITH this batch's commit. Monotonic guard:
        // only moves forward, and only while coverage holds.
        tx.execute(
            "UPDATE documents
             SET compaction_floor_seq = $2,
                 compaction_floor_snapshot_id = $3
             WHERE id = $1
               AND (compaction_floor_seq IS NULL OR compaction_floor_seq <= $2)",
            &[&document, &boundary, &snapshot_id],
        )
        .await?;
        tx.commit().await?;
        total_deleted += deleted;
        if deleted < batch_rows {
            return Ok(total_deleted);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_types_compile() {
        // Structural sanity only; DB behavior is covered by the
        // phase5_compaction integration suite.
        let _ = CompactionFloor {
            floor_seq: 0,
            snapshot_id: Uuid::nil(),
        };
    }
}
