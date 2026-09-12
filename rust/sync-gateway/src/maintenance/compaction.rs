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
//! or both NULL). Each batch also re-verifies the revision-protection
//! predicate and the covering snapshot's FINALIZED status INSIDE the
//! transaction, under the documents row lock (SEC5-2 race closure) —
//! the pre-loop eligibility reads alone are advisory only.
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
    db: &Db,
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
    // 2. Revision protection (SEC5-2 fix): a revision's target_seq must
    //    remain reconstructable. Reconstruction needs the ops in
    //    (covering_snapshot, target_seq] to still exist in the durable
    //    log — so pruning may NEVER advance above the LOWEST revision
    //    target. When revisions exist, the effective prune boundary is
    //    min(revision target_seq); a prune request above that is
    //    refused (RetentionProtected). When no revisions exist, the
    //    covering snapshot alone justifies pruning.
    let revision_floor: Option<i64> = {
        let client = db.get().await?;
        let row = client
            .query_opt(
                "SELECT MIN(target_seq) AS min_target FROM crdt_revisions
                 WHERE document_id = $1",
                &[&document],
            )
            .await?;
        row.and_then(|r| r.get::<_, Option<i64>>("min_target"))
    };
    if let Some(min_target) = revision_floor {
        if boundary > min_target {
            return Err(CompactionError::RetentionProtected { document, boundary });
        }
    }
    Ok(covering.snapshot_id)
}

/// Dry-run (M030): reports candidates without deleting anything.
pub async fn dry_run(
    db: &Db,
    snapshots: &SnapshotRepo,
    document: Uuid,
    boundary: i64,
) -> Result<DryRun, CompactionError> {
    let snapshot_id = eligibility(db, snapshots, document, boundary).await?;
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

/// Per-batch in-transaction guard (SEC5-2 follow-up, P5-M045): the
/// eligibility reads above run OUTSIDE the prune transactions on a
/// separate connection, so a revision (or a retention status flip) can
/// land between them and the DELETE. This re-checks everything the
/// DELETE depends on, inside the batch transaction, AFTER taking the
/// documents-row lock:
///
/// 1. `SELECT ... FOR UPDATE` on the documents row serializes prune
///    against every writer that locks documents first (revision
///    creation's FOR SHARE, retention's documents lock). Interleaving
///    safety: either the revision row is already visible when the
///    predicate runs (we refuse below), or we hold the documents lock
///    first and the creator's FOR SHARE blocks until this batch
///    commits — after which the creator re-reads the NEW floor and can
///    never insert a revision below it.
/// 2. The revision predicate at statement time must mirror
///    eligibility's refusal exactly: STRICTLY below the boundary
///    (boundary == min_target stays prunable — a revision T ≥ boundary
///    reconstructs from the floor snapshot at coverage ≤ T plus ops
///    (boundary, T], all still present after pruning the covered
///    prefix).
/// 3. The covering snapshot row is re-locked (FOR UPDATE) and must
///    still be FINALIZED for THIS document — a concurrent retention
///    mark_superseded cannot flip coverage between eligibility and the
///    DELETE.
///
/// Returns Ok(()) when the batch may proceed; the caller rolls the
/// transaction back (by returning the error) on any refusal.
async fn recheck_in_batch_tx(
    tx: &tokio_postgres::Transaction<'_>,
    document: Uuid,
    boundary: i64,
    snapshot_id: Uuid,
) -> Result<(), CompactionError> {
    // (1) Serialize on the documents row — see the doc comment above.
    tx.query_opt(
        "SELECT id FROM documents WHERE id = $1 FOR UPDATE",
        &[&document],
    )
    .await?
    .ok_or(CompactionError::NoCoverage { document, boundary })?;

    // (2) Statement-time revision predicate (strictly below boundary,
    //     same as eligibility's boundary > min_target refusal).
    let protected = tx
        .query_opt(
            "SELECT 1 WHERE EXISTS(
                 SELECT 1 FROM crdt_revisions
                 WHERE document_id = $1 AND target_seq < $2)",
            &[&document, &boundary],
        )
        .await?
        .is_some();
    if protected {
        return Err(CompactionError::RetentionProtected { document, boundary });
    }

    // (3) Covering snapshot still FINALIZED, still ours, row-locked so
    //     retention cannot flip it mid-batch.
    let covered = tx
        .query_opt(
            "SELECT 1 FROM crdt_snapshots
             WHERE snapshot_id = $1 AND document_id = $2
               AND status = 'finalized'
             FOR UPDATE",
            &[&snapshot_id, &document],
        )
        .await?
        .is_some();
    if !covered {
        return Err(CompactionError::NoCoverage { document, boundary });
    }
    Ok(())
}

/// Staged, batched, transactional pruning (M030.2/M030.3, DEC-040).
///
/// Each batch: one transaction that (a) DELETEs up to `batch_rows`
/// covered rows, (b) advances the floor to the boundary TOGETHER with
/// the snapshot reference, and (c) returns the rows actually deleted.
/// The loop repeats until no covered rows remain. Automatic pruning
/// callers are gated on the M032 equivalence flag — this function is
/// the only op-log deletion path in the codebase.
///
/// The eligibility reads before the loop are advisory for the dry-run
/// path; EVERY batch re-verifies protection inside its transaction
/// (see [`recheck_in_batch_tx`]) — a revision created below the
/// boundary after eligibility, or a retention flip of the covering
/// snapshot, refuses the batch and leaves the log intact.
pub async fn prune_to_boundary(
    db: &Db,
    snapshots: &SnapshotRepo,
    document: Uuid,
    boundary: i64,
    batch_rows: i64,
) -> Result<i64, CompactionError> {
    // P6-M009/M010: compaction span + duration/rows/bytes metrics.
    let started = std::time::Instant::now();
    let _compaction_span = tracing::info_span!("maintenance.compaction").entered();
    let result = prune_to_boundary_inner(db, snapshots, document, boundary, batch_rows).await;
    if let Ok(PruneOutcome { rows, bytes }) = &result {
        crate::observability::metrics::incr_by("concord_compaction_rows_total", *rows as u64);
        // Bytes pruned is measured transactionally per batch (the batch
        // CTE sums octet_length(payload) of exactly the rows it
        // deletes), so the counter reflects real reclaimed bytes.
        crate::observability::metrics::incr_by("concord_compaction_bytes_total", *bytes as u64);
    }
    crate::observability::metrics::observe(
        "concord_compaction_duration_seconds",
        &["prune"],
        started.elapsed().as_secs_f64(),
    );
    result.map(|o| o.rows)
}

/// Rows deleted + payload bytes reclaimed by one prune run.
struct PruneOutcome {
    rows: i64,
    bytes: i64,
}

async fn prune_to_boundary_inner(
    db: &Db,
    snapshots: &SnapshotRepo,
    document: Uuid,
    boundary: i64,
    batch_rows: i64,
) -> Result<PruneOutcome, CompactionError> {
    let snapshot_id = eligibility(db, snapshots, document, boundary).await?;
    let batch_rows = batch_rows.clamp(1, 10_000);
    let mut client = db.get().await?;

    let mut total_deleted: i64 = 0;
    let mut total_bytes: i64 = 0;
    loop {
        // One batch: re-verify + delete + floor advance commit
        // atomically.
        let tx = client.transaction().await?;
        // SEC5-2 race closure: eligibility ran on a separate connection;
        // re-check the revision predicate and the covering snapshot
        // INSIDE this transaction, under the documents row lock, or
        // roll the whole batch back.
        if let Err(e) = recheck_in_batch_tx(&tx, document, boundary, snapshot_id).await {
            tracing::warn!(
                document = %document,
                boundary,
                snapshot = %snapshot_id,
                error = %e,
                "prune refused by in-transaction recheck"
            );
            return Err(e);
        }
        let deleted = tx
            .query_one(
                // PostgreSQL DELETE has no LIMIT: bound the batch with a
                // CTE selecting the ids to delete, ordered for
                // deterministic batch boundaries. The same batch CTE sums
                // the payload bytes of exactly those rows, so the bytes
                // counter reflects real reclaimed bytes (P6-M010 close:
                // RETURNING-free aggregate — one round trip, no per-row
                // traffic to the client).
                "WITH batch AS (
                     SELECT id, octet_length(payload) AS bytes
                     FROM crdt_operations
                     WHERE document_id = $1 AND id <= $2
                     ORDER BY id ASC
                     LIMIT $3::bigint
                 ),
                 deleted AS (
                     DELETE FROM crdt_operations o
                     USING batch
                     WHERE o.document_id = $1 AND o.id = batch.id
                     RETURNING 1
                 )
                 SELECT count(*)::bigint AS rows,
                        coalesce((SELECT sum(bytes) FROM batch), 0)::bigint AS bytes
                 FROM deleted",
                &[&document, &boundary, &batch_rows],
            )
            .await;
        let (deleted, batch_bytes): (i64, i64) = match deleted {
            Ok(row) => {
                let n: i64 = row.get("rows");
                let b: i64 = row.get("bytes");
                (n, b)
            }
            Err(e) => return Err(e.into()),
        };
        if deleted == 0 && total_deleted > 0 {
            // Fully pruned in a previous batch; still set the floor.
            // (The in-tx rechecks above already ran for this batch.)
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
            return Ok(PruneOutcome {
                rows: total_deleted,
                bytes: total_bytes,
            });
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
            return Ok(PruneOutcome { rows: 0, bytes: 0 });
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
        total_bytes += batch_bytes;
        if deleted < batch_rows {
            return Ok(PruneOutcome {
                rows: total_deleted,
                bytes: total_bytes,
            });
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
