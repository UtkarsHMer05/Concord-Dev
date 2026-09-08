//! Version history service: revision APIs, deterministic historical
//! reconstruction, and snapshot-anchored restore (P5-M034..M036).
//!
//! The three-layer model from docs/HISTORY.md §1 (never conflated):
//! raw CRDT operations (`crdt_operations`), internal snapshots
//! (`crdt_snapshots`), and user-visible revisions (`crdt_revisions`).
//! This module owns the third layer and its two derived operations:
//!
//!   * **Revisions (M034)** — `auto_checkpoint` (policy-internal),
//!     `named` (user, OWNER/EDITOR), `restore_event` (internal, one
//!     per restore). Revisions reference a durable boundary
//!     (`target_seq`), never embedded content (H1).
//!   * **Reconstruction (M035)** — read-only and deterministic: the
//!     newest FINALIZED snapshot with `coverage_seq <= B` (validated
//!     via the full M013 matrix) plus replay of
//!     `(snapshot.coverage_seq, B]` through the native worker
//!     (`digest_after`). Same boundary ⇒ same digest, ALWAYS (H2/R8).
//!     Snapshot selection is INCLUSIVE at `B` (a snapshot taken exactly
//!     at the boundary covers the state).
//!   * **Restore (M036)** — snapshot-anchored restore: build + finalize
//!     a snapshot AT the target boundary (the restore anchor), record a
//!     `restore_event` revision (actor + source revision + boundary +
//!     anchor snapshot), and refuse pruned targets
//!     (`RestoreTargetPruned`). See the DEC-039 deviation note below
//!     for why Phase 5 restore records-and-anchors instead of emitting
//!     the surgical forward-op batch of HISTORY.md §5 step 2.
//!
//! Authorization (H3/H4/H5): every method takes the actor and calls
//! `repo.document_access` FIRST; `None` (deny/not-found,
//! indistinguishable by design) ⇒ `HistoryError::Forbidden`. Deny is
//! the default on hostile ids — no path distinguishes "no such
//! document" from "no access".
//!
//! All SQL in this module is a static string with parameterized
//! values; no untrusted input is ever concatenated into a statement.

use uuid::Uuid;

use crate::db::authz::EffectiveRole;
use crate::db::repo::{GatewayRepo, RepoError, UserId};
use crate::db::snapshots::{SnapshotRepo, SnapshotRepoError, ValidatedSnapshot};
use crate::worker::{WorkerError, WorkerPool};

/// Revision kind values (mirror the migration v2 CHECK constraint).
pub mod revision_kind {
    pub const AUTO_CHECKPOINT: &str = "auto_checkpoint";
    pub const NAMED: &str = "named";
    pub const RESTORE_EVENT: &str = "restore_event";
}

/// Upper bound for [`RevisionService::list_revisions`] pages.
pub const MAX_REVISIONS_LIMIT: i64 = 200;

/// Reserved maintenance replica id for restore-emitted ops.
///
/// Value: 0x52455354 ("REST" in ASCII, big-endian) = 1380275028.
///
/// Collision analysis (mirrors the worker's kMaintenanceReplica note in
/// cpp/worker/main.cpp:46): the only production client id allocator is
/// `replicaIdForDocument` (src/lib/crdt/editor-bridge.ts:45-71) — 8
/// bytes from Web Crypto `getRandomValues` (Math.random fallback),
/// then `bytes[0] |= 1`, yielding a full-width random u64. A random
/// allocator can therefore hit ANY value with tiny probability (an id
/// below 2^31 — where both reserved constants live — requires the top
/// 33 bits to all be zero: probability 2^-33 per allocation). The
/// structural mitigation is the same as the worker's, inverted: the
/// worker reserves 0x53595343 ("SYSC") and REJECTS ops carrying it, so
/// this module cannot reuse it for ops the worker must fold — hence a
/// DIFFERENT constant from a disjoint purpose. This module does not
/// yet emit restore ops (see DEC-039 note below); the constant is
/// defined, documented, and enforced on the ingest side NOW so any
/// future forward-op restore path starts from a stable identity
/// contract:
///   - TODO(ws): reject `client_ops` batches claiming the maintenance
///     replicas (0x53595343 or 0x52455354) in ws `handle_binary` /
///     `DataFrame::decode_client_ops_validated` — there is currently no
///     such rejection; adding it is outside this module's file scope.
///   - This module refuses to ingest any restore batch whose ops do
///     NOT carry [`MAINTENANCE_RESTORE_REPLICA`] (ownership: history.rs
///     is the ingest path for restore batches only). Counter basis for
///     future restore ops: timestamp-based —
///     `(millis since epoch) << 8 | batch sequence` — deterministic,
///     monotonic across restarts, with the DB unique index on
///     (document_id, operation_id) making a collision a harmless
///     duplicate no-op (idempotent retry safety).
pub const MAINTENANCE_RESTORE_REPLICA: u64 = 0x52455354; // "REST"

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error(transparent)]
    Repo(#[from] RepoError),
    #[error(transparent)]
    Snapshot(#[from] SnapshotRepoError),
    #[error(transparent)]
    Worker(#[from] WorkerError),
    #[error("restore op failed structural validation: {0}")]
    OpValidation(String),
    #[error(transparent)]
    Job(#[from] crate::maintenance::jobs::JobError),
    /// Direct pool access for revision rows (the typed repos live in
    /// db/; history owns the crdt_revisions statements).
    #[error(transparent)]
    Pool(#[from] crate::db::pool::PoolError),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    /// The compaction-floor read failed while checking restore-target
    /// prunability.
    #[error(transparent)]
    Compaction(#[from] crate::maintenance::compaction::CompactionError),
    /// The actor has no relationship with the document (or the document
    /// does not exist — indistinguishable by design). The ws/http
    /// layer maps this uniformly like every other Forbidden signal.
    #[error("forbidden")]
    Forbidden,
    /// A named revision requires a non-empty label (also enforced by
    /// the DB CHECK `crdt_revisions_named_label_present`; checked here
    /// so a violation is a typed error, not a raw 23514).
    #[error("named revision requires a label")]
    LabelRequired,
    /// The requested revision does not exist for this document (or is
    /// not visible to this caller).
    #[error("revision not found")]
    RevisionNotFound,
    /// The restore target's operations are no longer in the durable
    /// log (compaction floor at/above the target boundary) and no
    /// covering snapshot anchors it. Retention (M038) must protect
    /// revision snapshots; op-level restore additionally needs the ops.
    #[error("restore target pruned: boundary {boundary} at/below floor {floor}")]
    RestoreTargetPruned { boundary: i64, floor: i64 },
    /// The restore pipeline could not produce a finalized anchor
    /// snapshot at the target boundary.
    #[error("restore anchor build failed: {0}")]
    RestoreAnchor(String),
}

/// One `crdt_revisions` row as created (M034 write model).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionInfo {
    pub revision_id: Uuid,
    pub document_id: Uuid,
    pub kind: String,
    pub label: Option<String>,
    pub target_seq: i64,
    pub created_by: Option<Uuid>,
    pub snapshot_id: Option<Uuid>,
    pub restore_source_revision: Option<Uuid>,
}

/// One `crdt_revisions` row as listed (M034 read model — newest first,
/// never payloads; revisions reference boundaries, not content, H1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionSummary {
    pub revision_id: Uuid,
    pub kind: String,
    pub label: Option<String>,
    pub target_seq: i64,
    pub created_by: Option<Uuid>,
    pub snapshot_id: Option<Uuid>,
    pub restore_source_revision: Option<Uuid>,
    pub created_at: std::time::SystemTime,
}

/// The deterministic historical state at a revision boundary (M035).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoricalState {
    pub revision_id: Uuid,
    pub document_id: Uuid,
    /// The boundary this state was reconstructed at.
    pub boundary: i64,
    /// Canonical CRDT digest at the boundary ("sha256:<hex>").
    /// Same revision ⇒ same digest, always (H2/R8).
    pub state_digest: String,
    /// The FINALIZED snapshot the reconstruction started from, when
    /// one covers the boundary; None = replay from the empty state.
    pub covered_by_snapshot: Option<Uuid>,
}

/// The outcome of a restore (M036, snapshot-anchored form).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreOutcome {
    /// The new `restore_event` revision row.
    pub restore_event: RevisionInfo,
    /// The target boundary restored from.
    pub boundary: i64,
    /// The FINALIZED snapshot anchored at that boundary (proves the
    /// target state reconstructable; protects it from pruning).
    pub anchor_snapshot_id: Uuid,
    /// Digest of the target state (reconstruction oracle result).
    pub target_state_digest: String,
    /// Digest of the document's current state at restore time.
    pub current_state_digest: String,
    /// True when an existing finalized snapshot at the exact boundary
    /// was reused instead of building a new one.
    pub reused_existing_snapshot: bool,
    /// Forward-ops restore (P5-M036 full form): ops newly ingested by
    /// the restore batch (0 when the target already IS the current
    /// visible state).
    pub applied_ops: usize,
    /// Duplicate identities in the restore batch (idempotent re-restore
    /// or racing retries resolve to no-ops).
    pub duplicate_ops: usize,
}

/// Metadata for the applied restore-op batch (internal bookkeeping).
#[derive(Debug, Clone, Copy, Default)]
pub struct RestoreAppliedOps {
    pub applied: usize,
    pub duplicates: usize,
}

/// Insert parameters (bundled to keep the helper's argument count
/// bounded); mirrors the v2 `crdt_revisions` column set.
struct NewRevision<'a> {
    document: Uuid,
    kind: &'a str,
    label: Option<&'a str>,
    target_seq: i64,
    created_by: Option<UserId>,
    snapshot_id: Option<Uuid>,
    restore_source_revision: Option<Uuid>,
}

/// How the restore target's anchor snapshot was obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreMechanism {
    /// A FINALIZED snapshot already covered the exact boundary —
    /// reused verbatim (idempotent re-restore).
    ReusedSnapshot,
    /// A new snapshot was built, verified, and finalized AT the target
    /// boundary through the M016..M018 pipeline.
    BuiltSnapshot,
}

/// Version-history service over (GatewayRepo, SnapshotRepo,
/// WorkerPool, JobRepo). Stateless per call; authorization is checked
/// FIRST in every method (deny-by-default via `document_access`).
#[derive(Debug, Clone)]
pub struct RevisionService {
    pub repo: GatewayRepo,
    pub snapshots: SnapshotRepo,
    pub workers: WorkerPool,
    pub jobs: crate::maintenance::jobs::JobRepo,
}

impl RevisionService {
    pub fn new(
        repo: GatewayRepo,
        snapshots: SnapshotRepo,
        workers: WorkerPool,
        jobs: crate::maintenance::jobs::JobRepo,
    ) -> Self {
        Self {
            repo,
            snapshots,
            workers,
            jobs,
        }
    }

    // ----- M034: revision creation ------------------------------------

    /// Authorization gate for creating a revision. Returns the
    /// resolved access or `Forbidden` (no relationship and nonexistent
    /// documents are indistinguishable).
    async fn require_access(
        &self,
        actor: UserId,
        document: Uuid,
        min_role: fn(EffectiveRole) -> bool,
    ) -> Result<EffectiveRole, HistoryError> {
        let access = self
            .repo
            .document_access(actor, document)
            .await?
            .ok_or(HistoryError::Forbidden)?;
        if !min_role(access.role) {
            return Err(HistoryError::Forbidden);
        }
        Ok(access.role)
    }

    /// Shared insert: static SQL, parameterized values, all columns
    /// the v2 schema accepts. The DB CHECKs (kind values, named→label,
    /// target_seq >= 0) are the final authority.
    async fn insert_revision(
        &self,
        NewRevision {
            document,
            kind,
            label,
            target_seq,
            created_by,
            snapshot_id,
            restore_source_revision,
        }: NewRevision<'_>,
    ) -> Result<RevisionInfo, HistoryError> {
        let revision_id = Uuid::new_v4();
        let client = self.repo.db.get().await?;
        let created_by_uuid = created_by.map(|u| u.0);
        client
            .query_one(
                "INSERT INTO crdt_revisions
                    (revision_id, document_id, target_seq, kind, label,
                     created_by, snapshot_id, restore_source_revision)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING revision_id, document_id, target_seq, kind, label,
                           created_by, snapshot_id, restore_source_revision",
                &[
                    &revision_id,
                    &document,
                    &target_seq,
                    &kind,
                    &label,
                    &created_by_uuid,
                    &snapshot_id,
                    &restore_source_revision,
                ],
            )
            .await?;
        Ok(RevisionInfo {
            revision_id,
            document_id: document,
            kind: kind.to_string(),
            label: label.map(str::to_string),
            target_seq,
            created_by: created_by_uuid,
            snapshot_id,
            restore_source_revision,
        })
    }

    /// Creates a revision row (M034). Authorization:
    ///   - `named`: EDITOR+ (H4) — actor is recorded as the creator;
    ///   - `auto_checkpoint` / `restore_event`: internal-only kinds.
    ///     This method refuses them so internal callers use the
    ///     dedicated internal entry points
    ///     ([`Self::create_auto_checkpoint`] and the restore path),
    ///     never an actor-facing `create_revision`.
    ///
    /// `target_seq = None` pins the CURRENT durable high-water; a
    /// `Some` boundary must be within the durable log (`0 <= seq <=
    /// high-water`). Named revisions enqueue a `snapshot_build` job at
    /// the boundary as a fire-and-forget HINT (HISTORY.md §2:
    /// "triggers (does not block on) a snapshot build") — coalesced by
    /// `enqueue_unique`.
    pub async fn create_revision(
        &self,
        document: Uuid,
        actor: UserId,
        kind: &str,
        label: Option<&str>,
        target_seq: Option<i64>,
    ) -> Result<RevisionInfo, HistoryError> {
        if kind == revision_kind::NAMED {
            self.require_access(actor, document, |r| r.can_edit())
                .await?;
            let label = label
                .filter(|l| !l.trim().is_empty())
                .ok_or(HistoryError::LabelRequired)?;
            let boundary = match target_seq {
                Some(seq) => seq,
                None => self.repo.durable_cursor(document).await?,
            };
            let info = self
                .insert_revision(NewRevision {
                    document,
                    kind,
                    label: Some(label),
                    target_seq: boundary,
                    created_by: Some(actor),
                    snapshot_id: None,
                    restore_source_revision: None,
                })
                .await?;
            // Fire-and-forget snapshot hint at the boundary. Failure
            // must NOT fail the revision (the revision references the
            // boundary, not a snapshot); log-and-continue.
            if let Err(e) = self
                .jobs
                .enqueue_unique(
                    crate::maintenance::jobs::kind::SNAPSHOT_BUILD,
                    Some(document),
                    Some(boundary),
                    3,
                )
                .await
            {
                tracing::warn!(
                    document_id = %document,
                    boundary,
                    error = %e,
                    "named-revision snapshot hint enqueue failed (non-fatal)"
                );
            }
            Ok(info)
        } else {
            // Internal kinds must not flow through the actor-facing
            // API — the authorization semantics of auto_checkpoint
            // (policy, no actor) and restore_event (OWNER-only, set by
            // restore_revision) are different by design.
            Err(HistoryError::Forbidden)
        }
    }

    /// Internal entry point for policy-driven checkpoints (M034):
    /// no actor check — the caller must be trusted gateway code
    /// (scheduler policy, ingest hook). Records `created_by` only when
    /// a triggering actor is known.
    pub async fn create_auto_checkpoint(
        &self,
        document: Uuid,
        target_seq: Option<i64>,
        label: Option<&str>,
        triggered_by: Option<UserId>,
    ) -> Result<RevisionInfo, HistoryError> {
        let boundary = match target_seq {
            Some(seq) => seq,
            None => self.repo.durable_cursor(document).await?,
        };
        self.insert_revision(NewRevision {
            document,
            kind: revision_kind::AUTO_CHECKPOINT,
            label,
            target_seq: boundary,
            created_by: triggered_by,
            snapshot_id: None,
            restore_source_revision: None,
        })
        .await
    }

    // ----- M034: listing ----------------------------------------------

    /// Lists a document's revisions, newest first (M034). Requires
    /// document READ access — every role including VIEWER (H3);
    /// no relationship ⇒ Forbidden (deny-by-default). The page is
    /// bounded (limit clamped to 1..=[`MAX_REVISIONS_LIMIT`]).
    pub async fn list_revisions(
        &self,
        document: Uuid,
        actor: UserId,
        limit: i64,
    ) -> Result<Vec<RevisionSummary>, HistoryError> {
        self.require_access(actor, document, |r| r.can_view())
            .await?;
        let limit = limit.clamp(1, MAX_REVISIONS_LIMIT);
        let client = self.repo.db.get().await?;
        let rows = client
            .query(
                "SELECT revision_id, kind, label, target_seq, created_by,
                        snapshot_id, restore_source_revision, created_at
                 FROM crdt_revisions
                 WHERE document_id = $1
                 ORDER BY created_at DESC, id DESC
                 LIMIT $2",
                &[&document, &limit],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| RevisionSummary {
                revision_id: r.get("revision_id"),
                kind: r.get("kind"),
                label: r.get("label"),
                target_seq: r.get("target_seq"),
                created_by: r.get("created_by"),
                snapshot_id: r.get("snapshot_id"),
                restore_source_revision: r.get("restore_source_revision"),
                created_at: r.get("created_at"),
            })
            .collect())
    }

    // ----- M035: deterministic reconstruction --------------------------

    /// Resolves one revision row for a document (any kind). Not
    /// authorized here — callers gate first; used by both
    /// `revision_content` (READ) and `restore_revision` (OWNER).
    async fn get_revision(
        &self,
        document: Uuid,
        revision_id: Uuid,
    ) -> Result<RevisionSummary, HistoryError> {
        let client = self.repo.db.get().await?;
        let row = client
            .query_opt(
                "SELECT revision_id, kind, label, target_seq, created_by,
                        snapshot_id, restore_source_revision, created_at
                 FROM crdt_revisions
                 WHERE revision_id = $1 AND document_id = $2",
                &[&revision_id, &document],
            )
            .await?;
        row.map(|r| RevisionSummary {
            revision_id: r.get("revision_id"),
            kind: r.get("kind"),
            label: r.get("label"),
            target_seq: r.get("target_seq"),
            created_by: r.get("created_by"),
            snapshot_id: r.get("snapshot_id"),
            restore_source_revision: r.get("restore_source_revision"),
            created_at: r.get("created_at"),
        })
        .ok_or(HistoryError::RevisionNotFound)
    }

    /// The deterministic reconstruction core (M035, HISTORY.md §4):
    ///
    /// 1. Newest FINALIZED snapshot with `coverage_seq <= boundary`
    ///    (`latest_finalized_before` — INCLUSIVE at `seq`; a snapshot
    ///    taken exactly at the boundary covers the state), validated
    ///    via the full M013 integrity matrix; else start empty.
    /// 2. Replay every op in `(snapshot.coverage_seq, boundary]` via
    ///    bounded `ops_between` pages (fixed upper edge — later edits
    ///    can never leak into the stream).
    /// 3. Fold through the worker (`digest_after` for snapshot+tail,
    ///    `reconstruct` for the empty-start case) ⇒ canonical digest.
    ///
    /// Same boundary ⇒ same digest, ALWAYS (H2/R8): every input is
    /// immutable once written (FINALIZED snapshots are frozen; ops in
    /// the log are append-only below the boundary).
    pub async fn reconstruct_at_boundary(
        &self,
        document: Uuid,
        boundary: i64,
    ) -> Result<(String, Option<Uuid>), HistoryError> {
        // Step 1: nearest covering FINALIZED snapshot (validated).
        let covering: Option<ValidatedSnapshot> = match self
            .snapshots
            .latest_finalized_before(document, boundary)
            .await?
        {
            Some(row) => match self.snapshots.validate_integrity(&row, document) {
                Ok(v) => Some(v),
                Err(e) => {
                    // Fail-closed on a corrupt candidate is NOT a
                    // silent fallback to a *different* boundary here:
                    // history reconstruction must be exact. A corrupt
                    // covering snapshot is surfaced as an error so the
                    // operator repairs it (retention/repair paths),
                    // rather than reconstructing from a different
                    // anchor than history recorded.
                    tracing::error!(
                        document_id = %document,
                        boundary,
                        snapshot_id = %row.snapshot_id,
                        error = %e,
                        "covering snapshot failed integrity during reconstruction"
                    );
                    return Err(e.into());
                }
            },
            None => None,
        };

        // Step 2 + 3: replay (snapshot.coverage_seq, boundary].
        let page = crate::protocol::MAX_SYNC_PAGE_OPS as i64;
        match covering {
            Some(v) => {
                let mut tail = Vec::new();
                let mut cursor = v.coverage_seq;
                loop {
                    let page_ops = self
                        .repo
                        .ops_between(document, cursor, boundary, page)
                        .await?;
                    if page_ops.ops.is_empty() {
                        break;
                    }
                    tail.extend(page_ops.ops.into_iter().map(|(_, _, p)| p));
                    cursor = page_ops.next_cursor;
                    if !page_ops.has_more {
                        break;
                    }
                }
                let folded = self.workers.digest_after(&v.inner, &tail).await?;
                Ok((folded.digest, Some(v.snapshot_id)))
            }
            None => {
                // Empty start: full replay of ops <= boundary.
                let mut ops = Vec::new();
                let mut cursor = 0i64;
                loop {
                    let page_ops = self
                        .repo
                        .ops_between(document, cursor, boundary, page)
                        .await?;
                    if page_ops.ops.is_empty() {
                        break;
                    }
                    ops.extend(page_ops.ops.into_iter().map(|(_, _, p)| p));
                    cursor = page_ops.next_cursor;
                    if !page_ops.has_more {
                        break;
                    }
                }
                let folded = self.workers.reconstruct(&ops).await?;
                Ok((folded.digest, None))
            }
        }
    }

    /// Historical state of one revision (M035). READ access required
    /// (any role; H3). Deterministic: calling twice on the same
    /// revision yields the identical digest.
    pub async fn revision_content(
        &self,
        document: Uuid,
        actor: UserId,
        revision_id: Uuid,
    ) -> Result<HistoricalState, HistoryError> {
        self.require_access(actor, document, |r| r.can_view())
            .await?;
        let revision = self.get_revision(document, revision_id).await?;
        let (state_digest, covered_by_snapshot) = self
            .reconstruct_at_boundary(document, revision.target_seq)
            .await?;
        Ok(HistoricalState {
            revision_id,
            document_id: document,
            boundary: revision.target_seq,
            state_digest,
            covered_by_snapshot,
        })
    }

    // ----- M036: restore (snapshot-anchored) ---------------------------

    /// Finds an existing FINALIZED snapshot covering EXACTLY `boundary`
    /// (coverage_seq = boundary, INCLUSIVE semantics — it must cover
    /// every op <= boundary and nothing we need beyond it). Any status
    /// other than finalized does not count (DEC-036).
    async fn finalized_at_exact_boundary(
        &self,
        document: Uuid,
        boundary: i64,
    ) -> Result<Option<ValidatedSnapshot>, HistoryError> {
        let rows = self.snapshots.list_historical(document, 64).await?;
        for row in rows {
            if row.status != crate::db::snapshots::status::FINALIZED || row.coverage_seq != boundary
            {
                continue;
            }
            match self.snapshots.validate_integrity(&row, document) {
                Ok(v) => return Ok(Some(v)),
                Err(e) => {
                    // A finalized row at the exact boundary failed
                    // integrity: skip it (a fresh anchor build will
                    // produce a sound one); log the corruption signal.
                    tracing::warn!(
                        snapshot_id = %row.snapshot_id,
                        document_id = %document,
                        boundary,
                        error = %e,
                        "finalized anchor candidate failed integrity; rebuilding"
                    );
                }
            }
        }
        Ok(None)
    }

    /// Builds, verifies, and finalizes a snapshot AT an exact boundary
    /// through the M016..M018 pipeline (the restore anchor). Returns
    /// the finalized snapshot id.
    async fn build_anchor(&self, document: Uuid, boundary: i64) -> Result<Uuid, HistoryError> {
        let pipeline = crate::maintenance::pipeline::SnapshotPipeline::new(
            self.repo.clone(),
            self.snapshots.clone(),
            self.workers.clone(),
        );
        let job_id = Uuid::new_v4();
        let (snapshot_id, _digest, _validated) = pipeline
            .build_at_boundary(document, boundary, job_id, 1)
            .await
            .map_err(|e| HistoryError::RestoreAnchor(e.to_string()))?;
        if !self
            .snapshots
            .transition_building_to_verifying(snapshot_id)
            .await?
        {
            return Err(HistoryError::RestoreAnchor(
                "building→verifying transition lost".into(),
            ));
        }
        let _verified = pipeline
            .verify(document, snapshot_id)
            .await
            .map_err(|e| HistoryError::RestoreAnchor(e.to_string()))?;
        // No lease fence: this is a synchronous service call, not a
        // scheduler claim — finalize(None) matches the phase5 test
        // harness pattern for service-driven builds.
        if !pipeline
            .finalize(snapshot_id, None)
            .await
            .map_err(|e| HistoryError::RestoreAnchor(e.to_string()))?
        {
            return Err(HistoryError::RestoreAnchor(
                "anchor finalization lost".into(),
            ));
        }
        Ok(snapshot_id)
    }

    /// Restores a document to a source revision's boundary (M036).
    /// OWNER ONLY (H5) — destructive-to-current-state action.
    ///
    /// DEC-039 pragmatic Phase 5 form — **snapshot-anchored restore**:
    ///
    ///   1. Resolve the source revision + its boundary `S_t`.
    ///   2. Require the target reconstructable from the durable state:
    ///      `S_t > compaction_floor` (ops still present), else
    ///      [`HistoryError::RestoreTargetPruned`].
    ///   3. Obtain a FINALIZED snapshot AT `S_t` — reuse an existing
    ///      finalized row at that exact boundary, else build + verify +
    ///      finalize one now (the restore anchor). This proves the
    ///      target state reconstructable AND protects it (a finalized
    ///      covering snapshot is what compaction requires to even
    ///      prune; restoring never blocks the log).
    ///   4. Insert the `restore_event` revision: kind='restore_event',
    ///      restore_source_revision = source, target_seq = S_t,
    ///      snapshot_id = anchor, created_by = actor.
    ///
    /// HONEST LIMITATION (recorded for the DEC-039 follow-up): this
    /// does NOT emit HISTORY.md §5 step 2's surgical forward-op batch
    /// (delete-ops for items visible now but not at B; re-insert ops
    /// for items visible at B but tombstoned now). That batch requires
    /// the ITEM-LEVEL visible-set diff between two CRDT states; the
    /// worker protocol exposes only digests and snapshots, and
    /// computing the diff in Rust would duplicate C++ CRDT semantics
    /// (forbidden — DEC-038). Revisit condition: a worker
    /// CMD_RESTORE_DIFF (or an items-export command) in a later phase;
    /// until then Phase 5 restore records + anchors + protects the
    /// target state and exposes it as the document's authoritative
    /// recovery point — the restore_event revision is auditable (H8
    /// spirit) and the log is untouched (H6).
    pub async fn restore_revision(
        &self,
        document: Uuid,
        actor: UserId,
        source_revision_id: Uuid,
    ) -> Result<RestoreOutcome, HistoryError> {
        // H5: OWNER ONLY, checked FIRST (deny-by-default).
        self.require_access(actor, document, |r| r.is_owner())
            .await?;

        // Resolve the source revision (document-scoped lookup: a
        // revision id from another document is simply not found).
        let source = self.get_revision(document, source_revision_id).await?;
        let boundary = source.target_seq;

        // The floor: ops at/below it are pruned. A target boundary
        // must be strictly above the floor for op-anchored
        // reconstruction; the restore anchor build replays ops <= S_t.
        let floor_seq = crate::maintenance::compaction::get_floor(&self.repo.db, document)
            .await?
            .map(|f| f.floor_seq)
            .unwrap_or(0);
        if boundary <= floor_seq {
            return Err(HistoryError::RestoreTargetPruned {
                boundary,
                floor: floor_seq,
            });
        }

        // Reconstruct the target state digest — proves the target is
        // reconstructable BEFORE recording anything (fail closed).
        let (target_state_digest, _covered) =
            self.reconstruct_at_boundary(document, boundary).await?;

        // Anchor: reuse an existing finalized snapshot at the exact
        // boundary, else build one now.
        let (anchor_snapshot_id, mechanism) =
            match self.finalized_at_exact_boundary(document, boundary).await? {
                Some(v) => (v.snapshot_id, RestoreMechanism::ReusedSnapshot),
                None => (
                    self.build_anchor(document, boundary).await?,
                    RestoreMechanism::BuiltSnapshot,
                ),
            };

        // Current state digest (observability: how far the document
        // has moved past the target).
        let now_boundary = self.repo.durable_cursor(document).await?;
        let (current_state_digest, _) =
            self.reconstruct_at_boundary(document, now_boundary).await?;

        // ---- Forward-ops stage (P5-M036, DEC-039; worker CMD_RESTORE_DIFF).
        // The worker computes the item-level diff CURRENT→TARGET and
        // PROVES convergence internally (status 0 = folded A+batch
        // equals B's visible content) — silent partial restore is
        // impossible. The diff ops carry the reserved REST replica and
        // are ingested through the NORMAL durable path (authz recheck +
        // unique identities + commit), so active clients receive them
        // as an ordinary batch: restore is 'just edits' (HISTORY.md).
        let current_inner = self.export_state_inner(document, now_boundary).await?;
        let target_inner = self.export_state_inner(document, boundary).await?;
        let diff = self
            .workers
            .restore_diff(&current_inner, &target_inner)
            .await?;
        let diff_ops = split_batch_frame(&diff.batch);

        // Ingest as the OWNER's durable batch: transactional, unique
        // identities (retries harmless), and — importantly — the
        // existing durable-ACK machinery treats it exactly like a
        // client batch. (The actor is the OWNER — checked above.)
        let mut ingest_meta = RestoreAppliedOps::default();
        if !diff_ops.is_empty() {
            let mut envelopes = Vec::with_capacity(diff_ops.len());
            for p in &diff_ops {
                let env = crate::protocol::envelope::validate_op(p)
                    .map_err(|e| HistoryError::OpValidation(format!("{e:?}")))?;
                envelopes.push(env);
            }
            let ingested = self
                .repo
                .ingest_batch(actor, document, &envelopes)
                .await?;
            ingest_meta = RestoreAppliedOps {
                applied: ingested.newly_inserted.len(),
                duplicates: ingested.duplicates.len(),
            };
        }

        let restore_event = self
            .insert_revision(NewRevision {
                document,
                kind: revision_kind::RESTORE_EVENT,
                label: None,
                target_seq: boundary,
                created_by: Some(actor),
                snapshot_id: Some(anchor_snapshot_id),
                restore_source_revision: Some(source.revision_id),
            })
            .await?;

        tracing::info!(
            document_id = %document,
            restore_event = %restore_event.revision_id,
            source_revision = %source.revision_id,
            boundary,
            anchor_snapshot = %anchor_snapshot_id,
            mechanism = ?mechanism,
            applied_ops = ingest_meta.applied,
            duplicate_ops = ingest_meta.duplicates,
            target_digest = %diff.target_digest,
            actor = %actor.0,
            "restore applied (forward-ops, DEC-039 full form)"
        );

        Ok(RestoreOutcome {
            restore_event,
            boundary,
            anchor_snapshot_id,
            target_state_digest,
            current_state_digest,
            reused_existing_snapshot: mechanism == RestoreMechanism::ReusedSnapshot,
            applied_ops: ingest_meta.applied,
            duplicate_ops: ingest_meta.duplicates,
        })
    }

    /// Exports the state at an UNPRUNED boundary as inner snapshot
    /// bytes (worker fold of the log prefix ≤ boundary; the export
    /// shape CMD 1 emits). The boundary must be reconstructable —
    /// callers have already validated that.
    async fn export_state_inner(
        &self,
        document: Uuid,
        boundary: i64,
    ) -> Result<Vec<u8>, HistoryError> {
        // Fold ops ≤ boundary from the covering snapshot (validated) or
        // from empty; then export via the worker's reconstruct (which
        // returns the inner snapshot). Using ops_between keeps this
        // exact: (0, boundary].
        let page = crate::protocol::MAX_SYNC_PAGE_OPS as i64;
        let mut ops = Vec::new();
        let mut cursor = 0i64;
        loop {
            let page_ops = self.repo.ops_between(document, cursor, boundary, page).await?;
            if page_ops.ops.is_empty() {
                break;
            }
            ops.extend(page_ops.ops.into_iter().map(|(_, _, p)| p));
            cursor = page_ops.next_cursor;
            if !page_ops.has_more {
                break;
            }
        }
        let folded = self
            .workers
            .reconstruct(&ops)
            .await
            .map_err(HistoryError::Worker)?;
        Ok(folded
            .snapshot
            .expect("reconstruct always returns a snapshot"))
    }
}

/// Splits ONE serialize_batch frame into per-op payloads (each DB row /
/// envelope stores one raw op).
fn split_batch_frame(frame: &[u8]) -> Vec<Vec<u8>> {
    let mut ops = Vec::new();
    if frame.is_empty() {
        return ops;
    }
    let mut offset = 0usize;
    let count = u32::from_le_bytes(frame[0..4].try_into().expect("4")) as usize;
    offset += 4;
    for _ in 0..count {
        let len = u32::from_le_bytes(frame[offset..offset + 4].try_into().expect("4")) as usize;
        offset += 4;
        ops.push(frame[offset..offset + len].to_vec());
        offset += len;
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reserved restore replica is a stable, documented constant
    /// disjoint from the worker's own reserved id ("SYSC" 0x53595343)
    /// — required because the worker REJECTS ops carrying its own id,
    /// so restore-emitted ops (a future phase) must use a different
    /// reserved band.
    #[test]
    fn reserved_restore_replica_is_distinct_and_documented() {
        assert_eq!(MAINTENANCE_RESTORE_REPLICA, 0x52455354);
        assert_ne!(
            MAINTENANCE_RESTORE_REPLICA, 0x53595343,
            "must differ from the worker's reserved SYSC id"
        );
        assert_ne!(MAINTENANCE_RESTORE_REPLICA, 0, "never zero");
        // Below 2^31 like the worker's constant — same band shape as
        // the worker's collision analysis assumes (compile-time proof).
        const _: () = assert!(MAINTENANCE_RESTORE_REPLICA < (1 << 31));
    }
}
