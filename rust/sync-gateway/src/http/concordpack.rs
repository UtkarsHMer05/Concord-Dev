use super::*;
use crate::maintenance::concordpack::{PackError, PackService, TrustRecord, MAX_BYTES};
use crate::maintenance::proofs::ProofSigner;

fn service(app: &AppState) -> PackService {
    PackService {
        repo: app.repo.as_ref().clone(),
        worker: WorkerPool::new(
            app.config
                .worker_binary
                .as_deref()
                .unwrap_or("<worker-not-configured>"),
            Duration::from_secs(600),
        ),
    }
}
fn error(error: PackError) -> ApiError {
    match error {
        PackError::Invalid(code) => ApiError::new(
            match code {
                "not_found" => StatusCode::NOT_FOUND,
                "archive_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
                "request_id_conflicts" => StatusCode::CONFLICT,
                "stable_signing_key_required" => StatusCode::SERVICE_UNAVAILABLE,
                _ => StatusCode::BAD_REQUEST,
            },
            code,
        ),
        other => {
            tracing::warn!(error=%other,"concordpack request failed");
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "concordpack_unavailable")
        }
    }
}

pub(super) async fn export(
    State(app): State<AppState>,
    Path(document): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    let bytes = service(&app)
        .export(document, actor, ProofSigner::shared())
        .await
        .map_err(error)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.concord.concordpack"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=history.concordpack",
            ),
        ],
        bytes,
    )
        .into_response())
}
pub(super) async fn provenance(
    State(app): State<AppState>,
    Path(document): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    service(&app)
        .provenance(document, actor)
        .await
        .map(Json)
        .map_err(error)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImportQuery {
    request_id: Uuid,
    title: String,
    public_key: String,
    document_id: Uuid,
    seq: String,
    base_snapshot_seq: String,
    revision_id: Option<Uuid>,
    workspace: String,
}
pub(super) async fn import(
    State(app): State<AppState>,
    Query(query): Query<ImportQuery>,
    request: axum::extract::Request,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, request.headers()).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    if query.workspace != "personal" {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "personal_workspace_required",
        ));
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        != Some("application/vnd.concord.concordpack")
    {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "concordpack_content_type_required",
        ));
    }
    // Destination policy is configured independently of the incoming file.
    let mut allowed_keys: Vec<String> = std::env::var("GATEWAY_TRUSTED_IMPORT_KEYS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    if allowed_keys.iter().any(|key| {
        key.len() != 64
            || !key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "invalid_import_trust_configuration",
        ));
    }
    let signer = ProofSigner::shared();
    if !signer.is_ephemeral() {
        allowed_keys.push(hex::encode(signer.public_key_bytes()));
    }
    if !allowed_keys.contains(&query.public_key) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "untrusted_import_key",
        ));
    }
    let bytes = axum::body::to_bytes(request.into_body(), MAX_BYTES)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "archive_too_large"))?;
    let trust = TrustRecord {
        public_key: query.public_key,
        document_id: query.document_id,
        seq: query.seq,
        base_snapshot_seq: query.base_snapshot_seq,
        revision_id: query.revision_id,
    };
    service(&app)
        .import(
            actor,
            query.request_id,
            &query.title,
            &bytes,
            &trust,
            &allowed_keys,
        )
        .await
        .map(Json)
        .map_err(error)
}
