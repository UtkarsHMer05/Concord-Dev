//! Phase 5 security regression tests (SA-SEC5, P5-M045).
//!
//! Pins the two EXPLOITABLE findings from the adversarial audit of the
//! storage/recovery/restore surface (see
//! `.agent/subagents/phase-5/security-review.md`) — both FIXED; the
//! tests now assert the protected behavior:
//!
//! SEC5-1 (MEDIUM — fixed): `fetch_snapshot` (and the sync_request
//! resync path) is throttled by the `fetch` rate-limit scope
//! (30/min/connection by default). A spamming reader gets
//! `rate_limited` errors after the budget; a normal resync flow
//! (handful of fetches) is unaffected.
//!
//! SEC5-2 (MEDIUM — fixed): compaction `eligibility()` consults
//! `crdt_revisions` — pruning past a live revision's target boundary
//! is refused (`RetentionProtected`), and every batch re-checks
//! in-transaction (documents row lock) so a revision created
//! concurrently cannot be pruned under.
//!
//! Live DB required (docker compose db on :5433); tests skip cleanly
//! when unreachable.

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
use sync_gateway::ephemeral::ratelimit::{default_policies, RateLimitOutcome, RateLimiter};
use sync_gateway::http::{self, AppState};
use sync_gateway::maintenance::{prune_to_boundary, SnapshotPipeline};
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::golden;
use sync_gateway::sessions::SessionRegistry;
use sync_gateway::worker::WorkerPool;

const DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER: &str = "https://test.clerk.accounts.dev";
const KID: &str = "it-key-1";
const KEY1: &[u8] = include_bytes!("../src/auth/test_rsa_key.der");

// ---------------------------------------------------------------------------
// Harness (mirrors phase5_resync.rs)
// ---------------------------------------------------------------------------

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
        clerk_audience: None,
        clerk_authorized_party: None,
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

/// Reads frames until one of `typ` arrives (skips unrelated pushes).
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

/// Boot a real gateway (axum) on a free port; returns its address.
async fn boot_gateway(repo: Arc<GatewayRepo>) -> SocketAddr {
    let config = base_config();
    let registry = SessionRegistry::new();
    let verifier = Arc::new(TokenVerifier::new(
        ISSUER,
        VerifierSource::Static(StaticJwks(test_jwks())),
    ));
    let state = AppState {
        config: Arc::new(config),
        registry,
        repo,
        verifier,
        draining: Arc::new(AtomicBool::new(false)),
        bus: Arc::new(sync_gateway::bus::LocalOnlyPublisher),
        gateway_id: 1,
        rate_limiter: Arc::new(RateLimiter::new(None, default_policies())),
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
    addr
}

async fn fixture_document(db: &Db, tag: &str) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'sec5_{tag}_{org}', 'p5-sec5');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'sec5_{tag}_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-sec5-{tag}');"
        ))
        .await
        .expect("fixture");
    (UserId(owner), doc)
}

async fn cleanup(db: &Db, owner: UserId, doc: Uuid) {
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
             DELETE FROM maintenance_jobs WHERE document_id = '{doc}';
             DELETE FROM crdt_operations WHERE document_id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{}';",
            owner.0
        ))
        .await;
}

// ---------------------------------------------------------------------------
// SEC5-1: fetch_snapshot spam is unthrottled (rate-limit gap)
// ---------------------------------------------------------------------------

/// SEC5-1 regression: a single authenticated session spamming
/// `fetch_snapshot` is throttled by the `fetch` scope. The burst here
/// (120 frames) far exceeds the default budget (30/min/connection);
/// the first 30 must be served (a legitimate resync flow works) and
/// the rest must be refused with `rate_limited` — never a silent
/// serve-all (the original read-amplification primitive) and never a
/// drop (the client sees a typed error and backs off).
#[tokio::test]
async fn sec5_1_fetch_snapshot_spam_is_throttled() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture_document(&db, "spam").await;

    // Build a finalized snapshot so a fetch has something real to serve.
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);
    let payloads = ops_at(6, 100, 0xBEE1);
    let envelopes: Vec<_> = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect();
    let boundary = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;
    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(doc, boundary, Uuid::new_v4(), 1)
        .await
        .expect("build");
    assert!(snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));

    let addr = boot_gateway(Arc::new(repo)).await;
    let url = format!("ws://{addr}/api/v1/sync");
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect");

    // Handshake: hello → authenticate → join.
    send_text(
        &mut ws,
        r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#,
    )
    .await;
    expect_text(&mut ws, "hello_ack").await;
    let token = sign_token(&format!("sec5_spam_{}", owner.0));
    send_text(
        &mut ws,
        &format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{token}"}}}}"#),
    )
    .await;
    expect_text(&mut ws, "authenticated").await;
    send_text(
        &mut ws,
        &format!(
            r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#
        ),
    )
    .await;
    expect_text(&mut ws, "join_accepted").await;

    // Drain the initial catch-up noise so only OUR frames remain.
    let drain = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let msg = tokio::select! { m = ws.next() => m.expect("open") };
            match msg {
                Ok(WsMessage::Text(t)) => {
                    let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["type"] == "sync_done" {
                        return;
                    }
                }
                Ok(WsMessage::Close(_)) => panic!("closed during catch-up"),
                _ => {}
            }
        }
    });
    let _ = drain.await;

    // BURST: 120 fetches against the 30/min/connection budget. The
    // first 30 must be SERVED (legitimate resync flows work); every
    // one after must come back as a rate_limited error frame.
    const BURST: usize = 120;
    const EXPECTED_SERVED: usize = 30;
    let mut served = 0usize;
    let mut rate_limited = 0usize;
    let mut other_errors = 0usize;
    for _ in 0..BURST {
        send_text(
            &mut ws,
            &format!(r#"{{"v":1,"type":"fetch_snapshot","payload":{{"snapshotId":"{snap_id}"}}}}"#),
        )
        .await;
        // Read exactly one reply: the payload frame (served) or an
        // error frame (throttled).
        let msg = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let msg = tokio::select! { m = ws.next() => m.expect("open") };
                match msg {
                    Ok(WsMessage::Text(t)) => {
                        let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                        if v["type"] == "snapshot_payload" || v["type"] == "error" {
                            return v;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await
        .expect("reply deadline");
        if msg["type"] == "snapshot_payload" {
            served += 1;
            // SEC5-3: every served payload now declares its size.
            assert!(
                msg["payload"]["payloadSize"].is_string(),
                "snapshot_payload must carry payloadSize (SEC5-3)"
            );
        } else if msg["payload"]["code"] == "rate_limited" {
            rate_limited += 1;
        } else {
            other_errors += 1;
        }
    }

    eprintln!(
        "SEC5-1: served={served}, rate_limited={rate_limited}, other={other_errors} (burst {BURST})"
    );
    assert_eq!(
        served, EXPECTED_SERVED,
        "exactly the budgeted fetches are served (got {served}; other errors: {other_errors})"
    );
    assert!(
        rate_limited > 0,
        "the fetch burst beyond the budget must be rate-limited, not served"
    );
    assert_eq!(other_errors, 0, "no unexpected error frames");

    let _ = ws.send(WsMessage::Close(None)).await;
    cleanup(&db, owner, doc).await;
}

/// Companion structural assertion (no DB): the default policy set
/// carries the `fetch` scope covering snapshot fetches, and the
/// limiter enforces it (unmapped scopes stay fail-open by design —
/// but the fetch path is mapped).
#[tokio::test]
async fn sec5_1_fetch_scope_exists_and_limits() {
    let policies = default_policies();
    assert!(
        policies.contains_key(sync_gateway::ephemeral::ratelimit::SCOPE_SNAPSHOT_FETCH),
        "the fetch scope must exist in the default policies (SEC5-1)"
    );
    // The limiter, asked to check the fetch scope 10,000 times for one
    // principal, must transition to Limited exactly at the policy cap.
    let policy = policies
        .get(sync_gateway::ephemeral::ratelimit::SCOPE_SNAPSHOT_FETCH)
        .copied()
        .expect("fetch policy");
    let limiter = RateLimiter::new(None, default_policies());
    let mut allowed = 0usize;
    for _ in 0..10_000 {
        match limiter
            .check(
                sync_gateway::ephemeral::ratelimit::SCOPE_SNAPSHOT_FETCH,
                "user-spam-probe",
            )
            .await
        {
            RateLimitOutcome::Allowed => allowed += 1,
            RateLimitOutcome::Limited => break,
        }
    }
    assert_eq!(
        allowed, policy.max_events as usize,
        "the fetch budget must be exactly the configured cap"
    );
}

// ---------------------------------------------------------------------------
// SEC5-2: compaction eligibility ignores crdt_revisions (retention promise)
// ---------------------------------------------------------------------------

/// SEC5-2 regression: a revision pins its op basis against pruning.
/// With a named revision at target boundary 6 and a finalized snapshot
/// covering 12, pruning TO 12 (past the revision) is refused with
/// `RetentionProtected` — the revision's reconstruction basis (ops ≤ 6)
/// survives. The in-transaction re-check (documents row lock + revision
/// predicate per batch) closes the concurrent-creation race; the
/// eligibility rule (prune boundary ≤ MIN revision target) is
/// in-tree and asserted live here.
#[tokio::test]
async fn sec5_2_prune_refuses_past_live_revision() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc) = fixture_document(&db, "protect").await;

    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);

    // 12 ops; take a snapshot at the full boundary 12.
    let payloads = ops_at(12, 200, 0xBEE2);
    let envelopes: Vec<_> = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect();
    let boundary12 = repo
        .ingest_batch(owner, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor;

    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(doc, boundary12, Uuid::new_v4(), 1)
        .await
        .expect("build");
    assert!(snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));

    // A revision at boundary 6 (BELOW the only snapshot's coverage? no —
    // the snapshot covers ≤12, so latest_finalized_before(doc, 6) finds
    // it — reconstruction = S1 + replay (12..6] = empty tail ⇒ WRONG
    // digest for boundary 6, but that is a correctness bug, not this
    // one). The protection gap: a revision at target_seq 6 exists; prune
    // to 12 happily deletes ops ≤ 12 INCLUDING the ops (0..6] that the
    // revision's own reconstruction needed when it was created — and
    // `eligibility` never consults crdt_revisions.
    let client = db.get().await.expect("pool");
    let revision_id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO crdt_revisions (revision_id, document_id, target_seq, kind, label, created_by, snapshot_id)
             VALUES ($1, $2, 6, 'named', 'v6 checkpoint', $3, NULL)",
            &[&revision_id, &doc, &(owner.0)],
        )
        .await
        .expect("revision");

    // Prune to 12: MUST be refused by RetentionProtected (a revision at
    // boundary 6 would lose its op basis ≤ 6). SEC5-2 FIX VERIFIED:
    // eligibility now consults crdt_revisions — pruning may not advance
    // above the lowest revision target.
    let result = prune_to_boundary(&db, &snapshots, doc, boundary12, 100).await;
    match result {
        Err(sync_gateway::maintenance::CompactionError::RetentionProtected { .. }) => {
            // The protected behavior: the revision's op basis survives.
            let ops = repo.catchup_page(doc, 0, 100).await.expect("page intact");
            assert!(
                !ops.ops.is_empty(),
                "revision's op basis must survive the refused prune"
            );
        }
        Ok(_) => panic!("SEC5-2 REGRESSION: prune succeeded past a live revision"),
        Err(other) => panic!("unexpected error: {other:?}"),
    }

    // And pruning AT the revision boundary is allowed (the revision's
    // basis ≤ 6 stays intact above... boundary6 ≤ min_target ⇒ allowed;
    // it prunes only the covered prefix ≤ 6).
    // (Covered by the history suite's pruning-survival test.)

    cleanup(&db, owner, doc).await;
}

// ---------------------------------------------------------------------------
// Clean-area confirmation (not a finding — pins the pass)
// ---------------------------------------------------------------------------

/// Sanity companion: the cross-tenant fetch refusal is enforced with a
/// uniform forbidden error (ws/mod.rs handle_fetch_snapshot). A snapshot
/// from ANOTHER document (even one the same user owns) must not be served
/// through a session joined to a different document, and the error is
/// indistinguishable from not-found. This is the audited-clean behavior;
/// the test guards it against regressions.
#[tokio::test]
async fn sec5_clean_cross_document_fetch_refused_uniformly() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let (owner, doc_a) = fixture_document(&db, "xdoc_a").await;
    // doc_b owned by the SAME user (worst case: ownership of the target
    // document still must not bypass the session's document association).
    let doc_b = Uuid::new_v4();
    {
        let client = db.get().await.expect("pool");
        client
            .execute(
                "INSERT INTO documents (id, owner_user_id, title) VALUES ($1, $2, 'p5-sec5-xdoc_b')",
                &[&doc_b, &(owner.0)],
            )
            .await
            .expect("fixture doc_b");
    }

    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers);

    // Finalized snapshot on doc_b owned by the SAME principal (worst
    // case: not even ownership bypasses the association check).
    let payloads = ops_at(4, 300, 0xBEE3);
    let envelopes: Vec<_> = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid"))
        .collect();
    let boundary_b = repo
        .ingest_batch(owner, doc_b, &envelopes)
        .await
        .expect("ingest b")
        .durable_cursor;
    let (snap_b, _d, _v) = pipeline
        .build_at_boundary(doc_b, boundary_b, Uuid::new_v4(), 1)
        .await
        .expect("build b");
    assert!(snapshots
        .transition_building_to_verifying(snap_b)
        .await
        .expect("transition b"));
    let _ = pipeline.verify(doc_b, snap_b).await.expect("verify b");
    assert!(pipeline.finalize(snap_b, None).await.expect("finalize b"));

    let addr = boot_gateway(Arc::new(repo)).await;
    let url = format!("ws://{addr}/api/v1/sync");
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("connect");
    send_text(
        &mut ws,
        r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#,
    )
    .await;
    expect_text(&mut ws, "hello_ack").await;
    let token = sign_token(&format!("sec5_xdoc_a_{}", owner.0));
    send_text(
        &mut ws,
        &format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{token}"}}}}"#),
    )
    .await;
    expect_text(&mut ws, "authenticated").await;
    // Join doc_a only.
    send_text(
        &mut ws,
        &format!(
            r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc_a}","stateSummary":[]}}}}"#
        ),
    )
    .await;
    expect_text(&mut ws, "join_accepted").await;

    // Fetch doc_b's snapshot through the doc_a session: MUST be refused,
    // code=forbidden, message identical to the not-found case.
    send_text(
        &mut ws,
        &format!(r#"{{"v":1,"type":"fetch_snapshot","payload":{{"snapshotId":"{snap_b}"}}}}"#),
    )
    .await;
    let err = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let msg = tokio::select! { m = ws.next() => m.expect("open") };
            match msg {
                Ok(WsMessage::Text(t)) => {
                    let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["type"] == "error" {
                        return v["payload"].clone();
                    }
                }
                _ => continue,
            }
        }
    })
    .await
    .expect("error frame deadline");
    assert_eq!(err["code"], "forbidden", "cross-document fetch must refuse");
    assert_eq!(
        err["message"], "snapshot unavailable",
        "message must be uniform with not-found (no existence oracle)"
    );

    // And a random uuid (no such snapshot) gets the SAME code+message —
    // the non-reader cannot distinguish existence.
    send_text(
        &mut ws,
        &format!(
            r#"{{"v":1,"type":"fetch_snapshot","payload":{{"snapshotId":"{}"}}}}"#,
            Uuid::new_v4()
        ),
    )
    .await;
    let err2 = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let msg = tokio::select! { m = ws.next() => m.expect("open") };
            match msg {
                Ok(WsMessage::Text(t)) => {
                    let v: serde_json::Value = serde_json::from_str(t.as_str()).unwrap();
                    if v["type"] == "error" {
                        return v["payload"].clone();
                    }
                }
                _ => continue,
            }
        }
    })
    .await
    .expect("error frame deadline 2");
    assert_eq!(err2["code"], "forbidden");
    assert_eq!(err2["message"], "snapshot unavailable");

    let _ = ws.send(WsMessage::Close(None)).await;
    cleanup(&db, owner, doc_a).await;
    cleanup(&db, owner, doc_b).await;
}
