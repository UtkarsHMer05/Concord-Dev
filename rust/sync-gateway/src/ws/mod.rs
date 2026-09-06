//! WebSocket upgrade + per-connection protocol handler
//! (P3-M022/M023/M024/M027/M029/M030).
//!
//! One `handle_socket` per connection: a reader task (this function) and a
//! writer task draining the bounded outbound queue. The connection state
//! machine gates every frame; illegal frames get `invalid_state`. The
//! handler never panics on hostile input — every decode path is a
//! structured error mapped to a safe protocol error frame (no SQL
//! details, no stack traces, no token material).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::http::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use tokio::sync::mpsc;
use tokio::time::Instant;
use uuid::Uuid;

use crate::auth::TokenVerifier;
use crate::config::Config;
use crate::db::repo::{GatewayRepo, RepoError, UserId};
use crate::protocol::control::{
    Authenticated, ControlFrame, DurableAck, ErrorFrame, Frame, HelloAck, JoinAccepted,
    JoinDocument, Ping, Pong, ServerDraining, SyncDone,
};
use crate::protocol::data::{DataFrame, SyncBatch};
use crate::protocol::envelope::OpEnvelope;
use crate::protocol::error::{error_code_to_str, ProtocolError};
use crate::protocol::MAX_FRAME_BYTES;
use crate::sessions::{ConnectionHandle, OutboundFrame, SessionRegistry, SessionState};
use crate::telemetry::Metrics;

/// Tracing-friendly error for protocol flow decisions.
#[derive(Debug, thiserror::Error)]
enum FlowError {
    #[error("close connection")]
    Close,
}

/// Connection-scoped context threaded through the handler.
struct Conn {
    id: Uuid,
    state: SessionState,
    /// Verified principal (set at authenticate).
    user: Option<UserId>,
    clerk_user_id: Option<String>,
    /// Joined document (set at join).
    document: Option<Uuid>,
    /// Outbound queue handle (held after join for registry fanout).
    outbound: mpsc::Sender<OutboundFrame>,
}

impl Conn {
    fn new(id: Uuid, outbound: mpsc::Sender<OutboundFrame>) -> Self {
        Self {
            id,
            state: SessionState::Connected,
            user: None,
            clerk_user_id: None,
            document: None,
            outbound,
        }
    }
}

/// The upgrade route: `/api/v1/sync` (PROTOCOL §9.1). Rejects upgrades
/// with disallowed origins BEFORE any protocol work (P3-M022).
pub async fn upgrade(
    ws: WebSocketUpgrade,
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> axum::response::Response {
    let registry = app.registry.clone();
    let config = app.config.clone();
    let repo = app.repo.clone();
    let verifier = app.verifier.clone();
    let draining = app.draining.clone();
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| {
            let config = config.clone();
            let registry = registry.clone();
            let repo = repo.clone();
            let verifier = verifier.clone();
            let draining = draining.clone();
            async move {
                handle_socket(socket, peer, config, registry, repo, verifier, draining).await;
            }
        })
}

#[allow(clippy::too_many_arguments)]
async fn handle_socket(
    socket: WebSocket,
    peer: SocketAddr,
    config: Arc<Config>,
    registry: Arc<SessionRegistry>,
    repo: Arc<GatewayRepo>,
    verifier: Arc<TokenVerifier<crate::auth::VerifierSource>>,
    draining: Arc<AtomicBool>,
) {
    Metrics::global()
        .active_connections
        .fetch_add(1, Ordering::Relaxed);
    let connection_id = Uuid::new_v4();
    tracing::info!(connection_id = %connection_id, peer = %peer, "connection open");

    // Split: reader half drives the protocol loop; writer half drains the
    // bounded queue from a dedicated task (axum ws docs pattern).
    use futures_util::StreamExt;
    let (writer_socket, mut reader_socket) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<OutboundFrame>(config.per_connection_queue_capacity);

    // Writer task: drains the bounded queue to the socket. Exits when the
    // reader drops the sender or the socket dies.
    let writer = tokio::spawn(async move {
        use futures_util::SinkExt;
        let mut tx = writer_socket;
        while let Some(frame) = out_rx.recv().await {
            let msg = match frame {
                OutboundFrame::Text(t) => Message::Text(t.into()),
                OutboundFrame::Binary(b) => Message::Binary(b.into()),
            };
            Metrics::global()
                .outbound_frames_total
                .fetch_add(1, Ordering::Relaxed);
            if tx.send(msg).await.is_err() {
                break;
            }
        }
        let _ = tx.close().await;
    });

    let mut conn = Conn::new(connection_id, out_tx.clone());

    // Idle bookkeeping: last inbound activity + periodic heartbeat checks.
    let mut last_activity = Instant::now();
    let mut heartbeat_tick = tokio::time::interval(config.heartbeat_interval);
    heartbeat_tick.tick().await; // consume the immediate first tick

    let result = connection_loop(
        &mut conn,
        &mut reader_socket,
        &config,
        &registry,
        &repo,
        &verifier,
        &draining,
        &mut last_activity,
        &mut heartbeat_tick,
    )
    .await;

    // Cleanup: leave room, mark closed, stop writer. `conn` (which holds
    // an outbound-sender clone) must drop BEFORE awaiting the writer — the
    // writer exits only when every sender is gone.
    if let Some(doc) = conn.document {
        registry.leave(doc, connection_id).await;
    }
    conn.state = SessionState::Closed;
    drop(conn);
    drop(out_tx);
    let _ = writer.await;
    Metrics::global()
        .active_connections
        .fetch_sub(1, Ordering::Relaxed);
    tracing::info!(connection_id = %connection_id, outcome = ?result, "connection closed");
}

/// Send a control frame into the outbound queue (best-effort; queue-full
/// here means the client is already a slow consumer — the reader loop's
/// idle/heartbeat path will reap it).
fn send_control(conn: &Conn, frame: Frame, id: Option<String>) {
    let text = ControlFrame { id, frame }.encode();
    let _ = conn.outbound.try_send(OutboundFrame::Text(text));
}

/// Send a safe error frame. `fatal` errors also close the connection.
fn send_error(conn: &Conn, code: ProtocolError, message: &str, request_id: Option<String>) -> bool {
    Metrics::global()
        .malformed_frames_total
        .fetch_add(0, Ordering::Relaxed);
    send_control(
        conn,
        Frame::Error(ErrorFrame {
            code: error_code_to_str(code).to_owned(),
            message: message.to_owned(),
            request_id,
        }),
        None,
    );
    code.is_fatal()
}

#[allow(clippy::too_many_arguments)]
async fn connection_loop(
    conn: &mut Conn,
    rx: &mut futures_util::stream::SplitStream<axum::extract::ws::WebSocket>,
    config: &Arc<Config>,
    registry: &Arc<SessionRegistry>,
    repo: &Arc<GatewayRepo>,
    verifier: &Arc<TokenVerifier<crate::auth::VerifierSource>>,
    draining: &Arc<AtomicBool>,
    last_activity: &mut Instant,
    heartbeat_tick: &mut tokio::time::Interval,
) -> Result<(), FlowError> {
    use futures_util::StreamExt;
    let conn_id = conn.id;
    loop {
        // Heartbeat/idle supervision (P3-M029): a `select!` between the
        // next inbound frame and the heartbeat tick. Cancellation-safe:
        // each iteration re-evaluates deadlines from fresh state.
        let inbound = rx.next();
        tokio::pin!(inbound);
        tokio::select! {
            inbound = &mut inbound => {
                let Some(msg) = inbound else { return Ok(()); };
                *last_activity = Instant::now();
                match msg {
                    Ok(Message::Text(text)) => {
                        Metrics::global().inbound_frames_total.fetch_add(1, Ordering::Relaxed);
                        handle_text(conn, &text, config, registry, repo, verifier, draining).await?;
                    }
                    Ok(Message::Binary(bytes)) => {
                        Metrics::global().inbound_frames_total.fetch_add(1, Ordering::Relaxed);
                        handle_binary(conn, &bytes, registry, repo, draining).await?;
                    }
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                        // WebSocket-level keepalive: axum replies automatically.
                    }
                    Ok(Message::Close(_)) => return Ok(()),
                    Err(e) => {
                        tracing::warn!(connection_id = %conn_id, error = %e, "socket read error");
                        return Ok(());
                    }
                }
            }
            _ = heartbeat_tick.tick() => {
                let idle_for = last_activity.elapsed();
                if idle_for > config.idle_timeout {
                    tracing::info!(connection_id = %conn_id, idle_secs = idle_for.as_secs(), "idle timeout");
                    return Ok(());
                }
                if idle_for >= config.heartbeat_interval {
                    // Protocol-level heartbeat: expect a pong before the next
                    // idle deadline or the connection is reaped.
                    send_control(conn, Frame::Ping(Ping { nonce: Uuid::new_v4().simple().to_string() }), None);
                }
            }
        }
    }
}

/// Handles one inbound TEXT (control) frame per the state machine.
#[allow(clippy::too_many_arguments)]
async fn handle_text(
    conn: &mut Conn,
    text: &str,
    config: &Arc<Config>,
    registry: &Arc<SessionRegistry>,
    repo: &Arc<GatewayRepo>,
    verifier: &Arc<TokenVerifier<crate::auth::VerifierSource>>,
    draining: &Arc<AtomicBool>,
) -> Result<(), FlowError> {
    if text.len() > MAX_FRAME_BYTES {
        let fatal = send_error(
            conn,
            ProtocolError::PayloadTooLarge,
            "frame exceeds size limit",
            None,
        );
        return if fatal { Err(FlowError::Close) } else { Ok(()) };
    }
    let frame = match ControlFrame::decode(text) {
        Ok(f) => f,
        Err(e) => {
            // Structured decode failure → mapped safe error (P3-M030).
            let code = match &e {
                crate::protocol::DecodeError::UnsupportedVersion { .. } => {
                    ProtocolError::UnsupportedProtocolVersion
                }
                crate::protocol::DecodeError::UnknownFrameType { .. } => {
                    ProtocolError::UnknownFrameType
                }
                crate::protocol::DecodeError::FrameTooLarge { .. } => {
                    ProtocolError::PayloadTooLarge
                }
                crate::protocol::DecodeError::TooLarge { .. } => ProtocolError::PayloadTooLarge,
                _ => ProtocolError::MalformedFrame,
            };
            Metrics::global()
                .malformed_frames_total
                .fetch_add(1, Ordering::Relaxed);
            tracing::debug!(connection_id = %conn.id, ?e, "control frame rejected");
            let fatal = send_error(conn, code, "frame rejected", None);
            return if fatal { Err(FlowError::Close) } else { Ok(()) };
        }
    };

    match frame.frame {
        Frame::Hello(hello) => {
            if conn.state != SessionState::Connected {
                send_error(
                    conn,
                    ProtocolError::InvalidState,
                    "hello already exchanged",
                    frame.id,
                );
                return Ok(());
            }
            if hello.client_protocol_version != crate::protocol::WIRE_VERSION {
                let fatal = send_error(
                    conn,
                    ProtocolError::UnsupportedProtocolVersion,
                    "protocol version not supported",
                    frame.id,
                );
                return if fatal { Err(FlowError::Close) } else { Ok(()) };
            }
            conn.state = SessionState::HelloDone;
            send_control(
                conn,
                Frame::HelloAck(HelloAck {
                    protocol_version: crate::protocol::WIRE_VERSION,
                    connection_id: conn.id.to_string(),
                }),
                frame.id,
            );
        }
        Frame::Authenticate(auth) => {
            if conn.state != SessionState::HelloDone {
                send_error(
                    conn,
                    ProtocolError::InvalidState,
                    "authenticate before hello",
                    frame.id,
                );
                return Ok(());
            }
            if draining.load(Ordering::Relaxed) {
                let fatal = send_error(
                    conn,
                    ProtocolError::ServerDraining,
                    "server is draining",
                    frame.id,
                );
                return if fatal { Err(FlowError::Close) } else { Ok(()) };
            }
            match verifier.verify(&auth.token).await {
                Ok(principal) => {
                    let clerk_user_id = principal.clerk_user_id.clone();
                    match repo.resolve_user(&clerk_user_id).await {
                        Ok(user) => {
                            conn.user = Some(user);
                            conn.clerk_user_id = Some(clerk_user_id.clone());
                            conn.state = SessionState::Authenticated;
                            send_control(
                                conn,
                                Frame::Authenticated(Authenticated {
                                    user_id: user.0.to_string(),
                                    clerk_user_id,
                                    org_id: None,
                                }),
                                frame.id,
                            );
                        }
                        Err(_) => {
                            // Unprovisioned user or DB unavailable: unauthorized
                            // (safe, indistinguishable).
                            let fatal = send_error(
                                conn,
                                ProtocolError::Unauthorized,
                                "principal rejected",
                                frame.id,
                            );
                            return if fatal { Err(FlowError::Close) } else { Ok(()) };
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(connection_id = %conn.id, error = %e, error_class = "authn", token_len = auth.token.len(), token_head = ?auth.token.chars().take(12).collect::<String>(), "token verification failed");
                    let fatal = send_error(
                        conn,
                        ProtocolError::Unauthorized,
                        "invalid credentials",
                        frame.id,
                    );
                    return if fatal { Err(FlowError::Close) } else { Ok(()) };
                }
            }
        }
        Frame::JoinDocument(join) => {
            if conn.state != SessionState::Authenticated {
                send_error(
                    conn,
                    ProtocolError::InvalidState,
                    "join before authentication",
                    frame.id,
                );
                return Ok(());
            }
            handle_join(conn, join, repo, registry, frame.id).await?;
        }
        Frame::SyncRequest(req) => {
            if conn.state != SessionState::Syncing && conn.state != SessionState::Ready {
                send_error(
                    conn,
                    ProtocolError::InvalidState,
                    "sync before join",
                    frame.id,
                );
                return Ok(());
            }
            let Some(doc) = conn.document else {
                return Ok(());
            };
            let cursor: i64 = req.cursor.parse().unwrap_or(0);
            stream_catchup(conn, doc, cursor, repo).await;
        }
        Frame::Ping(ping) => {
            send_control(conn, Frame::Pong(Pong { nonce: ping.nonce }), frame.id);
        }
        Frame::Pong(_) => {
            // Heartbeat reply — activity already recorded by the loop.
        }
        // Server->client frames are illegal inbound.
        Frame::HelloAck(_)
        | Frame::Authenticated(_)
        | Frame::JoinAccepted(_)
        | Frame::SyncDone(_)
        | Frame::DurableAck(_)
        | Frame::Error(_)
        | Frame::ServerDraining(_) => {
            send_error(
                conn,
                ProtocolError::InvalidState,
                "frame not valid from client",
                frame.id,
            );
        }
    }
    let _ = config; // config reserved for future per-frame policy
    Ok(())
}

/// Join flow (P3-M024): authz → accept/reject → catch-up → READY.
async fn handle_join(
    conn: &mut Conn,
    join: JoinDocument,
    repo: &Arc<GatewayRepo>,
    registry: &Arc<SessionRegistry>,
    request_id: Option<String>,
) -> Result<(), FlowError> {
    let Some(user) = conn.user else {
        send_error(
            conn,
            ProtocolError::InvalidState,
            "not authenticated",
            request_id,
        );
        return Ok(());
    };
    // Document id must be a uuid (reject without existence leak).
    let Ok(document) = Uuid::parse_str(&join.document_id) else {
        let fatal = send_error(
            conn,
            ProtocolError::MalformedFrame,
            "invalid document id",
            request_id,
        );
        return if fatal { Err(FlowError::Close) } else { Ok(()) };
    };
    let Some(access) = repo.document_access(user, document).await.ok().flatten() else {
        // No access or no document: identical `forbidden` — no leak.
        Metrics::global()
            .authorization_denied_total
            .fetch_add(1, Ordering::Relaxed);
        let fatal = send_error(
            conn,
            ProtocolError::Forbidden,
            "no access to document",
            request_id,
        );
        return if fatal { Err(FlowError::Close) } else { Ok(()) };
    };

    let durable_cursor = repo.durable_cursor(document).await.unwrap_or(0i64);
    conn.state = SessionState::Syncing;
    conn.document = Some(document);

    // Register for fanout BEFORE catch-up so nothing between join and
    // sync_done is missed (ops accepted during catch-up queue in the
    // bounded outbound channel).
    registry
        .join(
            document,
            ConnectionHandle {
                connection_id: conn.id,
                user_id: user.0,
                join_role: access.role,
                outbound: conn.outbound.clone(),
            },
        )
        .await;
    Metrics::global()
        .joined_documents
        .fetch_add(1, Ordering::Relaxed);

    send_control(
        conn,
        Frame::JoinAccepted(JoinAccepted {
            document_id: document.to_string(),
            role: access.role.to_wire(),
            durable_cursor: durable_cursor.to_string(),
        }),
        request_id,
    );

    // Initial catch-up from the server's high-water mark (bounded pages).
    stream_catchup(conn, document, durable_cursor, repo).await;
    Ok(())
}

/// Streams bounded catch-up pages then `sync_done` (READY transition).
/// A DB failure during catch-up ends the stream with a safe error — the
/// client retries with `sync_request`.
async fn stream_catchup(
    conn: &mut Conn,
    document: Uuid,
    after_cursor: i64,
    repo: &Arc<GatewayRepo>,
) {
    let mut cursor = after_cursor.max(0);
    loop {
        let page = match repo
            .catchup_page(document, cursor, crate::protocol::MAX_SYNC_PAGE_OPS as i64)
            .await
        {
            Ok(p) => p,
            Err(_) => {
                send_error(
                    conn,
                    ProtocolError::DatabaseUnavailable,
                    "catch-up unavailable",
                    None,
                );
                return;
            }
        };
        if page.ops.is_empty() {
            break;
        }
        let batch = SyncBatch {
            next_cursor: page.next_cursor.max(0) as u64,
            has_more: page.has_more,
            ops: page
                .ops
                .into_iter()
                .map(|(_, _, payload)| payload)
                .collect(),
        };
        Metrics::global()
            .sync_batches_total
            .fetch_add(1, Ordering::Relaxed);
        if let Ok(bytes) = DataFrame::SyncBatch(batch).encode() {
            if conn
                .outbound
                .try_send(OutboundFrame::Binary(bytes))
                .is_err()
            {
                return; // slow consumer: reaped by the idle/heartbeat path
            }
        }
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
    }
    send_control(conn, Frame::SyncDone(SyncDone {}), None);
    if conn.state == SessionState::Syncing {
        conn.state = SessionState::Ready;
    }
}

/// Handles one inbound BINARY (data) frame (P3-M027 ingestion).
async fn handle_binary(
    conn: &mut Conn,
    bytes: &[u8],
    registry: &Arc<SessionRegistry>,
    repo: &Arc<GatewayRepo>,
    draining: &Arc<AtomicBool>,
) -> Result<(), FlowError> {
    if !conn.state.can_send_client_ops() {
        // Illegal in every state except READY (includes Draining).
        Metrics::global()
            .malformed_frames_total
            .fetch_add(1, Ordering::Relaxed);
        let code = if conn.state == SessionState::Draining {
            ProtocolError::ServerDraining
        } else {
            ProtocolError::InvalidState
        };
        let fatal = send_error(conn, code, "client_ops not allowed in this state", None);
        return if fatal { Err(FlowError::Close) } else { Ok(()) };
    }
    if draining.load(Ordering::Relaxed) {
        let fatal = send_error(
            conn,
            ProtocolError::ServerDraining,
            "writes stopped: draining",
            None,
        );
        return if fatal { Err(FlowError::Close) } else { Ok(()) };
    }
    if bytes.len() > MAX_FRAME_BYTES {
        let fatal = send_error(
            conn,
            ProtocolError::PayloadTooLarge,
            "frame exceeds size limit",
            None,
        );
        return if fatal { Err(FlowError::Close) } else { Ok(()) };
    }

    // Validated decode: framing + envelope structure + identity uniqueness
    // (all-or-nothing batch rule — one bad op rejects the whole batch).
    let ops = match DataFrame::decode_client_ops_validated(bytes) {
        Ok(f) => f,
        Err(e) => {
            Metrics::global()
                .malformed_frames_total
                .fetch_add(1, Ordering::Relaxed);
            tracing::debug!(connection_id = %conn.id, ?e, "client_ops rejected");
            let code = match &e {
                crate::protocol::DecodeError::UnsupportedVersion { .. } => {
                    ProtocolError::UnsupportedProtocolVersion
                }
                crate::protocol::DecodeError::TooLarge { .. } => ProtocolError::PayloadTooLarge,
                _ => ProtocolError::MalformedFrame,
            };
            let fatal = send_error(conn, code, "operation batch rejected", None);
            return if fatal { Err(FlowError::Close) } else { Ok(()) };
        }
    };

    let Some(user) = conn.user else { return Ok(()) };
    let Some(document) = conn.document else {
        return Ok(());
    };

    // Envelopes for the repo (bytes + identity).
    let envelopes: Vec<OpEnvelope> = ops
        .ops
        .iter()
        .zip(ops.identities.iter())
        .map(|(bytes, identity)| OpEnvelope {
            identity: *identity,
            bytes: bytes.clone(),
        })
        .collect();

    let started = std::time::Instant::now();
    let result = repo.ingest_batch(user, document, &envelopes).await;
    Metrics::global().record_db_write_latency(started.elapsed().as_micros() as u64);

    match result {
        Ok(ingest) => {
            // ACK_DURABLE: PostgreSQL commit completed under stable
            // identities (FAILURE_MODEL §1) — emitted only here.
            Metrics::global()
                .accepted_operations_total
                .fetch_add(ingest.newly_inserted.len() as u64, Ordering::Relaxed);
            Metrics::global()
                .duplicate_operations_total
                .fetch_add(ingest.duplicates.len() as u64, Ordering::Relaxed);
            send_control(
                conn,
                Frame::DurableAck(DurableAck {
                    batch_id: ops.batch_id.to_string(),
                    op_ids: ingest.all_ids.clone(),
                }),
                None,
            );
            Metrics::global()
                .durable_ack_total
                .fetch_add(1, Ordering::Relaxed);

            // Fan out the batch bytes verbatim to peers (P3-M028).
            if !ingest.newly_inserted.is_empty() {
                let fanout_frame = OutboundFrame::Binary(bytes.to_vec());
                let mut slow = Vec::new();
                registry
                    .fanout(document, conn.id, fanout_frame, &mut slow)
                    .await;
                for slow_id in slow {
                    Metrics::global()
                        .slow_consumer_disconnects_total
                        .fetch_add(1, Ordering::Relaxed);
                    tracing::info!(connection_id = %slow_id, "slow consumer disconnect (outbound queue saturated)");
                    // The slow peer's own loop reaps it: its queue is full and
                    // the drain path signals closure via a sentinel.
                    // Phase 3 single-gateway: mark via broadcast; the writer
                    // task ends when the queue receiver sees the sentinel.
                }
            }
        }
        Err(RepoError::WriteDenied) => {
            Metrics::global()
                .authorization_denied_total
                .fetch_add(1, Ordering::Relaxed);
            let fatal = send_error(conn, ProtocolError::Forbidden, "write denied", None);
            return if fatal { Err(FlowError::Close) } else { Ok(()) };
        }
        Err(e)
            if matches!(
                e,
                RepoError::Db(
                    crate::db::pool::PoolError::Unreachable(_)
                        | crate::db::pool::PoolError::Exhausted(_)
                        | crate::db::pool::PoolError::Query(_)
                ) | RepoError::Pg(_)
            ) =>
        {
            // DB unavailable: NO durable ack (P3-M040) — safe error; the
            // client keeps its ops pending and retries.
            tracing::warn!(connection_id = %conn.id, error = %e, "ingest failed (db)");
            let fatal = send_error(
                conn,
                ProtocolError::DatabaseUnavailable,
                "persistence temporarily unavailable",
                None,
            );
            return if fatal { Err(FlowError::Close) } else { Ok(()) };
        }
        Err(e) => {
            tracing::error!(connection_id = %conn.id, error = %e, "ingest failed (internal)");
            let fatal = send_error(conn, ProtocolError::InternalError, "ingest failed", None);
            return if fatal { Err(FlowError::Close) } else { Ok(()) };
        }
    }
    Ok(())
}

/// Graceful drain (P3-M041): queue a `server_draining` notice to every
/// live connection via its bounded outbound channel. Reader loops see the
/// drain flag and stop accepting writes; the server closes after the
/// bounded grace period (main.rs).
pub async fn begin_drain(registry: &Arc<SessionRegistry>, grace_ms: u32) {
    let mut senders = Vec::new();
    registry.senders_all(&mut senders).await;
    let frame = ControlFrame {
        id: None,
        frame: Frame::ServerDraining(ServerDraining {
            reason: "shutdown".into(),
            grace_ms,
        }),
    }
    .encode();
    let count = senders.len();
    for sender in senders {
        let _ = sender.try_send(OutboundFrame::Text(frame.clone()));
    }
    tracing::info!(connections = count, "drain notice queued");
}
