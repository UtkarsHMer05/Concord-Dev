//! Structured tracing + lightweight runtime metrics (P3-M010 / P3-M042).

use std::sync::atomic::AtomicU64;
use std::sync::OnceLock;
use tracing_subscriber::EnvFilter;

/// Initializes the global tracing subscriber. `default_filter` is used when
/// `RUST_LOG` is absent. Never logs secrets or raw tokens.
pub fn init(default_filter: &str) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

/// Process-wide operational counters (Phase 3 metrics, M042).
#[derive(Debug)]
pub struct Metrics {
    pub active_connections: AtomicU64,
    pub joined_documents: AtomicU64,
    pub inbound_frames_total: AtomicU64,
    pub outbound_frames_total: AtomicU64,
    pub accepted_operations_total: AtomicU64,
    pub duplicate_operations_total: AtomicU64,
    pub durable_ack_total: AtomicU64,
    pub authorization_denied_total: AtomicU64,
    pub malformed_frames_total: AtomicU64,
    pub slow_consumer_disconnects_total: AtomicU64,
    pub sync_batches_total: AtomicU64,
    /// Recent DB write latencies (µs), capped ring for p50/p95/p99 (M043).
    pub db_write_latency_us: std::sync::Mutex<Vec<u64>>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            active_connections: AtomicU64::new(0),
            joined_documents: AtomicU64::new(0),
            inbound_frames_total: AtomicU64::new(0),
            outbound_frames_total: AtomicU64::new(0),
            accepted_operations_total: AtomicU64::new(0),
            duplicate_operations_total: AtomicU64::new(0),
            durable_ack_total: AtomicU64::new(0),
            authorization_denied_total: AtomicU64::new(0),
            malformed_frames_total: AtomicU64::new(0),
            slow_consumer_disconnects_total: AtomicU64::new(0),
            sync_batches_total: AtomicU64::new(0),
            db_write_latency_us: std::sync::Mutex::new(Vec::with_capacity(4096)),
        }
    }
}

impl Metrics {
    pub fn global() -> &'static Metrics {
        static METRICS: OnceLock<Metrics> = OnceLock::new();
        METRICS.get_or_init(Metrics::default)
    }

    pub fn record_db_write_latency(&self, micros: u64) {
        let mut samples = self
            .db_write_latency_us
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if samples.len() >= 4096 {
            // Keep the most recent window: drop the oldest half.
            samples.drain(..2048);
        }
        samples.push(micros);
    }
}
