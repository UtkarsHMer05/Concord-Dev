//! HTTP layer: liveness/readiness/metrics and (later) the WebSocket upgrade.

use std::sync::atomic::Ordering;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::config::Config;
use crate::telemetry::Metrics;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
}

/// Base router. WebSocket routes + readiness are added by later milestones
/// (M021/M022); the health endpoint never bypasses readiness semantics.
pub fn router(config: Config) -> Router {
    Router::new()
        .route("/api/v1/health/live", get(live))
        .route("/api/v1/metrics", get(metrics))
        .with_state(AppState { config })
}

async fn live() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "concord-sync-gateway",
        "protocolVersion": crate::WIRE_PROTOCOL_VERSION,
    }))
}

/// Local metrics endpoint (M042): counters as plain text. No secrets.
pub async fn metrics(State(_app): State<AppState>) -> (StatusCode, String) {
    let m = Metrics::global();
    let mut out = String::new();
    macro_rules! emit {
        ($name:literal, $expr:expr) => {
            out.push_str(&format!("{name} {value}\n", name = $name, value = $expr));
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
