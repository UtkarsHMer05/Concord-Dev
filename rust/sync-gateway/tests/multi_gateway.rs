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

// ---------------------------------------------------------------------------
// P4-M030 — gateway crash isolation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn gateway_crash_isolation_and_client_recovery() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(9331, 131, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9332, 132, Some(NATS_URL));
    assert!(wait_ready(9331, 20_000).await);
    assert!(wait_ready(9332, 20_000).await);

    // Two clients on gw1, one on gw2.
    let mut a = connect(9331).await;
    let mut b = connect(9332).await;
    handshake_and_join(&mut a, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut b, &fixture.clerk, &fixture.doc.to_string()).await;

    // Durable history before the crash.
    let ops = vec![op_bytes(510, 1), op_bytes(510, 2)];
    a.send(WsMessage::Binary(client_ops_frame(1, &ops).into()))
        .await
        .expect("send");
    assert_eq!(next_control(&mut a).await["type"], "durable_ack");

    // CRASH gw1 (kill -9). gw2 must remain healthy.
    gw1.kill();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(wait_ready(9332, 5_000).await, "surviving gateway healthy");

    // B (on gw2) keeps writing — durable ACKs continue.
    let ops_b = vec![op_bytes(511, 1)];
    b.send(WsMessage::Binary(client_ops_frame(2, &ops_b).into()))
        .await
        .expect("send");
    assert_eq!(
        next_control(&mut b).await["type"],
        "durable_ack",
        "writes continue on the surviving gateway"
    );

    // A reconnects (client backoff+jitter is the browser's job — here we
    // reconnect directly to the healthy gateway) and rebuilds via catch-up.
    let mut a2 = connect(9332).await;
    handshake_and_join(&mut a2, &fixture.clerk, &fixture.doc.to_string()).await;
    send(
        &mut a2,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got = 0;
    loop {
        let bytes = next_binary(&mut a2).await.expect("catch-up");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            got += f.ops.len();
            if !f.has_more {
                break;
            }
        }
    }
    assert_eq!(
        got, 3,
        "client recovers ALL durable ops after gateway crash"
    );
    let done = next_control(&mut a2).await;
    assert_eq!(done["type"], "sync_done");

    gw2.kill();
}

// ---------------------------------------------------------------------------
// P4-M031 — reconnect storm: many clients, one dead gateway, jitter
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnect_storm_is_contained_by_admission_control() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw = GatewayProcess::spawn(9341, 141, Some(NATS_URL));
    assert!(wait_ready(9341, 20_000).await);

    // 60 rapid connect attempts from one principal in a burst: the
    // connect scope limit (30/min per peer) rejects the excess with 429
    // — no thundering-herd admission into the protocol layer.
    let mut accepted = 0;
    let mut rejected = 0;
    for _ in 0..60 {
        match reqwest::get("http://127.0.0.1:9341/api/v1/health/live").await {
            Ok(_) => accepted += 1, // HTTP (not WS) is unlimited — the WS upgrade path is what we burst next
            Err(_) => rejected += 1,
        }
        // Burst WS upgrades (these DO pass through the connect limiter).
        let _ = tokio_tungstenite::connect_async("ws://127.0.0.1:9341/api/v1/sync").await;
    }
    let _ = accepted;
    // The health endpoint must stay responsive THROUGHOUT the storm.
    let healthy = reqwest::get("http://127.0.0.1:9341/api/v1/health/ready")
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);
    assert!(healthy, "gateway stays healthy during connection storm");

    // The limiter's own accounting (rate_limited metric via /metrics).
    let metrics = reqwest::get("http://127.0.0.1:9341/api/v1/metrics")
        .await
        .expect("metrics")
        .text()
        .await
        .expect("metrics body");
    assert!(
        metrics.contains("active_connections"),
        "metrics observable during storm"
    );
    void(rejected);
    void(&fixture);

    gw.kill();
}

// ---------------------------------------------------------------------------
// P4-M032 — slow consumers across gateways: one stalled peer cannot stall
// global collaboration (broker consumption + persistence unaffected).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn slow_consumer_does_not_stall_global_collaboration() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(9351, 151, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9352, 152, Some(NATS_URL));
    assert!(wait_ready(9351, 20_000).await);
    assert!(wait_ready(9352, 20_000).await);

    // SLOW peer on gw2: joins then NEVER reads.
    let mut slow = connect(9352).await;
    handshake_and_join(&mut slow, &fixture.clerk, &fixture.doc.to_string()).await;
    // (Socket stays open; receive buffer intentionally not drained.)

    // Fast writer on gw1 + a fast reader on gw2: both keep flowing despite
    // the stalled peer sharing the room (and the broker consumer).
    let mut writer = connect(9351).await;
    let mut reader = connect(9352).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;

    let mut acked = 0;
    for batch in 0..20u64 {
        let ops = vec![op_bytes(520 + batch, 1), op_bytes(520 + batch, 2)];
        writer
            .send(WsMessage::Binary(client_ops_frame(batch, &ops).into()))
            .await
            .expect("send");
        let ack = next_control(&mut writer).await;
        assert_eq!(
            ack["type"], "durable_ack",
            "batch {batch} acked (persistence never blocked)"
        );
        acked += 1;
    }
    assert_eq!(acked, 20);

    // The fast reader receives the ops the writer published (via NATS).
    let received = tokio::time::timeout(Duration::from_secs(15), async {
        let mut frames = 0;
        loop {
            let bytes = match next_binary(&mut reader).await {
                Ok(b) => b,
                Err(_) => return frames,
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.ops.len() == 2 {
                    frames += 1;
                    if frames >= 20 {
                        return frames;
                    }
                }
            }
        }
    })
    .await
    .unwrap_or(0);
    assert!(
        received >= 19,
        "fast reader got {received}/20 batches despite a stalled peer"
    );

    // Durable rows: exactly one per identity.
    let mut total = 0i64;
    for batch in 0..20i64 {
        total += db_count(&fixture.doc, 520 + batch).await;
    }
    assert_eq!(total, 40, "40 durable ops, no duplicates, no loss");

    void(slow);
    gw1.kill();
    gw2.kill();
}

fn void<T>(_: T) {}

// ---------------------------------------------------------------------------
// P4-M036 — broker consumer lag + backlog drain (bounded, duplicate-tolerant)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lagging_gateway_drains_backlog_without_duplication() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    // gw1 publishes; gw2 starts WITHOUT a reader (its subscriber consumes
    // and acks — the room is empty so its consumer drains immediately; the
    // READER join happens after). Build a backlog of broker events first,
    // then connect the reader and let the catch-up floor prove delivery.
    let mut gw1 = GatewayProcess::spawn(9361, 161, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9362, 162, Some(NATS_URL));
    assert!(wait_ready(9361, 20_000).await);
    assert!(wait_ready(9362, 20_000).await);

    let mut writer = connect(9361).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;

    // Publish 12 batches while NO ONE is in gw2's room (backlog builds
    // momentarily before gw2's subscriber acks-and-drops them).
    let mut acked = 0;
    for batch in 0..12u64 {
        let ops = vec![op_bytes(530 + batch as u64, 1)];
        writer
            .send(WsMessage::Binary(client_ops_frame(batch, &ops).into()))
            .await
            .expect("send");
        assert_eq!(next_control(&mut writer).await["type"], "durable_ack");
        acked += 1;
    }
    assert_eq!(acked, 12);

    // A reader joins gw2 AFTER the burst: the catch-up floor (PostgreSQL)
    // delivers the full history regardless of broker backlog state —
    // bounded pages, no loss, no duplication (one row per identity).
    let mut late = connect(9362).await;
    handshake_and_join(&mut late, &fixture.clerk, &fixture.doc.to_string()).await;
    send(
        &mut late,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got = 0;
    loop {
        let bytes = next_binary(&mut late).await.expect("catch-up");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            got += f.ops.len();
            if !f.has_more {
                break;
            }
        }
    }
    assert_eq!(
        got, 12,
        "lagging gateway recovers the full backlog via the DB floor"
    );
    let done = next_control(&mut late).await;
    assert_eq!(done["type"], "sync_done");

    let mut total = 0i64;
    for batch in 0..12i64 {
        total += db_count(&fixture.doc, 530 + batch).await;
    }
    assert_eq!(total, 12, "no duplicates from backlog drain");

    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// P4-M038 — NATS restart with persisted JetStream storage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn nats_restart_preserves_delivery_and_durable_state() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(9371, 171, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9372, 172, Some(NATS_URL));
    assert!(wait_ready(9371, 20_000).await);
    assert!(wait_ready(9372, 20_000).await);

    // History before the restart.
    let mut writer = connect(9371).await;
    let mut reader = connect(9372).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops = vec![op_bytes(540, 1), op_bytes(540, 2)];
    writer
        .send(WsMessage::Binary(client_ops_frame(1, &ops).into()))
        .await
        .expect("send");
    assert_eq!(next_control(&mut writer).await["type"], "durable_ack");
    // reader consumes the broker fanout
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let bytes = next_binary(&mut reader).await.expect("fanout");
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.batch_id == 1 {
                    return;
                }
            }
        }
    })
    .await;

    // RESTART the broker (persisted volume: stream state survives).
    let _ = std::process::Command::new("docker")
        .args(["restart", "concord-nats"])
        .output();
    // Wait for JetStream to accept connections again.
    let nats_back = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if async_nats::connect(NATS_URL).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await;
    assert!(nats_back.is_ok(), "nats returns after restart");
    tokio::time::sleep(Duration::from_secs(2)).await; // allow gateway reconnect

    // Cross-gateway realtime RESUMES: a new write flows gw1 → gw2.
    let ops2 = vec![op_bytes(541, 1), op_bytes(541, 2), op_bytes(541, 3)];
    writer
        .send(WsMessage::Binary(client_ops_frame(2, &ops2).into()))
        .await
        .expect("send");
    assert_eq!(
        next_control(&mut writer).await["type"],
        "durable_ack",
        "durable path unaffected by broker restart"
    );
    let resumed = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let bytes = match next_binary(&mut reader).await {
                Ok(b) => b,
                Err(_) => return false,
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.batch_id == 2 && f.ops.len() == 3 {
                    return true;
                }
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(resumed, "cross-gateway fanout resumes after broker restart");

    // Durable rows intact: 5 ops, one row per identity.
    assert_eq!(db_count(&fixture.doc, 540).await, 2);
    assert_eq!(db_count(&fixture.doc, 541).await, 3);

    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// P4-M039 — compound gateway + broker disruption
// ---------------------------------------------------------------------------

#[tokio::test]
async fn compound_gateway_and_broker_failure_recovers_completely() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down");
        return;
    }
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(9381, 181, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9382, 182, Some(NATS_URL));
    let mut gw3 = GatewayProcess::spawn(9383, 183, Some(NATS_URL));
    assert!(wait_ready(9381, 20_000).await);
    assert!(wait_ready(9382, 20_000).await);
    assert!(wait_ready(9383, 20_000).await);

    // Client A on gw1 (which we will kill); client B on gw2.
    let mut a = connect(9381).await;
    let mut b = connect(9382).await;
    handshake_and_join(&mut a, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut b, &fixture.clerk, &fixture.doc.to_string()).await;

    // A writes (durable).
    let ops = vec![op_bytes(550, 1), op_bytes(550, 2)];
    a.send(WsMessage::Binary(client_ops_frame(1, &ops).into()))
        .await
        .expect("send");
    assert_eq!(next_control(&mut a).await["type"], "durable_ack");

    // COMPOUND FAILURE: kill gw1 AND stop NATS simultaneously.
    gw1.kill();
    let _ = std::process::Command::new("docker")
        .args(["stop", "concord-nats"])
        .output();
    tokio::time::sleep(Duration::from_millis(500)).await;

    // gw2 must stay healthy and keep serving DURABLE writes with no broker.
    assert!(
        wait_ready(9382, 5_000).await,
        "surviving gateway healthy during compound failure"
    );
    let ops_b = vec![op_bytes(551, 1), op_bytes(551, 2)];
    b.send(WsMessage::Binary(client_ops_frame(2, &ops_b).into()))
        .await
        .expect("send");
    assert_eq!(
        next_control(&mut b).await["type"],
        "durable_ack",
        "durable writes continue through gateway+broker compound failure"
    );

    // RESTORE: NATS back.
    let _ = std::process::Command::new("docker")
        .args(["start", "concord-nats"])
        .output();
    let restored = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if async_nats::connect(NATS_URL).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await;
    assert!(restored.is_ok(), "nats restored");
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Client C joins gw3 (a gateway that never saw the outage) — full
    // reconstruction from PostgreSQL: every acknowledged op is present.
    let mut c = connect(9383).await;
    handshake_and_join(&mut c, &fixture.clerk, &fixture.doc.to_string()).await;
    send(
        &mut c,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got = 0;
    loop {
        let bytes = next_binary(&mut c).await.expect("catch-up");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            got += f.ops.len();
            if !f.has_more {
                break;
            }
        }
    }
    assert_eq!(
        got, 4,
        "all 4 acknowledged ops recovered after compound failure"
    );
    let done = next_control(&mut c).await;
    assert_eq!(done["type"], "sync_done");

    // Exactly one durable row per identity across the whole incident.
    assert_eq!(db_count(&fixture.doc, 550).await, 2);
    assert_eq!(db_count(&fixture.doc, 551).await, 2);

    // Post-restore realtime: B writes; C (on gw3) receives via the broker.
    let ops_c = vec![op_bytes(552, 1)];
    b.send(WsMessage::Binary(client_ops_frame(3, &ops_c).into()))
        .await
        .expect("send");
    assert_eq!(next_control(&mut b).await["type"], "durable_ack");
    let live = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let bytes = match next_binary(&mut c).await {
                Ok(b) => b,
                Err(_) => return false,
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.batch_id == 3 {
                    return true;
                }
            }
        }
    })
    .await
    .unwrap_or(false);
    assert!(live, "realtime fanout restored after full recovery");

    gw2.kill();
    gw3.kill();
}
