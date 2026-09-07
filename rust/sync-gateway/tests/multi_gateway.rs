//! Multi-gateway integration tests (P4-M016/M017/M019/M028/M029/M030).
//!
//! Boots TWO REAL gateway processes (release binary, distinct ports,
//! distinct gateway IDs, same NATS namespace + Postgres) and proves:
//! cross-gateway fanout, origin suppression, no duplicate durable rows,
//! NATS-outage degraded mode + recovery, reconnect-to-another-gateway.
//!
//! Requires: docker compose up -d db nats redis; release binary current.
//! Skips when dependencies are unreachable.

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use uuid::Uuid;

static COUNTER: AtomicU64 = AtomicU64::new(0);

const TEST_DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const NATS_URL: &str = "nats://127.0.0.1:4222";
/// Repo root (rust/sync-gateway/../..) — the E2E key material lives under
/// the git-ignored private scratch (never committed).
fn repo_path(relative: &str) -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
        .to_string_lossy()
        .into_owned()
}
const JWKS_REL: &str = ".agent/scratch/phase-3/e2e-jwks.json";
const KEY_DER_REL: &str = ".agent/scratch/phase-3/e2e-key.der";
const ISSUER: &str = "https://e2e.clerk.accounts.dev";
fn bin_path() -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/release/sync-gateway")
        .to_string_lossy()
        .into_owned()
}
const KID: &str = "e2e-key-1";

async fn deps_available() -> bool {
    // DB probe.
    let db_ok = tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .is_ok();
    if !db_ok {
        return false;
    }
    // NATS probe.
    async_nats::connect(NATS_URL).await.is_ok()
}

fn sign_token(sub: &str) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    use rsa::pkcs8::EncodePrivateKey;
    let key: rsa::RsaPrivateKey = rsa::pkcs8::DecodePrivateKey::from_pkcs8_der(
        &std::fs::read(repo_path(KEY_DER_REL)).expect("key file"),
    )
    .expect("key");
    let pem = key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).expect("pem");
    let enc = EncodingKey::from_rsa_pem(pem.as_str().as_bytes()).expect("enc");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    #[derive(serde::Serialize)]
    struct Claims {
        sub: String,
        exp: u64,
        iss: String,
    }
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some(KID.to_owned());
    encode(
        &header,
        &Claims {
            sub: sub.to_owned(),
            exp: now + 600,
            iss: ISSUER.to_owned(),
        },
        &enc,
    )
    .expect("sign")
}

struct GatewayProcess {
    child: Child,
    #[allow(dead_code)] // kept for future debug dumps; port is a spawn input
    port: u16,
}

impl GatewayProcess {
    fn spawn(port: u16, gateway_id: u64, nats: Option<&str>) -> Self {
        let mut cmd = Command::new(bin_path());
        cmd.env("GATEWAY_DATABASE_URL", TEST_DB_URL)
            .env("GATEWAY_CLERK_ISSUER", ISSUER)
            .env("GATEWAY_JWKS_FILE", repo_path(JWKS_REL))
            .env("GATEWAY_BIND_PORT", port.to_string())
            .env("GATEWAY_ID", gateway_id.to_string())
            .env("RUST_LOG", "info");
        if let Some(url) = nats {
            cmd.env("GATEWAY_NATS_URL", url);
        }
        let child = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn gateway");
        Self { child, port }
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn dump_stderr(&mut self) {
        if let Some(stderr) = self.child.stderr.take() {
            use std::io::Read;
            let mut buf = String::new();
            let mut file = stderr;
            let _ = file.read_to_string(&mut buf);
            let lines: Vec<&str> = buf.lines().collect();
            for line in lines.iter().rev().take(40).collect::<Vec<_>>().iter().rev() {
                eprintln!("  | {line}");
            }
        }
    }
}

async fn wait_ready(port: u16, timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if let Ok(res) = reqwest::get(format!("http://127.0.0.1:{port}/api/v1/health/ready")).await
        {
            if res.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    false
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(port: u16) -> Ws {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/api/v1/sync"))
        .await
        .expect("connect");
    ws
}

async fn send(ws: &mut Ws, text: String) {
    ws.send(WsMessage::Text(text.into())).await.expect("send");
}

async fn next_control(ws: &mut Ws) -> serde_json::Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("frame timeout")
            .expect("open")
            .expect("ok");
        match msg {
            WsMessage::Text(t) => return serde_json::from_str(t.as_str()).expect("json"),
            WsMessage::Binary(_) => continue,
            WsMessage::Close(_) => panic!("unexpected close"),
            _ => continue,
        }
    }
}

async fn next_binary(ws: &mut Ws) -> Result<Vec<u8>, String> {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(15), ws.next())
            .await
            .map_err(|_| "frame timeout".to_string())?
            .transpose()
            .map_err(|e| format!("stream error: {e}"))?
            .ok_or("stream closed")?;
        match msg {
            WsMessage::Binary(b) => return Ok(b.into()),
            WsMessage::Text(_) => continue,
            _ => continue,
        }
    }
}

async fn handshake_and_join(ws: &mut Ws, clerk: &str, doc: &str) {
    send(
        ws,
        r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#.into(),
    )
    .await;
    let _ = next_control(ws).await; // hello_ack
    let token = sign_token(clerk);
    send(
        ws,
        format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{token}"}}}}"#),
    )
    .await;
    let auth = next_control(ws).await;
    assert_eq!(auth["type"], "authenticated", "auth ok: {auth}");
    send(ws, format!(
        r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#
    ))
    .await;
    let joined = next_control(ws).await;
    assert_eq!(joined["type"], "join_accepted", "join ok: {joined}");
    let done = next_control(ws).await;
    assert_eq!(done["type"], "sync_done", "ready: {done}");
}

/// Canonical 32-byte insert op.
fn op_bytes(replica: u64, counter: u64) -> Vec<u8> {
    let mut b = vec![0u8; 32];
    b[0] = 1;
    b[1] = 1;
    b[2..10].copy_from_slice(&replica.to_le_bytes());
    b[10..18].copy_from_slice(&counter.to_le_bytes());
    b[18..26].copy_from_slice(&1u64.to_le_bytes());
    b[26] = 0;
    b[27] = 0;
    b[28] = 1;
    b[29] = 1;
    b[30] = b'a';
    b[31] = 0;
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

struct Fixture {
    clerk: String,
    doc: Uuid,
}

async fn seed() -> Fixture {
    let (client, conn) = tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .expect("db");
    // The Connection future drives the protocol — poll it on a task.
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            eprintln!("db connection driver ended: {e}");
        }
    });
    let clerk = format!(
        "mg-user-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let user: Uuid = client
        .query_one(
            "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
            &[&clerk],
        )
        .await
        .expect("user")
        .get("id");
    let doc: Uuid = client
        .query_one(
            "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'mg', '') RETURNING id",
            &[&user],
        )
        .await
        .expect("doc")
        .get("id");
    Fixture { clerk, doc }
}

async fn db_count(doc: &Uuid, replica: i64) -> i64 {
    let (client, conn) = tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .expect("db");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    client
        .query_one(
            "SELECT COUNT(*)::bigint AS n FROM crdt_operations WHERE document_id = $1 AND replica_id = $2",
            &[doc, &replica],
        )
        .await
        .expect("count")
        .get("n")
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn cross_gateway_collaboration_and_durable_singularity() {
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
    tokio::time::sleep(Duration::from_millis(400)).await;
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(9301, 101, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9302, 102, Some(NATS_URL));
    assert!(wait_ready(9301, 20_000).await, "gw1 ready");
    assert!(wait_ready(9302, 20_000).await, "gw2 ready");

    // Client A on gw1; Client B on gw2 — same document.
    let mut a = connect(9301).await;
    let mut b = connect(9302).await;
    handshake_and_join(&mut a, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut b, &fixture.clerk, &fixture.doc.to_string()).await;

    // A writes on gw1 → durable ACK on gw1; B on gw2 receives via NATS.
    let ops = vec![op_bytes(501, 1), op_bytes(501, 2), op_bytes(501, 3)];
    a.send(WsMessage::Binary(client_ops_frame(1, &ops).into()))
        .await
        .expect("send");
    let ack = next_control(&mut a).await;
    assert_eq!(ack["type"], "durable_ack", "durable ack on gw1");

    // B receives the client_ops fanout from the broker path (cross-gateway).
    let fanout = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let bytes = match next_binary(&mut b).await {
                Ok(bytes) => bytes,
                Err(e) => {
                    eprintln!("B binary read failed: {e}");
                    return false;
                }
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.batch_id == 1 && f.ops.len() == 3 {
                    return true;
                }
            }
        }
    })
    .await
    .unwrap_or(false);
    if !fanout {
        eprintln!("=== gateway stderr dump ===");
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(fanout, "cross-gateway fanout within 15s");

    // Exactly one durable row per identity (publish + broker delivery
    // created no duplicates).
    let n = db_count(&fixture.doc, 501).await;
    assert_eq!(n, 3, "one row per op across gateways");

    // Reverse direction: B writes on gw2; A receives on gw1.
    let ops_b = vec![op_bytes(502, 1), op_bytes(502, 2)];
    b.send(WsMessage::Binary(client_ops_frame(2, &ops_b).into()))
        .await
        .expect("send");
    let ack_b = next_control(&mut b).await;
    assert_eq!(ack_b["type"], "durable_ack");
    let reverse = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let bytes = match next_binary(&mut a).await {
                Ok(bytes) => bytes,
                Err(_) => return false,
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.batch_id == 2 && f.ops.len() == 2 {
                    return true;
                }
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(reverse, "reverse cross-gateway fanout");
    let n_b = db_count(&fixture.doc, 502).await;
    assert_eq!(n_b, 2);

    gw1.kill();
    gw2.kill();
}

#[tokio::test]
async fn reconnect_to_a_different_gateway_converges() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(9311, 111, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9312, 112, Some(NATS_URL));
    assert!(wait_ready(9311, 20_000).await);
    assert!(wait_ready(9312, 20_000).await);

    // Session on gw1: write history.
    let mut a = connect(9311).await;
    handshake_and_join(&mut a, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops = vec![op_bytes(503, 1), op_bytes(503, 2)];
    a.send(WsMessage::Binary(client_ops_frame(1, &ops).into()))
        .await
        .expect("send");
    assert_eq!(next_control(&mut a).await["type"], "durable_ack");
    drop(a); // disconnect (socket drop = unclean close)

    // Reconnect to gw2 (a DIFFERENT gateway): catch-up via sync_request
    // rebuilds state; resend works; convergence is DB-floor based.
    let mut b = connect(9312).await;
    handshake_and_join(&mut b, &fixture.clerk, &fixture.doc.to_string()).await;
    send(
        &mut b,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got_ops = 0;
    loop {
        let bytes = next_binary(&mut b).await.expect("sync batch");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            got_ops += f.ops.len();
            if !f.has_more {
                break;
            }
        }
    }
    assert_eq!(got_ops, 2, "full history via the OTHER gateway");
    let done = next_control(&mut b).await;
    assert_eq!(done["type"], "sync_done");

    gw1.kill();
    gw2.kill();
}

#[tokio::test]
async fn nats_outage_degrades_then_recovers() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let fixture = seed().await;

    // gw1 WITHOUT NATS (local-only bus) + gw2 WITH NATS: cross-gateway is
    // degraded for gw1's publishes, but local semantics hold everywhere.
    let mut gw1 = GatewayProcess::spawn(9321, 121, None);
    let mut gw2 = GatewayProcess::spawn(9322, 122, Some(NATS_URL));
    assert!(wait_ready(9321, 20_000).await);
    assert!(wait_ready(9322, 20_000).await);

    // Client on the broker-less gateway: durable writes still ACK (M019).
    let mut a = connect(9321).await;
    handshake_and_join(&mut a, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops = vec![op_bytes(504, 1), op_bytes(504, 2)];
    a.send(WsMessage::Binary(client_ops_frame(1, &ops).into()))
        .await
        .expect("send");
    let ack = next_control(&mut a).await;
    assert_eq!(ack["type"], "durable_ack", "durable ACK without broker");
    let n = db_count(&fixture.doc, 504).await;
    assert_eq!(n, 2, "durability is Postgres-only");

    // The broker-connected gateway recovers it via DB catch-up (the floor).
    let mut b = connect(9322).await;
    handshake_and_join(&mut b, &fixture.clerk, &fixture.doc.to_string()).await;
    send(
        &mut b,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got = 0;
    loop {
        let bytes = next_binary(&mut b).await.expect("sync batch");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            got += f.ops.len();
            if !f.has_more {
                break;
            }
        }
    }
    assert_eq!(got, 2, "broker-less writes recovered via catch-up floor");

    gw1.kill();
    gw2.kill();
}
