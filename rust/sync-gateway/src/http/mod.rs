//! HTTP layer: liveness, readiness (Postgres-aware), metrics, and the
//! WebSocket upgrade route (M021/M022).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, UNIX_EPOCH};
use uuid::Uuid;

use crate::auth::{TokenVerifier, VerifierSource};
use crate::bus::EventPublisher;
use crate::config::Config;
use crate::db::pool::PoolHealth;
use crate::db::repo::{GatewayRepo, RepoError, UserId};
use crate::db::snapshots::SnapshotRepo;
use crate::maintenance::history::{HistoryError, RevisionService};
use crate::maintenance::jobs::JobRepo;
use crate::sessions::SessionRegistry;
use crate::telemetry::Metrics;
use crate::worker::WorkerPool;
use crate::ws;

/// Shared application state (all clones are cheap Arc handles).
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub registry: Arc<SessionRegistry>,
    pub repo: Arc<GatewayRepo>,
    pub verifier: Arc<TokenVerifier<VerifierSource>>,
    /// Drain flag (P3-M041): set on SIGTERM/SIGINT before closing.
    pub draining: Arc<AtomicBool>,
    /// Distributed event bus (P4-M013): publish after durable commit.
    pub bus: Arc<dyn EventPublisher>,
    /// This gateway's identity (P4-M010; observability, not correctness).
    pub gateway_id: u64,
    /// Distributed rate limiter (P4-M023): None ⇒ local-only fallback
    /// limiter; Some ⇒ Redis-backed with automatic local fallback.
    pub rate_limiter: Arc<crate::ephemeral::ratelimit::RateLimiter>,
    /// Presence store (P4-M022): None ⇒ presence disabled (Phase 3 mode).
    pub presence: Option<Arc<crate::ephemeral::presence::PresenceStore>>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health/live", get(live))
        .route("/api/v1/health/ready", get(ready))
        .route("/api/v1/health/info", get(info))
        .route("/api/v1/metrics", get(metrics))
        .route("/metrics", get(prometheus_metrics))
        .route(
            "/api/v1/documents/{document_id}/revisions",
            get(list_revisions).post(create_revision),
        )
        .route(
            "/api/v1/documents/{document_id}/revisions/{revision_id}",
            get(revision_content),
        )
        .route(
            "/api/v1/documents/{document_id}/revisions/{revision_id}/restore",
            post(restore_revision),
        )
        .route("/api/v1/documents/{document_id}/proof", get(document_proof))
        .route("/api/v1/sync", get(ws::upgrade))
        .with_state(state)
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.code }))).into_response()
    }
}

fn repo_api_error(error: RepoError) -> ApiError {
    match error {
        RepoError::UserNotProvisioned => ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized"),
        _ => ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"),
    }
}

async fn actor(app: &AppState, headers: &HeaderMap) -> Result<UserId, ApiError> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    let mut parts = authorization.split_ascii_whitespace();
    let scheme = parts.next();
    let token = parts.next();
    if !matches!(scheme, Some(value) if value.eq_ignore_ascii_case("bearer"))
        || token.is_none()
        || parts.next().is_some()
    {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    let principal = app
        .verifier
        .verify(token.unwrap())
        .await
        .map_err(|error| match error {
            crate::auth::AuthError::JwksUnavailable => {
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable")
            }
            _ => ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized"),
        })?;
    app.repo
        .resolve_user(&principal.clerk_user_id)
        .await
        .map_err(repo_api_error)
}

fn history_service(app: &AppState) -> RevisionService {
    // Named checkpoints and listing work without a native worker. Operations
    // that need reconstruction fail as service_unavailable until configured.
    let worker = app
        .config
        .worker_binary
        .as_deref()
        .unwrap_or("<worker-not-configured>");
    let repo = app.repo.as_ref().clone();
    RevisionService::new(
        repo.clone(),
        SnapshotRepo::new(repo.db.clone()),
        WorkerPool::new(worker, Duration::from_secs(600)),
        JobRepo::new(repo.db.clone()),
    )
}

async fn enforce_history_budget(
    limiter: &crate::ephemeral::ratelimit::RateLimiter,
    actor: UserId,
) -> Result<(), ApiError> {
    if limiter
        .check(
            crate::ephemeral::ratelimit::SCOPE_HISTORY_API,
            &format!("user:{}", actor.0),
        )
        .await
        == crate::ephemeral::ratelimit::RateLimitOutcome::Limited
    {
        crate::telemetry::Metrics::global()
            .rate_limited_total
            .fetch_add(1, Ordering::Relaxed);
        crate::observability::metrics::incr_labeled("concord_rate_limit_hits_total", &["history"]);
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct RevisionQuery {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRevisionRequest {
    label: String,
    target_seq: Option<i64>,
}

fn history_api_error(error: HistoryError) -> ApiError {
    match error {
        HistoryError::Forbidden | HistoryError::RevisionNotFound => {
            // Preserve Concord's no-access/not-found equivalence.
            ApiError::new(StatusCode::NOT_FOUND, "not_found")
        }
        HistoryError::LabelRequired => ApiError::new(StatusCode::BAD_REQUEST, "label_required"),
        HistoryError::InvalidBoundary { boundary } if boundary < 0 => {
            ApiError::new(StatusCode::BAD_REQUEST, "invalid_boundary")
        }
        HistoryError::InvalidBoundary { .. } | HistoryError::RestoreTargetPruned { .. } => {
            ApiError::new(StatusCode::CONFLICT, "revision_boundary_unavailable")
        }
        HistoryError::Repo(_)
        | HistoryError::Snapshot(_)
        | HistoryError::Worker(_)
        | HistoryError::Job(_)
        | HistoryError::Pool(_)
        | HistoryError::Pg(_)
        | HistoryError::Compaction(_)
        | HistoryError::RestoreAnchor(_)
        | HistoryError::VisibleStateMalformed => {
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "history_unavailable")
        }
        HistoryError::OpValidation(_) => {
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "history_unavailable")
        }
    }
}

// ---------------------------------------------------------------------------
// History proofs (Feature 5): Merkle audit path over the retained durable log
// + Ed25519-signed state receipt. Read access (view+), history rate budget.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProofQuery {
    /// Server seq to prove (default: the current durable cursor).
    seq: Option<i64>,
}

/// One row of the retained log, gathered in ascending server-seq order.
struct ProofLeafRow {
    seq: i64,
    operation_id: String,
    checksum: String,
    payload: Vec<u8>,
}

async fn document_proof(
    State(app): State<AppState>,
    Path(document): Path<Uuid>,
    Query(query): Query<ProofQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    use crate::maintenance::proofs::{
        leaf_hash, merkle_proof, merkle_root, receipt_message, ProofSigner,
    };

    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    // View-or-better reads the proof (same read surface as listing
    // revisions); outsiders get the standard no-access 404 equivalence.
    let access = app
        .repo
        .document_access(actor, document)
        .await
        .map_err(repo_api_error)?;
    let Some(access) = access else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    };
    if !access.role.can_view() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }

    // Bound: the whole retained log up to `seq` (or the durable cursor).
    let cursor = app
        .repo
        .durable_cursor(document)
        .await
        .map_err(repo_api_error)?;
    let seq = match query.seq {
        None => cursor,
        Some(requested) if requested >= 0 && requested <= cursor => requested,
        Some(_) => return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_boundary")),
    };
    // Retention boundary: a seq below the compaction floor cannot be proven
    // from the retained log (delta replay is impossible there). `seq` is the
    // ABSOLUTE server id (same space as the catch-up cursor), so a boundary
    // before this document's first op is a legitimate empty-state proof, not
    // a pruned one.
    let floor_row = app
        .repo
        .db
        .get()
        .await
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))?
        .query_one(
            "SELECT compaction_floor_seq FROM documents WHERE id = $1",
            &[&document],
        )
        .await
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))?;
    let floor: Option<i64> = floor_row.get("compaction_floor_seq");
    if let Some(floor) = floor {
        if seq < floor {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "revision_boundary_unavailable",
            ));
        }
    }
    let mut rows: Vec<ProofLeafRow> = Vec::new();
    let mut after = 0i64;
    loop {
        let page = app
            .repo
            .ops_between(document, after, seq, 1024)
            .await
            .map_err(repo_api_error)?;
        let page_had_more = page.has_more;
        for (operation_id, op_seq, payload) in page.ops {
            // Same checksum formula as ingest (repo.rs hex_checksum).
            use sha2::Digest as _;
            let checksum = hex::encode(sha2::Sha256::digest(&payload));
            rows.push(ProofLeafRow {
                seq: op_seq,
                operation_id,
                checksum,
                payload,
            });
            after = op_seq;
        }
        if !page_had_more {
            break;
        }
    }
    let base_seq = rows.first().map(|r| r.seq).unwrap_or(0);

    // State receipt content: the canonical digest of the state at `seq`,
    // computed by the native worker (same reconstruction the gateway trusts).
    let worker = app
        .config
        .worker_binary
        .as_deref()
        .unwrap_or("<worker-not-configured>");
    let payloads: Vec<Vec<u8>> = rows.iter().map(|r| r.payload.clone()).collect();
    let state_digest = WorkerPool::new(worker, Duration::from_secs(600))
        .reconstruct(&payloads)
        .await
        .map(|ok| ok.digest)
        .map_err(|_| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "history_unavailable"))?;

    // Merkle root + audit path for the LAST retained leaf (index count-1).
    let leaves: Vec<[u8; 32]> = rows
        .iter()
        .map(|r| leaf_hash(r.seq as u64, &r.operation_id, &r.checksum))
        .collect();
    let root = merkle_root(&leaves);
    let leaf_index = leaves.len().saturating_sub(1);
    let proof: Vec<[u8; 32]> = if leaves.is_empty() {
        Vec::new()
    } else {
        merkle_proof(&leaves, leaf_index).unwrap_or_default()
    };

    // Sign (document, seq, root, stateDigest, opCount, issuedAt, keyId).
    let signer = ProofSigner::shared();
    let issued_at_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let op_count = rows.len() as u64;
    let message = receipt_message(
        document,
        seq as u64,
        &root,
        &state_digest,
        op_count,
        issued_at_ms,
        signer.key_id(),
    );
    let signature = signer.sign(&message);
    let receipt = json!({
        "documentId": document.to_string(),
        "seq": seq.to_string(),
        "root": hex::encode(root),
        "stateDigest": state_digest,
        "opCount": op_count.to_string(),
        "issuedAtMs": issued_at_ms.to_string(),
        "keyId": signer.key_id(),
        "signature": base64_encode(&signature),
    });
    Ok(Json(json!({
        "documentId": document.to_string(),
        "seq": seq.to_string(),
        "baseSeq": base_seq.to_string(),
        "opCount": op_count.to_string(),
        "leafIndex": leaf_index.to_string(),
        "leaf": hex::encode(leaves.last().copied().unwrap_or_default()),
        "proof": proof.iter().map(hex::encode).collect::<Vec<_>>(),
        "root": hex::encode(root),
        "stateDigest": state_digest,
        "publicKey": hex::encode(signer.public_key_bytes()),
        "keyEphemeral": signer.is_ephemeral(),
        "receipt": receipt,
    })))
}

/// Standard base64 (RFC 4648, with padding) — dependency-free: the signature
/// rides a JSON response, so raw bytes must be encoded.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn created_at_ms(value: std::time::SystemTime) -> u128 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn revision_summary_json(revision: crate::maintenance::history::RevisionSummary) -> Value {
    json!({
        "revisionId": revision.revision_id,
        "kind": revision.kind,
        "label": revision.label,
        "targetSeq": revision.target_seq,
        "createdBy": revision.created_by,
        "snapshotId": revision.snapshot_id,
        "restoreSourceRevision": revision.restore_source_revision,
        "createdAtMs": created_at_ms(revision.created_at),
    })
}

async fn list_revisions(
    State(app): State<AppState>,
    Path(document): Path<Uuid>,
    Query(query): Query<RevisionQuery>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    let revisions = history_service(&app)
        .list_revisions(document, actor, query.limit.unwrap_or(50))
        .await
        .map_err(history_api_error)?;
    Ok(Json(json!({
        "revisions": revisions.into_iter().map(revision_summary_json).collect::<Vec<_>>(),
    })))
}

async fn create_revision(
    State(app): State<AppState>,
    Path(document): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateRevisionRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if request.label.chars().count() > 200 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "label_too_long"));
    }
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    let revision = history_service(&app)
        .create_revision(
            document,
            actor,
            crate::maintenance::history::revision_kind::NAMED,
            Some(&request.label),
            request.target_seq,
        )
        .await
        .map_err(history_api_error)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "revisionId": revision.revision_id,
            "documentId": revision.document_id,
            "kind": revision.kind,
            "label": revision.label,
            "targetSeq": revision.target_seq,
            "createdBy": revision.created_by,
            "snapshotId": revision.snapshot_id,
            "restoreSourceRevision": revision.restore_source_revision,
            "createdAtMs": created_at_ms(std::time::SystemTime::now()),
        })),
    ))
}

async fn revision_content(
    State(app): State<AppState>,
    Path((document, revision)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    let state = history_service(&app)
        .revision_content(document, actor, revision)
        .await
        .map_err(history_api_error)?;
    Ok(Json(json!({
        "revisionId": state.revision_id,
        "documentId": state.document_id,
        "boundary": state.boundary,
        "stateDigest": state.state_digest,
        "visibleContent": state.visible_content,
        "coveredBySnapshot": state.covered_by_snapshot,
    })))
}

async fn restore_revision(
    State(app): State<AppState>,
    Path((document, revision)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    let outcome = history_service(&app)
        .restore_revision(document, actor, revision)
        .await
        .map_err(history_api_error)?;

    // RevisionService has already committed the restore operations and the
    // restore_event before returning. Fanout is best-effort, matching the
    // WebSocket path; reconnecting clients recover from durable catch-up.
    let committed_ops = outcome.committed_ops;
    if !committed_ops.is_empty() {
        let event_id = (outcome.restore_event.revision_id.as_u128() as u64).max(1);
        if let Err(error) = app
            .bus
            .publish_batch(
                document,
                event_id,
                outcome.durable_cursor.max(0) as u64,
                committed_ops.clone(),
            )
            .await
        {
            tracing::warn!(document_id = %document, error = %error, "restore committed; cross-gateway publish failed");
        }
        match (crate::protocol::data::DataFrame::ClientOps(crate::protocol::data::ClientOps {
            batch_id: event_id,
            ops: committed_ops,
            identities: vec![],
        }))
        .encode()
        {
            Ok(bytes) => {
                let mut slow = Vec::new();
                app.registry
                    .fanout(
                        document,
                        Uuid::nil(),
                        crate::sessions::OutboundFrame::Binary(bytes),
                        &mut slow,
                    )
                    .await;
                for connection_id in slow {
                    tracing::info!(%connection_id, document_id = %document, "restore fanout closed a slow consumer");
                }
            }
            Err(error) => {
                tracing::error!(document_id = %document, error = %error, "restore committed; local fanout frame could not be encoded")
            }
        }
    }

    Ok(Json(json!({
        "restoreEvent": {
            "revisionId": outcome.restore_event.revision_id,
            "documentId": outcome.restore_event.document_id,
            "kind": outcome.restore_event.kind,
            "targetSeq": outcome.restore_event.target_seq,
            "createdBy": outcome.restore_event.created_by,
            "snapshotId": outcome.restore_event.snapshot_id,
            "restoreSourceRevision": outcome.restore_event.restore_source_revision,
        },
        "boundary": outcome.boundary,
        "anchorSnapshotId": outcome.anchor_snapshot_id,
        "targetStateDigest": outcome.target_state_digest,
        "currentStateDigest": outcome.current_state_digest,
        "appliedOps": outcome.applied_ops,
        "duplicateOps": outcome.duplicate_ops,
    })))
}

async fn live() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "concord-sync-gateway",
        "protocolVersion": crate::WIRE_PROTOCOL_VERSION,
    }))
}

/// Build-info surface (release 1.0.0): EXACTLY four compile-time fields —
/// version, git sha, build profile, protocol version. Nothing from the
/// runtime environment is read (build_info.rs), so no env value or secret
/// can leak through this route. The response shape is pinned by test below.
async fn info() -> Json<Value> {
    Json(json!({
        "version": crate::VERSION,
        "git_sha": crate::build_info::GIT_SHA,
        "build_profile": crate::build_info::BUILD_PROFILE,
        "protocol_version": crate::WIRE_PROTOCOL_VERSION,
    }))
}

/// Readiness (M021): reflects the Postgres dependency — distinguishes
/// "process alive" (live) from "DB usable" (ready). No internals leaked.
async fn ready(State(app): State<AppState>) -> (StatusCode, Json<Value>) {
    match app.repo.db.health().await {
        PoolHealth::Healthy => (StatusCode::OK, json!({"status": "ready"}).into()),
        PoolHealth::Unhealthy => (
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"status": "not_ready", "reason": "dependency_unavailable"}).into(),
        ),
    }
}

/// Local metrics endpoint (M042): counters as plain text. No secrets.
async fn metrics(State(app): State<AppState>) -> (StatusCode, String) {
    // Keep the legacy /api/v1/metrics body in lockstep with live gauges
    // before rendering it (P6-M010: one source of truth for the gauge).
    let active = Metrics::global().active_connections.load(Ordering::Relaxed);
    crate::observability::metrics::set_gauge("concord_active_connections", active as i64);
    let _ = &app;
    let m = Metrics::global();
    let mut out = String::new();
    macro_rules! emit {
        ($name:literal, $expr:expr) => {
            out.push_str(&format!("{} {}\n", $name, $expr));
        };
    }
    emit!(
        "active_connections",
        m.active_connections.load(Ordering::Relaxed)
    );
    emit!(
        "joined_documents",
        m.joined_documents.load(Ordering::Relaxed)
    );
    emit!(
        "inbound_frames_total",
        m.inbound_frames_total.load(Ordering::Relaxed)
    );
    emit!(
        "outbound_frames_total",
        m.outbound_frames_total.load(Ordering::Relaxed)
    );
    emit!(
        "accepted_operations_total",
        m.accepted_operations_total.load(Ordering::Relaxed)
    );
    emit!(
        "duplicate_operations_total",
        m.duplicate_operations_total.load(Ordering::Relaxed)
    );
    emit!(
        "durable_ack_total",
        m.durable_ack_total.load(Ordering::Relaxed)
    );
    emit!(
        "authorization_denied_total",
        m.authorization_denied_total.load(Ordering::Relaxed)
    );
    emit!(
        "malformed_frames_total",
        m.malformed_frames_total.load(Ordering::Relaxed)
    );
    emit!(
        "slow_consumer_disconnects_total",
        m.slow_consumer_disconnects_total.load(Ordering::Relaxed)
    );
    emit!(
        "sync_batches_total",
        m.sync_batches_total.load(Ordering::Relaxed)
    );
    (StatusCode::OK, out)
}

/// Prometheus text-exposition endpoint (P6-M010): GET /metrics.
///
/// Unauthenticated BY DESIGN but on the SAME loopback-bound HTTP server as
/// every other gateway route (the bind host is validated to an IP literal
/// and defaults to 127.0.0.1 — see Config). Label cardinality is bounded
/// by the registry's call-site rules (integration test asserts this).
async fn prometheus_metrics(State(_app): State<AppState>) -> (StatusCode, String) {
    // Refresh the live gauges so a scrape is current even without recent
    // connection churn.
    let active = Metrics::global().active_connections.load(Ordering::Relaxed);
    crate::observability::metrics::set_gauge("concord_active_connections", active as i64);
    (StatusCode::OK, crate::observability::metrics::render())
}

/// WebSocket upgrade route requires ConnectInfo — helper for the server
/// builder (main.rs uses `into_make_service_with_connect_info`).
#[allow(dead_code)]
fn assert_connect_info_type(_upgrade: WebSocketUpgrade, _connect: ConnectInfo<SocketAddr>) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The info route returns the version and NOTHING else: the response
    /// is pinned to exactly the four documented build fields (no extra
    /// key can be added silently, and no env value can leak in).
    #[tokio::test]
    async fn health_info_returns_version_and_only_version() {
        let Json(body) = info().await;

        assert_eq!(body["version"], crate::VERSION, "version must be reported");
        assert_eq!(body["git_sha"], crate::build_info::GIT_SHA);
        assert_eq!(body["build_profile"], crate::build_info::BUILD_PROFILE);
        assert_eq!(body["protocol_version"], crate::WIRE_PROTOCOL_VERSION);

        // Exactly the four documented fields — nothing else leaks.
        let mut keys: Vec<&str> = body
            .as_object()
            .expect("info body is a JSON object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["build_profile", "git_sha", "protocol_version", "version"]
        );
    }

    #[test]
    fn history_denials_hide_document_existence_and_worker_outage_is_retryable() {
        let forbidden = history_api_error(HistoryError::Forbidden);
        let missing = history_api_error(HistoryError::RevisionNotFound);
        assert_eq!(forbidden.status, StatusCode::NOT_FOUND);
        assert_eq!(missing.status, StatusCode::NOT_FOUND);

        let negative_boundary = history_api_error(HistoryError::InvalidBoundary { boundary: -1 });
        assert_eq!(negative_boundary.status, StatusCode::BAD_REQUEST);
        assert_eq!(negative_boundary.code, "invalid_boundary");

        let worker_missing = history_api_error(HistoryError::Worker(
            crate::worker::WorkerError::BinaryUnavailable("unconfigured".into()),
        ));
        assert_eq!(worker_missing.status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn history_endpoints_have_a_per_user_compute_budget() {
        use crate::ephemeral::ratelimit::{RateLimitPolicy, SCOPE_HISTORY_API};
        use std::collections::HashMap;

        let limiter = crate::ephemeral::ratelimit::RateLimiter::new(
            None,
            HashMap::from([(
                SCOPE_HISTORY_API,
                RateLimitPolicy {
                    max_events: 0,
                    window: Duration::from_secs(60),
                },
            )]),
        );
        let error = enforce_history_budget(&limiter, UserId(Uuid::nil()))
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(error.code, "rate_limited");
    }
}
