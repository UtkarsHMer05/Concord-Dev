//! Repository: all gateway SQL (P3-M015, M018–M020).
//!
//! One module owns every statement — static strings, parameterized values,
//! never concatenation. Write authorization is rechecked inside the
//! ingestion transaction (P3-M037 policy: recheck on every batch).

use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::authz::{DocumentAccess, EffectiveRole, AUTHZ_QUERY};
use super::pool::PoolError;
use crate::protocol::envelope::OpEnvelope;

#[derive(Debug, thiserror::Error)]
pub enum RepoError {
    #[error(transparent)]
    Db(#[from] PoolError),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    /// The user resolved from the verified Clerk token has no users row.
    #[error("user not provisioned")]
    UserNotProvisioned,
    /// Document uuid form is invalid.
    #[error("invalid document id")]
    InvalidDocumentId,
    /// The user may not write this document (role recheck failed inside
    /// the ingestion transaction — P3-M037 recheck-per-write policy).
    #[error("write denied")]
    WriteDenied,
}

/// Concord user id (uuid) for a verified Clerk user id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserId(pub Uuid);

#[derive(Debug, Clone)]
pub struct GatewayRepo {
    pub db: super::Db,
}

/// Result of an idempotent operation-batch insert (M018/M019).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestResult {
    /// Identities that were newly committed by THIS call.
    pub newly_inserted: Vec<String>,
    /// Identities that already existed durably (duplicates resolved to the
    /// existing rows — never a second row).
    pub duplicates: Vec<String>,
    /// All operation identities in the committed batch, in order.
    pub all_ids: Vec<String>,
    /// Server sequence of the highest committed row (durable cursor).
    pub durable_cursor: i64,
}

/// One catch-up page of durable operations (M020).
#[derive(Debug, Clone)]
pub struct CatchupPage {
    pub ops: Vec<(String, i64, Vec<u8>)>, // (operation_id, server_seq, payload)
    pub next_cursor: i64,
    pub has_more: bool,
}

impl GatewayRepo {
    pub fn new(db: super::Db) -> Self {
        Self { db }
    }

    /// Resolves the Concord user (uuid) for a verified Clerk `sub`.
    pub async fn resolve_user(&self, clerk_user_id: &str) -> Result<UserId, RepoError> {
        let client = self.db.get().await?;
        let row = client
            .query_opt(
                "SELECT id FROM users WHERE clerk_user_id = $1 LIMIT 1",
                &[&clerk_user_id],
            )
            .await?;
        row.map(|r| UserId(r.get("id")))
            .ok_or(RepoError::UserNotProvisioned)
    }

    /// Effective-role authorization for one (user, document).
    /// `None` = deny/not-found (indistinguishable by design).
    pub async fn document_access(
        &self,
        user: UserId,
        document: Uuid,
    ) -> Result<Option<DocumentAccess>, RepoError> {
        let client = self.db.get().await?;
        let row = client.query_opt(AUTHZ_QUERY, &[&user.0, &document]).await?;
        let Some(row) = row else { return Ok(None) };
        let is_owner: bool = row.get("is_owner");
        let direct: Option<String> = row.get("direct_role");
        let org_member: bool = row.get("org_member");
        Ok(
            EffectiveRole::resolve(is_owner, direct.as_deref(), org_member)
                .map(|role| DocumentAccess { role }),
        )
    }

    /// Current durable high-water mark for a document (server sequence).
    pub async fn durable_cursor(&self, document: Uuid) -> Result<i64, RepoError> {
        let client = self.db.get().await?;
        let row = client
            .query_one(
                "SELECT COALESCE(MAX(id), 0) AS cursor FROM crdt_operations WHERE document_id = $1",
                &[&document],
            )
            .await?;
        Ok(row.get("cursor"))
    }

    /// Idempotent batch ingestion (M018/M019). One transaction:
    ///   1. recheck write authorization (P3-M037: every batch),
    ///   2. INSERT ... ON CONFLICT (document_id, operation_id) DO NOTHING,
    ///   3. report newly-inserted vs duplicates,
    ///   4. the returned durable_cursor exists only after COMMIT.
    ///
    /// A duplicate concurrent retry can never create a second row: the
    /// unique index enforces it (verified by integration tests).
    pub async fn ingest_batch(
        &self,
        user: UserId,
        document: Uuid,
        envelopes: &[OpEnvelope],
    ) -> Result<IngestResult, RepoError> {
        debug_assert!(
            !envelopes.is_empty(),
            "empty batches are rejected at decode"
        );

        let mut client = self.db.get().await?;
        let tx = client.transaction().await?;

        // 1. Write-authz recheck INSIDE the transaction (fresh snapshot).
        let row = tx.query_opt(AUTHZ_QUERY, &[&user.0, &document]).await?;
        let (is_owner, direct, org_member): (bool, Option<String>, bool) = match row {
            Some(r) => (r.get("is_owner"), r.get("direct_role"), r.get("org_member")),
            None => (false, None, false),
        };
        let Some(role) = EffectiveRole::resolve(is_owner, direct.as_deref(), org_member) else {
            return Err(RepoError::WriteDenied);
        };
        if !role.can_edit() {
            return Err(RepoError::WriteDenied);
        }

        let mut newly = Vec::with_capacity(envelopes.len());
        let mut dups = Vec::new();
        let mut all_ids = Vec::with_capacity(envelopes.len());
        let mut max_seq: i64 = 0;

        for env in envelopes {
            let op_id = env.identity.to_wire();
            let replica = env.identity.replica as i64;
            let seq = env.identity.counter as i64;
            let payload = env.bytes.clone();
            let checksum = hex_checksum(&payload);

            let inserted = tx
                .execute(
                    "INSERT INTO crdt_operations
                        (document_id, operation_id, replica_id, replica_sequence,
                         payload, payload_version, payload_checksum)
                     VALUES ($1::uuid, $2, $3, $4, $5, 1, $6)
                     ON CONFLICT (document_id, operation_id) DO NOTHING",
                    &[&document, &op_id, &replica, &seq, &payload, &checksum],
                )
                .await?;
            if inserted == 1 {
                newly.push(op_id.clone());
                // Fetch the assigned server sequence for the new row.
                let row = tx
                    .query_one(
                        "SELECT id FROM crdt_operations
                         WHERE document_id = $1 AND operation_id = $2",
                        &[&document, &op_id],
                    )
                    .await?;
                let seq_now: i64 = row.get("id");
                max_seq = max_seq.max(seq_now);
            } else {
                dups.push(op_id.clone());
            }
            all_ids.push(op_id);
        }

        // Durable cursor after the batch: max server seq in the document.
        let cursor_row = tx
            .query_one(
                "SELECT COALESCE(MAX(id), 0) AS cursor FROM crdt_operations WHERE document_id = $1",
                &[&document],
            )
            .await?;
        let durable_cursor: i64 = cursor_row.get("cursor");
        let _ = max_seq;

        tx.commit().await?;

        Ok(IngestResult {
            newly_inserted: newly,
            duplicates: dups,
            all_ids,
            durable_cursor,
        })
    }

    /// Bounded, deterministic catch-up page: ops with server seq strictly
    /// after `after_cursor`, ordered by seq, capped at `limit` (M020).
    /// `has_more` is true when another page exists past this one.
    pub async fn catchup_page(
        &self,
        document: Uuid,
        after_cursor: i64,
        limit: i64,
    ) -> Result<CatchupPage, RepoError> {
        let limit = limit.clamp(1, crate::protocol::MAX_SYNC_PAGE_OPS as i64);
        let client = self.db.get().await?;
        let rows = client
            .query(
                "SELECT operation_id, id, payload FROM crdt_operations
                 WHERE document_id = $1 AND id > $2
                 ORDER BY id ASC
                 LIMIT ($3::bigint + 1)",
                &[&document, &after_cursor, &limit],
            )
            .await?;

        let has_more = rows.len() as i64 > limit;
        let rows = if has_more {
            rows[..rows.len() - 1].to_vec()
        } else {
            rows
        };

        let ops = rows
            .into_iter()
            .map(|r| {
                let op_id: String = r.get("operation_id");
                let seq: i64 = r.get("id");
                let payload: Vec<u8> = r.get("payload");
                (op_id, seq, payload)
            })
            .collect::<Vec<_>>();
        let next_cursor = ops.last().map(|o| o.1).unwrap_or(after_cursor);
        Ok(CatchupPage {
            ops,
            next_cursor,
            has_more,
        })
    }

    /// Bounded page of operations with server seq in (after_cursor, up_to]
    /// for snapshot builds and history reconstruction (P5-M016/M035).
    /// Same ordering/paging contract as [`Self::catchup_page`]; the caller
    /// fixes the immutable upper boundary (`up_to`) up front so newer
    /// edits arriving mid-build can never leak into the stream.
    pub async fn ops_between(
        &self,
        document: Uuid,
        after_cursor: i64,
        up_to: i64,
        limit: i64,
    ) -> Result<CatchupPage, RepoError> {
        let limit = limit.clamp(1, crate::protocol::MAX_SYNC_PAGE_OPS as i64);
        if up_to <= after_cursor {
            return Ok(CatchupPage {
                ops: Vec::new(),
                next_cursor: after_cursor,
                has_more: false,
            });
        }
        let client = self.db.get().await?;
        let rows = client
            .query(
                "SELECT operation_id, id, payload FROM crdt_operations
                 WHERE document_id = $1 AND id > $2 AND id <= $3
                 ORDER BY id ASC
                 LIMIT ($4::bigint + 1)",
                &[&document, &after_cursor, &up_to, &limit],
            )
            .await?;
        let has_more = rows.len() as i64 > limit;
        let rows = if has_more {
            rows[..rows.len() - 1].to_vec()
        } else {
            rows
        };
        let ops = rows
            .into_iter()
            .map(|r| {
                let op_id: String = r.get("operation_id");
                let seq: i64 = r.get("id");
                let payload: Vec<u8> = r.get("payload");
                (op_id, seq, payload)
            })
            .collect::<Vec<_>>();
        let next_cursor = ops.last().map(|o| o.1).unwrap_or(after_cursor);
        Ok(CatchupPage {
            ops,
            next_cursor,
            has_more,
        })
    }
}

fn hex_checksum(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex::encode(digest)
}
