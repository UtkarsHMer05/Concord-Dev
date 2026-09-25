//! Connection session state machine + in-process document room registry
//! (P3-M023/M025).
//!
//! States follow PROTOCOL §9.13 exactly; frames illegal for the current
//! state are rejected with `invalid_state` by the ws handler (which owns
//! the machine). The registry is the Phase 3 single-gateway fanout point —
//! a clean seam so Phase 4 can swap in a broker-backed registry without
//! touching protocol code (P3-M048 boundary).
//!
//! The registry holds NO durable truth: rooms are rebuilt from client
//! joins + PostgreSQL; empty rooms are removed (no leak).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{mpsc, watch, Mutex};

use uuid::Uuid;

/// Connection lifecycle state (PROTOCOL §9.13, normative).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SessionState {
    /// TCP/WS established, awaiting `hello`.
    Connected,
    /// `hello` accepted, awaiting `authenticate`.
    HelloDone,
    /// Token verified, awaiting `join_document`.
    Authenticated,
    /// Join accepted, catch-up in flight.
    Syncing,
    /// Catch-up complete (`sync_done`); ops flow.
    Ready,
    /// `server_draining` sent or drain initiated; no new writes accepted.
    Draining,
    /// Terminal.
    Closed,
}

impl SessionState {
    /// `client_ops` (binary data frames) are legal only in READY.
    pub fn can_send_client_ops(self) -> bool {
        matches!(self, SessionState::Ready)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, SessionState::Closed)
    }
}

/// A frame the writer task sends to the socket.
#[derive(Debug, Clone)]
pub enum OutboundFrame {
    Text(String),
    Binary(Vec<u8>),
}

/// What one live connection presents to its document room.
pub struct ConnectionHandle {
    pub connection_id: Uuid,
    pub user_id: Uuid,
    /// Role at join time (server-computed); writes are rechecked per batch
    /// against the DB, never against this cached value (P3-M037).
    pub join_role: crate::db::authz::EffectiveRole,
    /// Bounded outbound frame queue (M026). Capacity from config.
    pub outbound: mpsc::Sender<OutboundFrame>,
    /// Out-of-band close signal so a full outbound queue cannot prevent cleanup.
    pub close: watch::Sender<bool>,
}

/// One document room: the set of live connections joined to the document.
struct Room {
    connections: HashMap<Uuid, ConnectionHandle>,
}

/// In-process document-session registry (P3-M025). Concurrency-safe;
/// rooms vanish when empty (no leak, no durable truth).
pub struct SessionRegistry {
    rooms: Mutex<HashMap<Uuid, Room>>,
    connections: Mutex<HashMap<Uuid, watch::Sender<bool>>>,
}

impl SessionRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            rooms: Mutex::new(HashMap::new()),
            connections: Mutex::new(HashMap::new()),
        })
    }

    /// Tracks every upgraded socket, including those not yet joined to a document.
    pub async fn register_connection(&self, id: Uuid, close: watch::Sender<bool>) {
        self.connections.lock().await.insert(id, close);
    }

    pub async fn unregister_connection(&self, id: Uuid) {
        self.connections.lock().await.remove(&id);
    }

    /// Closes every tracked socket independently of its bounded outbound queue.
    pub async fn close_all(&self) {
        for close in self.connections.lock().await.values() {
            close.send_replace(true);
        }
    }

    /// Registers a joined connection; creates the room when first.
    pub async fn join(&self, document: Uuid, handle: ConnectionHandle) {
        let mut rooms = self.rooms.lock().await;
        rooms
            .entry(document)
            .or_insert_with(|| Room {
                connections: HashMap::new(),
            })
            .connections
            .insert(handle.connection_id, handle);
    }

    /// Removes a connection; removes the room when it becomes empty.
    pub async fn leave(&self, document: Uuid, connection_id: Uuid) {
        let mut rooms = self.rooms.lock().await;
        if let Some(room) = rooms.get_mut(&document) {
            room.connections.remove(&connection_id);
            if room.connections.is_empty() {
                rooms.remove(&document);
            }
        }
    }

    /// Fan out an accepted durable operation batch to every OTHER member
    /// of the document room (P3-M028): the sender receives its `durable_ack`
    /// separately and is deliberately not echoed the ops (CRDT idempotency
    /// makes duplicate receipt safe; echoing is pointless traffic).
    ///
    /// Bounded behavior (M026): a peer whose outbound queue is full is a
    /// slow consumer — `try_send` fails and its out-of-band close signal is
    /// set. Persistence never blocks on a slow peer.
    pub async fn fanout(
        &self,
        document: Uuid,
        sender: Uuid,
        frame: OutboundFrame,
        mark_slow: &mut Vec<Uuid>,
    ) {
        let rooms = self.rooms.lock().await;
        let Some(room) = rooms.get(&document) else {
            return;
        };
        for (id, handle) in room.connections.iter() {
            if *id == sender {
                continue;
            }
            if handle.outbound.try_send(frame.clone()).is_err() {
                handle.close.send_replace(true);
                mark_slow.push(*id);
            }
        }
    }

    /// Sends a control frame to every member of one room (drain notices).
    pub async fn broadcast(&self, document: Uuid, frame: OutboundFrame) {
        let rooms = self.rooms.lock().await;
        if let Some(room) = rooms.get(&document) {
            for handle in room.connections.values() {
                let _ = handle.outbound.try_send(frame.clone());
            }
        }
    }

    /// Best-effort EPHEMERAL relay (presence / live cursors): deliver a frame
    /// to every OTHER room member, DROPPING silently when a peer's queue is
    /// full. Unlike [`Self::fanout`], a slow consumer is never marked or
    /// closed — presence is disposable and must never exert backpressure on
    /// durable delivery nor tear down a connection over a dropped caret.
    pub async fn relay_ephemeral(&self, document: Uuid, sender: Uuid, frame: OutboundFrame) {
        let rooms = self.rooms.lock().await;
        let Some(room) = rooms.get(&document) else {
            return;
        };
        for (id, handle) in room.connections.iter() {
            if *id == sender {
                continue;
            }
            let _ = handle.outbound.try_send(frame.clone());
        }
    }

    /// Collects outbound senders of ALL live connections (graceful drain).
    pub async fn senders_all(&self, senders: &mut Vec<mpsc::Sender<OutboundFrame>>) {
        let rooms = self.rooms.lock().await;
        for room in rooms.values() {
            for handle in room.connections.values() {
                senders.push(handle.outbound.clone());
            }
        }
    }

    /// Number of live rooms (metrics/tests).
    pub async fn room_count(&self) -> usize {
        self.rooms.lock().await.len()
    }

    /// Members of one room (tests).
    pub async fn room_members(&self, document: Uuid) -> HashSet<Uuid> {
        self.rooms
            .lock()
            .await
            .get(&document)
            .map(|r| r.connections.keys().copied().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::authz::EffectiveRole;

    fn handle(id: Uuid, cap: usize) -> (ConnectionHandle, mpsc::Receiver<OutboundFrame>) {
        let (tx, rx) = mpsc::channel(cap);
        (
            ConnectionHandle {
                connection_id: id,
                user_id: Uuid::new_v4(),
                join_role: EffectiveRole::Editor,
                outbound: tx,
                close: watch::channel(false).0,
            },
            rx,
        )
    }

    #[tokio::test]
    async fn room_lifecycle_join_leave_cleanup() {
        let registry = SessionRegistry::new();
        let doc = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let (ha, _ra) = handle(a, 8);
        let (hb, _rb) = handle(b, 8);
        registry.join(doc, ha).await;
        registry.join(doc, hb).await;
        assert_eq!(registry.room_count().await, 1);
        assert_eq!(registry.room_members(doc).await.len(), 2);

        registry.leave(doc, a).await;
        assert_eq!(registry.room_members(doc).await.len(), 1);
        registry.leave(doc, b).await;
        // Empty room removed — no leak (P3-M025).
        assert_eq!(registry.room_count().await, 0);
    }

    #[tokio::test]
    async fn fanout_skips_sender_and_delivers_to_peers() {
        let registry = SessionRegistry::new();
        let doc = Uuid::new_v4();
        let sender = Uuid::new_v4();
        let peer_a = Uuid::new_v4();
        let peer_b = Uuid::new_v4();
        let (hs, mut rs) = handle(sender, 8);
        let (ha, mut ra) = handle(peer_a, 8);
        let (hb, mut rb) = handle(peer_b, 8);
        registry.join(doc, hs).await;
        registry.join(doc, ha).await;
        registry.join(doc, hb).await;

        let mut slow = Vec::new();
        registry
            .fanout(doc, sender, OutboundFrame::Binary(vec![1, 2, 3]), &mut slow)
            .await;
        assert!(slow.is_empty());
        assert!(matches!(ra.recv().await, Some(OutboundFrame::Binary(_))));
        assert!(matches!(rb.recv().await, Some(OutboundFrame::Binary(_))));
        // Sender is not echoed (its receipt is the durable_ack).
        assert!(rs.try_recv().is_err());
    }

    #[tokio::test]
    async fn slow_consumer_marked_and_never_blocks_fanout() {
        let registry = SessionRegistry::new();
        let doc = Uuid::new_v4();
        let sender = Uuid::new_v4();
        let slow_peer = Uuid::new_v4();
        let fast_peer = Uuid::new_v4();
        let (hs, _rs) = handle(sender, 8);
        let (hslow, _rslow) = handle(slow_peer, 1); // capacity 1 — fills fast
        let mut slow_close = hslow.close.subscribe();
        let (hfast, mut rfast) = handle(fast_peer, 8);
        registry.join(doc, hs).await;
        registry.join(doc, hslow).await;
        registry.join(doc, hfast).await;

        let mut slow = Vec::new();
        for i in 0..4 {
            registry
                .fanout(doc, sender, OutboundFrame::Binary(vec![i]), &mut slow)
                .await;
        }
        // The stalled peer got marked (queue capacity 1, no receiver).
        assert!(slow.contains(&slow_peer), "slow consumer must be marked");
        assert!(slow_close.changed().await.is_ok());
        assert!(*slow_close.borrow(), "slow consumer must be closed");
        // The fast peer still received frames (fanout never blocked).
        assert!(matches!(rfast.try_recv(), Ok(OutboundFrame::Binary(_))));
    }

    #[tokio::test]
    async fn close_all_signals_unjoined_connections() {
        let registry = SessionRegistry::new();
        let id = Uuid::new_v4();
        let (close, mut receiver) = watch::channel(false);
        registry.register_connection(id, close).await;
        registry.close_all().await;
        assert!(receiver.changed().await.is_ok());
        assert!(*receiver.borrow());
        registry.unregister_connection(id).await;
    }

    #[tokio::test]
    async fn fanout_on_unknown_document_is_noop() {
        let registry = SessionRegistry::new();
        let mut slow = Vec::new();
        registry
            .fanout(
                Uuid::new_v4(),
                Uuid::new_v4(),
                OutboundFrame::Text("{}".into()),
                &mut slow,
            )
            .await;
        assert!(slow.is_empty());
    }

    #[tokio::test]
    async fn relay_ephemeral_skips_sender_and_never_closes_slow_peers() {
        let registry = SessionRegistry::new();
        let doc = Uuid::new_v4();
        let sender = Uuid::new_v4();
        let fast = Uuid::new_v4();
        let slow = Uuid::new_v4();
        let (hs, mut rs) = handle(sender, 8);
        let (hf, mut rf) = handle(fast, 8);
        let (hslow, _rslow) = handle(slow, 1); // capacity 1, no receiver drain
        let mut slow_close = hslow.close.subscribe();
        registry.join(doc, hs).await;
        registry.join(doc, hf).await;
        registry.join(doc, hslow).await;

        // Many relays: the slow peer's queue overflows and frames are dropped,
        // but it is NEVER closed and the fast peer keeps receiving.
        for i in 0..8u8 {
            registry
                .relay_ephemeral(doc, sender, OutboundFrame::Text(format!("p{i}")))
                .await;
        }
        assert!(matches!(rf.try_recv(), Ok(OutboundFrame::Text(_))));
        assert!(
            rs.try_recv().is_err(),
            "sender is never echoed its own presence"
        );
        assert!(
            !*slow_close.borrow_and_update(),
            "presence must not close a slow peer"
        );
    }

    #[test]
    fn state_machine_transitions() {
        // client_ops only in Ready; Draining rejects writes.
        assert!(SessionState::Ready.can_send_client_ops());
        assert!(!SessionState::Syncing.can_send_client_ops());
        assert!(!SessionState::Authenticated.can_send_client_ops());
        assert!(!SessionState::Draining.can_send_client_ops());
        assert!(SessionState::Closed.is_terminal());
    }
}
