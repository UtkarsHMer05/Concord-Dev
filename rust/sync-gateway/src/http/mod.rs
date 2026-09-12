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
}
