//! WebSocket upgrade + per-connection protocol handler
//! (P3-M022/M023/M024/M027/M029/M030).
//!
//! One `handle_socket` per connection: a reader task (this function) and a
//! writer task draining the bounded outbound queue. The connection state
//! machine gates every frame; illegal frames get `invalid_state`. The
//! handler never panics on hostile input — every decode path is a
//! structured error mapped to a safe protocol error frame (no SQL
//! details, no stack traces, no token material).

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::bus::EventPublisher;
use crate::ephemeral::ratelimit::RateLimitOutcome;
use crate::http::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::IntoResponse;
use tokio::sync::mpsc;
use tokio::time::Instant;
use uuid::Uuid;

/// Resolve a connect-limit identity only through explicitly trusted peers.
/// Each trusted hop appends its observed peer to XFF. Walk right to left and
/// use the first untrusted address; a client-supplied leftmost spoof cannot
/// replace the actual address appended by the LB. Invalid/ambiguous chains
/// conservatively use the TCP peer's shared bucket.
fn client_ip(
    peer: SocketAddr,
    headers: &axum::http::HeaderMap,
    trusted: &[ipnet::IpNet],
) -> IpAddr {
    if !trusted.iter().any(|range| range.contains(&peer.ip())) {
        return peer.ip();
    }
    let mut values = headers.get_all("x-forwarded-for").iter();
    let Some(value) = values.next() else {
        return peer.ip();
    };
    if values.next().is_some() {
        return peer.ip();
    }
    let Ok(raw) = value.to_str() else {
        return peer.ip();
    };
    let parts: Vec<_> = raw.split(',').collect();
    if parts.is_empty() || parts.len() > 8 {
        return peer.ip();
    }
    let mut chain = Vec::with_capacity(parts.len());
    for part in parts {
        let Ok(ip) = part.trim().parse::<IpAddr>() else {
            return peer.ip();
        };
        chain.push(ip);
    }
    chain
        .into_iter()
        .rev()
        .find(|ip| !trusted.iter().any(|range| range.contains(ip)))
        .unwrap_or(peer.ip())
}

use crate::auth::TokenVerifier;
use crate::config::Config;
use crate::db::repo::{GatewayRepo, RepoError, UserId};
use crate::protocol::control::{
    Authenticated, ControlFrame, DurableAck, ErrorFrame, FetchSnapshot, Frame, HelloAck,
    JoinAccepted, JoinDocument, Ping, Pong, ServerDraining, SnapshotPayload,
    SnapshotResyncRequired, SyncDone,
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
/// with disallowed origins BEFORE any protocol work (P3-M022; enforcement
/// landed in P7 — finding F-P7-SEC-01 closed).
pub async fn upgrade(
    ws: WebSocketUpgrade,
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    // Origin admission (F-P7-SEC-01 / CSWSH defense): a browser MUST only
    // open this socket from an allowed origin. Non-browser clients omit
    // Origin entirely — allowed (the JWT still gates them; Origin is a
    // browser-scoped defense, not the auth boundary). A present-but-
    // disallowed Origin is a cross-site WebSocket hijack attempt or a
    // misconfigured deployment: reject with 403 before any protocol work.
    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
        let origin_str = origin
            .to_str()
            .map(|value| value.trim_end_matches('/'))
            .unwrap_or("");
        let allowed = app
            .config
            .allowed_origins
            .iter()
            .any(|allowed_origin| allowed_origin.trim_end_matches('/') == origin_str);
        if !allowed {
            crate::telemetry::Metrics::global()
                .rate_limited_total
                .fetch_add(1, Ordering::Relaxed);
            crate::observability::metrics::incr_labeled(
                "concord_ops_rejected_total",
                &[crate::telemetry::reject_reason::AUTHZ],
            );
            tracing::info!(
                origin = %origin_str,
                peer = %peer,
                "upgrade rejected: origin not allowed"
            );
            return axum::http::StatusCode::FORBIDDEN.into_response();
        }
    }
    // Admission control: normalized client IP only when every trusted hop
    // is configured; distributed with Redis, local fallback otherwise.
    let rate_client = client_ip(peer, &headers, &app.config.trusted_proxy_cidrs);
    if app
        .rate_limiter
        .check(
            crate::ephemeral::ratelimit::SCOPE_CONNECT,
            &rate_client.to_string(),
        )
        .await
        == RateLimitOutcome::Limited
    {
        crate::telemetry::Metrics::global()
            .rate_limited_total
            .fetch_add(1, Ordering::Relaxed);
        crate::observability::metrics::incr_labeled("concord_rate_limit_hits_total", &["connect"]);
        crate::observability::metrics::incr_labeled(
            "concord_ops_rejected_total",
            &[crate::telemetry::reject_reason::RATE_LIMITED],
        );
        tracing::info!(peer = %peer, client_ip = %rate_client, "connection rejected: rate limited");
        return axum::http::StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let registry = app.registry.clone();
    let config = app.config.clone();
    let repo = app.repo.clone();
    let verifier = app.verifier.clone();
    let draining = app.draining.clone();
    let bus = app.bus.clone();
    let gateway_id = app.gateway_id;
    let presence = app.presence.clone();
    let rate_limiter = app.rate_limiter.clone();
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| {
            let config = config.clone();
            let registry = registry.clone();
            let repo = repo.clone();
            let verifier = verifier.clone();
            let draining = draining.clone();
            let rate_limiter = rate_limiter.clone();
            async move {
                handle_socket(
                    socket,
                    peer,
                    config,
                    registry,
                    repo,
                    verifier,
                    draining,
                    bus,
                    gateway_id,
                    presence,
                    rate_limiter,
                )
                .await;
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
    bus: Arc<dyn EventPublisher>,
    gateway_id: u64,
    presence: Option<Arc<crate::ephemeral::presence::PresenceStore>>,
    rate_limiter: Arc<crate::ephemeral::ratelimit::RateLimiter>,
) {
    Metrics::global()
        .active_connections
        .fetch_add(1, Ordering::Relaxed);
    // P6-M010: prometheus-surface connection gauges (legacy counter above
    // feeds /api/v1/metrics; this one feeds /metrics).
    crate::observability::metrics::incr("concord_connections_accepted_total");
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
        &bus,
        gateway_id,
        &rate_limiter,
        &mut last_activity,
        &mut heartbeat_tick,
    )
    .await;

    // Cleanup: leave room, remove presence (best-effort), mark closed,
    // stop writer. `conn` (which holds an outbound-sender clone) must drop
    // BEFORE awaiting the writer — the writer exits only when every sender
    // is gone.
    if let Some(doc) = conn.document {
        registry.leave(doc, connection_id).await;
        if let Some(store) = &presence {
            if let Some(user) = conn.user {
                let _ = store.remove(doc, user.0).await;
            }
        }
    }
    conn.state = SessionState::Closed;
    drop(conn);
    drop(out_tx);
    let _ = writer.await;
    Metrics::global()
        .active_connections
        .fetch_sub(1, Ordering::Relaxed);
    // P6-M010: keep the prometheus gauge in lockstep with the legacy one.
    let active = Metrics::global().active_connections.load(Ordering::Relaxed) as i64;
    crate::observability::metrics::set_gauge("concord_active_connections", active);
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
    bus: &Arc<dyn EventPublisher>,
    gateway_id: u64,
    rate_limiter: &Arc<crate::ephemeral::ratelimit::RateLimiter>,
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
                        handle_text(conn, &text, config, registry, repo, verifier, draining, bus, gateway_id, rate_limiter)
                            .await?;
                    }
                    Ok(Message::Binary(bytes)) => {
                        Metrics::global().inbound_frames_total.fetch_add(1, Ordering::Relaxed);
                        let binary_context = BinaryContext {
                            registry,
                            repo,
                            draining,
                            bus,
                            gateway_id,
                            rate_limiter,
                        };
                        handle_binary(conn, &bytes, &binary_context).await?;
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
    bus: &Arc<dyn EventPublisher>,
    gateway_id: u64,
    rate_limiter: &Arc<crate::ephemeral::ratelimit::RateLimiter>,
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
            crate::observability::metrics::incr_labeled(
                "concord_malformed_frames_total",
                &["control"],
            );
            tracing::debug!(connection_id = %conn.id, ?e, "control frame rejected");
            if !conn_allows_scope(
                conn,
                rate_limiter,
                crate::ephemeral::ratelimit::SCOPE_MALFORMED,
                MALFORMED_RATE_LABEL,
            )
            .await
            {
                let _ = send_error(
                    conn,
                    ProtocolError::RateLimited,
                    "malformed frames rate limited",
                    None,
                );
                return Err(FlowError::Close);
            }
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
                    // P6-M009 security fix: log ONLY the token length —
                    // never fragments (token_head used to leak a JWT
                    // prefix into logs; removed).
                    tracing::warn!(connection_id = %conn.id, error = %e, error_class = "authn", token_len = auth.token.len(), "token verification failed");
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
            tracing::debug!(gateway_id, connection_id = %conn.id, "join via gateway");
            let _ = bus; // bus flows through binary frames only
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
            // P5-M029/M031: a cursor below the compaction floor cannot
            // be served by delta catch-up — the pruned ops are gone.
            // Signal snapshot resync with the covering snapshot's
            // metadata instead of streaming from the floor (which
            // would silently produce a divergent replica).
            if let Some(floor) = crate::maintenance::compaction::get_floor(&repo.db, doc)
                .await
                .ok()
                .flatten()
            {
                if cursor < floor.floor_seq {
                    // Resync decision (P5-M031): the covering snapshot
                    // must be FINALIZED for this document and pass
                    // integrity validation before announcing it. The
                    // resync read path (floor snapshot fetch +
                    // validate) shares the fetch budget — a stale
                    // cursor replayed in a loop is the same
                    // read-amplification primitive as fetch spam
                    // (SEC5-1) and is throttled identically.
                    if !conn_allows_snapshot_read(conn, rate_limiter).await {
                        let fatal = send_error(
                            conn,
                            ProtocolError::RateLimited,
                            "snapshot reads rate limited",
                            frame.id,
                        );
                        return if fatal { Err(FlowError::Close) } else { Ok(()) };
                    }
                    let snapshots = crate::db::snapshots::SnapshotRepo::new(repo.db.clone());
                    let served = snapshots
                        .get_by_snapshot_id(floor.snapshot_id)
                        .await
                        .ok()
                        .flatten()
                        .filter(|row| {
                            row.document_id == doc
                                && row.status == crate::db::snapshots::status::FINALIZED
                        })
                        .and_then(|row| {
                            snapshots
                                .validate_integrity(&row, doc)
                                .ok()
                                .map(|v| (row, v))
                        });
                    if let Some((row, validated)) = served {
                        send_control(
                            conn,
                            Frame::SnapshotResyncRequired(SnapshotResyncRequired {
                                boundary: floor.floor_seq.to_string(),
                                snapshot_id: row.snapshot_id.to_string(),
                                snapshot_checksum: row.payload_checksum.clone(),
                                snapshot_format_version: row.format_version.to_string(),
                                coverage_op_count: row.covered_op_count.to_string(),
                            }),
                            frame.id,
                        );
                        let _ = validated;
                        return Ok(());
                    }
                    // Floor snapshot unreadable: fall back to the error
                    // path — NEVER stream partial history silently.
                    send_error(
                        conn,
                        ProtocolError::DatabaseUnavailable,
                        "recovery snapshot unavailable",
                        frame.id,
                    );
                    return Ok(());
                }
            }
            stream_catchup(conn, doc, cursor, repo).await;
        }
        Frame::Ping(ping) => {
            send_control(conn, Frame::Pong(Pong { nonce: ping.nonce }), frame.id);
        }
        Frame::Pong(_) => {
            // Heartbeat reply — activity already recorded by the loop.
        }
        // P5-M031: snapshot fetch for stale-client resync. Legal in
        // Syncing/Ready (the states where a resync can be in flight);
        // the payload is validated + access-checked before send.
        Frame::FetchSnapshot(fetch) => {
            if conn.state != SessionState::Syncing && conn.state != SessionState::Ready {
                send_error(
                    conn,
                    ProtocolError::InvalidState,
                    "fetch_snapshot requires an active document session",
                    frame.id,
                );
                return Ok(());
            }
            // SEC5-1 fix: every fetch is a full-payload DB read + hash +
            // base64 serve — throttle per connection (shared budget
            // with the sync_request resync path so both read paths
            // are bounded by one scope).
            if !conn_allows_snapshot_read(conn, rate_limiter).await {
                let fatal = send_error(
                    conn,
                    ProtocolError::RateLimited,
                    "snapshot reads rate limited",
                    frame.id,
                );
                return if fatal { Err(FlowError::Close) } else { Ok(()) };
            }
            handle_fetch_snapshot(conn, fetch, repo).await;
        }
        // Server->client frames are illegal inbound.
        Frame::HelloAck(_)
        | Frame::Authenticated(_)
        | Frame::JoinAccepted(_)
        | Frame::SyncDone(_)
        | Frame::SnapshotResyncRequired(_)
        | Frame::SnapshotPayload(_)
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
        crate::observability::metrics::incr_labeled("concord_auth_denials_total", &["join_access"]);
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

/// Serves `fetch_snapshot` (P5-M031): full access recheck, snapshot
/// validation, then the wrapper payload base64 on the same session.
/// Rate-limited by the caller (SEC5-1: `fetch` scope, shared with the
/// sync_request resync path).
async fn handle_fetch_snapshot(conn: &mut Conn, fetch: FetchSnapshot, repo: &Arc<GatewayRepo>) {
    let Some(user) = conn.user else { return };
    let Some(doc) = conn.document else { return };
    let Ok(snapshot_uuid) = uuid::Uuid::parse_str(&fetch.snapshot_id) else {
        let fatal = send_error(
            conn,
            ProtocolError::MalformedFrame,
            "invalid snapshot id",
            None,
        );
        let _ = fatal;
        return;
    };
    // Read + document-association + integrity validation, then a fresh
    // authorization recheck — cross-tenant snapshot reads are refused
    // indistinguishably from not-found (SA-SEC5 concern).
    let snapshots = crate::db::snapshots::SnapshotRepo::new(repo.db.clone());
    let row = match snapshots.get_by_snapshot_id(snapshot_uuid).await {
        Ok(Some(r)) => r,
        _ => {
            let _ = send_error(conn, ProtocolError::Forbidden, "snapshot unavailable", None);
            return;
        }
    };
    if row.document_id != doc {
        let _ = send_error(conn, ProtocolError::Forbidden, "snapshot unavailable", None);
        return;
    }
    if repo
        .document_access(user, doc)
        .await
        .ok()
        .flatten()
        .is_none()
    {
        crate::telemetry::Metrics::global()
            .authorization_denied_total
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        crate::observability::metrics::incr_labeled(
            "concord_auth_denials_total",
            &["snapshot_access"],
        );
        let _ = send_error(conn, ProtocolError::Forbidden, "snapshot unavailable", None);
        return;
    }
    // Integrity validation is mandatory before serving any payload
    // (M013 gate; corrupted snapshots fail closed here).
    if snapshots.validate_integrity(&row, doc).is_err() {
        let _ = send_error(
            conn,
            ProtocolError::DatabaseUnavailable,
            "snapshot corrupt",
            None,
        );
        return;
    }
    // Only FINALIZED snapshots are ever served (lifecycle invariant).
    if row.status != crate::db::snapshots::status::FINALIZED {
        let _ = send_error(
            conn,
            ProtocolError::DatabaseUnavailable,
            "snapshot unavailable",
            None,
        );
        return;
    }
    // Oversize guard (SEC5-3 fix, audit V7): the payload rides a JSON
    // text frame as base64 (~4/3× the raw bytes). A snapshot whose
    // ENCODED size exceeds the frame cap can never be delivered —
    // it would overflow the wire limit and silently die in the
    // outbound queue. Refuse deterministically instead: the client
    // sees a size error, never a truncated frame. The +2 KiB margin
    // covers the frame's JSON metadata overhead.
    const B64: usize = 4;
    const RAW: usize = 3;
    const JSON_OVERHEAD_MARGIN: usize = 2 * 1024;
    let encoded_estimate = row
        .payload_size
        .saturating_mul(B64 as i64 / RAW as i64)
        .saturating_add(JSON_OVERHEAD_MARGIN as i64);
    if encoded_estimate > MAX_FRAME_BYTES as i64 {
        let _ = send_error(
            conn,
            ProtocolError::PayloadTooLarge,
            "snapshot exceeds frame limit",
            None,
        );
        return;
    }
    let payload_base64 = base64_encode(&row.payload);
    send_control(
        conn,
        Frame::SnapshotPayload(SnapshotPayload {
            snapshot_id: row.snapshot_id.to_string(),
            format_version: row.format_version.to_string(),
            coverage_seq: row.coverage_seq.to_string(),
            covered_op_count: row.covered_op_count.to_string(),
            state_digest: row.state_digest.clone(),
            checksum: row.payload_checksum.clone(),
            payload_base64,
            payload_size: row.payload_size.to_string(),
        }),
        None,
    );
}

/// Per-connection budget for snapshot read paths (fetch_snapshot +
/// sync_request resync signals — SEC5-1). The principal is the
/// connection id: budgets are per session, matching the per-tab
/// amplification model (a reconnect gets a fresh connection id, and
/// the connect scope already bounds reconnect churn).
async fn conn_allows_snapshot_read(
    conn: &Conn,
    rate_limiter: &Arc<crate::ephemeral::ratelimit::RateLimiter>,
) -> bool {
    match rate_limiter
        .check(
            crate::ephemeral::ratelimit::SCOPE_SNAPSHOT_FETCH,
            &conn.id.to_string(),
        )
        .await
    {
        RateLimitOutcome::Allowed => true,
        RateLimitOutcome::Limited => {
            crate::telemetry::Metrics::global()
                .rate_limited_total
                .fetch_add(1, Ordering::Relaxed);
            crate::observability::metrics::incr_labeled(
                "concord_rate_limit_hits_total",
                &["fetch"],
            );
            tracing::info!(connection_id = %conn.id, "snapshot read rate limited");
            false
        }
    }
}

/// Apply a bounded per-connection frame budget. The caller supplies only a
/// fixed scope/label pair from this module; the limiter itself also guards
/// the Prometheus label against arbitrary values. Rate exhaustion closes the
/// session so a hostile client cannot continue consuming parser/DB work.
async fn conn_allows_scope(
    conn: &Conn,
    rate_limiter: &Arc<crate::ephemeral::ratelimit::RateLimiter>,
    scope: &str,
    labels: &'static [&'static str],
) -> bool {
    match rate_limiter.check(scope, &conn.id.to_string()).await {
        RateLimitOutcome::Allowed => true,
        RateLimitOutcome::Limited => {
            crate::telemetry::Metrics::global()
                .rate_limited_total
                .fetch_add(1, Ordering::Relaxed);
            crate::observability::metrics::incr_labeled("concord_rate_limit_hits_total", labels);
            tracing::info!(connection_id = %conn.id, scope, "frame rate limited");
            false
        }
    }
}

const MALFORMED_RATE_LABEL: &[&str] = &["malformed"];
const WRITE_RATE_LABEL: &[&str] = &["write"];

/// Standard base64 (RFC 4648, with padding) — dependency-free: the
/// payload rides a JSON text frame, so raw bytes must be encoded.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(triple >> 6) as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[triple as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
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
    // P6-M009: catch-up replay span + P6-M010 duration/size histograms.
    let started = std::time::Instant::now();
    // EnteredSpan is !Send: scope the guard before any await in the loop.
    let catchup_span = tracing::info_span!("ws.catchup_replay");
    let _catchup_guard = catchup_span.enter();
    let mut cursor = after_cursor.max(0);
    let mut replayed: u64 = 0;
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
        replayed += page.ops.len() as u64;
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
    crate::observability::metrics::observe(
        "concord_catchup_duration_seconds",
        &["replay"],
        started.elapsed().as_secs_f64(),
    );
    crate::observability::metrics::observe_value(
        "concord_catchup_size",
        &["replay"],
        replayed as f64,
    );
    send_control(conn, Frame::SyncDone(SyncDone {}), None);
    if conn.state == SessionState::Syncing {
        conn.state = SessionState::Ready;
    }
}

struct BinaryContext<'a> {
    registry: &'a Arc<SessionRegistry>,
    repo: &'a Arc<GatewayRepo>,
    draining: &'a Arc<AtomicBool>,
    bus: &'a Arc<dyn EventPublisher>,
    gateway_id: u64,
    rate_limiter: &'a Arc<crate::ephemeral::ratelimit::RateLimiter>,
}

/// Handles one inbound BINARY (data) frame (P3-M027 ingestion).
async fn handle_binary(
    conn: &mut Conn,
    bytes: &[u8],
    context: &BinaryContext<'_>,
) -> Result<(), FlowError> {
    let BinaryContext {
        registry,
        repo,
        draining,
        bus,
        gateway_id,
        rate_limiter,
    } = context;
    if !conn.state.can_send_client_ops() {
        // Illegal in every state except READY (includes Draining).
        Metrics::global()
            .malformed_frames_total
            .fetch_add(1, Ordering::Relaxed);
        crate::observability::metrics::incr_labeled(
            "concord_malformed_frames_total",
            &["client_ops_state"],
        );
        let code = if conn.state == SessionState::Draining {
            ProtocolError::ServerDraining
        } else {
            ProtocolError::InvalidState
        };
        crate::observability::metrics::incr_labeled(
            "concord_ops_rejected_total",
            &[crate::telemetry::reject_reason::INVALID_STATE],
        );
        let fatal = send_error(conn, code, "client_ops not allowed in this state", None);
        return if fatal { Err(FlowError::Close) } else { Ok(()) };
    }
    if draining.load(Ordering::Relaxed) {
        crate::observability::metrics::incr_labeled(
            "concord_ops_rejected_total",
            &[crate::telemetry::reject_reason::DRAINING],
        );
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
            crate::observability::metrics::incr_labeled(
                "concord_malformed_frames_total",
                &["client_ops"],
            );
            tracing::debug!(connection_id = %conn.id, ?e, "client_ops rejected");
            let code = match &e {
                crate::protocol::DecodeError::UnsupportedVersion { .. } => {
                    ProtocolError::UnsupportedProtocolVersion
                }
                crate::protocol::DecodeError::TooLarge { .. } => ProtocolError::PayloadTooLarge,
                _ => ProtocolError::MalformedFrame,
            };
            crate::observability::metrics::incr_labeled(
                "concord_ops_rejected_total",
                &[crate::telemetry::reject_reason::MALFORMED],
            );
            if !conn_allows_scope(
                conn,
                rate_limiter,
                crate::ephemeral::ratelimit::SCOPE_MALFORMED,
                MALFORMED_RATE_LABEL,
            )
            .await
            {
                let _ = send_error(
                    conn,
                    ProtocolError::RateLimited,
                    "malformed frames rate limited",
                    None,
                );
                return Err(FlowError::Close);
            }
            let fatal = send_error(conn, code, "operation batch rejected", None);
            return if fatal { Err(FlowError::Close) } else { Ok(()) };
        }
    };

    // Count validated client operations, not bytes or parser attempts. The
    // budget is per connection, while connect admission limits reconnect
    // churn by resolved client IP. A batch is all-or-nothing: if any op
    // would exceed the budget, no part of it reaches the database.
    for _ in 0..ops.ops.len().max(1) {
        if !conn_allows_scope(
            conn,
            rate_limiter,
            crate::ephemeral::ratelimit::SCOPE_WRITE_OPS,
            WRITE_RATE_LABEL,
        )
        .await
        {
            let _ = send_error(conn, ProtocolError::RateLimited, "write rate limited", None);
            return Err(FlowError::Close);
        }
    }

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

    // M008: one correlation id per batch, attached at INGRESS and threaded
    // through authz → persist → ack → publish → fanout. Fields carry only
    // ids/latencies/outcomes — never content or tokens.
    let correlation_id =
        crate::observability::correlation::batch_correlation_id(*gateway_id, ops.batch_id);
    let ingress_started = Instant::now();
    // P6-M009: ingress span. EnteredSpan is !Send so the guard cannot be
    // held across the ingest await; enter/exit brackets the async work
    // and every event below still carries the correlation id explicitly.
    let ingress_span = tracing::info_span!(
        "ws.ingress",
        correlation_id = %correlation_id,
        op_count = ops.ops.len(),
    );
    let _ingress_guard = ingress_span.enter();

    tracing::info!(
        correlation_id = %correlation_id,
        outcome = "ingress",
        op_count = ops.ops.len(),
        "operation batch received"
    );
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
            crate::observability::metrics::incr_by(
                "concord_ops_accepted_total",
                ingest.newly_inserted.len() as u64,
            );
            // M008: persist + ack milestones on the SAME correlation id.
            // M010: ack latency histogram, both wire-visible stages.
            let persist_latency = started.elapsed();
            crate::observability::metrics::observe(
                "concord_ack_latency_seconds",
                &["persist"],
                persist_latency.as_secs_f64(),
            );
            crate::observability::metrics::observe(
                "concord_ack_latency_seconds",
                &["ingress"],
                ingress_started.elapsed().as_secs_f64(),
            );
            tracing::info!(
                correlation_id = %correlation_id,
                outcome = "durable_ack",
                op_ids = %ingest.all_ids.len(),
                newly = ingest.newly_inserted.len(),
                duplicates = ingest.duplicates.len(),
                persist_us = persist_latency.as_micros() as u64,
                "operation batch durably committed; ack emitted"
            );
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

            // Publish to the distributed bus AFTER the durable commit
            // (P4-M013): best-effort — a failure never invalidates the ACK
            // (peers recover via DB catch-up; FAILURE_MODEL §7.2).
            if !ingest.newly_inserted.is_empty() {
                let publish_ops: Vec<Vec<u8>> = ops
                    .ops
                    .iter()
                    .zip(ops.identities.iter())
                    .filter(|(_, id)| ingest.newly_inserted.contains(&id.to_wire()))
                    .map(|(bytes, _)| bytes.clone())
                    .collect();
                if !publish_ops.is_empty() {
                    tracing::info!(
                        correlation_id = %correlation_id,
                        outcome = "broker_publish",
                        op_count = publish_ops.len(),
                        "publishing committed batch to inter-gateway bus"
                    );
                    match bus
                        .publish_batch(
                            document,
                            ops.batch_id,
                            ingest.durable_cursor.max(0) as u64,
                            publish_ops,
                        )
                        .await
                    {
                        Ok(()) => crate::observability::metrics::incr_labeled(
                            "concord_broker_publish_total",
                            &[crate::telemetry::broker_outcome::OK],
                        ),
                        Err(e) => {
                            crate::observability::metrics::incr_labeled(
                                "concord_broker_publish_total",
                                &[crate::telemetry::broker_outcome::FAILED],
                            );
                            tracing::warn!(
                                correlation_id = %correlation_id,
                                gateway_id,
                                connection_id = %conn.id,
                                error = %e,
                                error_class = "broker_publish",
                                "cross-gateway publish failed (durable ack unaffected)"
                            );
                        }
                    }
                }
            }

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
                    crate::observability::metrics::incr("concord_slow_consumer_disconnects_total");
                    tracing::info!(connection_id = %slow_id, correlation_id = %correlation_id, "slow consumer disconnect (outbound queue saturated)");
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
            // M008/M010: authz deny on the same correlation id + labeled
            // denial counters (bounded reason values only).
            crate::observability::metrics::incr_labeled(
                "concord_auth_denials_total",
                &["write_role"],
            );
            crate::observability::metrics::incr_labeled(
                "concord_ops_rejected_total",
                &[crate::telemetry::reject_reason::AUTHZ],
            );
            tracing::info!(
                correlation_id = %correlation_id,
                outcome = "rejected",
                reason = crate::telemetry::reject_reason::AUTHZ,
                "ingest denied by write-role recheck"
            );
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
            crate::observability::metrics::incr("concord_db_errors_total");
            crate::observability::metrics::incr_labeled(
                "concord_ops_rejected_total",
                &[crate::telemetry::reject_reason::DB_UNAVAILABLE],
            );
            tracing::warn!(
                correlation_id = %correlation_id,
                error = %e,
                "ingest failed (db)"
            );
            let fatal = send_error(
                conn,
                ProtocolError::DatabaseUnavailable,
                "persistence temporarily unavailable",
                None,
            );
            return if fatal { Err(FlowError::Close) } else { Ok(()) };
        }
        Err(e) => {
            crate::observability::metrics::incr("concord_db_errors_total");
            crate::observability::metrics::incr_labeled(
                "concord_ops_rejected_total",
                &[crate::telemetry::reject_reason::DB_UNAVAILABLE],
            );
            tracing::error!(
                correlation_id = %correlation_id,
                error = %e,
                "ingest failed (internal)"
            );
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

#[cfg(test)]
mod client_ip_tests {
    use super::*;

    fn headers(value: &str) -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().expect("test header"));
        headers
    }

    #[test]
    fn direct_peer_cannot_spoof_a_forwarded_client() {
        let proxy = ["10.0.0.0/8".parse().expect("CIDR")];
        let direct = "198.51.100.9:1234".parse().expect("peer");
        assert_eq!(
            client_ip(direct, &headers("203.0.113.1"), &proxy),
            direct.ip()
        );
        assert_eq!(client_ip(direct, &headers("203.0.113.1"), &[]), direct.ip());
    }

    #[test]
    fn trusted_multihop_uses_rightmost_untrusted_ipv4_or_ipv6() {
        let proxies = [
            "10.0.0.0/8".parse().expect("CIDR"),
            "fd00::/8".parse().expect("CIDR"),
        ];
        let gateway_peer = "10.2.0.3:8890".parse().expect("peer");
        // Attacker-controlled leftmost value is ignored; ALB/nginx append
        // the observed client and intermediary addresses to its right.
        let chain = headers("192.0.2.99, 198.51.100.5, 10.1.0.4");
        assert_eq!(
            client_ip(gateway_peer, &chain, &proxies),
            "198.51.100.5".parse::<IpAddr>().unwrap()
        );
        let ipv6_peer = "[fd00::3]:8890".parse().expect("peer");
        assert_eq!(
            client_ip(ipv6_peer, &headers("2001:db8::5, fd00::4"), &proxies),
            "2001:db8::5".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn missing_malformed_or_ambiguous_chain_falls_back_to_peer() {
        let proxies = ["10.0.0.0/8".parse().expect("CIDR")];
        let peer = "10.2.0.3:8890".parse().expect("peer");
        for header in ["garbage", "198.51.100.1,", "198.51.100.1:1234", "10.1.2.3"] {
            assert_eq!(client_ip(peer, &headers(header), &proxies), peer.ip());
        }
        assert_eq!(
            client_ip(peer, &axum::http::HeaderMap::new(), &proxies),
            peer.ip()
        );
        let mut duplicate = headers("198.51.100.1");
        duplicate.append("x-forwarded-for", "198.51.100.2".parse().unwrap());
        assert_eq!(client_ip(peer, &duplicate, &proxies), peer.ip());
    }
}
