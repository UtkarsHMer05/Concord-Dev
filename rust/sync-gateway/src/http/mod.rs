//! HTTP layer: liveness, readiness (Postgres-aware), metrics, and the
//! WebSocket upgrade route (M021/M022).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::{TokenVerifier, VerifierSource};
use crate::bus::EventPublisher;
use crate::config::Config;
use crate::db::pool::PoolHealth;
use crate::db::repo::GatewayRepo;
use crate::sessions::SessionRegistry;
use crate::telemetry::Metrics;
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
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health/live", get(live))
        .route("/api/v1/health/ready", get(ready))
        .route("/api/v1/metrics", get(metrics))
        .route("/api/v1/sync", get(ws::upgrade))
        .with_state(state)
}

async fn live() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "concord-sync-gateway",
        "protocolVersion": crate::WIRE_PROTOCOL_VERSION,
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
async fn metrics(State(_app): State<AppState>) -> (StatusCode, String) {
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

/// WebSocket upgrade route requires ConnectInfo — helper for the server
/// builder (main.rs uses `into_make_service_with_connect_info`).
#[allow(dead_code)]
fn assert_connect_info_type(_upgrade: WebSocketUpgrade, _connect: ConnectInfo<SocketAddr>) {}
