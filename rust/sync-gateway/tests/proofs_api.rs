//! History-proof endpoint integration tests (Feature 5). Live DB + real
//! worker; skipped when either is unavailable (same conventions as
//! ws_integration.rs / phase5_history.rs).
//!
//! Proves: the endpoint's authz surface (view-or-better reads, outsider 404
//! equivalence), the Merkle audit path replaying to the advertised root, the
//! Ed25519 receipt verifying over the documented canonical bytes, and that a
//! tampered signature is rejected. The production client verify is the TS
//! mirror (`src/lib/crdt/proofs.ts`); here the SAME rules are re-derived
//! independently in Rust so neither implementation can drift silently.

use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use jsonwebtoken::jwk::{
    AlgorithmParameters, CommonParameters, Jwk, JwkSet, KeyAlgorithm, RSAKeyParameters, RSAKeyType,
};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::Serialize;
use serde_json::Value;
use sha2::Digest as _;
use uuid::Uuid;

use sync_gateway::auth::{StaticJwks, TokenVerifier, VerifierSource};
use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::http::{self, AppState};
use sync_gateway::maintenance::proofs::{leaf_hash, merkle_root, receipt_message, replay_path};
use sync_gateway::protocol::envelope::{validate_op, OpEnvelope};
use sync_gateway::protocol::golden;
use sync_gateway::sessions::SessionRegistry;

const TEST_DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER: &str = "https://test.clerk.accounts.dev";
const KID: &str = "it-key-1";
const KEY1: &[u8] = include_bytes!("../src/auth/test_rsa_key.der");

// ---------------------------------------------------------------------------
// Test harness (mirrors ws_integration.rs boot; HTTP instead of WS)
// ---------------------------------------------------------------------------

fn encoding_key(der: &[u8]) -> EncodingKey {
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
        &encoding_key(KEY1),
    )
    .expect("sign")
}

fn worker_path() -> Option<std::path::PathBuf> {
    let mut root = std::env::current_dir().expect("cwd");
    for _ in 0..3 {
        for rel in [
            "build/native/concord-worker",
            "build/native/worker/concord-worker",
        ] {
            let mut path = root.clone();
            path.push(rel);
            if path.is_file() {
                return Some(path);
            }
        }
        if !root.pop() {
            break;
        }
    }
    None
}

struct TestServer {
    addr: SocketAddr,
    repo: Arc<GatewayRepo>,
}

async fn boot() -> Option<TestServer> {
    let worker = worker_path()?;
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_DB_URL.into(),
        clerk_issuer: ISSUER.into(),
        clerk_audience: None,
        clerk_authorized_party: None,
        require_internal_services: false,
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
        worker_binary: Some(worker.to_string_lossy().into_owned()),
    };
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
    let _registry = registry;
    tokio::spawn(async move {
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        );
        let _ = server.await;
    });
    Some(TestServer { addr, repo })
}

async fn get_proof(
    server: &TestServer,
    token: &str,
    document: Uuid,
    seq: Option<i64>,
) -> (u16, Value) {
    let client = reqwest::Client::new();
    let mut url = format!(
        "http://{}/api/v1/documents/{}/proof",
        server.addr,
        document.hyphenated()
    );
    if let Some(seq) = seq {
        url.push_str(&format!("?seq={seq}"));
    }
    let mut request = client.get(url);
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.expect("http get");
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    (status, body)
}

fn make_op(replica: u64, counter: u64) -> OpEnvelope {
    let mut bytes = golden::golden_insert_op();
    bytes[2..10].copy_from_slice(&replica.to_le_bytes());
    bytes[10..18].copy_from_slice(&counter.to_le_bytes());
    validate_op(&bytes).expect("valid golden insert")
}

async fn ensure_user(repo: &GatewayRepo, clerk_id: &str) -> Uuid {
    let client = repo.db.get().await.expect("pool");
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

async fn seed_document(repo: &GatewayRepo, owner: Uuid) -> Uuid {
    let client = repo.db.get().await.expect("pool");
    let doc = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO documents (id, owner_user_id, title, initial_content)
             VALUES ($1, $2, 'proof-it', '')",
            &[&doc, &owner],
        )
        .await
        .expect("seed doc");
    doc
}

async fn seed_acl(repo: &GatewayRepo, document: Uuid, user: Uuid, role: &str) {
    let client = repo.db.get().await.expect("pool");
    client
        .execute(
            "INSERT INTO document_user_permissions (document_id, user_id, role)
             VALUES ($1, $2, $3::text::document_role)
             ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role",
            &[&document, &user, &role],
        )
        .await
        .expect("seed acl");
}

async fn cleanup(repo: &GatewayRepo, owner: UserId, document: Uuid) {
    let client = repo.db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM document_user_permissions WHERE document_id = '{document}';
             DELETE FROM crdt_operations WHERE document_id = '{document}';
             DELETE FROM crdt_replica_owners WHERE document_id = '{document}';
             DELETE FROM documents WHERE id = '{document}';
             DELETE FROM users WHERE id = '{}';",
            owner.0
        ))
        .await;
}

/// Independently re-derives the CLIENT verify rules from the response body.
fn verify_receipt_like_a_client(body: &Value) -> Result<(), String> {
    let receipt = body
        .get("receipt")
        .and_then(Value::as_object)
        .ok_or("receipt object missing")?;
    let get_str = |k: &str| -> Result<&str, String> {
        receipt
            .get(k)
            .and_then(Value::as_str)
            .ok_or(format!("{k} missing"))
    };
    let seq: u64 = get_str("seq")?.parse().map_err(|_| "seq not u64")?;
    let op_count: u64 = get_str("opCount")?.parse().map_err(|_| "opCount not u64")?;
    let issued_at_ms: u64 = get_str("issuedAtMs")?
        .parse()
        .map_err(|_| "issuedAtMs not u64")?;
    let root_hex = get_str("root")?;
    let state_digest = get_str("stateDigest")?;
    let key_id = get_str("keyId")?;
    let signature_b64 = get_str("signature")?;

    let root = hex::decode(root_hex).map_err(|_| "root not hex")?;
    let root: [u8; 32] = root.try_into().map_err(|_| "root not 32 bytes")?;

    // Signature = Ed25519 over the canonical message (base64std, padded).
    let signature = base64std_decode(signature_b64).ok_or("signature not base64")?;
    let signature: [u8; 64] = signature.try_into().map_err(|_| "signature not 64 bytes")?;
    let public_key_hex = body
        .get("publicKey")
        .and_then(Value::as_str)
        .ok_or("publicKey missing")?;
    let public_key: [u8; 32] = hex::decode(public_key_hex)
        .expect("publicKey hex")
        .try_into()
        .map_err(|_| "publicKey not 32 bytes")?;
    let document: Uuid = get_str("documentId")?
        .parse()
        .map_err(|_| "bad documentId")?;
    let message = receipt_message(
        document,
        seq,
        &root,
        state_digest,
        op_count,
        issued_at_ms,
        key_id,
    );
    let verifying = VerifyingKey::from_bytes(&public_key).map_err(|_| "bad verifying key")?;
    verifying
        .verify(&message, &Signature::from_bytes(&signature))
        .map_err(|e| format!("signature rejected: {e}"))?;

    // Merkle path: the advertised leaf replays to the advertised root.
    let leaf_hex = body
        .get("leaf")
        .and_then(Value::as_str)
        .ok_or("leaf missing")?;
    let leaf: [u8; 32] = hex::decode(leaf_hex)
        .expect("leaf hex")
        .try_into()
        .map_err(|_| "leaf not 32 bytes")?;
    let leaf_index: usize = body
        .get("leafIndex")
        .and_then(Value::as_str)
        .ok_or("leafIndex missing")?
        .parse()
        .map_err(|_| "leafIndex not usize")?;
    let proof: Vec<[u8; 32]> = body
        .get("proof")
        .and_then(Value::as_array)
        .ok_or("proof missing")?
        .iter()
        .map(|p| {
            let bytes = hex::decode(p.as_str().unwrap_or("")).expect("proof hex");
            <[u8; 32]>::try_from(bytes).expect("proof entry 32 bytes")
        })
        .collect();
    let replayed = replay_path(leaf, leaf_index, &proof).ok_or("path replay failed")?;
    if replayed != root {
        return Err("audit path does not reach the advertised root".into());
    }
    Ok(())
}

fn base64std_decode(input: &str) -> Option<Vec<u8>> {
    const REV: fn(u8) -> Option<u8> = |c| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let input: Vec<u8> = input.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for chunk in input.chunks(4) {
        if chunk.len() < 2 {
            return None;
        }
        let mut n: u32 = 0;
        for (i, c) in chunk.iter().enumerate() {
            n |= u32::from(REV(*c)?) << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn proof_verifies_end_to_end_and_rejects_tampering() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: concord_test DB or worker binary unavailable");
        return;
    };
    let clerk = format!("proof-owner-{}", Uuid::new_v4().simple());
    let owner = ensure_user(&server.repo, &clerk).await;
    let doc = seed_document(&server.repo, owner).await;

    // Ingest a handful of ops through the REAL repo path.
    let ops: Vec<OpEnvelope> = (1u64..=5).map(|c| make_op(4242, c)).collect();
    server
        .repo
        .ingest_batch(UserId(owner), doc, &ops)
        .await
        .expect("ingest");

    let (status, body) = get_proof(&server, &sign_token(&clerk), doc, None).await;
    assert_eq!(status, 200, "body: {body}");
    // `seq` is the ABSOLUTE server id (bigserial, shared id space — the same
    // value the catch-up cursor uses), not the op count.
    let expected_cursor = server.repo.durable_cursor(doc).await.expect("cursor");
    assert_eq!(
        body["seq"],
        expected_cursor.to_string(),
        "default seq = durable cursor"
    );
    assert_eq!(body["opCount"], "5");
    assert_eq!(
        body["leafIndex"], "4",
        "audit path anchors the LAST retained leaf"
    );

    // Client rules: audit path reaches the root; signature verifies.
    verify_receipt_like_a_client(&body).expect("receipt verifies like a client would");

    // The leaf for the LAST row is recomputable from the durable row itself.
    let client = server.repo.db.get().await.expect("pool");
    let row = client
        .query_one(
            "SELECT id, operation_id, payload FROM crdt_operations
             WHERE document_id = $1 ORDER BY id DESC LIMIT 1",
            &[&doc],
        )
        .await
        .expect("last op row");
    let seq: i64 = row.get("id");
    let op_id: String = row.get("operation_id");
    let payload: Vec<u8> = row.get("payload");
    let checksum = hex::encode(sha2::Sha256::digest(&payload));
    let expected_leaf = leaf_hash(seq as u64, &op_id, &checksum);
    assert_eq!(
        hex::decode(body["leaf"].as_str().expect("leaf")).expect("leaf hex"),
        expected_leaf.to_vec(),
        "leaf binds (seq, operation_id, payload checksum)"
    );
    // The root is over exactly these five leaves (client can recompute all).
    let rows = client
        .query(
            "SELECT id, operation_id, payload FROM crdt_operations
             WHERE document_id = $1 ORDER BY id ASC",
            &[&doc],
        )
        .await
        .expect("rows");
    let leaves: Vec<[u8; 32]> = rows
        .iter()
        .map(|r| {
            let checksum = hex::encode(sha2::Sha256::digest(r.get::<_, Vec<u8>>("payload")));
            leaf_hash(
                r.get::<_, i64>("id") as u64,
                &r.get::<_, String>("operation_id"),
                &checksum,
            )
        })
        .collect();
    assert_eq!(
        hex::decode(body["root"].as_str().expect("root")).expect("root hex"),
        merkle_root(&leaves).to_vec()
    );

    // Tampered signature: flip one bit -> the same canonical bytes fail.
    let mut receipt = body.clone();
    let mut sig = base64std_decode(receipt["receipt"]["signature"].as_str().expect("sig"))
        .expect("sig bytes");
    sig[0] ^= 0x01;
    receipt["receipt"]["signature"] = Value::String(base64std_encode(&sig));
    assert!(
        verify_receipt_like_a_client(&receipt).is_err(),
        "tampered sig must fail"
    );

    // Tampered leaf: the audit path no longer reaches the root.
    let mut forged = body.clone();
    let mut leaf = hex::decode(forged["leaf"].as_str().expect("leaf")).expect("leaf hex");
    leaf[0] ^= 0x01;
    let leaf_bytes: [u8; 32] = leaf.clone().try_into().expect("32");
    forged["leaf"] = Value::String(hex::encode(leaf));
    let proof: Vec<[u8; 32]> = forged["proof"]
        .as_array()
        .expect("proof array")
        .iter()
        .map(|p| {
            hex::decode(p.as_str().expect("hex"))
                .expect("bytes")
                .try_into()
                .expect("32")
        })
        .collect();
    let idx: usize = forged["leafIndex"]
        .as_str()
        .expect("idx")
        .parse()
        .expect("num");
    assert_ne!(
        replay_path(leaf_bytes, idx, &proof),
        Some(merkle_root(&leaves)),
        "forged leaf must not verify"
    );

    cleanup(&server.repo, UserId(owner), doc).await;
}

#[tokio::test]
async fn proof_authz_and_boundary_rules() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: concord_test DB or worker binary unavailable");
        return;
    };
    let owner_clerk = format!("proof-acl-owner-{}", Uuid::new_v4().simple());
    let viewer_clerk = format!("proof-acl-viewer-{}", Uuid::new_v4().simple());
    let outsider_clerk = format!("proof-acl-outsider-{}", Uuid::new_v4().simple());
    let owner = ensure_user(&server.repo, &owner_clerk).await;
    let viewer = ensure_user(&server.repo, &viewer_clerk).await;
    ensure_user(&server.repo, &outsider_clerk).await;
    let doc = seed_document(&server.repo, owner).await;
    seed_acl(&server.repo, doc, viewer, "VIEWER").await;

    // Viewer (read-only) CAN fetch a proof.
    let (status, body) = get_proof(&server, &sign_token(&viewer_clerk), doc, None).await;
    assert_eq!(status, 200, "viewer reads proofs: {body}");
    assert_eq!(body["opCount"], "0", "empty log");
    assert_eq!(
        body["root"],
        "0000000000000000000000000000000000000000000000000000000000000000"
    );
    verify_receipt_like_a_client(&body).expect("empty-log receipt still verifies");

    // Outsider: 404 (no-access/not-found equivalence, no existence leak).
    let (status, _) = get_proof(&server, &sign_token(&outsider_clerk), doc, None).await;
    assert_eq!(status, 404);
    // No token: 401.
    let (status, _) = get_proof(&server, "", doc, None).await;
    assert_eq!(status, 401);

    // Owner ingests; a bounded seq proves a prefix. Server ids are absolute,
    // so "state after the second op" = the second row's id read from the DB.
    let ops: Vec<OpEnvelope> = (1u64..=3).map(|c| make_op(4243, c)).collect();
    server
        .repo
        .ingest_batch(UserId(owner), doc, &ops)
        .await
        .expect("ingest");
    let second_id: i64 = {
        let client = server.repo.db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT id FROM crdt_operations WHERE document_id = $1 ORDER BY id ASC OFFSET 1 LIMIT 1",
                &[&doc],
            )
            .await
            .expect("second op row");
        row.get("id")
    };
    let (status, body) = get_proof(&server, &sign_token(&owner_clerk), doc, Some(second_id)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["seq"], second_id.to_string());
    assert_eq!(
        body["opCount"], "2",
        "seq proves the prefix, not the whole log"
    );

    // seq beyond the cursor is refused; seq 0 is an explicit empty-state proof.
    let cursor = server.repo.durable_cursor(doc).await.expect("cursor");
    let (status, _) = get_proof(&server, &sign_token(&owner_clerk), doc, Some(cursor + 1)).await;
    assert_eq!(status, 400);
    let (status, body0) = get_proof(&server, &sign_token(&owner_clerk), doc, Some(0)).await;
    assert_eq!(status, 200);
    assert_eq!(body0["opCount"], "0");
    verify_receipt_like_a_client(&body0).expect("empty-state receipt verifies");

    cleanup(&server.repo, UserId(owner), doc).await;
}

fn base64std_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}
