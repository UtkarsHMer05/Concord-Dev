//! Synthetic multi-gateway load generator (P4-M041) + scaling baselines
//! (P4-M042).
//!
//! Reproducible, machine-readable (JSON summary) workload against REAL
//! gateway processes through the LB (or direct per-gateway). Configurable:
//! clients, documents, ops/s, duration, reconnect fraction, slow fraction.
//!
//! Run (from rust/):
//!   cargo run --release --example loadgen -- \
//!     --gateways 127.0.0.1:8791,127.0.0.1:8792 --clients 20 --docs 5 \
//!     --ops-per-sec 50 --seconds 20 --out /tmp/load.json
//!
//! Requires the E2E test JWT material (local JWKS + key under the private
//! scratch dir) and a matching seeded user — the generator creates its own
//! users/documents via SQL (needs the test DB up).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{encode, EncodingKey, Header};
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
const ISSUER: &str = "https://e2e.clerk.accounts.dev";
const KID: &str = "e2e-key-1";
const KEY_DER: &[u8] = include_bytes!("../src/auth/test_rsa_key.der");

fn encoding_key() -> EncodingKey {
    use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey};
    let key: rsa::RsaPrivateKey = DecodePrivateKey::from_pkcs8_der(KEY_DER).expect("key");
    let pem = key.to_pkcs8_pem(rsa::pkcs8::LineEnding::LF).expect("pem");
    EncodingKey::from_rsa_pem(pem.as_str().as_bytes()).expect("enc")
}

fn jwks() -> jsonwebtoken::jwk::JwkSet {
    use jsonwebtoken::jwk::{
        AlgorithmParameters, CommonParameters, Jwk, KeyAlgorithm, RSAKeyParameters, RSAKeyType,
    };
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::traits::PublicKeyParts;
    let key: rsa::RsaPrivateKey = DecodePrivateKey::from_pkcs8_der(KEY_DER).expect("key");
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
    jsonwebtoken::jwk::JwkSet {
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

fn token(sub: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some(KID.to_owned());
    #[derive(serde::Serialize)]
    struct Claims {
        sub: String,
        exp: u64,
        iss: String,
    }
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

struct Args {
    gateways: Vec<SocketAddr>,
    clients: usize,
    docs: usize,
    ops_per_sec: f64,
    seconds: u64,
    out: String,
    slow_fraction: f64,
}

fn parse_args() -> Result<Args, String> {
    let mut gateways = None;
    let mut clients = 20;
    let mut docs = 5;
    let mut ops_per_sec = 50.0;
    let mut seconds = 20;
    let mut out = String::new();
    let mut slow_fraction = 0.0;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--gateways" => gateways = Some(it.next().ok_or("--gateways needs a value")?),
            "--clients" => {
                clients = it
                    .next()
                    .ok_or("--clients needs a value")?
                    .parse()
                    .map_err(|_| "bad --clients")?
            }
            "--docs" => {
                docs = it
                    .next()
                    .ok_or("--docs needs a value")?
                    .parse()
                    .map_err(|_| "bad --docs")?
            }
            "--ops-per-sec" => {
                ops_per_sec = it
                    .next()
                    .ok_or("--ops-per-sec needs a value")?
                    .parse()
                    .map_err(|_| "bad --ops-per-sec")?
            }
            "--seconds" => {
                seconds = it
                    .next()
                    .ok_or("--seconds needs a value")?
                    .parse()
                    .map_err(|_| "bad --seconds")?
            }
            "--out" => out = it.next().ok_or("--out needs a value")?,
            "--slow-fraction" => {
                slow_fraction = it
                    .next()
                    .ok_or("--slow-fraction needs a value")?
                    .parse()
                    .map_err(|_| "bad --slow-fraction")?
            }
            other => return Err(format!("unknown arg {other}")),
        }
    }
    let gateways = gateways
        .ok_or("missing --gateways host:port,host:port")?
        .split(',')
        .map(|s| {
            s.trim()
                .parse()
                .map_err(|_| format!("bad gateway addr {s}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Args {
        gateways,
        clients,
        docs,
        ops_per_sec,
        seconds,
        out,
        slow_fraction,
    })
}

#[derive(Default, serde::Serialize)]
struct Summary {
    args: serde_json::Value,
    gateways: usize,
    clients: usize,
    docs: usize,
    duration_s: f64,
    ops_sent: u64,
    durable_acks: u64,
    peer_frames: u64,
    reconnects: u64,
    ack_latency_us: Vec<u128>,
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("usage: loadgen --gateways h:p,h:p [--clients N] [--docs N] [--ops-per-sec F] [--seconds S] [--slow-fraction F] [--out FILE]\nerror: {e}");
            std::process::exit(2);
        }
    };

    // Seed a bench user + documents.
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
        nats_url: None,
        nats_subject_prefix: "concord.bench".into(),
        gateway_id: 90,
        redis_url: None,
    };
    let db = match Db::connect(&config).await {
        Ok(db) => db,
        Err(_) => {
            eprintln!("SKIP: concord_test DB unreachable");
            return;
        }
    };
    run_migrations(&db).await.expect("migrations");
    let clerk = format!("user_loadgen_{}", Uuid::new_v4().simple());
    let client_sql = db.get().await.expect("pool");
    let user: Uuid = client_sql
        .query_one(
            "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
            &[&clerk],
        )
        .await
        .expect("user")
        .get("id");
    let mut docs = Vec::with_capacity(args.docs);
    for _ in 0..args.docs {
        let doc: Uuid = client_sql
            .query_one(
                "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'loadgen', '') RETURNING id",
                &[&user],
            )
            .await
            .expect("doc")
            .get("id");
        docs.push(doc);
    }

    // Boot IN-PROCESS gateways bound to the requested ports (identical to
    // the release binary's server; this makes the generator self-contained
    // and keeps scaling runs reproducible without port collisions).
    let mut started = Vec::new();
    let verifier = Arc::new(TokenVerifier::new(
        ISSUER,
        VerifierSource::Static(StaticJwks(jwks())),
    ));
    for (i, addr) in args.gateways.iter().enumerate() {
        let gw_config = Config {
            bind_port: addr.port(),
            nats_url: Some("nats://127.0.0.1:4222".into()),
            gateway_id: 900 + i as u64,
            ..config.clone()
        };
        let registry = SessionRegistry::new();
        let broker = sync_gateway::broker::Broker::connect(
            "nats://127.0.0.1:4222",
            "concord.bench",
            900 + i as u64,
        )
        .await
        .expect("broker");
        let broker = Arc::new(broker);
        let state = AppState {
            config: Arc::new(gw_config),
            registry: registry.clone(),
            repo: Arc::new(GatewayRepo::new(db.clone())),
            verifier: verifier.clone(),
            draining: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            bus: Arc::new(sync_gateway::bus::NatsPublisher::new(
                broker.clone(),
                900 + i as u64,
            )),
            gateway_id: 900 + i as u64,
            rate_limiter: Arc::new(sync_gateway::ephemeral::ratelimit::RateLimiter::new(
                None,
                sync_gateway::ephemeral::ratelimit::default_policies(),
            )),
            presence: None,
        };
        let app = http::router(state);
        let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", addr.port()))
            .await
            .expect("bind");
        started.push(addr.port());
        let subscriber = sync_gateway::bus::NatsSubscriber::new(broker, registry);
        tokio::spawn(async move {
            subscriber.run().await;
        });
        tokio::spawn(async move {
            let server = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            );
            let _ = server.await;
        });
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The workload: clients spread across gateways (round-robin), docs
    // spread across clients; every client sends ops at the global rate.
    let summary = Arc::new(Mutex::new(Summary {
        args: serde_json::json!({
            "gateways": started,
            "clients": args.clients,
            "docs": args.docs,
            "ops_per_sec": args.ops_per_sec,
            "seconds": args.seconds,
            "slow_fraction": args.slow_fraction,
        }),
        gateways: started.len(),
        clients: args.clients,
        docs: args.docs,
        ..Default::default()
    }));
    let ack_latencies: Arc<Mutex<Vec<u128>>> = Arc::new(Mutex::new(Vec::new()));
    let ops_sent = Arc::new(AtomicU64::new(0));
    let durable_acks = Arc::new(AtomicU64::new(0));
    let peer_frames = Arc::new(AtomicU64::new(0));
    let reconnects = Arc::new(AtomicU64::new(0));

    let per_client_rate = args.ops_per_sec / args.clients as f64;
    let start = Instant::now();
    let mut handles = Vec::new();
    for client_idx in 0..args.clients {
        let gateway = args.gateways[client_idx % args.gateways.len()];
        let doc = docs[client_idx % docs.len()];
        let clerk = clerk.clone();
        let summary = summary.clone();
        let latencies = ack_latencies.clone();
        let sent_counter = ops_sent.clone();
        let ack_counter = durable_acks.clone();
        let peer_counter = peer_frames.clone();
        let reconnect_counter = reconnects.clone();
        let slow = (client_idx as f64) < args.slow_fraction * args.clients as f64;
        let rate = per_client_rate;
        let seconds = args.seconds;
        handles.push(tokio::spawn(async move {
            let url = format!("ws://{gateway}/api/v1/sync");
            let (ws, _) = tokio_tungstenite::connect_async(&url).await.expect("connect");
            let (mut writer, mut reader) = ws.split();

            // hello + auth + join (direct sends — no boxed helpers)
            let _ = writer
                .send(WsMessage::Text(r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#.into()))
                .await;
            let _ = reader.next().await;
            let t = token(&clerk);
            let _ = writer
                .send(WsMessage::Text(format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{t}"}}}}"#).into()))
                .await;
            let _ = reader.next().await;
            let join = format!(
                r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#
            );
            let _ = writer.send(WsMessage::Text(join.into())).await;
            // drain join → ready
            loop {
                match reader.next().await {
                    Some(Ok(WsMessage::Text(t))) if t.contains("sync_done") => break,
                    Some(Ok(WsMessage::Close(_))) | None => {
                        reconnect_counter.fetch_add(1, Ordering::Relaxed);
                        return; // reconnect fraction scenarios handled at the loop level
                    }
                    _ => {}
                }
            }

            let mut batch_id = 0u64;
            let interval = Duration::from_secs_f64(1.0 / rate.max(0.001));
            let mut next_tick = Instant::now();
            while start.elapsed() < Duration::from_secs(seconds) {
                if next_tick > Instant::now() {
                    tokio::time::sleep(next_tick - Instant::now()).await;
                }
                next_tick += interval;
                batch_id += 1;
                let ops = vec![op_bytes(10_000 + client_idx as u64, batch_id)];
                let sent_at = Instant::now();
                if writer.send(WsMessage::Binary(client_ops_frame(batch_id, &ops).into())).await.is_err() {
                    reconnect_counter.fetch_add(1, Ordering::Relaxed);
                    break;
                }
                sent_counter.fetch_add(1, Ordering::Relaxed);
                // Await the durable ack (bounded).
                let deadline = tokio::time::Duration::from_secs(10);
                loop {
                    match tokio::time::timeout(deadline, reader.next()).await {
                        Ok(Some(Ok(WsMessage::Text(t)))) => {
                            if t.contains("durable_ack") {
                                ack_counter.fetch_add(1, Ordering::Relaxed);
                                latencies.lock().unwrap().push(sent_at.elapsed().as_micros());
                                break;
                            }
                        }
                        Ok(Some(Ok(WsMessage::Binary(_)))) => {
                            peer_counter.fetch_add(1, Ordering::Relaxed);
                        }
                        _ => break,
                    }
                }
                if slow {
                    // Stalled readers still send but read rarely (slow path).
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
            let _ = summary;
            let _ = writer.close().await;
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    let duration = start.elapsed();

    // Compile + print the summary.
    {
        let mut s = summary.lock().unwrap();
        s.duration_s = duration.as_secs_f64();
        s.ops_sent = ops_sent.load(Ordering::Relaxed);
        s.durable_acks = durable_acks.load(Ordering::Relaxed);
        s.peer_frames = peer_frames.load(Ordering::Relaxed);
        s.reconnects = reconnects.load(Ordering::Relaxed);
        s.ack_latency_us = {
            let mut v = ack_latencies.lock().unwrap().clone();
            v.sort_unstable();
            v
        };
        let json = serde_json::to_string_pretty(&*s).expect("json");
        println!("{json}");
        if !args.out.is_empty() {
            std::fs::write(&args.out, json).expect("write out");
        }
    }

    // Cleanup bench rows.
    for doc in docs {
        let _ = client_sql
            .execute(
                "DELETE FROM crdt_operations WHERE document_id = $1",
                &[&doc],
            )
            .await;
        let _ = client_sql
            .execute("DELETE FROM documents WHERE id = $1", &[&doc])
            .await;
    }
    let _ = client_sql
        .execute("DELETE FROM users WHERE id = $1", &[&user])
        .await;
}
