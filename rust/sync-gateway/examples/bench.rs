//! Single-gateway throughput/latency baselines (P3-M043).
//!
//! Reproducible local benchmark against the Docker Postgres test DB with a
//! REAL gateway process and REAL WebSocket clients. Workload: canonical
//! Phase 2 insert ops (32 bytes — the actual production envelope).
//!
//! Run: `cargo run --release --example bench` (from rust/).
//! Records go to .agent/METRICS_LEDGER.md (honest baseline, no tuning —
//! M044 defers optimization unless evidence demands it).

use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::jwk::{
    AlgorithmParameters, CommonParameters, Jwk, JwkSet, KeyAlgorithm, RSAKeyParameters, RSAKeyType,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::Serialize;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use uuid::Uuid;

use sync_gateway::auth::{StaticJwks, TokenVerifier, VerifierSource};
use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::GatewayRepo;
use sync_gateway::http::{self, AppState};
use sync_gateway::sessions::SessionRegistry;

const DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER: &str = "https://bench.clerk.accounts.dev";
const KID: &str = "bench-key";
const KEY: &[u8] = include_bytes!("../src/auth/test_rsa_key.der");

fn encoding_key() -> EncodingKey {
    use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
    let key: rsa::RsaPrivateKey = DecodePrivateKey::from_pkcs8_der(KEY).expect("key");
    let pem = key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).expect("pem");
    EncodingKey::from_rsa_pem(pem.as_str().as_bytes()).expect("enc")
}

fn jwks() -> JwkSet {
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::traits::PublicKeyParts;
    let key: rsa::RsaPrivateKey = DecodePrivateKey::from_pkcs8_der(KEY).expect("key");
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
struct Claims {
    sub: String,
    exp: u64,
    iss: String,
}

fn token(sub: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some(KID.to_owned());
    encode(
        &header,
        &Claims {
            sub: sub.to_owned(),
            exp: now + 3600,
            iss: ISSUER.to_owned(),
        },
        &encoding_key(),
    )
    .expect("sign")
}

/** Canonical 32-byte insert op (same envelope as the tests). */
fn op_bytes(replica: u64, counter: u64) -> Vec<u8> {
    let mut op = vec![0u8; 32];
    op[0] = 1;
    op[1] = 1;
    op[2..10].copy_from_slice(&replica.to_le_bytes());
    op[10..18].copy_from_slice(&counter.to_le_bytes());
    op[18..26].copy_from_slice(&1u64.to_le_bytes()); // lamport
    op[26] = 0; // left None
    op[27] = 0; // right None
    op[28] = 1; // text
    op[29] = 1; // scalar len
    op[30] = b'a';
    op[31] = 0; // no attrs
    op
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

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(addr: SocketAddr) -> Ws {
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/v1/sync"))
        .await
        .expect("connect");
    ws
}

async fn handshake(ws: &mut Ws, sub: &str) {
    ws.send(WsMessage::Text(
        r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#.into(),
    ))
    .await
    .expect("hello");
    let _ = ws.next().await; // hello_ack
    let t = token(sub);
    ws.send(WsMessage::Text(
        format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{t}"}}}}"#).into(),
    ))
    .await
    .expect("auth");
    let _ = ws.next().await; // authenticated
}

async fn join_and_ready(ws: &mut Ws, doc: Uuid) {
    let join = format!(
        r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#
    );
    ws.send(WsMessage::Text(join.into())).await.expect("join");
    // drain join_accepted, (empty history: no batch), sync_done
    loop {
        let msg = ws.next().await.expect("frame").expect("ok");
        if let WsMessage::Text(t) = msg {
            if t.contains("sync_done") {
                break;
            }
        }
    }
}

async fn next_ack(ws: &mut Ws) -> (u64, usize) {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("ack within 30s")
            .expect("open")
            .expect("ok");
        if let WsMessage::Text(t) = msg {
            if t.contains("durable_ack") {
                let v: serde_json::Value = serde_json::from_str(t.as_str()).expect("json");
                let batch = v["payload"]["batchId"].as_str().unwrap().parse().unwrap();
                let count = v["payload"]["opIds"]
                    .as_array()
                    .map(|a| a.len())
                    .unwrap_or(0);
                return (batch, count);
            }
        }
    }
}

fn percentiles(mut samples: Vec<u128>) -> (u128, u128, u128) {
    samples.sort_unstable();
    if samples.is_empty() {
        return (0, 0, 0);
    }
    let p = |q: f64| samples[((samples.len() as f64 - 1.0) * q) as usize];
    (p(0.5), p(0.95), p(0.99))
}

#[tokio::main]
async fn main() {
    // Setup: gateway on a free port, benchmark user + document.
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: DB_URL.into(),
        clerk_issuer: ISSUER.into(),
        allowed_origins: vec![],
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 512,
        heartbeat_interval: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(600),
        db_pool_size: 8,
        jwks_file: None,
    };
    let db = match Db::connect(&config).await {
        Ok(db) => db,
        Err(_) => {
            eprintln!("SKIP: bench requires concord_test (docker compose up -d db)");
            return;
        }
    };
    run_migrations(&db).await.expect("migrations");
    let repo = Arc::new(GatewayRepo::new(db.clone()));
    let user_clerk = format!("user_bench_{}", Uuid::new_v4().simple());
    let client = db.get().await.expect("pool");
    let user: Uuid = client
        .query_one(
            "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
            &[&user_clerk],
        )
        .await
        .expect("seed user")
        .get("id");
    let doc: Uuid = client
        .query_one(
            "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'bench', '') RETURNING id",
            &[&user],
        )
        .await
        .expect("seed doc")
        .get("id");

    let registry = SessionRegistry::new();
    let verifier = Arc::new(TokenVerifier::new(
        ISSUER,
        VerifierSource::Static(StaticJwks(jwks())),
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
    tokio::spawn(async move {
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        );
        let _ = server.await;
    });
    let _ = registry;

    println!("=== Concord Phase 3 single-gateway baseline (P3-M043) ===");
    println!("hardware: host macOS arm64; commit: see git; mode: release");
    println!("db: Docker postgres 18.6 @ 127.0.0.1:5433; pool: 8; queue: 512\n");

    // --- 1. Ingest throughput + durable-ACK latency (single writer) -------
    {
        let mut ws = connect(addr).await;
        handshake(&mut ws, &user_clerk).await;
        join_and_ready(&mut ws, doc).await;

        const BATCHES: u64 = 200;
        const OPS_PER_BATCH: usize = 25;
        let mut ack_latencies_us: Vec<u128> = Vec::with_capacity(BATCHES as usize);
        let start = Instant::now();
        for batch in 0..BATCHES {
            let ops: Vec<Vec<u8>> = (0..OPS_PER_BATCH)
                .map(|i| op_bytes(10_000, batch * OPS_PER_BATCH as u64 + i as u64 + 1))
                .collect();
            let sent = Instant::now();
            ws.send(WsMessage::Binary(client_ops_frame(batch, &ops).into()))
                .await
                .expect("send");
            let (_b, _n) = next_ack(&mut ws).await;
            ack_latencies_us.push(sent.elapsed().as_micros());
        }
        let elapsed = start.elapsed();
        let total_ops = BATCHES as usize * OPS_PER_BATCH;
        println!("ingest: {total_ops} ops in {BATCHES} batches (25/batch)");
        println!(
            "  throughput: {:.0} ops/s",
            total_ops as f64 / elapsed.as_secs_f64()
        );
        let (p50, p95, p99) = percentiles(ack_latencies_us.clone());
        println!("  durable-ack batch latency p50/p95/p99: {p50}/{p95}/{p99} µs");
        ws.send(WsMessage::Close(None)).await.ok();
    }

    // --- 2. Peer propagation latency (writer + 3 readers) ------------------
    {
        let mut writer = connect(addr).await;
        handshake(&mut writer, &user_clerk).await;
        join_and_ready(&mut writer, doc).await;
        let mut peers = Vec::new();
        for i in 0..3 {
            let mut p = connect(addr).await;
            handshake(&mut p, &user_clerk).await;
            join_and_ready(&mut p, doc).await;
            let _ = i;
            peers.push(p);
        }

        const PROP_BATCHES: usize = 100;
        let mut prop_latencies_us: Vec<u128> = Vec::with_capacity(PROP_BATCHES);
        for batch in 0..PROP_BATCHES {
            let ops = vec![op_bytes(11_000, batch as u64 + 1)];
            let sent = Instant::now();
            writer
                .send(WsMessage::Binary(
                    client_ops_frame(batch as u64, &ops).into(),
                ))
                .await
                .expect("send");
            // Wait for the FIRST peer's binary fanout.
            loop {
                let msg = tokio::time::timeout(Duration::from_secs(10), peers[0].next())
                    .await
                    .expect("fanout")
                    .expect("open")
                    .expect("ok");
                if matches!(msg, WsMessage::Binary(_)) {
                    prop_latencies_us.push(sent.elapsed().as_micros());
                    // drain remaining peers for this batch
                    for p in peers.iter_mut().skip(1) {
                        let _ = tokio::time::timeout(Duration::from_secs(5), p.next()).await;
                    }
                    break;
                }
            }
            let _ = next_ack(&mut writer).await;
        }
        let (p50, p95, p99) = percentiles(prop_latencies_us);
        println!("fanout: 1 writer → 3 peers, 1 op/batch × {PROP_BATCHES}");
        println!("  peer propagation p50/p95/p99: {p50}/{p95}/{p99} µs");
    }

    // --- 3. Catch-up throughput ----------------------------------------------
    {
        let rows: i64 = db
            .get()
            .await
            .expect("pool")
            .query_one(
                "SELECT COUNT(*)::bigint AS n FROM crdt_operations WHERE document_id = $1",
                &[&doc],
            )
            .await
            .expect("count")
            .get("n");
        let mut ws = connect(addr).await;
        handshake(&mut ws, &user_clerk).await;
        join_and_ready(&mut ws, doc).await;
        ws.send(WsMessage::Text(
            r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.to_owned().into(),
        ))
        .await
        .expect("sync req");
        let start = Instant::now();
        let mut received: i64 = 0;
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(60), ws.next())
                .await
                .expect("batch")
                .expect("open")
                .expect("ok");
            match msg {
                WsMessage::Binary(b) => {
                    if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
                        sync_gateway::protocol::data::DataFrame::decode(&b)
                    {
                        received += f.ops.len() as i64;
                        if !f.has_more {
                            break;
                        }
                    }
                }
                WsMessage::Text(t) if t.contains("sync_done") => break,
                _ => {}
            }
        }
        let elapsed = start.elapsed();
        println!(
            "catch-up: {received}/{rows} ops re-streamed in {:.1} ms ({:.0} ops/s)",
            elapsed.as_secs_f64() * 1000.0,
            received as f64 / elapsed.as_secs_f64()
        );
    }

    // --- 4. Concurrent connection baseline -----------------------------------
    {
        const N: usize = 50;
        let mut conns = Vec::with_capacity(N);
        for _ in 0..N {
            match tokio::time::timeout(Duration::from_secs(5), connect(addr)).await {
                Ok(ws) => conns.push(ws),
                Err(_) => break,
            }
        }
        println!(
            "connections: {} concurrent sockets established (target {N})",
            conns.len()
        );
    }

    // Cleanup: remove bench rows (keep the DB tidy for reruns).
    let _ = client
        .execute(
            "DELETE FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await;
    let _ = client
        .execute("DELETE FROM documents WHERE id = $1", &[&doc])
        .await;
    let _ = client
        .execute("DELETE FROM users WHERE id = $1", &[&user])
        .await;
    println!("\n(done — record into .agent/METRICS_LEDGER.md)");
}
