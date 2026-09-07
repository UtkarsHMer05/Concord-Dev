//! Transport-neutral distributed event bus (P4-M013/M014/M025).
//!
//! Two seams the ws layer depends on — nothing NATS-specific leaks into
//! the protocol path:
//! - [`EventPublisher`]: publish an accepted batch AFTER the durable
//!   commit (best-effort; failure degrades cross-gateway realtime only).
//! - [`EventSubscriber`] runner: consume → validate → dedupe by identity →
//!   local fanout (origin-suppressed; never re-published — loop-safe).
//!
//! NATS lives behind these traits in `broker/`; tests use a loopback bus
//! or the real broker container.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use crate::broker::{Broker, BrokerError, BrokerEvent};
use crate::sessions::{OutboundFrame, SessionRegistry};

/// Publishes inter-gateway events (after-commit, best-effort).
/// Dyn-compatible (boxed future) so AppState can hold `Arc<dyn EventPublisher>`.
pub trait EventPublisher: Send + Sync {
    /// Returns Ok(()) when the event is accepted by the transport; errors
    /// are logged by the caller and never fail the ACK path.
    fn publish_batch(
        &self,
        document: Uuid,
        event_id: u64,
        server_cursor: u64,
        ops: Vec<Vec<u8>>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), BrokerError>> + Send>>;
}

/// NATS-backed publisher (DEC-031/032).
pub struct NatsPublisher {
    broker: Arc<Broker>,
    gateway_id: u64,
}

impl NatsPublisher {
    pub fn new(broker: Arc<Broker>, gateway_id: u64) -> Self {
        Self { broker, gateway_id }
    }
}

impl EventPublisher for NatsPublisher {
    fn publish_batch(
        &self,
        document: Uuid,
        event_id: u64,
        server_cursor: u64,
        ops: Vec<Vec<u8>>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), BrokerError>> + Send>> {
        let broker = self.broker.clone();
        let gateway_id = self.gateway_id;
        Box::pin(async move {
            if ops.is_empty() {
                return Ok(()); // nothing accepted → nothing to propagate
            }
            let event = BrokerEvent {
                origin_gateway: gateway_id,
                document_id: document,
                event_id,
                server_cursor,
                ops,
            };
            broker.publish(&event).await
        })
    }
}

/// A no-op publisher for single-gateway mode (no GATEWAY_NATS_URL).
pub struct LocalOnlyPublisher;

impl EventPublisher for LocalOnlyPublisher {
    fn publish_batch(
        &self,
        _document: Uuid,
        _event_id: u64,
        _server_cursor: u64,
        _ops: Vec<Vec<u8>>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), BrokerError>> + Send>> {
        Box::pin(async { Ok(()) })
    }
}

/// Subscription manager: runs the broker consumer loop and routes valid
/// events to LOCAL fanout (P4-M014/M016/M017).
///
/// Loop safety: broker-received events are NEVER re-published (the ws
/// ingest path only publishes its OWN accepted batches); origin-gateway
/// suppression drops self-events; identity dedup at the DB/client makes
/// redelivery harmless.
pub struct NatsSubscriber {
    broker: Arc<Broker>,
    registry: Arc<SessionRegistry>,
}

impl NatsSubscriber {
    pub fn new(broker: Arc<Broker>, registry: Arc<SessionRegistry>) -> Self {
        Self { broker, registry }
    }

    /// Runs the consumer loop until the process exits. One bounded pull at
    /// a time; ack AFTER local fanout completes (M018); poison (max
    /// deliveries reached / invalid) is terminated + logged (M015).
    /// Errors never crash the loop — transient failures retry.
    pub async fn run(self) {
        loop {
            let messages = match self.broker.fetch(64, Duration::from_secs(2)).await {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, error_class = "broker", "consume failed; retrying");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };
            for message in messages {
                match BrokerEvent::decode(&message.message.payload) {
                    Ok(event) => {
                        if event.origin_gateway == self.broker.gateway_id {
                            // Own event echoed back — suppress (M017).
                            let _ = message.ack().await;
                            continue;
                        }
                        // Local fanout ONLY if this gateway has local
                        // members in the document (cheap in-memory check;
                        // no DB read — full payload by design).
                        let members = self.registry.room_members(event.document_id).await;
                        if members.is_empty() {
                            let _ = message.ack().await;
                            continue;
                        }
                        // Reuse the client_ops binary frame: peers decode
                        // with the SAME wire codec (identical to Phase 3
                        // fanout frames).
                        let frame = crate::protocol::data::DataFrame::ClientOps(
                            crate::protocol::data::ClientOps {
                                batch_id: event.event_id,
                                ops: event.ops.clone(),
                                identities: vec![],
                            },
                        );
                        if let Ok(bytes) = frame.encode() {
                            let mut slow = Vec::new();
                            self.registry
                                .fanout(
                                    event.document_id,
                                    Uuid::nil(), // no single sender on broker path
                                    OutboundFrame::Binary(bytes),
                                    &mut slow,
                                )
                                .await;
                            for slow_id in slow {
                                crate::telemetry::Metrics::global()
                                    .slow_consumer_disconnects_total
                                    .fetch_add(1, Ordering::Relaxed);
                                let _ = slow_id;
                            }
                        }
                        let _ = message.ack().await;
                    }
                    Err(e) => {
                        // Poison: structured rejection — terminate so NATS
                        // stops redelivering; log with class only.
                        tracing::warn!(error = %e, error_class = "broker_poison", "invalid event terminated");
                        let _ = message.ack_with(async_nats::jetstream::AckKind::Term).await;
                    }
                }
            }
        }
    }
}
