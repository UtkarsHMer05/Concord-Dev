//! Observability subsystem (Phase 6):
//! - [`correlation`]: end-to-end operation correlation ids (M008).
//! - [`otel`]: optional OpenTelemetry tracing foundations (M009).
//! - [`metrics`]: Prometheus-compatible registry + `/metrics` text
//!   exposition (M010) — the process-wide counters in
//!   [`crate::telemetry::Metrics`] feed both `/api/v1/metrics` (legacy
//!   plain-text) and the Prometheus registry.

pub mod correlation;
pub mod metrics;
pub mod otel;
