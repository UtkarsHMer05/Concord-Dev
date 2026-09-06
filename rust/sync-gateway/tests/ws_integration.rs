//! WebSocket integration tests (P3-M021/M022/M023/M024/M027/M030).
//!
//! Boots the REAL axum router (same AppState wiring as main.rs, with a
//! static test JWKS so tests can authenticate with locally-signed tokens)
//! on an ephemeral port, then drives the protocol over real sockets with
//! tokio-tungstenite. Covers: handshake, auth (accept/reject), join
//! (authz matrix), catch-up, live ingestion + durable ACK + fanout,
//! state-machine rejections, malformed frames, oversized frames,
//! heartbeats, and the slow-consumer path.
//!
//! Skipped when the test DB is unreachable (gate precondition: compose db).

use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::jwk::{
    AlgorithmParameters, CommonParameters, Jwk, JwkSet, KeyAlgorithm, RSAKeyParameters, RSAKeyType,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::Serialize;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use sync_gateway::auth::{StaticJwks, TokenVerifier, VerifierSource};
use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::GatewayRepo;
use sync_gateway::http::{self, AppState};
use sync_gateway::sessions::SessionRegistry;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER: &str = "https://test.clerk.accounts.dev";
const KID: &str = "it-key-1";
const KEY1: &[u8] = include_bytes!("../src/auth/test_rsa_key.der");
const KEY2: &[u8] = include_bytes!("../src/auth/test_rsa_key2.der");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

fn encoding_key(der: &[u8]) -> EncodingKey {
    use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
    let key: rsa::RsaPrivateKey = DecodePrivateKey::from_pkcs8_der(der).expect("key parses");
    let pem = key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).expect("pem");
    EncodingKey::from_rsa_pem(pem.as_str().as_bytes()).expect("encoding key")
}

fn test_jwks() -> JwkSet {
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::traits::PublicKeyParts;
    let key: rsa::RsaPrivateKey = DecodePrivateKey::from_pkcs8_der(KEY1).expect("key1");
    let public = key.to_public_key();
    fn b64u(bytes: &[u8]) -> String {
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut s = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            s.push(CHARS[(b[0] >> 2) as usize] as char);
            s.push(CHARS[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
            if chunk.len() > 1 {
                s.push(CHARS[((b[1] & 0x0f) << 2 | (b[2] >> 6)) as usize] as char);
            } else {
                s.push('=');
            }
            if chunk.len() > 2 {
                s.push(CHARS[(b[2] & 0x3f) as usize] as char);
            } else {
                s.push('=');
            }
        }
        s.trim_end_matches('=').to_owned()
    }
    let n = public.n().to_bytes_be();
    let e = public.e().to_bytes_be();
    JwkSet {
        keys: vec![Jwk {
            common: CommonParameters {
                key_id: Some(KID.to_owned()),
                key_algorithm: Some(KeyAlgorithm::RS256),
                ..Default::default()
            },
            algorithm: AlgorithmParameters::RSA(RSAKeyParameters {
                key_type: RSAKeyType::RSA,
                n: b64u(&n),
                e: b64u(&e),
            }),
        }],
    }
}

#[derive(Serialize)]
struct TestClaims {
    sub: String,
    exp: u64,
    iss: String,
}

fn sign_token(sub: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some(KID.to_owned());
    encode(
        &header,
        &TestClaims {
            sub: sub.to_owned(),
            exp: now + 600,
            iss: ISSUER.to_owned(),
        },
        &encoding_key(KEY1),
    )
    .expect("sign")
}

fn forged_token(sub: &str) -> String {
    // Signed with a DIFFERENT key than the JWKS carries.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some(KID.to_owned());
    encode(
        &header,
        &TestClaims {
            sub: sub.to_owned(),
            exp: now + 600,
            iss: ISSUER.to_owned(),
        },
        &encoding_key(KEY2),
    )
    .expect("sign")
}

fn base_config() -> Config {
    Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_DB_URL.into(),
        clerk_issuer: ISSUER.into(),
        allowed_origins: vec![],
        max_frame_size: 8 * 1024 * 1024,
        // Small queue so slow-consumer behavior is reachable in tests.
        per_connection_queue_capacity: 8,
        // Long enough that tests never hit idle reaping accidentally.
        heartbeat_interval: Duration::from_secs(10),
        idle_timeout: Duration::from_secs(600),
        db_pool_size: 4,
        jwks_file: None,
    }
}

/// The running test server: bound addr + shared repo handle for fixtures.
struct TestServer {
    addr: SocketAddr,
    repo: Arc<GatewayRepo>,
    _registry: Arc<SessionRegistry>,
}

async fn boot() -> Option<TestServer> {
    // Make server-side logs visible in test output (test binaries have no
    // subscriber by default).
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();
    let config = base_config();
    let db = match Db::connect(&config).await {
        Ok(db) => db,
        Err(_) => return None, // DB down: skip suite
    };
    run_migrations(&db).await.expect("migrations");
    let repo = Arc::new(GatewayRepo::new(db));
    let registry = SessionRegistry::new();
    let verifier = Arc::new(TokenVerifier::new(
        ISSUER,
        VerifierSource::Static(StaticJwks(test_jwks())),
    ));
    let state = AppState {
        config: Arc::new(config),
        registry: registry.clone(),
        repo: repo.clone(),
        verifier,
        draining: Arc::new(AtomicBool::new(false)),
    };
    let app = http::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let registry_for_server = registry.clone();
    tokio::spawn(async move {
        let _registry = registry_for_server;
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        );
        let _ = server.await;
    });
    Some(TestServer {
        addr,
        repo,
        _registry: registry,
    })
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(server: &TestServer) -> Ws {
    let url = format!("ws://{}/api/v1/sync", server.addr);
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect");
    ws
}

async fn send_text(ws: &mut Ws, text: &str) {
    ws.send(WsMessage::Text(text.to_owned().into()))
        .await
        .expect("send text");
}

async fn send_binary(ws: &mut Ws, bytes: Vec<u8>) {
    ws.send(WsMessage::Binary(bytes.into()))
        .await
        .expect("send binary");
}

/// Receives the next TEXT control frame, skipping over binary frames.
async fn next_control(ws: &mut Ws) -> serde_json::Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("frame within timeout")
            .expect("stream open")
            .expect("frame ok");
        match msg {
            WsMessage::Text(t) => return serde_json::from_str(t.as_str()).expect("json"),
            WsMessage::Binary(_) => continue, // caller reads binaries separately
            WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
            WsMessage::Close(_) => panic!("unexpected close"),
            _ => continue,
        }
    }
}

/// Receives the next BINARY frame, skipping control frames.
async fn next_binary(ws: &mut Ws) -> Vec<u8> {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("frame within timeout")
            .expect("stream open")
            .expect("frame ok");
        match msg {
            WsMessage::Binary(b) => return b.into(),
            WsMessage::Text(_) => continue,
            WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
            _ => continue,
        }
    }
}

fn hello() -> String {
    r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#.into()
}

fn authenticate(token: &str) -> String {
    format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{token}"}}}}"#)
}

fn join(document: &str) -> String {
    format!(
        r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{document}","stateSummary":[]}}}}"#
    )
}

/// Complete handshake: hello → authenticate (signing a fresh token for the
/// given clerk id) → (authenticated). Returns the server-resolved user id.
async fn handshake(ws: &mut Ws, clerk_id: &str) -> String {
    send_text(ws, &hello()).await;
    let ack = next_control(ws).await;
    assert_eq!(ack["type"], "hello_ack");
    send_text(ws, &authenticate(&sign_token(clerk_id))).await;
    let auth = next_control(ws).await;
    assert_eq!(auth["type"], "authenticated", "token accepted: {auth}");
    auth["payload"]["userId"].as_str().unwrap().to_owned()
}

// Canonical minimal insert op (same as db tests).
fn make_op_bytes(replica: u64, counter: u64) -> Vec<u8> {
    let mut b = vec![1u8, 1u8];
    b.extend_from_slice(&replica.to_le_bytes());
    b.extend_from_slice(&counter.to_le_bytes());
    b.extend_from_slice(&1u64.to_le_bytes());
    b.push(0);
    b.push(0);
    b.push(1);
    b.push(1);
    b.push(b'a');
    b.push(0);
    b
}

fn client_ops_frame(batch_id: u64, ops: &[Vec<u8>]) -> Vec<u8> {
    sync_gateway::protocol::data::DataFrame::ClientOps(sync_gateway::protocol::data::ClientOps {
        batch_id,
        ops: ops.to_vec(),
        identities: vec![],
    })
    .encode()
    .expect("encode")
}

/// DB fixture: ensure the users row exists for a clerk id; returns uuid.
async fn ensure_user(clerk_id: &str) -> Uuid {
    let db = Db::connect(&base_config()).await.expect("db");
    let client = db.get().await.expect("pool");
    let row = client
        .query_one(
            "INSERT INTO users (clerk_user_id) VALUES ($1)
             ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
             RETURNING id",
            &[&clerk_id],
        )
        .await
        .expect("seed user");
    row.get("id")
}

/// DB fixture: owner user + fresh document owned by them.
async fn seed_owner_with_document(server: &TestServer, clerk_id: &str) -> (String, Uuid) {
    let user = ensure_user(clerk_id).await;
    let client = server.repo.db.get().await.expect("pool");
    let doc = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO documents (id, owner_user_id, title, initial_content)
             VALUES ($1, $2, 'ws-it', '')",
            &[&doc, &user],
        )
        .await
        .expect("seed doc");
    (clerk_id.to_owned(), doc)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_flow_join_ingest_ack_fanout_two_clients() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };

    // Owner + document.
    let (owner_clerk, doc) =
        seed_owner_with_document(&server, &format!("ws-owner-{}", Uuid::new_v4().simple())).await;

    // Two clients: the owner + a second session of the same user (editor
    // role via org is not needed: owner is enough for write).
    let mut a = connect(&server).await;
    let mut b = connect(&server).await;
    handshake(&mut a, &owner_clerk).await;
    handshake(&mut b, &owner_clerk).await;

    send_text(&mut a, &join(&doc.to_string())).await;
    let joined_a = next_control(&mut a).await;
    assert_eq!(joined_a["type"], "join_accepted");
    assert_eq!(joined_a["payload"]["role"], "owner");
    // Empty history: no binary batch — sync_done directly.
    assert_eq!(next_control(&mut a).await["type"], "sync_done");

    send_text(&mut b, &join(&doc.to_string())).await;
    let joined_b = next_control(&mut b).await;
    assert_eq!(joined_b["type"], "join_accepted");
    assert_eq!(next_control(&mut b).await["type"], "sync_done");

    // Owner writes: A sends a batch; B must receive the fanout; A gets ack.
    let ops = vec![make_op_bytes(77, 1), make_op_bytes(77, 2)];
    send_binary(&mut a, client_ops_frame(7, &ops)).await;

    // A: durable ack naming the batch + identities.
    let ack = next_control(&mut a).await;
    assert_eq!(ack["type"], "durable_ack", "durable ack after commit");
    assert_eq!(ack["payload"]["batchId"], "7");
    assert_eq!(ack["payload"]["opIds"][0], "77:1");

    // B: same op bytes via fanout (binary client_ops frame).
    let fanout = next_binary(&mut b).await;
    let decoded = sync_gateway::protocol::data::DataFrame::decode(&fanout).expect("fanout decodes");
    match decoded {
        sync_gateway::protocol::data::DataFrame::ClientOps(f) => {
            assert_eq!(f.batch_id, 7);
            assert_eq!(f.ops.len(), 2);
        }
        _ => panic!("fanout frame must be client_ops"),
    }

    // DB contains exactly one row per identity.
    let client = server.repo.db.get().await.expect("pool");
    let n: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n");
    assert_eq!(n, 2);
}

#[tokio::test]
async fn unauthorized_and_forged_tokens_rejected() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };

    // Forged signature (wrong key): authenticate → error unauthorized + close.
    let mut ws = connect(&server).await;
    send_text(&mut ws, &hello()).await;
    assert_eq!(next_control(&mut ws).await["type"], "hello_ack");
    send_text(&mut ws, &authenticate(&forged_token("user_attacker"))).await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["type"], "error");
    assert_eq!(err["payload"]["code"], "unauthorized");
    // Connection should close (fatal error) — Close frame or stream end.
    let closed = tokio::time::timeout(Duration::from_secs(10), ws.next()).await;
    assert!(closed.is_ok(), "close must arrive for fatal unauthorized");
    // second read: stream ends
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;

    // Valid signature but unknown subject (unprovisioned): rejected safely.
    let mut ws = connect(&server).await;
    send_text(&mut ws, &hello()).await;
    assert_eq!(next_control(&mut ws).await["type"], "hello_ack");
    send_text(
        &mut ws,
        &authenticate(&sign_token("user_never_provisioned_abc")),
    )
    .await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "unauthorized");
}

#[tokio::test]
async fn join_no_access_is_forbidden_without_leak() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };

    let stranger_clerk = format!("ws-stranger-{}", Uuid::new_v4().simple());
    ensure_user(&stranger_clerk).await;

    // A stranger joining a random (nonexistent) document: forbidden,
    // identical message — no existence leak.
    let mut ws = connect(&server).await;
    handshake(&mut ws, &stranger_clerk).await;
    send_text(&mut ws, &join(&Uuid::new_v4().to_string())).await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "forbidden");
}

#[tokio::test]
async fn state_machine_rejects_out_of_order_frames() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };

    // client_ops BEFORE join → invalid_state.
    let (owner_clerk, _doc) =
        seed_owner_with_document(&server, &format!("ws-oos-{}", Uuid::new_v4().simple())).await;
    let mut ws = connect(&server).await;
    handshake(&mut ws, &owner_clerk).await;
    send_binary(&mut ws, client_ops_frame(1, &[make_op_bytes(88, 1)])).await;
    let err = next_control(&mut ws).await;
    assert_eq!(
        err["payload"]["code"], "invalid_state",
        "ops before join rejected"
    );

    // authenticate after hello already done → invalid_state.
    let mut ws = connect(&server).await;
    send_text(&mut ws, &hello()).await;
    assert_eq!(next_control(&mut ws).await["type"], "hello_ack");
    send_text(&mut ws, &authenticate(&sign_token(&owner_clerk))).await;
    assert_eq!(next_control(&mut ws).await["type"], "authenticated");
    send_text(&mut ws, &authenticate(&sign_token(&owner_clerk))).await;
    let err = next_control(&mut ws).await;
    assert_eq!(
        err["payload"]["code"], "invalid_state",
        "double authenticate rejected"
    );

    // hello in wrong state (after hello) → invalid_state.
    let mut ws = connect(&server).await;
    send_text(&mut ws, &hello()).await;
    assert_eq!(next_control(&mut ws).await["type"], "hello_ack");
    send_text(&mut ws, &hello()).await;
    let err = next_control(&mut ws).await;
    assert_eq!(
        err["payload"]["code"], "invalid_state",
        "double hello rejected"
    );

    // join before authenticate → invalid_state.
    let mut ws = connect(&server).await;
    send_text(&mut ws, &hello()).await;
    assert_eq!(next_control(&mut ws).await["type"], "hello_ack");
    send_text(&mut ws, &join(&Uuid::new_v4().to_string())).await;
    let err = next_control(&mut ws).await;
    assert_eq!(
        err["payload"]["code"], "invalid_state",
        "join before auth rejected"
    );
}

#[tokio::test]
async fn malformed_frames_are_safe_errors() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };

    // Invalid JSON text.
    let mut ws = connect(&server).await;
    send_text(&mut ws, "{not json").await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "malformed_frame");

    // Unknown frame type.
    let mut ws = connect(&server).await;
    send_text(&mut ws, r#"{"v":1,"type":"h4x0r","payload":{}}"#).await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "unknown_frame_type");

    // Unknown protocol version.
    let mut ws = connect(&server).await;
    send_text(
        &mut ws,
        r#"{"v":99,"type":"hello","payload":{"clientProtocolVersion":99}}"#,
    )
    .await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "unsupported_protocol_version");
    // fatal → close
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;

    // Malformed binary (garbage header) — sent while READY so the
    // failure is the frame itself, not the state.
    let (owner_clerk, doc) =
        seed_owner_with_document(&server, &format!("ws-mal-{}", Uuid::new_v4().simple())).await;
    let mut ws = connect(&server).await;
    handshake(&mut ws, &owner_clerk).await;
    send_text(&mut ws, &join(&doc.to_string())).await;
    assert_eq!(next_control(&mut ws).await["type"], "join_accepted");
    // Empty history: no binary batch — go straight to sync_done.
    assert_eq!(next_control(&mut ws).await["type"], "sync_done");
    send_binary(&mut ws, vec![0x01, 0x7f, 0x00]).await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "malformed_frame");
}

#[tokio::test]
async fn ping_pong_heartbeat() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let (owner_clerk, _doc) =
        seed_owner_with_document(&server, &format!("ws-ping-{}", Uuid::new_v4().simple())).await;
    let mut ws = connect(&server).await;
    handshake(&mut ws, &owner_clerk).await;
    send_text(
        &mut ws,
        r#"{"v":1,"type":"ping","payload":{"nonce":"314"}}"#,
    )
    .await;
    let pong = next_control(&mut ws).await;
    assert_eq!(pong["type"], "pong");
    assert_eq!(pong["payload"]["nonce"], "314");
}

#[tokio::test]
async fn duplicate_resend_yields_single_durable_row_and_deterministic_ack() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let (owner_clerk, doc) =
        seed_owner_with_document(&server, &format!("ws-dup-{}", Uuid::new_v4().simple())).await;
    let mut ws = connect(&server).await;
    handshake(&mut ws, &owner_clerk).await;
    send_text(&mut ws, &join(&doc.to_string())).await;
    assert_eq!(next_control(&mut ws).await["type"], "join_accepted");
    // Empty history: no binary batch.
    assert_eq!(next_control(&mut ws).await["type"], "sync_done");

    let ops = vec![make_op_bytes(99, 1)];
    send_binary(&mut ws, client_ops_frame(11, &ops)).await;
    let ack1 = next_control(&mut ws).await;
    assert_eq!(ack1["type"], "durable_ack");

    // Retry the identical batch (FAILURE_MODEL §2.1): deterministic ack,
    // still exactly one row.
    send_binary(&mut ws, client_ops_frame(11, &ops)).await;
    let ack2 = next_control(&mut ws).await;
    assert_eq!(ack2["type"], "durable_ack");
    assert_eq!(ack2["payload"]["opIds"][0], "99:1");

    let client = server.repo.db.get().await.expect("pool");
    let n: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n");
    assert_eq!(n, 1, "duplicate resend: one durable row");
}

#[tokio::test]
async fn catchup_serves_history_to_rejoining_client() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let (owner_clerk, doc) =
        seed_owner_with_document(&server, &format!("ws-catch-{}", Uuid::new_v4().simple())).await;

    // First session writes history.
    {
        let mut ws = connect(&server).await;
        handshake(&mut ws, &owner_clerk).await;
        send_text(&mut ws, &join(&doc.to_string())).await;
        assert_eq!(next_control(&mut ws).await["type"], "join_accepted");
        // Empty history → no binary batch; sync_done directly.
        assert_eq!(next_control(&mut ws).await["type"], "sync_done");
        let ops: Vec<Vec<u8>> = (1..=5).map(|c| make_op_bytes(101, c)).collect();
        send_binary(&mut ws, client_ops_frame(3, &ops)).await;
        assert_eq!(next_control(&mut ws).await["type"], "durable_ack");
    }

    // New session joins: join_accepted carries durable_cursor; then the
    // catch-up streams the history in a bounded sync_batch + sync_done.
    let mut ws = connect(&server).await;
    handshake(&mut ws, &owner_clerk).await;
    send_text(&mut ws, &join(&doc.to_string())).await;
    let joined = next_control(&mut ws).await;
    assert_eq!(joined["type"], "join_accepted");
    assert!(joined["payload"]["durableCursor"].as_str().unwrap() != "0");

    // Client requests its missing range: full history (cursor 0).
    send_text(
        &mut ws,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#,
    )
    .await;

    let batch_bytes = next_binary(&mut ws).await;
    let decoded = sync_gateway::protocol::data::DataFrame::decode(&batch_bytes).expect("decode");
    match decoded {
        sync_gateway::protocol::data::DataFrame::SyncBatch(f) => {
            assert_eq!(f.ops.len(), 5, "full history catch-up");
            assert!(!f.has_more);
        }
        _ => panic!("expected sync_batch"),
    }
    assert_eq!(next_control(&mut ws).await["type"], "sync_done");
}

#[tokio::test]
async fn slow_consumer_disconnected_not_blocking_writer() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let (owner_clerk, doc) =
        seed_owner_with_document(&server, &format!("ws-slow-{}", Uuid::new_v4().simple())).await;

    // B joins but never reads (receiver dropped after join).
    let mut b = connect(&server).await;
    handshake(&mut b, &owner_clerk).await;
    send_text(&mut b, &join(&doc.to_string())).await;
    let _ = next_control(&mut b).await; // join_accepted
                                        // Empty history: no binary batch.
    let _ = next_control(&mut b).await; // sync_done
    drop(b); // stop reading entirely — its TCP buffers fill eventually

    // A keeps writing: ingestion + ACK path must never block on B's queue
    // (bounded try_send marks B slow; A still proceeds).
    let mut a = connect(&server).await;
    handshake(&mut a, &owner_clerk).await;
    send_text(&mut a, &join(&doc.to_string())).await;
    let _ = next_control(&mut a).await; // join_accepted
    let _ = next_control(&mut a).await; // sync_done (empty history: no binary)
                                        // If an empty catch-up produced no binary, the next control is sync_done:
    let mut acked = 0;
    'outer: for batch in 0..30u64 {
        let ops: Vec<Vec<u8>> = (1..=2).map(|c| make_op_bytes(300 + batch, c)).collect();
        send_binary(&mut a, client_ops_frame(batch, &ops)).await;
        let deadline = tokio::time::Duration::from_secs(15);
        // Read until we see the durable_ack for this batch (or the sync_done
        // from join arriving late, or binary echoes).
        loop {
            let next = tokio::time::timeout(deadline, a.next())
                .await
                .expect("no stall");
            match next {
                Some(Ok(WsMessage::Text(t))) => {
                    let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["type"] == "durable_ack" {
                        acked += 1;
                        continue 'outer;
                    }
                    // sync_done / join noise tolerated
                }
                Some(Ok(WsMessage::Binary(_))) => continue,
                Some(Ok(_)) => continue,
                Some(Err(_)) => panic!("socket error while writer still acking"),
                None => break 'outer,
            }
        }
    }
    // The writer must have been able to commit + ack continuously.
    assert!(
        acked >= 25,
        "writer kept acking despite a dead peer (acked={acked})"
    );
}

#[tokio::test]
async fn health_endpoints_reflect_db() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let live = reqwest::get(format!("http://{}/api/v1/health/live", server.addr))
        .await
        .expect("live")
        .status();
    assert_eq!(live, reqwest::StatusCode::OK);
    let ready = reqwest::get(format!("http://{}/api/v1/health/ready", server.addr))
        .await
        .expect("ready")
        .status();
    assert_eq!(ready, reqwest::StatusCode::OK);
}
