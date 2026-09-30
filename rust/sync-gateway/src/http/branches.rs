use super::*;
use crate::maintenance::branches::{BranchError, BranchService, CreateBranch, MergeRequest};

fn error(error: BranchError) -> ApiError {
    match error {
        BranchError::NotFound => ApiError::new(StatusCode::NOT_FOUND, "not_found"),
        BranchError::Invalid => ApiError::new(StatusCode::BAD_REQUEST, "invalid_request"),
        BranchError::TooLarge => ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "review_too_large"),
        BranchError::Stale => ApiError::new(StatusCode::CONFLICT, "review_is_stale"),
        BranchError::RetryConflict => ApiError::new(StatusCode::CONFLICT, "request_id_conflicts"),
        BranchError::Conflict => ApiError::new(StatusCode::CONFLICT, "resolve_conflict_explicitly"),
        BranchError::History(h) => history_api_error(h),
        BranchError::Repo(crate::db::repo::RepoError::WriteDenied) => {
            ApiError::new(StatusCode::NOT_FOUND, "not_found")
        }
        other => {
            tracing::warn!(error=%other,"review branch request failed");
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "branches_unavailable")
        }
    }
}

pub(super) async fn list(
    State(app): State<AppState>,
    Path(document): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    BranchService {
        history: history_service(&app),
    }
    .list(document, actor)
    .await
    .map(Json)
    .map_err(error)
}

pub(super) async fn create(
    State(app): State<AppState>,
    Path(document): Path<Uuid>,
    headers: HeaderMap,
    Json(input): Json<CreateBranch>,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    BranchService {
        history: history_service(&app),
    }
    .create(document, actor, input)
    .await
    .map(Json)
    .map_err(error)
}

pub(super) async fn compare(
    State(app): State<AppState>,
    Path((document, branch)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    BranchService {
        history: history_service(&app),
    }
    .compare(document, branch, actor)
    .await
    .map(Json)
    .map_err(error)
}

pub(super) async fn merge(
    State(app): State<AppState>,
    Path((document, branch)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<MergeRequest>,
) -> Result<Json<Value>, ApiError> {
    let actor = actor(&app, &headers).await?;
    enforce_history_budget(&app.rate_limiter, actor).await?;
    let id = input.request_id;
    let outcome = BranchService {
        history: history_service(&app),
    }
    .merge(document, branch, actor, input)
    .await
    .map_err(error)?;
    publish_committed_ops(
        &app,
        document,
        (id.as_u128() as u64).max(1),
        outcome.durable_cursor,
        outcome.committed_ops,
    )
    .await;
    Ok(Json(outcome.response))
}
