//! Snapshot retention + supersession policy (P5-M038) and storage
//! accounting (P5-M039).
//!
//! Retention (docs/STORAGE.md §7): per document, the newest FINALIZED
//! snapshot plus every snapshot referenced by a revision OR by the
//! compaction floor is PROTECTED — retention can never delete a
//! recovery- or history-critical snapshot. Unreferenced snapshots
//! older than the newest may be marked superseded; payload deletion
//! (a destructive act) is only performed through the explicit
//! `purge_unreferenced` call, guarded again at every step, and
//! disabled in automatic maintenance by default (the M032 gate allows
//! pruning, not payload deletion — payload GC ships deliberately
//! conservative).
//!
//! Race closure (P5-M045, SEC5-2 class): the candidate scan above each
//! mark/delete loop runs on its own connection, so a concurrent prune
//! could pin (or already be deleting toward) a snapshot mid-retention.
//! EVERY per-id mark/delete therefore runs inside a transaction that
//! FIRST takes the owning documents row FOR UPDATE — the same lock
//! order prune uses — which serializes retention against any prune in
//! flight, THEN row-locks the snapshot and re-checks the full
//! protection set (status, newest, revision references, floor
//! reference, and the coverage-below-floor belt-and-braces rule)
//! before mutating.
//!
//! Accounting (M039): one lightweight query pass over the Phase 5
//! tables for ops/bytes/floors/ages/counts — exposed for /metrics and
//! the maintenance scheduler; no monitoring-stack work (Phase 6).

use uuid::Uuid;

use crate::db::pool::PoolError;
use crate::db::Db;

#[derive(Debug, thiserror::Error)]
pub enum RetentionError {
    #[error(transparent)]
    Db(#[from] PoolError),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    /// The snapshot is protected (referenced by a revision or the
    /// floor) — deletion refused.
    #[error("snapshot {0} is retention-protected")]
    Protected(Uuid),
}

/// Per-id in-transaction re-check for the mark/purge loops (P5-M045
/// race closure). Must run INSIDE a transaction that already holds the
/// owning documents row FOR UPDATE (see callers) so no prune can
/// concurrently advance the floor underneath us.
///
/// The single SELECT row-locks the candidate snapshot (FOR UPDATE — a
/// concurrent retention pass cannot double-mark/double-delete it) and
/// refuses the id when ANY of these hold:
/// - the snapshot is not in the expected pre-state (`expected_status`)
///   any more (a concurrent pass or a status transition raced us);
/// - it IS the newest finalized for the document (protection set);
/// - some revision references it (protection set, statement-time);
/// - the document's compaction floor points at it (protection set);
/// - its coverage_seq is BELOW the document's compaction floor
///   (COALESCE(floor, -1) makes the no-floor case never refuse): a
///   snapshot whose coverage ended strictly before the floor could be
///   needed by the resync path's covered prefix. A snapshot AT the
///   floor's coverage (== the floor row itself or a same-coverage
///   sibling) is already excluded by the exact floor-reference check
///   above, so this clause only bites strictly-older rows —
///   belt-and-braces against a prune racing this retention pass.
async fn still_unprotected(
    tx: &tokio_postgres::Transaction<'_>,
    document: Uuid,
    snapshot_id: Uuid,
    expected_status: &str,
) -> Result<bool, RetentionError> {
    let row = tx
        .query_opt(
            "SELECT 1 FROM crdt_snapshots s
             WHERE s.snapshot_id = $1
               AND s.document_id = $2
               AND s.status = $3
               AND s.snapshot_id <> (
                   SELECT snapshot_id FROM crdt_snapshots
                   WHERE document_id = $2 AND status = 'finalized'
                   ORDER BY coverage_seq DESC, attempt DESC
                   LIMIT 1)
               AND NOT EXISTS (SELECT 1 FROM crdt_revisions r
                               WHERE r.snapshot_id = s.snapshot_id)
               AND NOT EXISTS (SELECT 1 FROM documents d
                               WHERE d.id = s.document_id
                                 AND d.compaction_floor_snapshot_id = s.snapshot_id)
               AND s.coverage_seq > (
                   SELECT COALESCE(d2.compaction_floor_seq, -1)
                   FROM documents d2 WHERE d2.id = $2)
             FOR UPDATE OF s",
            &[&snapshot_id, &document, &expected_status],
        )
        .await?;
    Ok(row.is_some())
}

/// Marks unreferenced non-newest FINALIZED snapshots as superseded
/// (metadata-only; payloads retained). Returns the ids marked.
/// Never touches: the newest FINALIZED per document, any snapshot
/// referenced by a revision, the floor snapshot, anything at/below
/// the current compaction floor, or non-finalized rows.
pub async fn mark_superseded_unreferenced(
    db: &Db,
    document: Uuid,
) -> Result<Vec<Uuid>, RetentionError> {
    let mut client = db.get().await?;
    // Candidates: finalized, NOT the newest finalized (per document),
    // not referenced by any revision, not the floor snapshot.
    let rows = client
        .query(
            "SELECT s.snapshot_id
             FROM crdt_snapshots s
             WHERE s.document_id = $1
               AND s.status = 'finalized'
               AND s.snapshot_id <> (
                   SELECT snapshot_id FROM crdt_snapshots
                   WHERE document_id = $1 AND status = 'finalized'
                   ORDER BY coverage_seq DESC, attempt DESC
                   LIMIT 1)
               AND NOT EXISTS (SELECT 1 FROM crdt_revisions r
                               WHERE r.snapshot_id = s.snapshot_id)
               AND NOT EXISTS (SELECT 1 FROM documents d
                               WHERE d.id = s.document_id
                                 AND d.compaction_floor_snapshot_id = s.snapshot_id)
             ORDER BY s.coverage_seq ASC",
            &[&document],
        )
        .await?;
    let mut marked = Vec::with_capacity(rows.len());
    for row in rows {
        let id: Uuid = row.get("snapshot_id");
        // Race closure (SEC5-2 class): the candidate scan above read
        // WITHOUT locks, so a concurrent prune may have pinned this
        // snapshot as its floor target between scan and mark. Run the
        // mark inside a transaction that first locks the documents row
        // FOR UPDATE — prune takes the same lock before each batch's
        // DELETE, so this serializes against any prune in flight —
        // then re-checks the full protection set on the row-locked
        // snapshot before flipping its status.
        let tx = client.transaction().await?;
        tx.query_opt(
            "SELECT id FROM documents WHERE id = $1 FOR UPDATE",
            &[&document],
        )
        .await?;
        if !still_unprotected(&tx, document, id, "finalized").await? {
            // Protected (or already flipped) between scan and lock —
            // skip, never destroy.
            tx.rollback().await?;
            continue;
        }
        let n = tx
            .execute(
                "UPDATE crdt_snapshots SET status = 'superseded'
                 WHERE snapshot_id = $1 AND status = 'finalized'",
                &[&id],
            )
            .await?;
        tx.commit().await?;
        if n > 0 {
            marked.push(id);
        }
    }
    Ok(marked)
}

/// Destructive payload cleanup (explicit-only): deletes rows for
/// snapshots already marked superseded AND unprotected. Returns rows
/// deleted + bytes reclaimed. This is the only payload-deletion path
/// in the codebase and is never called by automatic maintenance in
/// Phase 5 (guard documented at the call sites).
pub async fn purge_unreferenced(db: &Db, document: Uuid) -> Result<(usize, i64), RetentionError> {
    let mut client = db.get().await?;
    // Superseded + no revision reference + not floor snapshot.
    let rows = client
        .query(
            "SELECT s.snapshot_id, OCTET_LENGTH(s.payload) AS bytes
             FROM crdt_snapshots s
             WHERE s.document_id = $1
               AND s.status = 'superseded'
               AND NOT EXISTS (SELECT 1 FROM crdt_revisions r
                               WHERE r.snapshot_id = s.snapshot_id)
               AND NOT EXISTS (SELECT 1 FROM documents d
                               WHERE d.id = s.document_id
                                 AND d.compaction_floor_snapshot_id = s.snapshot_id)",
            &[&document],
        )
        .await?;
    let mut deleted = 0usize;
    let mut reclaimed = 0i64;
    for row in rows {
        let id: Uuid = row.get("snapshot_id");
        let bytes: i64 = i64::from(row.get::<_, i32>("bytes"));
        // Race closure: same shape as the mark loop — lock the
        // documents row (serializing against prune's per-batch lock),
        // re-check protection on the row-locked snapshot, and only
        // then DELETE. Any refusal aborts the whole call: a purge that
        // partially destroyed payloads while skipping a protected id
        // would be surprising to reason about, and the per-document
        // scope keeps the blast radius one retry.
        let tx = client.transaction().await?;
        tx.query_opt(
            "SELECT id FROM documents WHERE id = $1 FOR UPDATE",
            &[&document],
        )
        .await?;
        if !still_unprotected(&tx, document, id, "superseded").await? {
            return Err(RetentionError::Protected(id));
        }
        let n = tx
            .execute(
                "DELETE FROM crdt_snapshots
                 WHERE snapshot_id = $1 AND status = 'superseded'",
                &[&id],
            )
            .await?;
        tx.commit().await?;
        if n > 0 {
            deleted += 1;
            reclaimed += bytes;
        }
    }
    Ok((deleted, reclaimed))
}

/// Storage accounting snapshot for one document (P5-M039).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageAccounting {
    pub document_id: Uuid,
    pub op_rows: i64,
    pub op_bytes: i64,
    pub snapshot_count: i64,
    pub snapshot_bytes: i64,
    pub finalized_snapshots: i64,
    pub latest_snapshot_coverage: Option<i64>,
    pub latest_snapshot_age_secs: Option<i64>,
    pub compaction_floor: Option<i64>,
    pub tail_op_rows: i64,
    pub revision_count: i64,
    /// Ops at or below the floor that remain in the log (should be 0
    /// after a clean prune; nonzero after partial prune = resumable).
    pub prunable_rows_remaining: i64,
}

/// One lightweight pass; no heavy scans (counts + sums the planner
/// can serve from indexes at Phase 5 scale).
pub async fn storage_accounting(
    db: &Db,
    document: Uuid,
) -> Result<StorageAccounting, RetentionError> {
    let client = db.get().await?;
    let ops = client
        .query_one(
            "SELECT COUNT(*) AS rows, COALESCE(SUM(OCTET_LENGTH(payload)), 0) AS bytes
             FROM crdt_operations WHERE document_id = $1",
            &[&document],
        )
        .await?;
    let snaps = client
        .query_one(
            "SELECT COUNT(*) AS n, COALESCE(SUM(OCTET_LENGTH(payload)), 0) AS bytes,
                    COUNT(*) FILTER (WHERE status = 'finalized') AS finalized,
                    (SELECT coverage_seq FROM crdt_snapshots
                      WHERE document_id = $1 AND status = 'finalized'
                      ORDER BY coverage_seq DESC LIMIT 1) AS latest_coverage,
                    (SELECT EXTRACT(EPOCH FROM (now() - finalized_at))::bigint
                       FROM crdt_snapshots
                      WHERE document_id = $1 AND status = 'finalized'
                      ORDER BY coverage_seq DESC LIMIT 1) AS latest_age
             FROM crdt_snapshots WHERE document_id = $1",
            &[&document],
        )
        .await?;
    let doc_row = client
        .query_one(
            "SELECT compaction_floor_seq FROM documents WHERE id = $1",
            &[&document],
        )
        .await?;
    let revisions = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_revisions WHERE document_id = $1",
            &[&document],
        )
        .await?;
    let floor: Option<i64> = doc_row.get("compaction_floor_seq");
    let tail_rows = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_operations
             WHERE document_id = $1 AND ($2::bigint IS NULL OR id > $2)",
            &[&document, &floor],
        )
        .await?;
    let prunable = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_operations
             WHERE document_id = $1 AND $2::bigint IS NOT NULL AND id <= $2",
            &[&document, &floor],
        )
        .await?;
    Ok(StorageAccounting {
        document_id: document,
        op_rows: ops.get("rows"),
        op_bytes: ops.get("bytes"),
        snapshot_count: snaps.get("n"),
        snapshot_bytes: snaps.get("bytes"),
        finalized_snapshots: snaps.get("finalized"),
        latest_snapshot_coverage: snaps.get("latest_coverage"),
        latest_snapshot_age_secs: snaps.get("latest_age"),
        compaction_floor: floor,
        tail_op_rows: tail_rows.get("n"),
        revision_count: revisions.get("n"),
        prunable_rows_remaining: prunable.get("n"),
    })
}
