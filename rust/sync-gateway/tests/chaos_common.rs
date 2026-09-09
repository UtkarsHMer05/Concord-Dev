//! Shared chaos-harness module (P6-M028) — included via `mod chaos_common;`
//! at the top of every chaos suite in `rust/sync-gateway/tests/`.
//!
//! Rust integration-test rule: each `tests/*.rs` file is its own crate;
//! `mod chaos_common;` pulls this file in as a module of that crate
//! (the file must live at `tests/chaos_common.rs`). It is NOT a test
//! target itself (no `#[test]` at top level).
//!
//! Provides:
//! - `ScenarioRecord` — the 10-field scenario JSON from the chaos
//!   framework contract (`.agent/scratch/phase-6/chaos-framework-contract.md`),
//!   one file per scenario execution under `CHAOS_OUT_DIR` (default
//!   `.agent/bench/runs/manual-chaos/`).
//! - `aggregate()` — reads every scenario JSON in an out-dir and writes
//!   `chaos-summary.json` with `{attempted, passed, failed, skipped,
//!   lostDurableAckedOps, divergentReplicas}` (the M039 Metric C input;
//!   never hand-edited).
//! - Harness helpers copied/adapted from `tests/multi_gateway.rs`
//!   (GatewayProcess, connect/join, op_bytes, client_ops_frame, db_count,
//!   seed fixture) — copied, not imported, per the mission brief.
//!
//! Counting rules (contract "Hard rules"):
//! - `lostDurableAckedOps`: ops the writer OBSERVED a durable_ack for,
//!   absent from PG after the recovery window (never assert-by-absence
//!   without the ack observation).
//! - `divergentReplicas`: after recovery, a sync_request(cursor 0) on a
//!   FRESH connection to each surviving gateway; the returned op-id sets
//!   are compared EXACTLY (set equality of op identities). Any
//!   difference = divergence.

#![allow(dead_code)] // per-suite crates use different subsets

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Constants (match multi_gateway.rs)
// ---------------------------------------------------------------------------

pub const TEST_DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
pub const NATS_URL: &str = "nats://127.0.0.1:4222";
pub const REDIS_URL: &str = "redis://127.0.0.1:6379";
pub const DOCKER_DB: &str = "concord-db";
pub const DOCKER_NATS: &str = "concord-nats";
pub const DOCKER_REDIS: &str = "concord-redis";
pub const NATS_JETSTREAM_VOLUME: &str = "concord_nats";

/// Issuer/JWKS shared with the E2E key material (git-ignored scratch).
const JWKS_REL: &str = ".agent/scratch/phase-3/e2e-jwks.json";
const KEY_DER_REL: &str = ".agent/scratch/phase-3/e2e-key.der";
const ISSUER: &str = "https://e2e.clerk.accounts.dev";
const KID: &str = "e2e-key-1";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Repo root (rust/sync-gateway/../..).
pub fn repo_path(relative: &str) -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
        .to_string_lossy()
        .into_owned()
}

pub fn bin_path() -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../target/release/sync-gateway")
        .to_string_lossy()
        .into_owned()
}

// ---------------------------------------------------------------------------
// Scenario ledger
// ---------------------------------------------------------------------------

/// Default out-dir when the runner does not set CHAOS_OUT_DIR.
const DEFAULT_OUT_DIR: &str = ".agent/bench/runs/manual-chaos/";

/// The 10-field scenario record (contract schema). `lostDurableAckedOps`
/// and `divergentReplicas` ride along as counters (they are aggregate
/// inputs; the per-scenario JSON keeps the canonical 10 fields and two
/// evidence numbers). Camel-case field names are the CONTRACT wire
/// format (they mirror the contract JSON verbatim).
#[allow(non_snake_case)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScenarioRecord {
    pub scenarioId: String,
    pub seed: u64,
    pub precondition: String,
    pub fault: String,
    pub expectedDegradedBehavior: String,
    pub durabilityExpectation: String,
    pub recoveryExpectation: String,
    pub invariant: String,
    pub timeoutMs: u64,
    /// "PASS: ..." | "FAIL: ..." | "SKIP: ..." — always written, even on
    /// PASS (contract: every scenario records its JSON).
    pub observedResult: String,
    /// Ops observed durable-ACKed that are absent after recovery.
    #[serde(default)]
    pub lostDurableAckedOps: u64,
    /// Gateways whose post-recovery fresh-catch-up op set differs.
    #[serde(default)]
    pub divergentReplicas: u64,
}

impl ScenarioRecord {
    pub fn outcome(&self) -> Outcome {
        if self.observedResult.starts_with("PASS") {
            Outcome::Passed
        } else if self.observedResult.starts_with("SKIP") {
            Outcome::Skipped
        } else {
            Outcome::Failed
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Passed,
    Failed,
    Skipped,
}

/// Where scenario JSONs land: `CHAOS_OUT_DIR` (runner sets a per-suite
/// timestamped dir) or the documented default for manual runs.
pub fn chaos_out_dir() -> PathBuf {
    std::env::var("CHAOS_OUT_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(repo_path(DEFAULT_OUT_DIR).trim_start_matches("./")))
}

/// Writes one scenario JSON file. Panics on I/O failure — a scenario we
/// cannot record is a framework failure, not a pass.
pub fn record_scenario(rec: &ScenarioRecord) {
    let dir = chaos_out_dir();
    std::fs::create_dir_all(&dir).expect("create CHAOS_OUT_DIR");
    let file = dir.join(format!("{}.json", rec.scenarioId));
    let body = serde_json::to_string_pretty(rec).expect("serialize scenario record");
    std::fs::write(&file, body).unwrap_or_else(|e| panic!("write scenario {file:?}: {e}"));
    eprintln!("CHAOS-RECORD {} -> {:?}", rec.scenarioId, file);
}

/// Aggregate summary shape (contract ledger): computed from the scenario
/// JSONs, never hand-edited. Camel-case mirrors the contract's summary
/// object key names.
#[allow(non_snake_case)]
#[derive(Debug, Default, serde::Serialize)]
pub struct ChaosSummary {
    pub attempted: u64,
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
    pub lostDurableAckedOps: u64,
    pub divergentReplicas: u64,
}

/// Reads every `*.json` in `dir` (non-recursive) that parses as a
/// ScenarioRecord, aggregates, and writes `chaos-summary.json` in the
/// same dir. Returns the summary. Files that fail to parse are ignored
/// (they are not scenario records).
pub fn aggregate(dir: &PathBuf) -> ChaosSummary {
    let mut summary = ChaosSummary::default();
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read CHAOS_OUT_DIR {dir:?}: {e}"));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if path.file_name().and_then(|n| n.to_str()) == Some("chaos-summary.json") {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(rec) = serde_json::from_str::<ScenarioRecord>(&body) else {
            continue;
        };
        summary.attempted += 1;
        match rec.outcome() {
            Outcome::Passed => summary.passed += 1,
            Outcome::Failed => summary.failed += 1,
            Outcome::Skipped => summary.skipped += 1,
        }
        summary.lostDurableAckedOps += rec.lostDurableAckedOps;
        summary.divergentReplicas += rec.divergentReplicas;
    }
    let out = dir.join("chaos-summary.json");
    std::fs::write(
        &out,
        serde_json::to_string_pretty(&summary).expect("serialize summary"),
    )
    .unwrap_or_else(|e| panic!("write summary {out:?}: {e}"));
    eprintln!(
        "CHAOS-SUMMARY attempted={} passed={} failed={} skipped={} lostDurableAckedOps={} divergentReplicas={}",
        summary.attempted,
        summary.passed,
        summary.failed,
        summary.skipped,
        summary.lostDurableAckedOps,
        summary.divergentReplicas
    );
    summary
}

/// Test-side convenience: record a scenario + fail the Rust test if the
/// outcome is FAIL (the JSON still lands first — the ledger is never
/// lost, even for a failing scenario).
pub fn finish_scenario(rec: ScenarioRecord) {
    let outcome = rec.outcome();
    record_scenario(&rec);
    match outcome {
        Outcome::Failed => {
            panic!("CHScenario {}: {}", rec.scenarioId, rec.observedResult);
        }
        Outcome::Skipped => {
            eprintln!("SKIP: {}", rec.observedResult);
        }
        Outcome::Passed => {
            eprintln!("PASS: {}", rec.observedResult);
        }
    }
}

// ---------------------------------------------------------------------------
// Docker helpers (always restore state; every call is used by a scenario)
// ---------------------------------------------------------------------------

pub fn docker(args: &[&str]) -> bool {
    Command::new("docker")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn docker_ok(args: &[&str]) -> bool {
    Command::new("docker")
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Container state via `docker inspect -f {{.State.Status}}`.
pub fn docker_state(container: &str) -> Option<String> {
    let out = Command::new("docker")
        .args(["inspect", "-f", "{{.State.Status}}", container])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Waits until `predicate(container_state)` holds, up to `timeout_ms`.
pub async fn wait_container<F>(container: &str, timeout_ms: u64, predicate: F)
where
    F: Fn(&str) -> bool,
{
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if let Some(state) = docker_state(container) {
            if predicate(&state) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Waits until a host TCP service answers, by polling the service's own
/// probe (DB/NATS/Redis probes in `deps_available` style).
pub async fn wait_until<F, Fut>(timeout_ms: u64, mut probe: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if probe().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

// ---------------------------------------------------------------------------
// Dependency probes
// ---------------------------------------------------------------------------

pub async fn db_up() -> bool {
    tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .is_ok()
}

pub async fn nats_up() -> bool {
    async_nats::connect(NATS_URL).await.is_ok()
}

pub async fn redis_up() -> bool {
    redis::Client::open(REDIS_URL)
        .and_then(|c| c.get_connection())
        .map(|mut c| redis::cmd("PING").query::<String>(&mut c).is_ok())
        .unwrap_or(false)
}

/// Standard dependency gate: all three infra services reachable.
pub async fn deps_available() -> bool {
    db_up().await && nats_up().await && redis_up().await
}

/// The full skip helper: prints SKIP, records a SKIP scenario JSON, and
/// returns true when deps are down (caller returns early).
pub async fn skip_if_deps_down(scenario_id: &str) -> bool {
    if deps_available().await {
        return false;
    }
    eprintln!("SKIP: {scenario_id} (db/nats/redis not all reachable)");
    record_scenario(&ScenarioRecord {
        scenarioId: scenario_id.to_string(),
        seed: 0,
        precondition: "db + nats + redis up".into(),
        fault: "none (deps unavailable)".into(),
        expectedDegradedBehavior: "n/a".into(),
        durabilityExpectation: "n/a".into(),
        recoveryExpectation: "n/a".into(),
        invariant: "n/a".into(),
        timeoutMs: 0,
        observedResult: format!("SKIP: deps down ({scenario_id})"),
        lostDurableAckedOps: 0,
        divergentReplicas: 0,
    });
    true
}

// ---------------------------------------------------------------------------
// Gateway process harness (adapted from tests/multi_gateway.rs)
// ---------------------------------------------------------------------------

/// Kills stray gateways from earlier suites (the multi_gateway pattern —
/// keeps repeated runs deterministic; only matches our release binary).
pub fn kill_stray_gateways() {
    let _ = Command::new("pkill")
        .args(["-9", "-f", "target/release/sync-gateway"])
        .output();
}

pub fn sign_token(sub: &str) -> String {
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

pub struct GatewayProcess {
    pub child: Child,
    pub port: u16,
    pub gateway_id: u64,
}

impl GatewayProcess {
    pub fn spawn(port: u16, gateway_id: u64, nats: Option<&str>) -> Self {
        Self::spawn_full(port, gateway_id, nats, None, None)
    }

    /// Spawn with the ephemeral Redis tier wired (GATEWAY_REDIS_URL) —
    /// used by CH-REDIS and compound scenarios.
    pub fn spawn_redis(
        port: u16,
        gateway_id: u64,
        nats: Option<&str>,
        redis: Option<&str>,
    ) -> Self {
        Self::spawn_full(port, gateway_id, nats, redis, None)
    }

    /// Spawn with an explicit DB pool size (pool-exhaustion scenarios).
    pub fn spawn_with_pool(
        port: u16,
        gateway_id: u64,
        nats: Option<&str>,
        db_pool_size: u32,
    ) -> Self {
        Self::spawn_full(port, gateway_id, nats, None, Some(db_pool_size))
    }

    fn spawn_full(
        port: u16,
        gateway_id: u64,
        nats: Option<&str>,
        redis: Option<&str>,
        db_pool_size: Option<u32>,
    ) -> Self {
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
        if let Some(url) = redis {
            cmd.env("GATEWAY_REDIS_URL", url);
        }
        if let Some(size) = db_pool_size {
            cmd.env("GATEWAY_DB_POOL_SIZE", size.to_string());
        }
        let child = cmd
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn gateway");
        Self {
            child,
            port,
            gateway_id,
        }
    }

    /// SIGKILL (chaos kill — the harsh path; restart never happens on the
    /// same process object, tests respawn fresh ones).
    pub fn kill(&mut self) {
        let _ = self.child.kill(); // SIGKILL
        let _ = self.child.wait();
    }

    /// SIGSTOP the whole gateway process (freeze without killing).
    pub fn stop_process(&mut self) -> bool {
        let pid = self.child.id();
        Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// SIGCONT a SIGSTOPped gateway.
    pub fn cont_process(&mut self) -> bool {
        let pid = self.child.id();
        Command::new("kill")
            .args(["-CONT", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Dumps the gateway's recent stderr for debugging. NEVER blocks on a
    /// LIVE process: a piped-but-undrained stderr only yields EOF when
    /// the child exits, so a blocking read here would hang the test.
    /// If the child is still running, we report that instead.
    pub fn dump_stderr(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            eprintln!(
                "  | (gateway pid {} still running; stderr not drainable)",
                self.child.id()
            );
            return;
        }
        if let Some(stderr) = self.child.stderr.take() {
            use std::io::Read;
            let mut buf = String::new();
            let mut file = stderr;
            let _ = file.read_to_string(&mut buf);
            for line in buf.lines().rev().take(40).collect::<Vec<_>>().iter().rev() {
                eprintln!("  | {line}");
            }
        }
    }
}

pub async fn wait_ready(port: u16, timeout_ms: u64) -> bool {
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

/// Readiness check that does NOT retry — returns the current readiness.
pub async fn ready_now(port: u16) -> bool {
    reqwest::get(format!("http://127.0.0.1:{port}/api/v1/health/ready"))
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// WebSocket client harness (adapted from tests/multi_gateway.rs)
// ---------------------------------------------------------------------------

pub type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub async fn connect(port: u16) -> Ws {
    tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/api/v1/sync"))
        .await
        .expect("connect")
        .0
}

pub async fn send_text(ws: &mut Ws, text: String) {
    ws.send(WsMessage::Text(text.into())).await.expect("send");
}

pub async fn send_binary(ws: &mut Ws, bytes: Vec<u8>) {
    ws.send(WsMessage::Binary(bytes.into()))
        .await
        .expect("send binary");
}

pub async fn send(ws: &mut Ws, text: String) {
    send_text(ws, text).await;
}

pub async fn next_control(ws: &mut Ws) -> serde_json::Value {
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

/// Next control frame or an error string (timeout / close) — for the
/// "during-outage" windows where an error frame or silence is legal.
pub async fn try_next_control(ws: &mut Ws, timeout: Duration) -> Result<serde_json::Value, String> {
    let msg = tokio::time::timeout(timeout, ws.next())
        .await
        .map_err(|_| "frame timeout".to_string())?
        .transpose()
        .map_err(|e| format!("stream error: {e}"))?
        .ok_or("stream closed".to_string())?;
    match msg {
        WsMessage::Text(t) => serde_json::from_str(t.as_str()).map_err(|e| e.to_string()),
        WsMessage::Binary(_) => Ok(serde_json::json!({"type": "__binary__"})),
        WsMessage::Close(_) => Err("closed".to_string()),
        _ => Ok(serde_json::json!({"type": "__other__"})),
    }
}

pub async fn next_binary(ws: &mut Ws) -> Result<Vec<u8>, String> {
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

pub async fn handshake_and_join(ws: &mut Ws, clerk: &str, doc: &str) {
    send_text(
        ws,
        r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#.into(),
    )
    .await;
    let _ = next_control(ws).await; // hello_ack
    let token = sign_token(clerk);
    send_text(
        ws,
        format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{token}"}}}}"#),
    )
    .await;
    let auth = next_control(ws).await;
    assert_eq!(auth["type"], "authenticated", "auth ok: {auth}");
    send_text(
        ws,
        format!(r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#),
    )
    .await;
    let joined = next_control(ws).await;
    assert_eq!(joined["type"], "join_accepted", "join ok: {joined}");
    let done = next_control(ws).await;
    assert_eq!(done["type"], "sync_done", "ready: {done}");
}

/// Join a SECOND document on an ALREADY-authenticated connection. The
/// protocol allows join_document only from Authenticated state — a
/// session joins one document per connection (registry rooms are
/// per-connection). Multiple rooms = multiple connections.
pub async fn join_second_doc(ws: &mut Ws, doc: &str) {
    send_text(
        ws,
        format!(r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{doc}","stateSummary":[]}}}}"#),
    )
    .await;
    // Server answers invalid_state (already joined) — documented; the
    // caller uses fresh connections per room.
    let _ = try_next_control(ws, Duration::from_secs(2)).await;
}

/// Canonical 32-byte insert op (same shape as multi_gateway.rs).
pub fn op_bytes(replica: u64, counter: u64) -> Vec<u8> {
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

pub fn client_ops_frame(batch_id: u64, ops: &[Vec<u8>]) -> Vec<u8> {
    sync_gateway::protocol::data::DataFrame::ClientOps(sync_gateway::protocol::data::ClientOps {
        batch_id,
        ops: ops.to_vec(),
        identities: vec![],
    })
    .encode()
    .expect("encode")
}

/// Sends one batch and waits for its durable_ack; returns the acked op
/// identity set (the ack's `payload.opIds` — the observed-durability
/// ledger). The ack payload is camelCase per the protocol's serde.
pub async fn write_batch_acked(ws: &mut Ws, batch_id: u64, ops: &[Vec<u8>]) -> Vec<String> {
    send_binary(ws, client_ops_frame(batch_id, ops)).await;
    let ack = next_control(ws).await;
    assert_eq!(ack["type"], "durable_ack", "expected durable_ack: {ack}");
    ack["payload"]["opIds"]
        .as_array()
        .unwrap_or_else(|| panic!("opIds array in {ack}"))
        .iter()
        .map(|v| v.as_str().expect("op id str").to_string())
        .collect()
}

/// Extracts op ids from an observed durable_ack control frame (payload
/// shape), tolerating an absent array.
pub fn ack_op_ids(frame: &serde_json::Value) -> Vec<String> {
    frame["payload"]["opIds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Durable-truth assertions (PG floor)
// ---------------------------------------------------------------------------

pub struct Fixture {
    pub clerk: String,
    pub doc: Uuid,
}

pub async fn seed() -> Fixture {
    let (client, conn) = tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .expect("db");
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            eprintln!("db connection driver ended: {e}");
        }
    });
    let clerk = format!(
        "chaos-user-{}-{}",
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
            "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'chaos', '') RETURNING id",
            &[&user],
        )
        .await
        .expect("doc")
        .get("id");
    Fixture { clerk, doc }
}

/// One-off DB client for assertions (spawn the driver task!).
pub async fn db_client() -> tokio_postgres::Client {
    let (client, conn) = tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .expect("db");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    client
}

pub async fn db_count(doc: &Uuid, replica: i64) -> i64 {
    let client = db_client().await;
    client
        .query_one(
            "SELECT COUNT(*)::bigint AS n FROM crdt_operations WHERE document_id = $1 AND replica_id = $2",
            &[doc, &replica],
        )
        .await
        .expect("count")
        .get("n")
}

/// Durable op identities for a document (operation_id strings) — the
/// ground-truth set for divergence comparison.
pub async fn db_op_ids(doc: &Uuid) -> HashSet<String> {
    let client = db_client().await;
    let rows = client
        .query(
            "SELECT operation_id FROM crdt_operations WHERE document_id = $1",
            &[doc],
        )
        .await
        .expect("op ids");
    rows.into_iter().map(|r| r.get::<_, String>(0)).collect()
}

/// Ops still absent from PG after the recovery window: intersect the
/// observed-ACKed identities with durable absence. This is the
/// lost-durable-ACKed-op count (observed-ack + absent = lost; never
/// assert-by-absence without the ack observation).
pub async fn lost_acked_ops(acked: &[String], doc: &Uuid) -> Vec<String> {
    let durable = db_op_ids(doc).await;
    acked
        .iter()
        .filter(|id| !durable.contains(*id))
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Divergence measurement: fresh catch-up per gateway (op-id set equality)
// ---------------------------------------------------------------------------

/// Runs `sync_request(cursor "0")` on a FRESH connection to the gateway
/// at `port` and returns the full durable op set as op identities
/// (computed by re-deriving the identity from each op payload — the
/// server returns payloads in SyncBatch frames).
pub async fn fresh_catchup_ids(port: u16, clerk: &str, doc: &Uuid) -> HashSet<String> {
    let mut ws = connect(port).await;
    handshake_and_join(&mut ws, clerk, &doc.to_string()).await;
    send_text(
        &mut ws,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut ids = HashSet::new();
    loop {
        let bytes = next_binary(&mut ws).await.expect("catch-up batch");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            for op in &f.ops {
                if let Ok(env) = sync_gateway::protocol::envelope::validate_op(op) {
                    ids.insert(env.identity.to_wire());
                } else {
                    // Non-envelope payloads cannot happen from the durable
                    // log; count distinctly if ever observed.
                    ids.insert(format!("__invalid__{}", ids.len()));
                }
            }
            if !f.has_more {
                break;
            }
        }
    }
    let done = next_control(&mut ws).await;
    assert_eq!(done["type"], "sync_done", "catch-up completes: {done}");
    ids
}

/// Compares the fresh-catch-up op-id sets across the surviving gateways.
/// Returns the list of gateway ports whose set differs from the FIRST
/// gateway's set (any difference = divergence). Empty = no divergence.
pub async fn divergent_gateways(survivors: &[u16], clerk: &str, doc: &Uuid) -> Vec<u16> {
    let mut reference: Option<HashSet<String>> = None;
    let mut divergent = Vec::new();
    for port in survivors {
        let ids = fresh_catchup_ids(*port, clerk, doc).await;
        match &reference {
            None => reference = Some(ids),
            Some(r) => {
                if &ids != r {
                    divergent.push(*port);
                }
            }
        }
    }
    divergent
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

pub fn void<T>(_: T) {}

/// Deterministic workload seed: process id xor time — the SEED drives the
/// WORKLOAD (batch sizes, replica ids), not the kill timing (process-kill
/// timing is inherently racy; documented per the contract).
pub fn workload_seed() -> u64 {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ t
}
