//! Typed snapshot repository (P5-M012/M013) — the only API surface that
//! reads/writes `crdt_snapshots` (schema frozen at gateway migration v2).
//!
//! Design anchors:
//! - docs/STORAGE.md §3.2 lifecycle: `building → verifying → finalized |
//!   failed`; `finalized → superseded` is a retention marking only. Every
//!   transition is a guarded compare-and-set UPDATE returning the affected
//!   row count — a lost race or wrong-state call yields `false`, never a
//!   corrupt state.
//! - FINALIZED is immutable and the ONLY state recovery may use (DEC-036).
//!   This module offers no payload-update path: payload is set exactly once
//!   at creation ([`SnapshotRepo::create_attempt`]); BUILDING rows are
//!   never read by recovery.
//! - DEC-035: the `payload` column stores the server wrapper bytes
//!   ([`wrapper`] module). `payload_checksum` (SHA-256 hex) and
//!   `payload_size` are computed INSIDE the repo at insert time — one
//!   single source of truth; callers cannot desynchronize them.
//! - M013 integrity: [`validate_integrity`] verifies, fail-closed and in
//!   order, format version, document identity, declared size, SHA-256
//!   checksum over the exact stored bytes, state-digest metadata shape,
//!   wrapper structure, and wrapper/row metadata agreement — WITHOUT
//!   parsing the inner payload (the C++ worker owns parsing).
//!
//! All SQL in this module is static strings with parameterized values;
//! no untrusted input is ever concatenated into a statement.

use std::time::SystemTime;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::pool::PoolError;

/// The only snapshot payload format this gateway understands (DEC-035:
/// server wrapper version 1 wrapping the unchanged C++ v1 inner snapshot).
/// Bumping this requires a new wrapper encoder/decoder plus a migration.
pub const SUPPORTED_FORMAT_VERSION: i16 = 1;

/// Required prefix of `state_digest` metadata (canonical CRDT digest).
pub const STATE_DIGEST_PREFIX: &str = "sha256:";

/// Upper bound for [`SnapshotRepo::list_historical`] pages. The listing is
/// an admin/debug surface — it still stays bounded off the hot path.
pub const MAX_HISTORY_LIMIT: i64 = 500;

#[derive(Debug, thiserror::Error)]
pub enum SnapshotIntegrityError {
    /// The row's `format_version` is not a version this gateway supports.
    /// Checked BEFORE any parsing attempt (invariant S1).
    #[error(
        "unsupported snapshot format version {found} (supported: {})",
        SUPPORTED_FORMAT_VERSION
    )]
    UnsupportedFormat { found: i16 },
    /// The row belongs to a different document than the caller requested
    /// (invariant S2 — wrong-association).
    #[error("snapshot document {row_document} does not match requested {expected_document}")]
    DocumentMismatch {
        row_document: Uuid,
        expected_document: Uuid,
    },
    /// Declared `payload_size` disagrees with the actual payload length.
    #[error("declared payload size {declared} != actual {actual}")]
    SizeMismatch { declared: i64, actual: i64 },
    /// SHA-256 over the stored payload bytes does not match the stored
    /// checksum (invariant S4 — one-bit flip ⇒ reject).
    #[error("payload checksum mismatch (stored {expected}, computed {computed})")]
    ChecksumMismatch { expected: String, computed: String },
    /// `state_digest` metadata is not canonically shaped.
    #[error(
        "state digest metadata invalid: expected '{STATE_DIGEST_PREFIX}' prefix, found {found:?}"
    )]
    InvalidDigestMetadata { found: String },
    /// The payload is not a structurally valid server wrapper.
    #[error("malformed snapshot wrapper: {reason}")]
    MalformedWrapper { reason: String },
    /// The wrapper's embedded metadata disagrees with the row metadata —
    /// the signature of a row/payload swap attack (SA-SEC5 concern).
    #[error("wrapper/row metadata mismatch on {field} (row/payload swap suspected)")]
    MetadataMismatch { field: &'static str },
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotRepoError {
    #[error(transparent)]
    Db(#[from] PoolError),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    /// The candidate payload failed M013 integrity validation (fail-closed).
    #[error(transparent)]
    Integrity(#[from] SnapshotIntegrityError),
}

/// Snapshot lifecycle states (docs/STORAGE.md §3.2). The SQL guards inline
/// the literal strings; these constants exist for callers and tests reading
/// [`SnapshotRow::status`].
pub mod status {
    pub const BUILDING: &str = "building";
    pub const VERIFYING: &str = "verifying";
    pub const FINALIZED: &str = "finalized";
    pub const FAILED: &str = "failed";
    pub const SUPERSEDED: &str = "superseded";
}

/// Server snapshot wrapper (DEC-035). The `payload` column stores exactly
/// these bytes:
///
/// ```text
/// [u8  format_version = 1]
/// [16B  document uuid]
/// [u64  coverage_seq    LE]
/// [u64  covered_op_count LE]
/// [u64  inner_len       LE]
/// [inner payload bytes ...]
/// ```
///
/// The DB-level `payload_checksum` column (SHA-256 hex, CHAR(64)) covers
/// the ENTIRE wrapper payload as stored. The inner payload is the Phase 2
/// `Doc::export_snapshot()` byte string, VERBATIM — this module never
/// parses it (the C++ worker owns parsing).
pub mod wrapper {
    use uuid::Uuid;

    use super::SnapshotIntegrityError;

    /// Wrapper byte layout: 1 (version) + 16 (uuid) + 8 + 8 + 8 (LE u64s).
    const HEADER_LEN: usize = 41;

    /// The wrapper format version this module encodes/accepts.
    pub const WRAPPER_FORMAT_VERSION: u8 = 1;

    /// Decoded wrapper fields (inner payload kept opaque).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct WrapperParts {
        pub format_version: u8,
        pub document_id: Uuid,
        pub coverage_seq: u64,
        pub covered_op_count: u64,
        pub inner: Vec<u8>,
    }

    /// Encodes the server wrapper around the unchanged C++ v1 inner
    /// snapshot bytes. All integers little-endian, matching the native
    /// worker protocol conventions.
    pub fn encode_wrapper(
        document_id: Uuid,
        coverage_seq: u64,
        covered_op_count: u64,
        inner: &[u8],
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + inner.len());
        out.push(WRAPPER_FORMAT_VERSION);
        out.extend_from_slice(document_id.as_bytes());
        out.extend_from_slice(&coverage_seq.to_le_bytes());
        out.extend_from_slice(&covered_op_count.to_le_bytes());
        out.extend_from_slice(&(inner.len() as u64).to_le_bytes());
        out.extend_from_slice(inner);
        out
    }

    /// Decodes the server wrapper, validating all lengths. `inner_len`
    /// must equal the remaining bytes EXACTLY — trailing bytes after the
    /// inner payload are a corruption signal, not a tolerance.
    pub fn decode_wrapper(bytes: &[u8]) -> Result<WrapperParts, SnapshotIntegrityError> {
        if bytes.len() < HEADER_LEN {
            return Err(SnapshotIntegrityError::MalformedWrapper {
                reason: format!("header truncated: {} of {HEADER_LEN} bytes", bytes.len()),
            });
        }
        let format_version = bytes[0];
        if format_version != WRAPPER_FORMAT_VERSION {
            return Err(SnapshotIntegrityError::UnsupportedFormat {
                found: format_version as i16,
            });
        }
        let document_id = Uuid::from_slice(&bytes[1..17]).map_err(|_| {
            SnapshotIntegrityError::MalformedWrapper {
                reason: "invalid document uuid bytes".into(),
            }
        })?;
        let coverage_seq = read_u64_le(bytes, 17);
        let covered_op_count = read_u64_le(bytes, 25);
        let inner_len = read_u64_le(bytes, 33);

        // Exact-length contract: total = 41 + inner_len, checked with
        // overflow safety so a hostile inner_len cannot wrap.
        let total = (HEADER_LEN as u64).checked_add(inner_len).ok_or(
            SnapshotIntegrityError::MalformedWrapper {
                reason: format!("inner length {inner_len} overflows the wrapper"),
            },
        )?;
        match (bytes.len() as u64).cmp(&total) {
            std::cmp::Ordering::Less => {
                return Err(SnapshotIntegrityError::MalformedWrapper {
                    reason: format!(
                        "inner payload truncated: {} of {total} bytes",
                        bytes.len() - HEADER_LEN
                    ),
                });
            }
            std::cmp::Ordering::Greater => {
                return Err(SnapshotIntegrityError::MalformedWrapper {
                    reason: format!(
                        "{} trailing bytes after inner payload",
                        bytes.len() as u64 - total
                    ),
                });
            }
            std::cmp::Ordering::Equal => {}
        }

        Ok(WrapperParts {
            format_version,
            document_id,
            coverage_seq,
            covered_op_count,
            inner: bytes[HEADER_LEN..].to_vec(),
        })
    }

    /// Reads a little-endian u64 at `at`. Only called after the
    /// header-length check, so the slice is always in bounds.
    fn read_u64_le(bytes: &[u8], at: usize) -> u64 {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&bytes[at..at + 8]);
        u64::from_le_bytes(buf)
    }
}

/// Result of [`SnapshotRepo::create_attempt`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotAttempt {
    /// Public id of the new BUILDING attempt row.
    pub snapshot_id: Uuid,
    /// Attempt number persisted with the row (1-based per boundary).
    pub attempt: i32,
}

/// One full `crdt_snapshots` row, payload included. `state_summary` is
/// carried as the JSON text form (jsonb is parsed by the caller if
/// needed); everything else is typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRow {
    pub snapshot_id: Uuid,
    pub document_id: Uuid,
    pub format_version: i16,
    pub coverage_seq: i64,
    pub covered_op_count: i64,
    pub state_digest: String,
    /// JSON text of the `state_summary` jsonb column.
    pub state_summary: String,
    /// The stored server wrapper bytes (DEC-035), exactly as written.
    pub payload: Vec<u8>,
    pub payload_size: i64,
    /// SHA-256 hex over `payload` as stored (64 chars).
    pub payload_checksum: String,
    /// Lifecycle state (`status` column; see [`status`] constants).
    pub status: String,
    pub job_id: Option<Uuid>,
    pub attempt: i32,
    pub created_at: SystemTime,
    pub finalized_at: Option<SystemTime>,
}

/// A snapshot row that passed the full M013 integrity matrix. `inner` is
/// the unmodified C++ v1 snapshot byte string (ready for the native
/// worker); the identity fields are the row metadata, cross-checked
/// against the wrapper.
#[derive(Debug, Clone)]
pub struct ValidatedSnapshot {
    pub snapshot_id: Uuid,
    pub document_id: Uuid,
    pub format_version: i16,
    pub coverage_seq: i64,
    pub covered_op_count: i64,
    pub attempt: i32,
    pub state_digest: String,
    pub payload_checksum: String,
    /// The C++ v1 snapshot bytes extracted from the wrapper.
    pub inner: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SnapshotRepo {
    pub db: super::Db,
}

impl SnapshotRepo {
    pub fn new(db: super::Db) -> Self {
        Self { db }
    }

    /// Creates a new BUILDING attempt for (document, coverage_seq, attempt).
    ///
    /// `payload_bytes` must already be the complete server wrapper
    /// (DEC-035; see [`wrapper::encode_wrapper`]). The repo is the single
    /// source of truth for the derived columns — `payload_checksum`
    /// (SHA-256 hex over the exact stored bytes), `payload_size`, and
    /// `format_version` (always [`SUPPORTED_FORMAT_VERSION`]) are computed
    /// here and never accepted from the caller.
    ///
    /// The wrapper is decoded and cross-checked against the
    /// (document_id, coverage_seq, covered_op_count) arguments, and the
    /// `state_digest` prefix is validated, BEFORE the insert — a
    /// self-inconsistent attempt is rejected, never persisted.
    ///
    /// Payload immutability (docs/STORAGE.md §3.2, DEC-036): payload is
    /// set exactly once at creation; no update path exists for any
    /// payload-bearing column. FINALIZED immutability is enforced by this
    /// API surface plus the status guards, and BUILDING rows are never
    /// read by recovery.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_attempt(
        &self,
        document_id: Uuid,
        coverage_seq: i64,
        covered_op_count: i64,
        job_id: Uuid,
        attempt: i32,
        state_digest: &str,
        state_summary_json: &str,
        payload_bytes: &[u8],
    ) -> Result<SnapshotAttempt, SnapshotRepoError> {
        // Fail closed at the write boundary: never persist a payload that
        // disagrees with its own metadata.
        let parts = wrapper::decode_wrapper(payload_bytes)?;
        if parts.document_id != document_id {
            return Err(SnapshotRepoError::Integrity(
                SnapshotIntegrityError::MetadataMismatch {
                    field: "document_id",
                },
            ));
        }
        if parts.coverage_seq != coverage_seq as u64 {
            return Err(SnapshotRepoError::Integrity(
                SnapshotIntegrityError::MetadataMismatch {
                    field: "coverage_seq",
                },
            ));
        }
        if parts.covered_op_count != covered_op_count as u64 {
            return Err(SnapshotRepoError::Integrity(
                SnapshotIntegrityError::MetadataMismatch {
                    field: "covered_op_count",
                },
            ));
        }
        if !state_digest.starts_with(STATE_DIGEST_PREFIX) {
            return Err(SnapshotRepoError::Integrity(
                SnapshotIntegrityError::InvalidDigestMetadata {
                    found: state_digest.to_string(),
                },
            ));
        }

        // Derived columns: computed here, never caller-supplied.
        let payload_checksum = hex_checksum(payload_bytes);
        let payload_size = payload_bytes.len() as i64;
        let snapshot_id = Uuid::new_v4();

        let client = self.db.get().await?;
        let row = client
            .query_one(
                "INSERT INTO crdt_snapshots
                    (snapshot_id, document_id, format_version, coverage_seq,
                     covered_op_count, state_digest, state_summary, payload,
                     payload_size, payload_checksum, status, job_id, attempt)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10,
                         'building', $11, $12)
                 RETURNING snapshot_id, attempt",
                &[
                    &snapshot_id,
                    &document_id,
                    &SUPPORTED_FORMAT_VERSION,
                    &coverage_seq,
                    &covered_op_count,
                    &state_digest,
                    &state_summary_json,
                    &payload_bytes,
                    &payload_size,
                    &payload_checksum,
                    &job_id,
                    &attempt,
                ],
            )
            .await?;
        Ok(SnapshotAttempt {
            snapshot_id: row.get("snapshot_id"),
            attempt: row.get("attempt"),
        })
    }

    /// `building → verifying` (guarded compare-and-set).
    /// Returns `false` when no row matched (missing, or wrong state).
    pub async fn transition_building_to_verifying(
        &self,
        snapshot_id: Uuid,
    ) -> Result<bool, SnapshotRepoError> {
        let client = self.db.get().await?;
        let rows = client
            .execute(
                "UPDATE crdt_snapshots SET status = 'verifying'
                 WHERE snapshot_id = $1 AND status = 'building'",
                &[&snapshot_id],
            )
            .await?;
        Ok(rows > 0)
    }

    /// `verifying → finalized` (guarded compare-and-set).
    ///
    /// M012 semantics: the guard is the snapshot state alone. When
    /// `expected_claim_version` is `Some(v)`, the update additionally
    /// requires a `maintenance_jobs` row for the snapshot's job with
    /// exactly that `claim_version` (lease fence, fail-closed when no job
    /// row matches). Full lease-ownership fencing integrates at M018;
    /// the parameter exists now so the M018 call sites cannot forget it.
    ///
    /// FINALIZED rows are immutable: the only further transition is
    /// [`SnapshotRepo::mark_superseded`] (retention marking).
    pub async fn finalize(
        &self,
        snapshot_id: Uuid,
        expected_claim_version: Option<i64>,
    ) -> Result<bool, SnapshotRepoError> {
        let client = self.db.get().await?;
        let rows = client
            .execute(
                "UPDATE crdt_snapshots s
                 SET status = 'finalized', finalized_at = now()
                 WHERE s.snapshot_id = $1
                   AND s.status = 'verifying'
                   AND ($2::bigint IS NULL
                        OR EXISTS (SELECT 1 FROM maintenance_jobs j
                                   WHERE j.job_id = s.job_id
                                     AND j.claim_version = $2::bigint))",
                &[&snapshot_id, &expected_claim_version],
            )
            .await?;
        Ok(rows > 0)
    }

    /// `building | verifying → failed` (guarded compare-and-set).
    ///
    /// There is no failure-reason column (schema frozen at v2), so the
    /// reason is recorded as a structured warning — the retryable attempt
    /// history lives in `maintenance_jobs` (M018). Returns `false` when
    /// no row matched (missing, or already finalized/superseded/failed).
    pub async fn fail(&self, snapshot_id: Uuid, reason: &str) -> Result<bool, SnapshotRepoError> {
        let client = self.db.get().await?;
        let rows = client
            .execute(
                "UPDATE crdt_snapshots SET status = 'failed'
                 WHERE snapshot_id = $1 AND status IN ('building', 'verifying')",
                &[&snapshot_id],
            )
            .await?;
        if rows > 0 {
            tracing::warn!(
                snapshot_id = %snapshot_id,
                reason = %reason,
                "snapshot attempt failed (terminal for this attempt)"
            );
        }
        Ok(rows > 0)
    }

    /// `finalized → superseded` — retention marking ONLY; the payload is
    /// retained until retention policy allows deletion. Returns `false`
    /// when the row is not FINALIZED (only finalized rows may be marked).
    pub async fn mark_superseded(&self, snapshot_id: Uuid) -> Result<bool, SnapshotRepoError> {
        let client = self.db.get().await?;
        let rows = client
            .execute(
                "UPDATE crdt_snapshots SET status = 'superseded'
                 WHERE snapshot_id = $1 AND status = 'finalized'",
                &[&snapshot_id],
            )
            .await?;
        Ok(rows > 0)
    }

    /// Newest FINALIZED snapshot for a document (recovery entry point —
    /// the only state recovery may read, DEC-036). Ties on coverage_seq
    /// break by newest attempt, deterministically.
    pub async fn latest_finalized(
        &self,
        document_id: Uuid,
    ) -> Result<Option<SnapshotRow>, SnapshotRepoError> {
        let client = self.db.get().await?;
        let row = client
            .query_opt(
                "SELECT snapshot_id, document_id, format_version, coverage_seq,
                        covered_op_count, state_digest,
                        state_summary::text AS state_summary, payload,
                        payload_size, payload_checksum, status, job_id,
                        attempt, created_at, finalized_at
                 FROM crdt_snapshots
                 WHERE document_id = $1 AND status = 'finalized'
                 ORDER BY coverage_seq DESC, attempt DESC
                 LIMIT 1",
                &[&document_id],
            )
            .await?;
        Ok(row.map(|r| row_to_snapshot(&r)))
    }

    /// Newest FINALIZED snapshot with `coverage_seq <= seq` — inclusive
    /// boundary: a snapshot taken exactly at `seq` covers the requested
    /// state (revision/history reconstruction).
    pub async fn latest_finalized_before(
        &self,
        document_id: Uuid,
        seq: i64,
    ) -> Result<Option<SnapshotRow>, SnapshotRepoError> {
        let client = self.db.get().await?;
        let row = client
            .query_opt(
                "SELECT snapshot_id, document_id, format_version, coverage_seq,
                        covered_op_count, state_digest,
                        state_summary::text AS state_summary, payload,
                        payload_size, payload_checksum, status, job_id,
                        attempt, created_at, finalized_at
                 FROM crdt_snapshots
                 WHERE document_id = $1 AND status = 'finalized'
                   AND coverage_seq <= $2
                 ORDER BY coverage_seq DESC, attempt DESC
                 LIMIT 1",
                &[&document_id, &seq],
            )
            .await?;
        Ok(row.map(|r| row_to_snapshot(&r)))
    }

    /// One snapshot by public id, ANY status (admin/verify paths).
    /// Recovery paths must use `latest_finalized*` instead.
    pub async fn get_by_snapshot_id(
        &self,
        snapshot_id: Uuid,
    ) -> Result<Option<SnapshotRow>, SnapshotRepoError> {
        let client = self.db.get().await?;
        let row = client
            .query_opt(
                "SELECT snapshot_id, document_id, format_version, coverage_seq,
                        covered_op_count, state_digest,
                        state_summary::text AS state_summary, payload,
                        payload_size, payload_checksum, status, job_id,
                        attempt, created_at, finalized_at
                 FROM crdt_snapshots
                 WHERE snapshot_id = $1",
                &[&snapshot_id],
            )
            .await?;
        Ok(row.map(|r| row_to_snapshot(&r)))
    }

    /// All snapshots for a document, newest coverage first (admin/debug).
    /// The limit is clamped to 1..=[`MAX_HISTORY_LIMIT`].
    pub async fn list_historical(
        &self,
        document_id: Uuid,
        limit: i64,
    ) -> Result<Vec<SnapshotRow>, SnapshotRepoError> {
        let limit = limit.clamp(1, MAX_HISTORY_LIMIT);
        let client = self.db.get().await?;
        let rows = client
            .query(
                "SELECT snapshot_id, document_id, format_version, coverage_seq,
                        covered_op_count, state_digest,
                        state_summary::text AS state_summary, payload,
                        payload_size, payload_checksum, status, job_id,
                        attempt, created_at, finalized_at
                 FROM crdt_snapshots
                 WHERE document_id = $1
                 ORDER BY coverage_seq DESC, attempt DESC
                 LIMIT $2",
                &[&document_id, &limit],
            )
            .await?;
        Ok(rows.iter().map(row_to_snapshot).collect())
    }

    /// Method form of the M013 gate (delegates to [`validate_integrity`]).
    /// Exists so pipeline-style call sites can chain off the repo handle;
    /// the free function remains the canonical entry point.
    pub fn validate_integrity(
        &self,
        row: &SnapshotRow,
        expected_document_id: Uuid,
    ) -> Result<ValidatedSnapshot, SnapshotRepoError> {
        validate_integrity(row, expected_document_id).map_err(SnapshotRepoError::from)
    }
}

/// The M013 integrity matrix — the gate every recovery candidate must
/// pass, in fail-closed order:
///
/// 1. `format_version` is a supported version (S1) — before ANY parse;
/// 2. row `document_id` matches the requested document (S2);
/// 3. `payload_size` == actual payload length;
/// 4. SHA-256(payload) hex == stored `payload_checksum` (S4);
/// 5. `state_digest` carries the canonical prefix;
/// 6. the payload decodes as a structurally valid server wrapper;
/// 7. the wrapper's document/coverage/count agree with the row metadata
///    (row/payload swap defense, SA-SEC5).
///
/// None of this parses the inner payload — the C++ worker owns parsing.
/// Any failed check fails CLOSED: the caller must fall back to an older
/// FINALIZED snapshot or full replay (docs/STORAGE.md S10).
pub fn validate_integrity(
    row: &SnapshotRow,
    expected_document_id: Uuid,
) -> Result<ValidatedSnapshot, SnapshotIntegrityError> {
    // 1. Format gate (S1): known and supported before any parse.
    if row.format_version != SUPPORTED_FORMAT_VERSION {
        return Err(SnapshotIntegrityError::UnsupportedFormat {
            found: row.format_version,
        });
    }
    // 2. Document identity (S2).
    if row.document_id != expected_document_id {
        return Err(SnapshotIntegrityError::DocumentMismatch {
            row_document: row.document_id,
            expected_document: expected_document_id,
        });
    }
    // 3. Declared size must equal the actual stored length.
    let actual_size = row.payload.len() as i64;
    if row.payload_size != actual_size {
        return Err(SnapshotIntegrityError::SizeMismatch {
            declared: row.payload_size,
            actual: actual_size,
        });
    }
    // 4. Checksum over the exact stored bytes (S4): one-bit flip ⇒ reject.
    let computed = hex_checksum(&row.payload);
    if row.payload_checksum != computed {
        return Err(SnapshotIntegrityError::ChecksumMismatch {
            expected: row.payload_checksum.clone(),
            computed,
        });
    }
    // 5. State-digest metadata shape.
    if !row.state_digest.starts_with(STATE_DIGEST_PREFIX) {
        return Err(SnapshotIntegrityError::InvalidDigestMetadata {
            found: row.state_digest.clone(),
        });
    }
    // 6. Wrapper structure (still no inner parsing).
    let parts = wrapper::decode_wrapper(&row.payload)?;
    // 7. Wrapper/row metadata agreement — row/payload swap defense.
    if parts.document_id != row.document_id {
        return Err(SnapshotIntegrityError::MetadataMismatch {
            field: "document_id",
        });
    }
    if parts.coverage_seq != row.coverage_seq as u64 {
        return Err(SnapshotIntegrityError::MetadataMismatch {
            field: "coverage_seq",
        });
    }
    if parts.covered_op_count != row.covered_op_count as u64 {
        return Err(SnapshotIntegrityError::MetadataMismatch {
            field: "covered_op_count",
        });
    }

    Ok(ValidatedSnapshot {
        snapshot_id: row.snapshot_id,
        document_id: row.document_id,
        format_version: row.format_version,
        coverage_seq: row.coverage_seq,
        covered_op_count: row.covered_op_count,
        attempt: row.attempt,
        state_digest: row.state_digest.clone(),
        payload_checksum: row.payload_checksum.clone(),
        inner: parts.inner,
    })
}

/// Maps a fetched row to the typed [`SnapshotRow`]. The status string is
/// stored verbatim (the DB CHECK constraint is its authority); see the
/// [`status`] constants.
fn row_to_snapshot(row: &tokio_postgres::Row) -> SnapshotRow {
    SnapshotRow {
        snapshot_id: row.get("snapshot_id"),
        document_id: row.get("document_id"),
        format_version: row.get("format_version"),
        coverage_seq: row.get("coverage_seq"),
        covered_op_count: row.get("covered_op_count"),
        state_digest: row.get("state_digest"),
        state_summary: row.get("state_summary"),
        payload: row.get("payload"),
        payload_size: row.get("payload_size"),
        payload_checksum: row.get("payload_checksum"),
        status: row.get("status"),
        job_id: row.get("job_id"),
        attempt: row.get("attempt"),
        created_at: row.get("created_at"),
        finalized_at: row.get("finalized_at"),
    }
}

/// SHA-256 hex digest of the exact bytes (single checksum authority for
/// both the insert path and integrity validation).
fn hex_checksum(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
