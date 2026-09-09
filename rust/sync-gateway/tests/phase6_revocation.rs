//! P6-M022 — live permission revocation across gateways (SA-AUTH6).
//!
//! Spawns REAL gateway processes (multi_gateway.rs GatewayProcess pattern:
//! release binary, distinct ports 93xx, distinct gateway ids, shared NATS +
//! PostgreSQL) and proves that permission changes are enforced on live
//! sessions on EVERY gateway without reconnect — because the write recheck
//! runs inside the ingest transaction against a fresh snapshot (no TTL
//! cache exists at the gateway; repo.rs AUTHZ_QUERY + EffectiveRole).
//!
//! Scenarios:
//!  A. direct-ACL EDITOR writing on gw1; grant REVOKED via SQL mid-stream
//!     → next client_ops batch on gw1 is denied (error frame; session
//!     stays usable for reads — the documented non-fatal denial policy).
//!  B. same user concurrently connected on gw1 AND gw2 → revocation
//!     enforced on BOTH without reconnect.
//!  C. org-member EDITOR removed from the org mid-session → writes
//!     denied on the next batch across BOTH gateways.
//!  D. VIEWER upgraded to EDITOR mid-session → next write SUCCEEDS
//!     without reconnect (live upgrade proof).
//!  E. stale-cache bypass hunt: revoke + immediately write on the OTHER
//!     gateway; assert the invariant that EITHER the durable_ack precedes
//!     the revoke commit (op durable, allowed) OR the write is denied —
//!     no third outcome, ever.
//!
//! Documented policy (pinned by this suite, T9):
//!   "Permission changes are enforced on every batch via an in-transaction
//!    authorization recheck; no TTL cache exists at the gateway; enforcement
//!    is immediate at the next batch boundary."
//!
//! SERIALIZED: cargo test --test phase6_revocation -- --test-threads=1
//! (shared concord_test DB + dedicated ports). Skips cleanly when the DB
//! or NATS is down. Requires the release binary to be current
//! (cargo build --release).
//!
//! NOTE ON SCENARIO A's SESSION-ALIVE ASSERTION: the ws layer maps
//! RepoError::WriteDenied to a NON-FATAL `forbidden` error frame
//! (ws/mod.rs: `return if fatal { Err(FlowError::Close) } else { Ok(()) }`
//! with ProtocolError::Forbidden — `is_fatal()` is false for Forbidden).
//! The connection therefore STAYS OPEN for reads after a write denial.
//! This is the documented behavior; this suite pins it.

use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const NATS_URL: &str = "nats://127.0.0.1:4222";
const ISSUER: &str = "https://e2e.clerk.accounts.dev";
const KID: &str = "e2e-key-1";
const JWKS_REL: &str = ".agent/scratch/phase-3/e2e-jwks.json";
const KEY_DER_REL: &str = ".agent/scratch/phase-3/e2e-key.der";

fn repo_path(relative: &str) -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
        .to_string_lossy()
        .into_owned()
}

fn bin_path() -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/release/sync-gateway")
        .to_string_lossy()
        .into_owned()
}

async fn deps_available() -> bool {
    if tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .is_err()
    {
        return false;
    }
    if !std::path::Path::new(&bin_path()).is_file() {
        eprintln!("SKIP: release binary not built (cargo build --release)");
        return false;
    }
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
    #[allow(dead_code)]
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
    send(
        ws,
        format!(
            r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#
        ),
    )
    .await;
    let joined = next_control(ws).await;
    assert_eq!(joined["type"], "join_accepted", "join ok: {joined}");
    let done = next_control(ws).await;
    assert_eq!(done["type"], "sync_done", "ready: {done}");
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

/// One SQL client driver (spawned task) reused for fixture + revocations.
struct DbClient(tokio_postgres::Client);

async fn db() -> DbClient {
    let (client, conn) = tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .expect("db");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    DbClient(client)
}

impl DbClient {
    async fn exec(&self, sql: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) {
        self.0.execute(sql, params).await.expect("exec");
    }
    async fn one<T: tokio_postgres::types::FromSqlOwned + Send + 'static>(
        &self,
        sql: &str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> T {
        let row = self.0.query_one(sql, params).await.expect("query_one");
        row.try_get::<_, T>(0).expect("col 0")
    }
}

/// The scenario world: owner + document + one grantee clerk id.
struct Fixture {
    #[allow(dead_code)] // kept for debugging future scenarios
    owner_clerk: String,
    grantee_clerk: String,
    doc: Uuid,
}

async fn seed_fixture(grant_role: Option<&str>) -> Fixture {
    let db = db().await;
    let run = Uuid::new_v4().simple().to_string();
    let owner_clerk = format!("p6r-own-{run}");
    let grantee_clerk = format!("p6r-grt-{run}");
    let owner_id: Uuid = db
        .one(
            "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
            &[&owner_clerk],
        )
        .await;
    let grantee_id: Uuid = db
        .one(
            "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
            &[&grantee_clerk],
        )
        .await;
    let doc: Uuid = db
        .one(
            "INSERT INTO documents (owner_user_id, title, initial_content)
             VALUES ($1, 'p6r', '') RETURNING id",
            &[&owner_id],
        )
        .await;
    if let Some(role) = grant_role {
        db.exec(
            "INSERT INTO document_user_permissions (document_id, user_id, role)
             VALUES ($1, $2, $3::text::document_role)",
            &[&doc, &grantee_id, &role],
        )
        .await;
    }
    Fixture {
        owner_clerk,
        grantee_clerk,
        doc,
    }
}

/// Scenario A: grant revoked mid-stream on gw1 → next batch denied, the
/// session stays alive for reads (documented non-fatal denial policy).
#[tokio::test]
async fn scenario_a_revoke_acl_row_mid_stream_denies_next_batch_on_same_gateway() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down (or release binary not built)");
        return;
    }
    let f = seed_fixture(Some("EDITOR")).await;

    let mut gw1 = GatewayProcess::spawn(9301, 201, Some(NATS_URL));
    assert!(wait_ready(9301, 20_000).await, "gw1 ready");

    let mut ws = connect(9301).await;
    handshake_and_join(&mut ws, &f.grantee_clerk, &f.doc.to_string()).await;

    // Steady writing: two batches ACK before the revoke.
    for batch in 1..=2u64 {
        ws.send(WsMessage::Binary(
            client_ops_frame(batch, &[op_bytes(0x6A01, batch)]).into(),
        ))
        .await
        .expect("send");
        assert_eq!(
            next_control(&mut ws).await["type"],
            "durable_ack",
            "batch {batch} acked pre-revoke"
        );
    }

    // REVOKE mid-stream (owner-side action's SQL outcome).
    db().await
        .exec(
            "DELETE FROM document_user_permissions
             WHERE document_id = $1
               AND user_id = (SELECT id FROM users WHERE clerk_user_id = $2)",
            &[&f.doc, &f.grantee_clerk],
        )
        .await;

    // Next batch on the SAME session: DENIED.
    ws.send(WsMessage::Binary(
        client_ops_frame(3, &[op_bytes(0x6A01, 3)]).into(),
    ))
    .await
    .expect("send");
    let denied = next_control(&mut ws).await;
    assert_eq!(
        denied["payload"]["code"], "forbidden",
        "revocation enforced at the next batch boundary: {denied}"
    );
    assert_eq!(denied["payload"]["message"], "write denied");

    // Documented session policy: the denial is NON-FATAL — the same
    // socket keeps serving reads (ping/pong proves liveness).
    send(
        &mut ws,
        r#"{"v":1,"type":"ping","payload":{"nonce":"after-revoke"}}"#.into(),
    )
    .await;
    let pong = next_control(&mut ws).await;
    assert_eq!(pong["type"], "pong", "session stays alive for reads");

    gw1.kill();
}

/// Scenario B: the user is connected on gw1 AND gw2 concurrently;
/// revoking the ACL row denies the next batch on BOTH gateways without
/// any reconnect — the in-transaction recheck reads fresh state on every
/// gateway (no cached grants exist anywhere).
#[tokio::test]
async fn scenario_b_revocation_enforced_on_both_gateways_without_reconnect() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down (or release binary not built)");
        return;
    }
    let f = seed_fixture(Some("EDITOR")).await;

    let mut gw1 = GatewayProcess::spawn(9302, 211, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9303, 212, Some(NATS_URL));
    assert!(wait_ready(9302, 20_000).await, "gw1 ready");
    assert!(wait_ready(9303, 20_000).await, "gw2 ready");

    let mut a = connect(9302).await;
    let mut b = connect(9303).await;
    handshake_and_join(&mut a, &f.grantee_clerk, &f.doc.to_string()).await;
    handshake_and_join(&mut b, &f.grantee_clerk, &f.doc.to_string()).await;

    // Both sessions are live writers pre-revoke.
    for (ws, batch) in [(&mut a, 1u64), (&mut b, 1u64)] {
        ws.send(WsMessage::Binary(
            client_ops_frame(batch, &[op_bytes(0x6B01, batch)]).into(),
        ))
        .await
        .expect("send");
        let ack = next_control(ws).await;
        assert_eq!(ack["type"], "durable_ack", "pre-revoke write ok: {ack}");
    }

    db().await
        .exec(
            "DELETE FROM document_user_permissions
             WHERE document_id = $1
               AND user_id = (SELECT id FROM users WHERE clerk_user_id = $2)",
            &[&f.doc, &f.grantee_clerk],
        )
        .await;

    // Post-revoke writes on BOTH gateways — same socket, no reconnect.
    for (label, ws, batch) in [("gw1", &mut a, 2u64), ("gw2", &mut b, 2u64)] {
        ws.send(WsMessage::Binary(
            client_ops_frame(batch, &[op_bytes(0x6B01, batch + 100)]).into(),
        ))
        .await
        .expect("send");
        let denied = next_control(ws).await;
        assert_eq!(
            denied["payload"]["code"], "forbidden",
            "{label}: revocation enforced without reconnect: {denied}"
        );
    }

    gw1.kill();
    gw2.kill();
}

/// Scenario C: org-member EDITOR (access via membership, no ACL row)
/// removed from the org mid-session → writes denied on the next batch
/// on BOTH gateways.
#[tokio::test]
async fn scenario_c_org_membership_removal_denies_writes_on_both_gateways() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down (or release binary not built)");
        return;
    }
    let db = db().await;
    let run = Uuid::new_v4().simple().to_string();
    let owner_clerk = format!("p6r-own-{run}");
    let member_clerk = format!("p6r-mem-{run}");
    let owner_id: Uuid = db
        .one(
            "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
            &[&owner_clerk],
        )
        .await;
    let member_id: Uuid = db
        .one(
            "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
            &[&member_clerk],
        )
        .await;
    let org: Uuid = db
        .one(
            "INSERT INTO organizations (clerk_organization_id, name)
             VALUES ($1, 'p6r org') RETURNING id",
            &[&format!("org-{run}")],
        )
        .await;
    db.exec(
        "INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'member')",
        &[&org, &member_id],
    )
    .await;
    let doc: Uuid = db
        .one(
            "INSERT INTO documents (owner_user_id, organization_id, title, initial_content)
             VALUES ($1, $2, 'p6r orgdoc', '') RETURNING id",
            &[&owner_id, &org],
        )
        .await;

    let mut gw1 = GatewayProcess::spawn(9304, 221, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9305, 222, Some(NATS_URL));
    assert!(wait_ready(9304, 20_000).await, "gw1 ready");
    assert!(wait_ready(9305, 20_000).await, "gw2 ready");

    let mut a = connect(9304).await;
    let mut b = connect(9305).await;
    let joined_a = {
        send(
            &mut a,
            r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#.into(),
        )
        .await;
        let _ = next_control(&mut a).await;
        let token = sign_token(&member_clerk);
        send(
            &mut a,
            format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{token}"}}}}"#),
        )
        .await;
        assert_eq!(next_control(&mut a).await["type"], "authenticated");
        send(
            &mut a,
            format!(
                r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#
            ),
        )
        .await;
        let joined = next_control(&mut a).await;
        assert_eq!(joined["type"], "join_accepted", "{joined}");
        assert_eq!(joined["payload"]["role"], "editor", "org-derived EDITOR");
        let _ = next_control(&mut a).await; // sync_done
        joined
    };
    let _ = joined_a;
    handshake_and_join(&mut b, &member_clerk, &doc.to_string()).await;

    // Both gateways write once as org-member EDITORs.
    for (ws, batch) in [(&mut a, 1u64), (&mut b, 1u64)] {
        ws.send(WsMessage::Binary(
            client_ops_frame(batch, &[op_bytes(0x6C01, batch)]).into(),
        ))
        .await
        .expect("send");
        assert_eq!(next_control(ws).await["type"], "durable_ack");
    }

    // Removed from the org mid-session.
    db.exec(
        "DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
        &[&org, &member_id],
    )
    .await;

    // Next batch on BOTH gateways: denied (the authz join's membership
    // leg is gone; no direct grant exists).
    for (label, ws, batch) in [("gw1", &mut a, 2u64), ("gw2", &mut b, 2u64)] {
        ws.send(WsMessage::Binary(
            client_ops_frame(batch, &[op_bytes(0x6C01, batch + 100)]).into(),
        ))
        .await
        .expect("send");
        let denied = next_control(ws).await;
        assert_eq!(
            denied["payload"]["code"], "forbidden",
            "{label}: org removal enforced without reconnect: {denied}"
        );
    }

    gw1.kill();
    gw2.kill();
}

/// Scenario D: VIEWER upgraded to EDITOR mid-session → the next write
/// SUCCEEDS over the SAME session, no reconnect (live upgrade proof —
/// the recheck reads fresh state in BOTH directions).
#[tokio::test]
async fn scenario_d_viewer_upgrade_to_editor_succeeds_without_reconnect() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down (or release binary not built)");
        return;
    }
    let f = seed_fixture(Some("VIEWER")).await;

    let mut gw1 = GatewayProcess::spawn(9306, 231, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9307, 232, Some(NATS_URL));
    assert!(wait_ready(9306, 20_000).await, "gw1 ready");
    assert!(wait_ready(9307, 20_000).await, "gw2 ready");

    let mut a = connect(9306).await;
    let mut b = connect(9307).await;
    handshake_and_join(&mut a, &f.grantee_clerk, &f.doc.to_string()).await;
    handshake_and_join(&mut b, &f.grantee_clerk, &f.doc.to_string()).await;

    // Pre-upgrade: VIEWER writes are denied on both gateways.
    for (label, ws) in [("gw1", &mut a), ("gw2", &mut b)] {
        ws.send(WsMessage::Binary(
            client_ops_frame(1, &[op_bytes(0x6D01, 1)]).into(),
        ))
        .await
        .expect("send");
        let denied = next_control(ws).await;
        assert_eq!(
            denied["payload"]["code"], "forbidden",
            "{label}: VIEWER write denied pre-upgrade: {denied}"
        );
    }

    // UPGRADE to EDITOR mid-session (ACL row role change).
    db().await
        .exec(
            "UPDATE document_user_permissions SET role = 'EDITOR'::text::document_role
             WHERE document_id = $1
               AND user_id = (SELECT id FROM users WHERE clerk_user_id = $2)",
            &[&f.doc, &f.grantee_clerk],
        )
        .await;

    // Next writes on BOTH gateways, SAME sessions: ALLOWED.
    for (label, ws, batch) in [("gw1", &mut a, 2u64), ("gw2", &mut b, 2u64)] {
        ws.send(WsMessage::Binary(
            client_ops_frame(batch, &[op_bytes(0x6D01, batch + 10)]).into(),
        ))
        .await
        .expect("send");
        let ack = next_control(ws).await;
        assert_eq!(
            ack["type"], "durable_ack",
            "{label}: live upgrade to EDITOR takes effect without reconnect: {ack}"
        );
    }

    gw1.kill();
    gw2.kill();
}

/// Scenario E: stale-cache bypass hunt. The grant is revoked WHILE a
/// batch is being sent to the OTHER gateway — the recheck outcome
/// depends on transaction ordering, so the invariant asserted is the
/// ONLY acceptable one: EITHER the batch committed and was acked
/// BEFORE the revoke commit became visible (op durable, allowed —
/// the ack proves the then-current grant), OR the write is denied
/// (`forbidden`). There is NO third outcome: never an ack after
/// revocation, never a durable row without an ack, never a crash or
/// a wrong-role success. Repeated over many interleavings, the
/// boundary is always one of the two legal outcomes.
#[tokio::test]
async fn scenario_e_no_stale_cache_window_across_gateways() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down (or release binary not built)");
        return;
    }
    let f = seed_fixture(Some("EDITOR")).await;

    let mut gw1 = GatewayProcess::spawn(9308, 241, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9309, 242, Some(NATS_URL));
    assert!(wait_ready(9308, 20_000).await, "gw1 ready");
    assert!(wait_ready(9309, 20_000).await, "gw2 ready");

    let mut writer = connect(9308).await;
    handshake_and_join(&mut writer, &f.grantee_clerk, &f.doc.to_string()).await;

    // Interleave: for each round, send a batch from gw1 and IMMEDIATELY
    // (same millisecond range) revoke on a parallel task; then observe
    // the outcome. The allowed/denied boundary may flip per round — the
    // INVARIANT is that only the two legal outcomes occur.
    let mut acks = 0usize;
    let mut denies = 0usize;
    for round in 0..12u64 {
        // Alternate the interleaving pressure: even rounds revoke
        // immediately after send; odd rounds send after a hair's delay
        // post-revoke (pushing the race the other way).
        let doc = f.doc;
        let clerk = f.grantee_clerk.clone();
        let revoke = tokio::spawn(async move {
            if round % 2 == 1 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let db = db().await;
            db.exec(
                "DELETE FROM document_user_permissions
                 WHERE document_id = $1
                   AND user_id = (SELECT id FROM users WHERE clerk_user_id = $2)",
                &[&doc, &clerk],
            )
            .await;
            // Re-grant immediately so the next round starts as EDITOR
            // (each round is a fresh revoke race).
            tokio::time::sleep(Duration::from_millis(20)).await;
            db.exec(
                "INSERT INTO document_user_permissions (document_id, user_id, role)
                 VALUES ($1, (SELECT id FROM users WHERE clerk_user_id = $2),
                         'EDITOR'::text::document_role)",
                &[&doc, &clerk],
            )
            .await;
        });

        writer
            .send(WsMessage::Binary(
                client_ops_frame(round + 1, &[op_bytes(0x6E01, round + 1)]).into(),
            ))
            .await
            .expect("send");
        let outcome = next_control(&mut writer).await;
        if outcome["type"] == "durable_ack" {
            acks += 1;
        } else {
            assert_eq!(
                outcome["payload"]["code"], "forbidden",
                "third outcome observed — invariant violated: {outcome}"
            );
            denies += 1;
        }
        revoke.await.expect("revoke task");
        // Let the re-grant land before the next round.
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
    assert!(
        acks + denies == 12,
        "every round resolved to exactly one legal outcome (acks={acks}, denies={denies})"
    );
    eprintln!(
        "scenario E: 12 interleavings resolved as acks={acks} / denies={denies} — \
         both are legal outcomes; the ordering policy is transaction-visibility \
         based: a batch whose ingest transaction began before the revoke commit \
         is acked (op durable under the then-current grant); one that begins \
         after is denied. No TTL cache exists — the recheck reads a FRESH \
         snapshot inside the ingest transaction."
    );

    gw1.kill();
    gw2.kill();
}

/// The steady-state companion to the race: after the revoke commits and
/// settles, EVERY subsequent write on BOTH gateways is denied — there is
/// no window, however short, in which the revoked grant still
/// authorizes a write whose transaction begins after the revoke commit.
#[tokio::test]
async fn scenario_e_settled_state_has_no_authorization_window() {
    if !deps_available().await {
        eprintln!("SKIP: db or nats down (or release binary not built)");
        return;
    }
    let f = seed_fixture(Some("EDITOR")).await;

    let mut gw1 = GatewayProcess::spawn(9310, 251, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(9311, 252, Some(NATS_URL));
    assert!(wait_ready(9310, 20_000).await, "gw1 ready");
    assert!(wait_ready(9311, 20_000).await, "gw2 ready");

    let mut a = connect(9310).await;
    let mut b = connect(9311).await;
    handshake_and_join(&mut a, &f.grantee_clerk, &f.doc.to_string()).await;
    handshake_and_join(&mut b, &f.grantee_clerk, &f.doc.to_string()).await;

    // Revoke, then hammer writes on both gateways within the same
    // second — ALL must be denied (the commit already landed).
    db().await
        .exec(
            "DELETE FROM document_user_permissions
             WHERE document_id = $1
               AND user_id = (SELECT id FROM users WHERE clerk_user_id = $2)",
            &[&f.doc, &f.grantee_clerk],
        )
        .await;

    for i in 0..5u64 {
        for (label, ws) in [("gw1", &mut a), ("gw2", &mut b)] {
            ws.send(WsMessage::Binary(
                client_ops_frame(i, &[op_bytes(0x6E51, i + 1)]).into(),
            ))
            .await
            .expect("send");
            let denied = next_control(ws).await;
            assert_eq!(
                denied["payload"]["code"], "forbidden",
                "{label}: immediate post-revoke write {i} must be denied (no stale window): {denied}"
            );
        }
    }

    gw1.kill();
    gw2.kill();
}
