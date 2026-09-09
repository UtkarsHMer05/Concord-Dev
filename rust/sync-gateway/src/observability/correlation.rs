//! End-to-end operation correlation (P6-M008).
//!
//! One `correlation_id` names one client operation batch from ingress to
//! (durable ack → broker publish → peer fanout). The id is the client's
//! `batch_id` (u64) combined with this gateway's numeric id:
//! `gw-<gateway_id>-batch-<batch_id>` — stable, greppable, and derived
//! from protocol fields that already flow through every hop (the broker
//! event carries `event_id == batch_id` and `origin_gateway`).
//!
//! SECURITY: correlation fields carry ONLY ids, latencies, and outcomes.
//! Never document content, JWTs, or payload bytes. Op identity strings
//! (`replica:counter`) are durable unique keys — safe to log — but they
//! are NOT span attributes unless `GATEWAY_DEBUG_OP_IDS=true` (default
//! off) to keep OTel attribute cardinality bounded per the mission rule.
//!
//! Where the id appears (M008 checklist):
//! - ingress log/span (ws decode of `client_ops`)
//! - authz decision (ingest transaction recheck)
//! - DB persist (ingest commit)
//! - ACK (durable_ack emit)
//! - NATS publish (bus publish path)
//! - broker receive/fanout (subscriber loop; peers see `origin_gateway`
//!   + `event_id`, from which the same correlation id is derived)

/// Builds the canonical correlation id for one batch on this gateway.
pub fn batch_correlation_id(gateway_id: u64, batch_id: u64) -> String {
    format!("gw-{gateway_id}-batch-{batch_id}")
}

/// Builds the peer-side correlation id from a broker event's fields
/// (origin gateway + event id == the origin's client batch id).
pub fn broker_correlation_id(origin_gateway: u64, event_id: u64) -> String {
    format!("gw-{origin_gateway}-batch-{event_id}")
}

/// Debug-gated op-identity attribution: when false, call sites must NOT
/// put op ids (or any per-operation value) into span attributes.
/// Controlled by `GATEWAY_OTEL_DEBUG_OP_IDS` / tests (default: off).
static DEBUG_OP_IDS: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Sets the debug-op-ids flag (0 = off). Uses an atomic rather than a
/// OnceLock so tests can exercise both states.
pub fn set_debug_op_ids(enabled: bool) {
    DEBUG_OP_IDS.store(u8::from(enabled), std::sync::atomic::Ordering::SeqCst);
}

/// Whether op identities may appear as span attributes/log fields.
pub fn debug_op_ids_enabled() -> bool {
    DEBUG_OP_IDS.load(std::sync::atomic::Ordering::SeqCst) == 1
}

/// Tracing field for an op identity, respecting the debug gate: returns
/// `Some(id)` when debug op ids are enabled, `None` otherwise (the field
/// is simply omitted from the event).
pub fn op_id_field(identity: &str) -> Option<&str> {
    if debug_op_ids_enabled() {
        Some(identity)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlation_ids_are_stable_and_greppable() {
        assert_eq!(
            batch_correlation_id(1, 42),
            "gw-1-batch-42",
            "ingress id format is stable"
        );
        assert_eq!(
            broker_correlation_id(1, 42),
            "gw-1-batch-42",
            "peer-side id reconstructs to the same string"
        );
    }

    #[test]
    fn op_id_field_gated_by_debug_flag() {
        set_debug_op_ids(false);
        assert!(op_id_field("77:1").is_none());
        set_debug_op_ids(true);
        assert_eq!(op_id_field("77:1"), Some("77:1"));
        set_debug_op_ids(false); // restore default for other tests
    }
}
