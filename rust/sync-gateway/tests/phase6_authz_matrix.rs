//! P6-M021 — comprehensive authorization + IDOR matrix (SA-AUTH6).
//!
//! Systematic roles × surfaces matrix through the REAL gateway (same
//! boot() harness as ws_integration.rs: axum router + static test JWKS,
//! driven over real sockets). Every cell asserts the documented
//! ALLOW/DENY outcome, and denials assert the exact error shape so a
//! nonexistent document and a no-access document are indistinguishable
//! (T12: no existence oracle).
//!
//! Surfaces: join_document, client_ops write (per-batch recheck),  fetch
//! snapshot, and guessed/foreign document ids. Mid-session revocation
//! and downgrade cells live here too (T4/T9/T10/T12/T13 rows of
//! docs/SECURITY.md §8); the multi-gateway-process revocation matrix is
//! phase6_revocation.rs (M022).
//!
//! SERIALIZED: cargo test --test phase6_authz_matrix -- --test-threads=1
//! (shared concord_test DB). Skips cleanly when the DB is down.

use std::collections::HashMap;
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
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::http::{self, AppState};
use sync_gateway::sessions::SessionRegistry;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER: &str = "https://test.clerk.accounts.dev";
const KID: &str = "it-key-1";
const KEY1: &[u8] = include_bytes!("../src/auth/test_rsa_key.der");

// ---------------------------------------------------------------------------
// Harness (mirrors ws_integration.rs; kept local so this suite is
// self-contained — it is the P6-M021 deliverable).
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
            s.push(CHARS[((((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize) & 0x3f] as char);
            if chunk.len() > 1 {
                s.push(CHARS[((((b[1] & 0x0f) << 2) | (b[2] >> 6)) as usize) & 0x3f] as char);
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

fn base_config() -> Config {
    Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_DB_URL.into(),
        clerk_issuer: ISSUER.into(),
        allowed_origins: vec![],
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 8,
        heartbeat_interval: Duration::from_secs(10),
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

struct TestServer {
    addr: SocketAddr,
    repo: Arc<GatewayRepo>,
    _registry: Arc<SessionRegistry>,
}

async fn boot() -> Option<TestServer> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();
    let config = base_config();
    let db = match Db::connect(&config).await {
        Ok(db) => db,
        Err(_) => return None,
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

async fn next_control(ws: &mut Ws) -> serde_json::Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("frame within timeout")
            .expect("stream open")
            .expect("frame ok");
        match msg {
            WsMessage::Text(t) => return serde_json::from_str(t.as_str()).expect("json"),
            WsMessage::Binary(_) => continue,
            WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
            WsMessage::Close(_) => panic!("unexpected close"),
            _ => continue,
        }
    }
}

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

async fn handshake(ws: &mut Ws, clerk_id: &str) {
    send_text(
        ws,
        r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#,
    )
    .await;
    assert_eq!(next_control(ws).await["type"], "hello_ack");
    send_text(
        ws,
        &format!(
            r#"{{"v":1,"type":"authenticate","payload":{{"token":"{}"}}}}"#,
            sign_token(clerk_id)
        ),
    )
    .await;
    let auth = next_control(ws).await;
    assert_eq!(auth["type"], "authenticated", "auth ok: {auth}");
}

/// Join and return (join frame | error frame) — the cell's outcome.
async fn try_join(ws: &mut Ws, document: &str) -> serde_json::Value {
    send_text(
        ws,
        &format!(
            r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{document}","stateSummary":[]}}}}"#
        ),
    )
    .await;
    next_control(ws).await
}

/// Drive join to READY (join_accepted + sync_done) — panics on denial.
async fn join_ready(ws: &mut Ws, document: &str) -> serde_json::Value {
    let joined = try_join(ws, document).await;
    assert_eq!(
        joined["type"], "join_accepted",
        "expected join to be allowed, got: {joined}"
    );
    // Empty history → no binary batch: sync_done directly.
    let done = next_control(ws).await;
    assert_eq!(done["type"], "sync_done", "catch-up completes");
    joined
}

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

// ---------------------------------------------------------------------------
// Fixture: the full role × document world.
// ---------------------------------------------------------------------------

/// The seeded world: two organizations, one owner with a personal doc and
/// an org doc, direct-ACL grants of every role, an org member of another
/// org, a no-access user, and an other-tenant user.
struct World {
    /// clerk ids by role name (for signing tokens).
    clerks: HashMap<&'static str, String>,
    docs: HashMap<&'static str, Uuid>,
}

impl World {
    fn clerk(&self, role: &'static str) -> &str {
        self.clerks
            .get(role)
            .unwrap_or_else(|| panic!("no clerk for {role}"))
    }
    fn doc(&self, name: &'static str) -> Uuid {
        *self
            .docs
            .get(name)
            .unwrap_or_else(|| panic!("no doc for {name}"))
    }
}

const SUFFIX: &str = "p6a";

async fn seed_world(repo: &GatewayRepo) -> World {
    let client = repo.db.get().await.expect("pool");
    let run = Uuid::new_v4().simple().to_string();

    // Users: owner, direct-ACL editor/commenter/viewer, org member of
    // OTHER_ORG (foreign tenant), a member of the doc's org, and a
    // no-access stranger. clerk ids are unique per run.
    let mut clerks: HashMap<&'static str, String> = HashMap::new();
    let mut ids: HashMap<&'static str, Uuid> = HashMap::new();
    for role in [
        "owner",
        "acl_editor",
        "acl_commenter",
        "acl_viewer",
        "org_member",
        "foreign_org_member",
        "stranger",
    ] {
        let clerk = format!("{SUFFIX}-{role}-{run}");
        let id: Uuid = client
            .query_one(
                "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
                &[&clerk],
            )
            .await
            .expect("seed user")
            .get("id");
        clerks.insert(role, clerk);
        ids.insert(role, id);
    }

    // Two organizations (the doc's org + a foreign one).
    let doc_org: Uuid = client
        .query_one(
            "INSERT INTO organizations (clerk_organization_id, name)
             VALUES ($1, 'p6a org') RETURNING id",
            &[&format!("org-doc-{run}")],
        )
        .await
        .expect("seed org")
        .get("id");
    let foreign_org: Uuid = client
        .query_one(
            "INSERT INTO organizations (clerk_organization_id, name)
             VALUES ($1, 'p6a foreign org') RETURNING id",
            &[&format!("org-foreign-{run}")],
        )
        .await
        .expect("seed foreign org")
        .get("id");

    // Memberships: org_member belongs to the DOC's org (so the ORG doc
    // resolves them EDITOR); foreign_org_member belongs to the FOREIGN org
    // only (other-tenant for the org doc; no relationship with any doc).
    client
        .execute(
            "INSERT INTO organization_memberships (organization_id, user_id, role)
             VALUES ($1, $2, 'member')",
            &[&doc_org, ids.get("org_member").expect("org_member")],
        )
        .await
        .expect("seed membership");
    client
        .execute(
            "INSERT INTO organization_memberships (organization_id, user_id, role)
             VALUES ($1, $2, 'member')",
            &[
                &foreign_org,
                ids.get("foreign_org_member").expect("foreign_org_member"),
            ],
        )
        .await
        .expect("seed foreign membership");

    // Documents: one PERSONAL (owner, no org), one ORG-SCOPED (owner,
    // doc_org). Plus a second-org personal doc owned by the foreign
    // member (other-tenant resource).
    let personal: Uuid = client
        .query_one(
            "INSERT INTO documents (owner_user_id, title, initial_content)
             VALUES ($1, 'p6a personal', '') RETURNING id",
            &[ids.get("owner").expect("owner")],
        )
        .await
        .expect("seed personal doc")
        .get("id");
    let org_doc: Uuid = client
        .query_one(
            "INSERT INTO documents (owner_user_id, organization_id, title, initial_content)
             VALUES ($1, $2, 'p6a org doc', '') RETURNING id",
            &[ids.get("owner").expect("owner"), &doc_org],
        )
        .await
        .expect("seed org doc")
        .get("id");
    let foreign_doc: Uuid = client
        .query_one(
            "INSERT INTO documents (owner_user_id, title, initial_content)
             VALUES ($1, 'p6a foreign doc', '') RETURNING id",
            &[ids.get("foreign_org_member").expect("foreign_org_member")],
        )
        .await
        .expect("seed foreign-owned doc")
        .get("id");

    // Direct ACL grants on the PERSONAL doc (the primary matrix target —
    // no org path can confuse the cells).
    for (role_name, acl_role) in [
        ("acl_editor", "EDITOR"),
        ("acl_commenter", "COMMENTER"),
        ("acl_viewer", "VIEWER"),
    ] {
        client
            .execute(
                "INSERT INTO document_user_permissions (document_id, user_id, role)
                 VALUES ($1, $2, $3::text::document_role)",
                &[&personal, ids.get(role_name).expect("grantee"), &acl_role],
            )
            .await
            .expect("seed acl row");
    }

    let mut docs: HashMap<&'static str, Uuid> = HashMap::new();
    docs.insert("personal", personal);
    docs.insert("org_doc", org_doc);
    docs.insert("foreign_doc", foreign_doc);
    World { clerks, docs }
}

/// Per-role principals probed in every matrix: (label, clerk role key).
/// org_member is deliberately probed against the PERSONAL doc (no access —
/// personal docs have no org path) and separately against the ORG doc
/// (EDITOR via membership).
const MATRIX_ROLES: &[&str] = &[
    "owner",
    "acl_editor",
    "acl_commenter",
    "acl_viewer",
    "org_member",
    "stranger",
    "foreign_org_member",
];

async fn op_count(repo: &GatewayRepo, doc: Uuid) -> i64 {
    let client = repo.db.get().await.expect("pool");
    client
        .query_one(
            "SELECT COUNT(*)::bigint AS n FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n")
}

/// -----------------------------------------------------------------------
/// Matrix surface 1+2: join_document + client_ops per role.
/// Expected join: OWNER→ALLOW(role owner), EDITOR→ALLOW(editor),
/// COMMENTER→ALLOW(commenter), VIEWER→ALLOW(viewer), everyone else DENY
/// (forbidden). Expected write: OWNER/EDITOR ALLOW (durable_ack);
/// COMMENTER/VIEWER DENY (forbidden "write denied"); deny-join roles
/// never even reach the write path.
/// -----------------------------------------------------------------------
#[tokio::test]
async fn matrix_join_and_write_per_role() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let world = seed_world(&server.repo).await;
    let doc = world.doc("personal").to_string();

    let allowed_join: HashMap<&str, &str> = [
        ("owner", "owner"),
        ("acl_editor", "editor"),
        ("acl_commenter", "commenter"),
        ("acl_viewer", "viewer"),
    ]
    .into_iter()
    .collect();

    for (i, role) in MATRIX_ROLES.iter().enumerate() {
        let role = *role;
        // The write probe runs over a fresh connection for each role so
        // denial cells (which may close the socket) cannot poison later
        // cells.
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk(role)).await;

        let joined = try_join(&mut ws, &doc).await;
        match allowed_join.get(role) {
            Some(expected_role) => {
                assert_eq!(
                    joined["type"], "join_accepted",
                    "{role}: join must be ALLOWED, got {joined}"
                );
                assert_eq!(
                    joined["payload"]["role"], *expected_role,
                    "{role}: effective role on the wire"
                );
                // Empty history: sync_done directly (no binary batch).
                assert_eq!(
                    next_control(&mut ws).await["type"],
                    "sync_done",
                    "{role}: catch-up completes"
                );
            }
            None => {
                assert_eq!(
                    joined["payload"]["code"], "forbidden",
                    "{role}: join must be DENIED with forbidden, got {joined}"
                );
                assert_eq!(
                    joined["payload"]["message"], "no access to document",
                    "{role}: uniform denial message (no existence leak)"
                );
                continue; // no session → write path unreachable
            }
        }

        // client_ops write (per-batch in-transaction recheck). Each role
        // uses a DISTINCT replica id: the CRDT identity (replica:counter)
        // is globally unique per writer — sharing it would collide with
        // an earlier role's op and dedup to 0 new rows.
        let ops = vec![make_op_bytes(0x0A11 + i as u64, 1)];
        send_binary(&mut ws, client_ops_frame(1, &ops)).await;
        let after = next_control(&mut ws).await;
        let can_edit = matches!(joined["payload"]["role"].as_str(), Some("owner" | "editor"));
        if can_edit {
            assert_eq!(
                after["type"], "durable_ack",
                "{role}: write must be ALLOWED, got {after}"
            );
        } else {
            assert_eq!(
                after["payload"]["code"], "forbidden",
                "{role}: write must be DENIED, got {after}"
            );
            assert_eq!(
                after["payload"]["message"], "write denied",
                "{role}: write-denied message shape"
            );
        }
    }

    // Durable outcome: exactly 2 ops (owner + acl_editor), none from
    // COMMENTER/VIEWER/no-access principals.
    assert_eq!(op_count(&server.repo, world.doc("personal")).await, 2);
}

/// org_member (of the doc's org) on the ORG doc: join EDITOR, write ALLOW
/// (org-derived EDITOR); the same user on the PERSONAL doc: DENY.
/// foreign_org_member on the org doc: DENY (other tenant).
#[tokio::test]
async fn matrix_org_scoped_and_cross_tenant_documents() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let world = seed_world(&server.repo).await;

    // org member + org doc → EDITOR, write ALLOW.
    {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk("org_member")).await;
        let joined = join_ready(&mut ws, &world.doc("org_doc").to_string()).await;
        assert_eq!(joined["payload"]["role"], "editor", "org-derived EDITOR");
        send_binary(&mut ws, client_ops_frame(1, &[make_op_bytes(0x0B11, 1)])).await;
        assert_eq!(
            next_control(&mut ws).await["type"],
            "durable_ack",
            "org-member EDITOR write ALLOW"
        );
    }

    // Same user, PERSONAL doc (no org path) → DENY (forbidden).
    {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk("org_member")).await;
        let err = try_join(&mut ws, &world.doc("personal").to_string()).await;
        assert_eq!(
            err["payload"]["code"], "forbidden",
            "org member has NO access to a personal doc (deny by default): {err}"
        );
    }

    // Other-tenant member on the org doc → DENY.
    {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk("foreign_org_member")).await;
        let err = try_join(&mut ws, &world.doc("org_doc").to_string()).await;
        assert_eq!(
            err["payload"]["code"], "forbidden",
            "cross-tenant join denied: {err}"
        );
    }

    // Other-tenant member on the foreign-owned PERSONAL doc they do not
    // own (they are only a member of its owner's org — org membership
    // grants nothing on personal docs) → DENY.
    {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk("org_member")).await;
        let err = try_join(&mut ws, &world.doc("foreign_doc").to_string()).await;
        assert_eq!(
            err["payload"]["code"], "forbidden",
            "personal doc of another user is inaccessible: {err}"
        );
    }
}

/// Matrix surfaces 3+4: sync_request catch-up (read of history) and
/// fetch_snapshot (snapshot read) per role — read capabilities are held
/// by every joined role, while no-access principals never reach the
/// surfaces (deny at join). A FINALIZED snapshot is seeded via the real
/// SnapshotRepo lifecycle for the fetch probes.
#[tokio::test]
async fn matrix_catchup_and_fetch_snapshot_per_role() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let world = seed_world(&server.repo).await;
    let doc = world.doc("personal");
    let doc_str = doc.to_string();

    // Owner writes history (3 ops).
    {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk("owner")).await;
        join_ready(&mut ws, &doc_str).await;
        let ops: Vec<Vec<u8>> = (1..=3).map(|c| make_op_bytes(0x0C11, c)).collect();
        send_binary(&mut ws, client_ops_frame(1, &ops)).await;
        assert_eq!(next_control(&mut ws).await["type"], "durable_ack");
    }

    // Seed one FINALIZED snapshot via the real repo lifecycle
    // (create_attempt building → verifying → finalize).
    let snapshot_id = {
        let repo = SnapshotRepo::new(server.repo.db.clone());
        let wrapper = sync_gateway::db::snapshots::wrapper::encode_wrapper(
            doc,
            3,
            3,
            b"p6a inner snapshot bytes",
        );
        let digest = format!(
            "sha256:{}",
            hex::encode(sync_gateway::db::snapshots::wrapper::encode_wrapper(
                doc,
                3,
                3,
                b"p6a inner snapshot bytes"
            ))
        );
        let job_id = Uuid::new_v4();
        let attempt = repo
            .create_attempt(doc, 3, 3, job_id, 1, &digest, "{}", &wrapper)
            .await
            .expect("create snapshot attempt");
        assert!(repo
            .transition_building_to_verifying(attempt.snapshot_id)
            .await
            .expect("verify transition"));
        assert!(
            repo.finalize(attempt.snapshot_id, None)
                .await
                .expect("finalize"),
            "snapshot must reach FINALIZED"
        );
        attempt.snapshot_id
    };

    // Read-capable roles: each can catch-up AND fetch the snapshot.
    for role in ["owner", "acl_editor", "acl_commenter", "acl_viewer"] {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk(role)).await;
        join_ready(&mut ws, &doc_str).await;

        // Surface 3: sync_request catch-up — history is served.
        send_text(
            &mut ws,
            r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#,
        )
        .await;
        let mut got = 0usize;
        loop {
            let bytes = next_binary(&mut ws).await;
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
            next_control(&mut ws).await["type"],
            "sync_done",
            "{role}: catch-up completes"
        );
        assert_eq!(got, 3, "{role}: full history readable (read = all roles)");

        // Surface 4: fetch_snapshot — payload served to every read role.
        send_text(
            &mut ws,
            &format!(
                r#"{{"v":1,"type":"fetch_snapshot","payload":{{"snapshotId":"{snapshot_id}"}}}}"#
            ),
        )
        .await;
        let payload = next_control(&mut ws).await;
        assert_eq!(
            payload["type"], "snapshot_payload",
            "{role}: fetch_snapshot must be ALLOWED, got {payload}"
        );
    }

    // No-access principals never reach the surfaces: join denial is the
    // same frame regardless of what they intend to do next.
    for role in ["stranger", "org_member", "foreign_org_member"] {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk(role)).await;
        let err = try_join(&mut ws, &doc_str).await;
        assert_eq!(
            err["payload"]["code"], "forbidden",
            "{role}: no session, no surface"
        );
        // And a sync_request in the un-joined state is invalid_state,
        // never data: no history oracle.
        send_text(
            &mut ws,
            r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#,
        )
        .await;
        let err = next_control(&mut ws).await;
        assert_eq!(
            err["payload"]["code"], "invalid_state",
            "{role}: sync before join is invalid_state, not data: {err}"
        );
    }
}

/// Surface 4 hard cases: cross-tenant snapshot fetch + guessed snapshot
/// ids + non-FINALIZED snapshots — every refusal is the SAME
/// `forbidden`/`unavailable` shape (T12/T25: no existence oracle).
#[tokio::test]
async fn matrix_fetch_snapshot_cross_tenant_and_guessed_ids() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let world = seed_world(&server.repo).await;
    let doc = world.doc("personal");
    let doc_str = doc.to_string();

    // Two FINALIZED snapshots: one for OUR doc, one for a FOREIGN doc
    // (owned by the foreign tenant user).
    let foreign_doc = world.doc("foreign_doc");
    let repo = SnapshotRepo::new(server.repo.db.clone());
    let mut ids: HashMap<&str, Uuid> = HashMap::new();
    for (name, target_doc) in [("ours", doc), ("foreign", foreign_doc)] {
        let wrapper =
            sync_gateway::db::snapshots::wrapper::encode_wrapper(target_doc, 0, 0, b"p6a");
        let digest = format!("sha256:{}", hex::encode(&wrapper));
        let attempt = repo
            .create_attempt(target_doc, 0, 0, Uuid::new_v4(), 1, &digest, "{}", &wrapper)
            .await
            .expect("attempt");
        assert!(repo
            .transition_building_to_verifying(attempt.snapshot_id)
            .await
            .unwrap());
        assert!(repo.finalize(attempt.snapshot_id, None).await.unwrap());
        ids.insert(name, attempt.snapshot_id);
    }
    let our_snapshot = *ids.get("ours").expect("ours");
    let foreign_snapshot = *ids.get("foreign").expect("foreign");

    let fetch = |id: &str| {
        format!(r#"{{"v":1,"type":"fetch_snapshot","payload":{{"snapshotId":"{id}"}}}}"#)
    };

    // A joined EDITOR (acl_editor has read) tries ids that are NOT
    // associated with the joined document:
    let mut ws = connect(&server).await;
    handshake(&mut ws, world.clerk("acl_editor")).await;
    join_ready(&mut ws, &doc_str).await;

    // (a) a REAL snapshot belonging to ANOTHER tenant's document —
    //     document association refuses; same shape as everything below.
    send_text(&mut ws, &fetch(&foreign_snapshot.to_string())).await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "forbidden", "cross-tenant: {err}");
    assert_eq!(
        err["payload"]["message"], "snapshot unavailable",
        "uniform unavailable message (no existence leak)"
    );

    // (b) a RANDOM (guessed, nonexistent) snapshot uuid.
    send_text(&mut ws, &fetch(&Uuid::new_v4().to_string())).await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "forbidden", "guessed id: {err}");
    assert_eq!(
        err["payload"]["message"], "snapshot unavailable",
        "guessed == foreign == real-but-inaccessible: ONE shape"
    );

    // (c) malformed (non-uuid) snapshot id.
    send_text(&mut ws, &fetch("'; DROP TABLE crdt_snapshots; --")).await;
    let err = next_control(&mut ws).await;
    assert_eq!(
        err["payload"]["code"], "malformed_frame",
        "SQLi-shaped snapshot id: rejected as malformed, not executed: {err}"
    );

    // (d) control: our own associated snapshot still serves.
    send_text(&mut ws, &fetch(&our_snapshot.to_string())).await;
    assert_eq!(
        next_control(&mut ws).await["type"],
        "snapshot_payload",
        "associated snapshot still serves after refusals"
    );

    // A no-access user joins... they cannot even join, so fetch is
    // unreachable — but the pre-join fetch attempt must be invalid_state
    // with the SAME shape regardless of which snapshot id they guess.
    let mut ws = connect(&server).await;
    handshake(&mut ws, world.clerk("stranger")).await;
    send_text(&mut ws, &fetch(&our_snapshot.to_string())).await;
    let err = next_control(&mut ws).await;
    assert_eq!(
        err["payload"]["code"], "invalid_state",
        "fetch before join: uniform invalid_state (stranger): {err}"
    );
}

/// Surface 5: guessed document ids at JOIN — no-access-existent,
/// nonexistent, other-org — all produce the IDENTICAL error frame (code,
/// message): there is no existence oracle (T12).
#[tokio::test]
async fn matrix_guessed_document_ids_indistinguishable() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let world = seed_world(&server.repo).await;

    let mut ws = connect(&server).await;
    handshake(&mut ws, world.clerk("stranger")).await;

    // Three deny cases: existing-no-access (personal), nonexistent
    // (random uuid), foreign-tenant document. All must produce the same
    // code + message.
    let cases = [
        world.doc("personal").to_string(),    // exists, no access
        world.doc("foreign_doc").to_string(), // exists, other tenant
        Uuid::new_v4().to_string(),           // does not exist
    ];
    let mut shapes: Vec<(String, String)> = Vec::new();
    for doc in &cases {
        let err = try_join(&mut ws, doc).await;
        assert_eq!(err["type"], "error", "join denied: {err}");
        shapes.push((
            err["payload"]["code"].as_str().unwrap_or("").to_owned(),
            err["payload"]["message"].as_str().unwrap_or("").to_owned(),
        ));
    }
    let first = &shapes[0];
    for (i, shape) in shapes.iter().enumerate() {
        assert_eq!(
            shape, first,
            "case {i}: guessed-id join must be INDISTINGUISHABLE (no existence oracle): {shapes:?}"
        );
        assert_eq!(shape.0, "forbidden");
    }

    // Non-uuid document id: malformed_frame (a shape error, not a
    // forbidden — but it reveals nothing about any document).
    send_text(
        &mut ws,
        r#"{"v":1,"type":"join_document","payload":{"documentId":"not-a-uuid","stateSummary":[]}}"#,
    )
    .await;
    let err = next_control(&mut ws).await;
    assert_eq!(err["payload"]["code"], "malformed_frame", "{err}");
}

/// The CRITICAL revocation cases at the WS protocol boundary (single
/// in-process gateway; the multi-gateway-process matrix is M022):
/// a grant revoked between join and write denies the NEXT batch while
/// the session stays alive for reads; an EDITOR downgraded to VIEWER
/// mid-session is denied on the next write the same way.
#[tokio::test]
async fn matrix_revoke_and_downgrade_between_join_and_write() {
    let Some(server) = boot().await else {
        eprintln!("SKIP: db down");
        return;
    };
    let world = seed_world(&server.repo).await;
    let doc = world.doc("personal");
    let doc_str = doc.to_string();

    // --- REVOCATION: acl_editor joins (allowed), writes once (allowed),
    // the ACL row is deleted, the NEXT write is denied while the socket
    // stays usable for reads.
    {
        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk("acl_editor")).await;
        join_ready(&mut ws, &doc_str).await;
        send_binary(&mut ws, client_ops_frame(1, &[make_op_bytes(0x0D11, 1)])).await;
        assert_eq!(
            next_control(&mut ws).await["type"],
            "durable_ack",
            "pre-revocation write allowed"
        );

        // Revoke the grant via SQL (owner-side action simulated directly).
        revoke_grant(&server.repo, doc, world.clerk("acl_editor")).await;

        send_binary(&mut ws, client_ops_frame(2, &[make_op_bytes(0x0D11, 2)])).await;
        let denied = next_control(&mut ws).await;
        assert_eq!(
            denied["payload"]["code"], "forbidden",
            "post-revocation write denied: {denied}"
        );
        assert_eq!(denied["payload"]["message"], "write denied");

        // The session stays alive for READS (non-fatal denial): a
        // sync_request catch-up still serves history over the SAME socket.
        send_text(
            &mut ws,
            r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#,
        )
        .await;
        let mut got = 0usize;
        loop {
            let bytes = next_binary(&mut ws).await;
            if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                got += f.ops.len();
                if !f.has_more {
                    break;
                }
            }
        }
        assert_eq!(next_control(&mut ws).await["type"], "sync_done");
        assert_eq!(
            got, 1,
            "history readable after write denial (session alive)"
        );
    }

    // --- DOWNGRADE: the same user's grant is restored as EDITOR, they
    // join and write (allowed), the role is changed to VIEWER mid-session,
    // and the NEXT write is denied without a reconnect. A fresh session
    // afterwards re-resolves VIEWER.
    {
        // Re-grant as EDITOR (owner-side upsert simulated directly).
        let client = server.repo.db.get().await.expect("pool");
        client
            .execute(
                "INSERT INTO document_user_permissions (document_id, user_id, role)
                 VALUES ($1, (SELECT id FROM users WHERE clerk_user_id = $2),
                         'EDITOR'::text::document_role)",
                &[&doc, &world.clerk("acl_editor")],
            )
            .await
            .expect("re-grant EDITOR");

        let mut ws = connect(&server).await;
        handshake(&mut ws, world.clerk("acl_editor")).await;
        let joined = try_join(&mut ws, &doc_str).await;
        assert_eq!(
            joined["payload"]["role"], "editor",
            "re-grant resolves EDITOR"
        );
        assert_eq!(next_control(&mut ws).await["type"], "sync_done");
        send_binary(&mut ws, client_ops_frame(4, &[make_op_bytes(0x0D11, 3)])).await;
        assert_eq!(
            next_control(&mut ws).await["type"],
            "durable_ack",
            "post-re-grant write allowed"
        );

        // Downgrade EDITOR → VIEWER mid-session.
        client
            .execute(
                "UPDATE document_user_permissions SET role = 'VIEWER'::text::document_role
                 WHERE document_id = $1
                   AND user_id = (SELECT id FROM users WHERE clerk_user_id = $2)",
                &[&doc, &world.clerk("acl_editor")],
            )
            .await
            .expect("downgrade to VIEWER");

        // Same socket, next batch: denied (per-batch recheck sees VIEWER).
        send_binary(&mut ws, client_ops_frame(5, &[make_op_bytes(0x0D11, 4)])).await;
        let denied = next_control(&mut ws).await;
        assert_eq!(
            denied["payload"]["code"], "forbidden",
            "mid-session EDITOR→VIEWER downgrade denies the next write: {denied}"
        );
        assert_eq!(denied["payload"]["message"], "write denied");

        // Reads still work over the same socket (non-fatal denial).
        send_text(
            &mut ws,
            r#"{"v":1,"type":"ping","payload":{"nonce":"p6a-dg"}}"#,
        )
        .await;
        let pong = next_control(&mut ws).await;
        assert_eq!(pong["type"], "pong", "session alive after downgrade denial");
    }

    // Durable state: the pre-revocation op + the post-re-grant op — and
    // NOTHING from the denied batches.
    assert_eq!(op_count(&server.repo, doc).await, 2);
}

/// Helper: delete the direct ACL grant for a clerk user (simulates the
/// owner-side revoke through the product path's SQL outcome).
async fn revoke_grant(repo: &GatewayRepo, doc: Uuid, clerk_id: &str) {
    let client = repo.db.get().await.expect("pool");
    client
        .execute(
            "DELETE FROM document_user_permissions
             WHERE document_id = $1
               AND user_id = (SELECT id FROM users WHERE clerk_user_id = $2)",
            &[&doc, &clerk_id],
        )
        .await
        .expect("revoke acl row");
}
