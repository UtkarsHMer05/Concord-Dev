//! A review branch is an ordinary, separately authorized CRDT document. The
//! base is frozen here; selected forward edits and their provenance commit in
//! one transaction under the same locks as normal WebSocket ingestion.
use super::branch_merge;
use super::history::{split_batch_frame, HistoryError, RevisionService};
use crate::db::authz::{EffectiveRole, AUTHZ_QUERY};
use crate::db::repo::{GatewayRepo, UserId};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum BranchError {
    #[error(transparent)]
    History(#[from] HistoryError),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    #[error(transparent)]
    Pool(#[from] crate::db::pool::PoolError),
    #[error(transparent)]
    Repo(#[from] crate::db::repo::RepoError),
    #[error(transparent)]
    Worker(#[from] crate::worker::WorkerError),
    #[error("not_found")]
    NotFound,
    #[error("invalid_request")]
    Invalid,
    #[error("review_is_stale")]
    Stale,
    #[error("request_id_conflicts")]
    RetryConflict,
    #[error("resolve_conflict_explicitly")]
    Conflict,
    #[error("review_too_large")]
    TooLarge,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBranch {
    pub branch_id: Uuid,
    pub base_revision_id: Uuid,
    pub name: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeRequest {
    pub request_id: Uuid,
    pub expected_main_seq: String,
    pub expected_branch_seq: String,
    pub selections: Vec<Selection>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub id: String,
    pub resolution: String,
}

pub struct MergeOutcome {
    pub response: Value,
    pub committed_ops: Vec<Vec<u8>>,
    pub durable_cursor: i64,
}

pub struct BranchService {
    pub history: RevisionService,
}

async fn access(
    tx: &Transaction<'_>,
    actor: UserId,
    document: Uuid,
    edit: bool,
) -> Result<EffectiveRole, BranchError> {
    let row = tx
        .query_opt(AUTHZ_QUERY, &[&actor.0, &document])
        .await?
        .ok_or(BranchError::NotFound)?;
    let role = EffectiveRole::resolve(
        row.get("is_owner"),
        row.get::<_, Option<String>>("direct_role").as_deref(),
        row.get("org_member"),
    )
    .ok_or(BranchError::NotFound)?;
    if edit && !role.can_edit() {
        return Err(BranchError::NotFound);
    }
    Ok(role)
}

async fn lock(tx: &Transaction<'_>, document: Uuid) -> Result<(), BranchError> {
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        &[&document.to_string()],
    )
    .await?;
    Ok(())
}

async fn cursor(tx: &Transaction<'_>, document: Uuid) -> Result<i64, BranchError> {
    Ok(tx
        .query_one(crate::db::repo::DURABLE_CURSOR_QUERY, &[&document])
        .await?
        .get("cursor"))
}

fn branch_json(row: &Row) -> Value {
    json!({ "documentId": row.get::<_, Uuid>("document_id"), "mainDocumentId": row.get::<_, Uuid>("main_document_id"),
        "baseRevisionId": row.get::<_, Uuid>("base_revision_id"), "baseSeq": row.get::<_, i64>("base_seq").to_string(),
        "baseDigest": row.get::<_, String>("base_digest"), "name": row.get::<_, String>("name"),
        "createdBy": row.get::<_, Uuid>("created_by") })
}

fn merge_json(row: &Row) -> Value {
    json!({"mergeId": row.get::<_, Uuid>("id"), "sourceRevisionId": row.get::<_, Uuid>("source_revision_id"),
        "resultRevisionId": row.get::<_, Uuid>("result_revision_id"), "baseRevisionId": row.get::<_, Uuid>("base_revision_id"),
        "resultSeq": row.get::<_, i64>("result_seq").to_string(), "actorId": row.get::<_, Uuid>("actor_id"),
        "request": row.get::<_, Value>("request") })
}

fn request_json(request: &MergeRequest) -> Value {
    json!({"expectedMainSeq":request.expected_main_seq,"expectedBranchSeq":request.expected_branch_seq,
        "selections":request.selections.iter().map(|s|json!({"id":s.id,"resolution":s.resolution})).collect::<Vec<_>>()})
}

fn blocks(value: &Value) -> Result<&[Value], BranchError> {
    let blocks = value["blocks"].as_array().ok_or(BranchError::Invalid)?;
    if blocks.len() > 2000
        || serde_json::to_vec(value)
            .map_err(|_| BranchError::Invalid)?
            .len()
            > 2 * 1024 * 1024
    {
        return Err(BranchError::TooLarge);
    }
    Ok(blocks)
}

impl BranchService {
    pub async fn list(&self, document: Uuid, actor: UserId) -> Result<Value, BranchError> {
        let mut client = self.history.repo.db.get().await?;
        let tx = client.transaction().await?;
        access(&tx, actor, document, false).await?;
        let source = tx
            .query_opt(
                "SELECT * FROM review_branches WHERE document_id=$1",
                &[&document],
            )
            .await?;
        let rows = tx.query("SELECT * FROM review_branches WHERE main_document_id=$1 ORDER BY created_at DESC LIMIT 100", &[&document]).await?;
        let mut visible = vec![];
        for row in rows {
            if access(&tx, actor, row.get("document_id"), false)
                .await
                .is_ok()
            {
                visible.push(branch_json(&row));
            }
        }
        Ok(json!({"branches":visible,"sourceBranch":source.as_ref().map(branch_json)}))
    }

    pub async fn create(
        &self,
        main: Uuid,
        actor: UserId,
        input: CreateBranch,
    ) -> Result<Value, BranchError> {
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > 120 || main == input.branch_id {
            return Err(BranchError::Invalid);
        }
        self.history
            .repo
            .document_access(actor, main)
            .await?
            .filter(|r| r.edit())
            .ok_or(BranchError::NotFound)?;
        {
            let mut client = self.history.repo.db.get().await?;
            let tx = client.transaction().await?;
            if let Some(row) = tx
                .query_opt(
                    "SELECT * FROM review_branches WHERE document_id=$1",
                    &[&input.branch_id],
                )
                .await?
            {
                access(&tx, actor, main, true).await?;
                access(&tx, actor, input.branch_id, false).await?;
                if row.get::<_, Uuid>("main_document_id") != main
                    || row.get::<_, Uuid>("created_by") != actor.0
                    || row.get::<_, Uuid>("base_revision_id") != input.base_revision_id
                    || row.get::<_, String>("name") != name
                {
                    return Err(BranchError::RetryConflict);
                }
                return Ok(branch_json(&row));
            }
        }
        let state = self
            .history
            .revision_content(main, actor, input.base_revision_id)
            .await?;
        let base = self
            .history
            .export_state_inner(main, state.boundary)
            .await?;
        blocks(&state.visible_content)?;
        let empty = self
            .history
            .workers
            .reconstruct(&[])
            .await?
            .snapshot
            .ok_or(BranchError::Invalid)?;
        let diff = self.history.workers.restore_diff(&empty, &base).await?;
        let envelopes = split_batch_frame(&diff.batch)
            .iter()
            .map(|p| crate::protocol::envelope::validate_op(p).map_err(|_| BranchError::Invalid))
            .collect::<Result<Vec<_>, _>>()?;
        let mut client = self.history.repo.db.get().await?;
        let tx = client.transaction().await?;
        lock(&tx, main).await?;
        access(&tx, actor, main, true).await?;
        if tx
            .query_opt(
                "SELECT 1 FROM review_branches WHERE document_id=$1",
                &[&main],
            )
            .await?
            .is_some()
        {
            return Err(BranchError::Invalid);
        }
        if let Some(row) = tx
            .query_opt(
                "SELECT * FROM review_branches WHERE document_id=$1",
                &[&input.branch_id],
            )
            .await?
        {
            if row.get::<_, Uuid>("created_by") != actor.0
                || row.get::<_, Uuid>("base_revision_id") != input.base_revision_id
                || row.get::<_, String>("name") != name
                || row.get::<_, Uuid>("main_document_id") != main
            {
                return Err(BranchError::RetryConflict);
            }
            return Ok(branch_json(&row));
        }
        if tx
            .query_one(
                "SELECT count(*)::bigint FROM review_branches WHERE main_document_id=$1",
                &[&main],
            )
            .await?
            .get::<_, i64>(0)
            >= 100
        {
            return Err(BranchError::TooLarge);
        }
        let owner: Uuid = tx
            .query_one("SELECT owner_user_id FROM documents WHERE id=$1", &[&main])
            .await?
            .get(0);
        // Branch grants are explicit: organization-wide edit access is never inherited.
        tx.execute(
            "INSERT INTO documents(id,title,owner_user_id) VALUES($1,$2,$3)",
            &[&input.branch_id, &name, &actor.0],
        )
        .await?;
        if owner != actor.0 {
            tx.execute("INSERT INTO document_user_permissions(document_id,user_id,role,granted_by_user_id) VALUES($1,$2,'EDITOR',$3)", &[&input.branch_id,&owner,&actor.0]).await?;
        }
        GatewayRepo::ingest_batch_in_tx(&tx, actor, input.branch_id, &envelopes, false).await?;
        let row = tx.query_one("INSERT INTO review_branches(document_id,main_document_id,base_revision_id,base_seq,base_digest,base_content,name,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
            &[&input.branch_id,&main,&input.base_revision_id,&state.boundary,&state.state_digest,&state.visible_content,&name,&actor.0]).await?;
        tx.execute("INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,'document.branch.created','document',$2,$3)",
            &[&actor.0,&input.branch_id.to_string(),&json!({"mainDocumentId":main,"baseRevisionId":input.base_revision_id})]).await?;
        tx.commit().await?;
        Ok(branch_json(&row))
    }

    pub async fn compare(
        &self,
        main: Uuid,
        branch: Uuid,
        actor: UserId,
    ) -> Result<Value, BranchError> {
        let row = {
            let mut client = self.history.repo.db.get().await?;
            let tx = client.transaction().await?;
            access(&tx, actor, main, false).await?;
            access(&tx, actor, branch, false).await?;
            tx.query_opt(
                "SELECT * FROM review_branches WHERE document_id=$1 AND main_document_id=$2",
                &[&branch, &main],
            )
            .await?
            .ok_or(BranchError::NotFound)?
        };
        let main_seq = self.history.repo.durable_cursor(main).await?;
        let branch_seq = self.history.repo.durable_cursor(branch).await?;
        let (main_digest, _, current) = self.history.visible_at_boundary(main, main_seq).await?;
        let (branch_digest, _, source) =
            self.history.visible_at_boundary(branch, branch_seq).await?;
        let base: Value = row.get("base_content");
        let changes = branch_merge::plan(blocks(&base)?, blocks(&current)?, blocks(&source)?);
        let mut client = self.history.repo.db.get().await?;
        let tx = client.transaction().await?;
        let can_merge = access(&tx, actor, main, false).await?.can_edit();
        access(&tx, actor, branch, false).await?;
        let merges = tx.query("SELECT * FROM review_merges WHERE main_document_id=$1 AND branch_document_id=$2 ORDER BY created_at DESC LIMIT 100", &[&main,&branch]).await?;
        Ok(
            json!({"branch":branch_json(&row),"mainSeq":main_seq.to_string(),"branchSeq":branch_seq.to_string(),
            "mainDigest":main_digest,"branchDigest":branch_digest,"canMerge":can_merge,"changes":changes,"merges":merges.iter().map(merge_json).collect::<Vec<_>>()}),
        )
    }

    pub async fn merge(
        &self,
        main: Uuid,
        branch: Uuid,
        actor: UserId,
        input: MergeRequest,
    ) -> Result<MergeOutcome, BranchError> {
        let expected_main: i64 = input
            .expected_main_seq
            .parse()
            .map_err(|_| BranchError::Invalid)?;
        let expected_branch: i64 = input
            .expected_branch_seq
            .parse()
            .map_err(|_| BranchError::Invalid)?;
        if expected_main < 0
            || expected_branch < 0
            || input.selections.is_empty()
            || input.selections.len() > 2000
        {
            return Err(BranchError::Invalid);
        }
        let request = request_json(&input);
        // Authorization precedes idempotency lookup, including on recovery.
        let row = {
            let mut client = self.history.repo.db.get().await?;
            let tx = client.transaction().await?;
            access(&tx, actor, main, true).await?;
            access(&tx, actor, branch, false).await?;
            let row = tx
                .query_opt(
                    "SELECT * FROM review_branches WHERE document_id=$1 AND main_document_id=$2",
                    &[&branch, &main],
                )
                .await?
                .ok_or(BranchError::NotFound)?;
            if let Some(done) = retry(&tx, main, branch, actor, input.request_id, &request).await? {
                return Ok(done);
            }
            row
        };
        if self.history.repo.durable_cursor(main).await? != expected_main
            || self.history.repo.durable_cursor(branch).await? != expected_branch
        {
            return Err(BranchError::Stale);
        }
        let (_, _, current) = self
            .history
            .visible_at_boundary(main, expected_main)
            .await?;
        let (_, _, source) = self
            .history
            .visible_at_boundary(branch, expected_branch)
            .await?;
        let base: Value = row.get("base_content");
        let changes = branch_merge::plan(blocks(&base)?, blocks(&current)?, blocks(&source)?);
        let mut selected = std::collections::HashSet::new();
        let mut ranges = vec![];
        for selection in &input.selections {
            if !selected.insert(&selection.id) {
                return Err(BranchError::Invalid);
            }
            let change = changes
                .iter()
                .find(|c| c.id == selection.id)
                .ok_or(BranchError::Stale)?;
            if change.already_applied {
                return Err(BranchError::Stale);
            }
            if selection.resolution != "apply" && selection.resolution != "branch" {
                return Err(BranchError::Invalid);
            }
            if change.conflict && selection.resolution != "branch" {
                return Err(BranchError::Conflict);
            }
            ranges.push(change.range);
        }
        ranges.sort_by_key(|r| r[0]);
        let current_snapshot = self.history.export_state_inner(main, expected_main).await?;
        let source_snapshot = self
            .history
            .export_state_inner(branch, expected_branch)
            .await?;
        let diff = self
            .history
            .workers
            .merge_diff(&current_snapshot, &source_snapshot, &ranges)
            .await?;
        let envelopes = split_batch_frame(&diff.batch)
            .iter()
            .map(|p| crate::protocol::envelope::validate_op(p).map_err(|_| BranchError::Invalid))
            .collect::<Result<Vec<_>, _>>()?;
        let mut client = self.history.repo.db.get().await?;
        let tx = client.transaction().await?;
        let mut documents = [main, branch];
        documents.sort();
        for document in documents {
            lock(&tx, document).await?;
        }
        access(&tx, actor, main, true).await?;
        access(&tx, actor, branch, false).await?;
        if let Some(done) = retry(&tx, main, branch, actor, input.request_id, &request).await? {
            return Ok(done);
        }
        // Reuse history's row lock and floor guard: compaction must not
        // prune a source revision's basis between this check and commit.
        for document in documents {
            let seq = if document == main {
                expected_main
            } else {
                expected_branch
            };
            RevisionService::resolve_boundary(&tx, document, Some(seq))
                .await
                .map_err(|error| match error {
                    HistoryError::InvalidBoundary { .. } => BranchError::Stale,
                    error => BranchError::History(error),
                })?;
        }
        if cursor(&tx, main).await? != expected_main
            || cursor(&tx, branch).await? != expected_branch
        {
            return Err(BranchError::Stale);
        }
        let ingested = GatewayRepo::ingest_batch_in_tx(&tx, actor, main, &envelopes, false).await?;
        let source_revision = Uuid::new_v4();
        let result_revision = Uuid::new_v4();
        let name: String = row.get("name");
        let source_label = format!("Review source: {name}");
        let result_label = format!("Merge: {name}");
        tx.execute("INSERT INTO crdt_revisions(revision_id,document_id,target_seq,kind,label,created_by) VALUES($1,$2,$3,'named',$4,$5),($6,$7,$8,'named',$9,$5)",
            &[&source_revision,&branch,&expected_branch,&source_label,&actor.0,&result_revision,&main,&ingested.durable_cursor,&result_label]).await?;
        let base_revision: Uuid = row.get("base_revision_id");
        let record = tx.query_one("INSERT INTO review_merges(id,main_document_id,branch_document_id,base_revision_id,source_revision_id,result_revision_id,actor_id,request,result_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
            &[&input.request_id,&main,&branch,&base_revision,&source_revision,&result_revision,&actor.0,&request,&ingested.durable_cursor]).await?;
        tx.execute("INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,'document.branch.merged','document',$2,$3)",
            &[&actor.0,&main.to_string(),&merge_json(&record)]).await?;
        let inserted: std::collections::HashSet<_> = ingested.newly_inserted.iter().collect();
        let committed_ops = envelopes
            .into_iter()
            .filter(|e| inserted.contains(&e.identity.to_wire()))
            .map(|e| e.bytes)
            .collect::<Vec<_>>();
        tx.commit().await?;
        Ok(MergeOutcome {
            response: json!({"merge":merge_json(&record),"duplicate":false,"appliedOps":committed_ops.len()}),
            committed_ops,
            durable_cursor: ingested.durable_cursor,
        })
    }
}

async fn retry(
    tx: &Transaction<'_>,
    main: Uuid,
    branch: Uuid,
    actor: UserId,
    id: Uuid,
    request: &Value,
) -> Result<Option<MergeOutcome>, BranchError> {
    let Some(row) = tx
        .query_opt("SELECT * FROM review_merges WHERE id=$1", &[&id])
        .await?
    else {
        return Ok(None);
    };
    if row.get::<_, Uuid>("main_document_id") != main
        || row.get::<_, Uuid>("branch_document_id") != branch
        || row.get::<_, Uuid>("actor_id") != actor.0
        || row.get::<_, Value>("request") != *request
    {
        return Err(BranchError::RetryConflict);
    }
    Ok(Some(MergeOutcome {
        durable_cursor: row.get("result_seq"),
        committed_ops: vec![],
        response: json!({"merge":merge_json(&row),"duplicate":true,"appliedOps":0}),
    }))
}
