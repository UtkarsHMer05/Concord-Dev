//! Stale-client snapshot resync E2E (P5-M031): a real gateway process,
//! a client whose cursor precedes a compaction floor receives
//! `snapshot_resync_required`, fetches the snapshot, imports it, and
//! converges with delta catch-up — the full RECOVERY.md §4 flow minus
//! the browser engine (WASM-side import is covered by the TS unit
//! suite; the protocol path is proven here end to end).

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
use uuid::Uuid;

use sync_gateway::auth::{StaticJwks, TokenVerifier, VerifierSource};
use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::http::{self, AppState};
use sync_gateway::maintenance::{prune_to_boundary, RecoverySelector, SnapshotPipeline};
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::golden;
use sync_gateway::sessions::SessionRegistry;
use sync_gateway::worker::WorkerPool;

const DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER: &str = "https://test.clerk.accounts.dev";
const KID: &str = "it-key-1";
const KEY1: &[u8] = include_bytes!("../src/auth/test_rsa_key.der");

fn encoding_key() -> EncodingKey {
    let der = KEY1;
    let key = pkcs8::PrivateKeyInfo::try_from(der).expect("PKCS8 test key");
    EncodingKey::from_rsa_der(key.private_key)
}

fn test_jwks() -> JwkSet {
    let key = pkcs8::PrivateKeyInfo::try_from(KEY1).expect("PKCS8 test key");
    let public = pkcs1::RsaPrivateKey::try_from(key.private_key).expect("RSA test key");
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
    let n = public.modulus.as_bytes();
    let e = public.public_exponent.as_bytes();
    JwkSet {
        keys: vec![Jwk {
            common: CommonParameters {
                key_id: Some(KID.to_owned()),
                key_algorithm: Some(KeyAlgorithm::RS256),
                ..Default::default()
            },
            algorithm: AlgorithmParameters::RSA(RSAKeyParameters {
                key_type: RSAKeyType::RSA,
                n: b64u(n),
                e: b64u(e),
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
        &encoding_key(),
    )
    .expect("sign")
}

fn base_config() -> Config {
    Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: DB_URL.into(),
        clerk_issuer: ISSUER.into(),
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(600),
        db_pool_size: 4,
        jwks_file: None,
        nats_url: None,
        nats_subject_prefix: "concord.test".to_string(),
        gateway_id: 1,
        redis_url: None,
        otel_enabled: false,
        otel_endpoint: "http://127.0.0.1:4317".into(),
        otel_sample_ratio: 1.0,
        otel_exporter: "otlp".into(),
        debug_op_ids: false,
        worker_binary: None,
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send_text(ws: &mut Ws, text: &str) {
    ws.send(WsMessage::Text(text.to_owned().into()))
        .await
        .expect("send");
}

/// Reads frames (skipping unrelated pushes) until one of `typ` arrives.
async fn expect_text(ws: &mut Ws, typ: &str) -> serde_json::Value {
    let deadline = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let msg = tokio::select! {
                m = ws.next() => m.expect("open"),
            };
            match msg {
                Ok(WsMessage::Text(t)) => {
                    let v: serde_json::Value = serde_json::from_str(t.as_str()).expect("json");
                    if v["type"] == typ {
                        return v["payload"].clone();
                    }
                }
                Ok(WsMessage::Binary(_)) => continue,
                _ => continue,
            }
        }
    });
    deadline.await.expect("frame deadline")
}

fn ops_at(count: usize, counter_base: u64, replica: u64) -> Vec<Vec<u8>> {
    let builders = [
        golden::golden_insert_op,
        golden::golden_delimiter_op,
        golden::golden_delete_op,
    ];
    (0..count)
        .map(|i| {
            let mut base = builders[i % builders.len()]();
            base[2..10].copy_from_slice(&replica.to_le_bytes());
            base[10..18].copy_from_slice(&(counter_base + i as u64).to_le_bytes());
            validate_op(&base).expect("valid");
            base
        })
        .collect()
}

fn live_worker_pool() -> Option<WorkerPool> {
    let mut root = std::env::current_dir().expect("cwd");
    for _ in 0..3 {
        for rel in [
            "build/native/concord-worker",
            "build/native/worker/concord-worker",
        ] {
            let mut path = root.clone();
            path.push(rel);
            if path.is_file() {
                return Some(WorkerPool::new(path, Duration::from_secs(300)));
            }
        }
        if !root.pop() {
            break;
        }
    }
    eprintln!("SKIP: concord-worker binary not built");
    None
}

async fn test_db() -> Option<Db> {
    let config = base_config();
    match Db::connect(&config).await {
        Ok(db) => {
            run_migrations(&db).await.expect("migrations");
            Some(db)
        }
        Err(_) => {
            eprintln!("SKIP: concord_test DB unreachable");
            None
        }
    }
}

#[tokio::test]
async fn stale_client_resyncs_via_snapshot_and_converges() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };

    // Fixture: document + owner.
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'resync_{org}', 'p5-resync');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'resync_owner_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-resync');"
        ))
        .await
        .expect("fixture");

    // History: 12 ops → snapshot at boundary → prune → 6 more ops (tail).
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());
    let envelopes: Vec<_> = ops_at(12, 700, 0xEE01)
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect();
    let boundary = repo
        .ingest_batch(UserId(owner), doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;

    // Finalized snapshot covering the boundary, then prune below it.
    let job = Uuid::new_v4();
    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(doc, boundary, job, 1)
        .await
        .expect("build");
    assert!(snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));
    let deleted = prune_to_boundary(&db, &snapshots, doc, boundary, 4)
        .await
        .expect("prune");
    assert_eq!(deleted, 12);

    // Post-prune tail: ops the stale client also needs after resync.
    let tail_ops = ops_at(6, 900, 0xEE02);
    let envelopes2: Vec<_> = tail_ops
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect();
    repo.ingest_batch(UserId(owner), doc, &envelopes2)
        .await
        .expect("tail ingest");

    // Spin up a REAL gateway bound to a free port (harness mirrors
    // ws_integration.rs boot()).
    let config = base_config();
    let repo = Arc::new(repo);
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
        bus: Arc::new(sync_gateway::bus::LocalOnlyPublisher),
        gateway_id: 1,
        rate_limiter: Arc::new(sync_gateway::ephemeral::ratelimit::RateLimiter::new(
            None,
            sync_gateway::ephemeral::ratelimit::default_policies(),
        )),
        presence: None,
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

    // Connect + handshake (hello → authenticate → join).
    let url = format!("ws://{addr}/api/v1/sync");
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect");
    eprintln!("STEP: connected");
    send_text(
        &mut ws,
        r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#,
    )
    .await;
    eprintln!("STEP: hello sent");
    expect_text(&mut ws, "hello_ack").await;
    eprintln!("STEP: hello_ack ok");
    let token = sign_token(&format!("resync_owner_{owner}"));
    send_text(
        &mut ws,
        &format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{token}"}}}}"#),
    )
    .await;
    expect_text(&mut ws, "authenticated").await;
    eprintln!("STEP: authenticated ok");
    send_text(
        &mut ws,
        &format!(r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#),
    )
    .await;
    expect_text(&mut ws, "join_accepted").await;
    eprintln!("STEP: join ok");

    // Stale client: cursor BELOW the floor ⇒ resync signal, never
    // partial delta pages.
    send_text(
        &mut ws,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"5"}}"#,
    )
    .await;
    let resync = expect_text(&mut ws, "snapshot_resync_required").await;
    assert_eq!(
        resync["boundary"],
        serde_json::json!(boundary.to_string()),
        "announced boundary must be the compaction floor"
    );

    // Fetch the snapshot by the announced id; verify client-side the
    // way the TS runtime does (checksum over wrapper bytes, wrapper
    // decode, document/coverage agreement).
    let snapshot_id = resync["snapshotId"].as_str().expect("id").to_string();
    send_text(
        &mut ws,
        &format!(r#"{{"v":1,"type":"fetch_snapshot","payload":{{"snapshotId":"{snapshot_id}"}}}}"#),
    )
    .await;
    let payload = expect_text(&mut ws, "snapshot_payload").await;
    assert_eq!(
        payload["coverageSeq"],
        serde_json::json!(boundary.to_string())
    );
    assert_eq!(payload["coveredOpCount"], serde_json::json!("12"));
    let b64 = payload["payloadBase64"].as_str().expect("b64").to_string();
    let checksum = payload["checksum"].as_str().expect("checksum").to_string();

    use sha2::{Digest, Sha256};
    let wrapper_bytes = decode_base64(&b64).expect("b64 decodes");
    let digest = hex::encode(Sha256::digest(&wrapper_bytes));
    assert_eq!(digest, checksum, "client-side checksum must verify");
    let parts = sync_gateway::db::snapshots::wrapper::decode_wrapper(&wrapper_bytes)
        .expect("wrapper decodes");
    assert_eq!(parts.document_id, doc);
    assert_eq!(parts.coverage_seq, boundary as u64);
    assert_eq!(parts.covered_op_count, 12);

    // Snapshot imports into the CRDT (real worker) with the announced
    // digest — the browser-equivalent validation chain.
    let imported = workers.import_digest(&parts.inner).await.expect("import");
    assert_eq!(
        imported.digest,
        payload["stateDigest"].as_str().expect("digest"),
        "import digest must match the announced state digest"
    );

    // Resync done: cursor = boundary; delta catch-up delivers EXACTLY
    // the 6 tail ops and sync_done. No pruned op can ever be re-sent.
    send_text(
        &mut ws,
        &format!(r#"{{"v":1,"type":"sync_request","payload":{{"cursor":"{boundary}"}}}}"#),
    )
    .await;
    let mut tail_ops_seen = 0usize;
    let done = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let msg = tokio::select! { m = ws.next() => m.expect("open") };
            match msg {
                Ok(WsMessage::Binary(b)) => {
                    // sync_batch layout (PROTOCOL §9 data frames):
                    // [version u8][kind u8][next_cursor u64][has_more
                    // u8][count u16] — count is BE at bytes 11..13.
                    if b.len() >= 13 && b[1] == 0x21 {
                        let count = u16::from_be_bytes([b[11], b[12]]);
                        tail_ops_seen += count as usize;
                    }
                }
                Ok(WsMessage::Text(t)) => {
                    let v: serde_json::Value = serde_json::from_str(t.as_str()).expect("json");
                    if v["type"] == "sync_done" {
                        return;
                    }
                }
                _ => {}
            }
        }
    })
    .await;
    done.expect("catch-up must finish");
    assert_eq!(tail_ops_seen, 6, "exactly the tail ops, nothing pruned");

    // Convergence: differential verifier over the pruned document.
    let selector = RecoverySelector::new(
        sync_gateway::db::repo::GatewayRepo::new(repo.db.clone()),
        snapshots.clone(),
        workers,
    );
    selector.verify_equivalence(doc).await.expect("equivalence");

    let _ = ws.send(WsMessage::Close(None)).await;

    // Cleanup.
    let c = db.get().await.expect("pool");
    let _ = c
        .batch_execute(&format!(
            "DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
             DELETE FROM crdt_operations WHERE document_id = '{doc}';
             UPDATE documents SET compaction_floor_seq = NULL,
                 compaction_floor_snapshot_id = NULL WHERE id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{owner}';
             DELETE FROM organizations WHERE id = '{org}';"
        ))
        .await;
}

/// RFC 4648 base64 decode (test-local mirror of the client path).
fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let table = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let bytes: Vec<u8> = input.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let mut acc = 0u32;
        for (i, b) in chunk.iter().enumerate() {
            acc |= table(*b)? << (18 - 6 * i);
        }
        out.push((acc >> 16) as u8);
        if chunk.len() > 2 {
            out.push((acc >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(acc as u8);
        }
    }
    Some(out)
}
