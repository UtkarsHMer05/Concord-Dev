//! CH-COMPOUND — multi-fault chaos suite (P6-M034).
//!
//! Compound faults (FAILURE_MODEL §7.7 + reconnect storms + worker):
//! gateway SIGKILL + NATS stop simultaneously; NATS outage + 20-client
//! reconnect storm; Redis FLUSHALL + gateway SIGKILL; PG pause + 15
//! clients cycling reconnects; worker SIGKILL mid-snapshot while a
//! writer keeps editing.
//!
//! Invariant: NO false durable_ack anywhere; durable truth (PG) intact;
//! every observed-ACKed op durable; convergence after restore; no
//! divergence across survivors' fresh catch-ups.
//!
//! Divergence method: set-equality of op identities via fresh
//! sync_request(cursor 0) per surviving gateway (worker unavailable for
//! digest comparison in the gateway topology — documented per the
//! contract; the CH-WORKER suite owns the digest-verifier method).
//!
//! SERIALIZED: cargo test --test chaos_compound -- --test-threads=1.
//! Skips cleanly when deps are down. Ports 944x + 945x.

mod chaos_common;

use std::time::Duration;

use chaos_common::*;

const P_GW1: u16 = 9441;
const P_GW2: u16 = 9442;
const P_GW3: u16 = 9443;

async fn wait_nats_up(timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if async_nats::connect(NATS_URL).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    false
}

async fn wait_db_up(timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if db_up().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

fn record(
    id: &str,
    seed_value: u64,
    fault: &str,
    evidence: String,
    lost: u64,
    divergent: u64,
) -> ScenarioRecord {
    ScenarioRecord {
        scenarioId: id.to_string(),
        seed: seed_value,
        precondition: "gateways ready, clients joined, durable writes flowing".into(),
        fault: fault.into(),
        expectedDegradedBehavior:
            "compound degradation: realtime lost, no false ack, admission control contains storms"
                .into(),
        durabilityExpectation: "every observed durable_ack durable; PG is the only truth".into(),
        recoveryExpectation:
            "after restore: reconnects succeed, retries converge, presence rebuilds, zero divergence"
                .into(),
        invariant: "no lost ACKed ops; no divergence after recovery; no false ack during outages"
            .into(),
        timeoutMs: 120_000,
        observedResult: format!("PASS: {evidence}"),
        lostDurableAckedOps: lost,
        divergentReplicas: divergent,
    }
}

// ---------------------------------------------------------------------------
// CH-C-GW-NATS — gateway kill + NATS stop simultaneously + a THIRD gateway
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_c_gw_nats() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-C-GW-NATS").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 901, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 902, Some(NATS_URL));
    let mut gw3 = GatewayProcess::spawn(P_GW3, 903, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");
    assert!(wait_ready(P_GW3, 20_000).await, "gw3 ready");

    // A on gw1, B on gw2; A writes durably.
    let mut a = connect(P_GW1).await;
    let mut b = connect(P_GW2).await;
    handshake_and_join(&mut a, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut b, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9001, c)).collect();
    let mut acked = write_batch_acked(&mut a, 1, &ops).await;

    // COMPOUND FAULT: kill gw1 AND stop NATS simultaneously.
    gw1.kill();
    docker_ok(&["stop", DOCKER_NATS]);
    tokio::time::sleep(Duration::from_millis(300)).await;

    // gw2 stays healthy + keeps DURABLE writing with no broker.
    assert!(
        wait_ready(P_GW2, 5_000).await,
        "gw2 healthy through compound"
    );
    let ops_b: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9002, c)).collect();
    acked.extend(write_batch_acked(&mut b, 2, &ops_b).await);

    // Restore NATS.
    assert!(docker(&["start", DOCKER_NATS]), "start nats");
    assert!(wait_nats_up(60_000).await, "nats back");
    tokio::time::sleep(Duration::from_secs(2)).await;

    // THE THIRD GATEWAY (never saw the outage) joins and proves full
    // recovery: every acknowledged op present via catch-up.
    let mut c = connect(P_GW3).await;
    handshake_and_join(&mut c, &fixture.clerk, &fixture.doc.to_string()).await;
    // The last batch (ops_c below) is written AFTER the catch-up
    // window closes — assert 5 DURABLE rows here (batch 1 + 2), then
    // prove post-restore realtime with a separate write. A catch-up
    // racing gw2's publish of batch 2 can legally miss it (the floor
    // catch-up on join_document covers batch 1; batch 2's broker event
    // may land mid-catch-up); DURABLE presence, not catch-up count, is
    // the invariant — so assert the durable count, and use a fresh
    // catch-up AFTER all writes for the convergence check.
    send_text(
        &mut c,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got = 0usize;
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
    let done = next_control(&mut c).await;
    assert_eq!(done["type"], "sync_done");

    // Post-restore realtime resumes (B writes; C receives via broker).
    let ops_c: Vec<Vec<u8>> = (1..=1u64).map(|c| op_bytes(9003, c)).collect();
    acked.extend(write_batch_acked(&mut b, 3, &ops_c).await);
    let live = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let bytes = match next_binary(&mut c).await {
                Ok(b) => b,
                Err(_) => break,
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.ops.len() == 1 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    let n1 = db_count(&fixture.doc, 9001).await;
    let n2 = db_count(&fixture.doc, 9002).await;
    let n3 = db_count(&fixture.doc, 9003).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW2, P_GW3], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "gw1 SIGKILL + nats stop; gw2 durable through outage; third-gateway first-catchup={got}/5 \
         (racing ok — see divergence check); rows={n1}/{n2}/{n3} (2/2/1); fanout_restored={live}; \
         lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    // The load-bearing invariants: all 5 acked rows durable exactly
    // once, fanout restored, zero lost, zero divergence across BOTH
    // survivors' fresh catch-ups (which DO see all 5).
    let ok = n1 == 2 && n2 == 2 && n3 == 1 && live && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw2.dump_stderr();
        gw3.dump_stderr();
    }
    assert!(ok, "CH-C-GW-NATS violated: {evidence}");
    finish_scenario(record(
        "CH-C-GW-NATS",
        seed_value,
        "SIGKILL gw1 + docker stop concord-nats simultaneously; restore; third gateway proves recovery",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw2.kill();
    gw3.kill();
}

// ---------------------------------------------------------------------------
// CH-C-NATS-RECONNECT-STORM — NATS outage + 20 clients reconnecting
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_c_nats_reconnect_storm() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-C-NATS-RECONNECT-STORM").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 911, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9011, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &ops).await;

    // COMPOUND FAULT: stop NATS, then 20 clients reconnect in a tight
    // loop DURING the outage (the broker is down; the gateway must
    // admit-control the storm and stay healthy).
    docker_ok(&["stop", DOCKER_NATS]);
    let mut accepted = 0usize;
    let mut rejected = 0usize;
    for _ in 0..20usize {
        match tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{P_GW1}/api/v1/sync")).await
        {
            Ok(_) => accepted += 1,
            Err(_) => rejected += 1,
        }
    }

    // The gateway must stay alive + serving DURABLE writes through the
    // storm + outage (health endpoint responsive; writes ack).
    let healthy = ready_now(P_GW1).await;
    let ops2: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9012, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 2, &ops2).await);

    // Restore NATS; the drained clients converge.
    assert!(docker(&["start", DOCKER_NATS]), "start nats");
    assert!(wait_nats_up(60_000).await, "nats back");
    tokio::time::sleep(Duration::from_secs(2)).await;

    let ops3: Vec<Vec<u8>> = (1..=1u64).map(|c| op_bytes(9013, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 3, &ops3).await);

    let n1 = db_count(&fixture.doc, 9011).await;
    let n2 = db_count(&fixture.doc, 9012).await;
    let n3 = db_count(&fixture.doc, 9013).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "nats outage + 20-client reconnect storm (accepted={accepted}, rejected={rejected}); \
         healthy_throughout={healthy}; rows={n1}/{n2}/{n3} (2/2/1); lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n1 == 2 && n2 == 2 && n3 == 1 && healthy && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-C-NATS-RECONNECT-STORM violated: {evidence}");
    finish_scenario(record(
        "CH-C-NATS-RECONNECT-STORM",
        seed_value,
        "docker stop concord-nats + 20 clients reconnect in a tight loop during recovery",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}

// ---------------------------------------------------------------------------
// CH-C-REDIS-WIPE-GW-RESTART — FLUSHALL + gateway SIGKILL together
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_c_redis_wipe_gw_restart() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-C-REDIS-WIPE-GW-RESTART").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn_redis(P_GW1, 921, Some(NATS_URL), Some(REDIS_URL));
    let mut gw2 = GatewayProcess::spawn_redis(P_GW2, 922, Some(NATS_URL), Some(REDIS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9021, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &ops).await;

    // COMPOUND FAULT: FLUSHALL + SIGKILL gw1 at the same instant.
    {
        let client = redis::Client::open(REDIS_URL).expect("client");
        let mut conn = client.get_connection().expect("conn");
        redis::cmd("FLUSHALL")
            .query::<()>(&mut conn)
            .expect("flushall");
    }
    let pending: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9022, c)).collect();
    send_binary(&mut writer, client_ops_frame(2, &pending)).await;
    gw1.kill();
    let acked_before_kill = matches!(
        try_next_control(&mut writer, Duration::from_secs(3)).await,
        Ok(f) if f["type"] == "durable_ack"
    );

    // Reconnect to gw2 (ephemeral tier wiped + primary gone); resend.
    let mut r2 = connect(P_GW2).await;
    handshake_and_join(&mut r2, &fixture.clerk, &fixture.doc.to_string()).await;
    acked.extend(write_batch_acked(&mut r2, 2, &pending).await);
    let ops3: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9023, c)).collect();
    acked.extend(write_batch_acked(&mut r2, 3, &ops3).await);

    // Durable truth intact; presence rebuilt (new upserts populate the
    // wiped tier — proven via the store on the real namespace).
    {
        use sync_gateway::ephemeral::presence::PresenceStore;
        use sync_gateway::ephemeral::{RedisConfig, RedisHandle};
        let handle = RedisHandle::connect(&RedisConfig {
            url: REDIS_URL.to_owned(),
            namespace: "concord.dev".to_owned(),
        })
        .await
        .expect("reconnect post-wipe");
        let store = PresenceStore::new(handle);
        store
            .upsert(fixture.doc, uuid::Uuid::new_v4(), 922)
            .await
            .expect("presence upsert");
        assert!(
            store
                .document_presence_count(fixture.doc)
                .await
                .expect("count")
                >= 1
        );
    }

    let n1 = db_count(&fixture.doc, 9021).await;
    let n2 = db_count(&fixture.doc, 9022).await;
    let n3 = db_count(&fixture.doc, 9023).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "FLUSHALL + gw1 SIGKILL together; ack_before_kill={acked_before_kill}; \
         rows={n1}/{n2}/{n3} (2/2/2); presence rebuilt; lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n1 == 2 && n2 == 2 && n3 == 2 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw2.dump_stderr();
    }
    assert!(ok, "CH-C-REDIS-WIPE-GW-RESTART violated: {evidence}");
    finish_scenario(record(
        "CH-C-REDIS-WIPE-GW-RESTART",
        seed_value,
        "redis FLUSHALL + gateway SIGKILL simultaneously; reconnect to surviving gateway",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-C-PG-OUTAGE-RECONNECT-STORM — pause PG 3s + 15 clients cycling
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_c_pg_outage_reconnect_storm() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-C-PG-OUTAGE-RECONNECT-STORM").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 931, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9031, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &ops).await;

    // COMPOUND FAULT: pause PG; 15 clients cycle reconnects; writer
    // sends a batch during the window (NO false ack allowed).
    let paused_at = std::time::Instant::now();
    assert!(docker(&["pause", DOCKER_DB]), "pause db");

    let mut storm_accepted = 0usize;
    let mut storm_rejected = 0usize;
    for _ in 0..15usize {
        match tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{P_GW1}/api/v1/sync")).await
        {
            Ok(_) => storm_accepted += 1,
            Err(_) => storm_rejected += 1,
        }
    }

    let out: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(9032, c)).collect();
    match try_next_control_after_send(&mut writer, 2, &out, Duration::from_secs(3)).await {
        Ok(f) if f["type"] == "durable_ack" => {
            acked.extend(ack_op_ids(&f)); // legal ONLY if it committed pre-pause; verified below
        }
        Ok(f) => eprintln!(
            "CH-C-PG-OUTAGE-RECONNECT-STORM: error frame during pause: {}",
            f["payload"]["code"]
        ),
        Err(e) => eprintln!("CH-C-PG-OUTAGE-RECONNECT-STORM: silence during pause: {e}"),
    }

    while paused_at.elapsed() < Duration::from_secs(3) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(docker(&["unpause", DOCKER_DB]), "unpause db");
    assert!(wait_db_up(30_000).await, "db back");

    // Readiness green; clients retry; convergence.
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut ok = false;
        while std::time::Instant::now() < deadline {
            if ready_now(P_GW1).await {
                ok = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        assert!(ok, "readiness green after unpause");
    }
    acked.extend(write_batch_acked(&mut writer, 3, &out).await);
    let ops3: Vec<Vec<u8>> = (1..=1u64).map(|c| op_bytes(9033, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 4, &ops3).await);

    let n1 = db_count(&fixture.doc, 9031).await;
    let n2 = db_count(&fixture.doc, 9032).await;
    let n3 = db_count(&fixture.doc, 9033).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "pg pause 3s + 15-client reconnect storm (accepted={storm_accepted}, rejected={storm_rejected}); \
         rows={n1}/{n2}/{n3} (2/2/1); lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n1 == 2 && n2 == 2 && n3 == 1 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-C-PG-OUTAGE-RECONNECT-STORM violated: {evidence}");
    finish_scenario(record(
        "CH-C-PG-OUTAGE-RECONNECT-STORM",
        seed_value,
        "docker pause concord-db 3s while 15 clients cycle reconnects; no false acks; converge after unpause",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}

/// send + observe with a bounded window (the paused-DB variant).
async fn try_next_control_after_send(
    ws: &mut Ws,
    batch_id: u64,
    ops: &[Vec<u8>],
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    send_binary(ws, client_ops_frame(batch_id, ops)).await;
    try_next_control(ws, timeout).await
}

// ---------------------------------------------------------------------------
// CH-C-WORKER-CRASH-EDITING — worker SIGKILL mid-snapshot, writer editing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_c_worker_crash_editing() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-C-WORKER-CRASH-EDITING").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 941, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;

    // Baseline edits (observed acks).
    let mut acked: Vec<String> = Vec::new();
    for b in 0..3u64 {
        let ops: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(9041 + b, c)).collect();
        acked.extend(write_batch_acked(&mut writer, b, &ops).await);
    }

    // COMPOUND FAULT: run a snapshot build (library pipeline, spawned
    // task) and SIGKILL the worker child mid-build WHILE THE WRITER
    // KEEPS EDITING — edits keep flowing + acking throughout.
    let (repo, snapshots, pipeline) = {
        use sync_gateway::config::Config;
        use sync_gateway::db::migrations::run_migrations;
        use sync_gateway::db::pool::Db;
        use sync_gateway::db::repo::GatewayRepo;
        use sync_gateway::db::snapshots::SnapshotRepo;
        use sync_gateway::maintenance::SnapshotPipeline;
        use sync_gateway::worker::WorkerPool;

        let config = Config {
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            database_url: TEST_DB_URL.into(),
            clerk_issuer: "https://chaos.clerk.accounts.dev".into(),
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
            worker_binary: None,
        };
        let db = Db::connect(&config).await.expect("db");
        run_migrations(&db).await.expect("migrations");
        let workers = WorkerPool::new(
            std::path::PathBuf::from(repo_path("build/native/worker/concord-worker")),
            Duration::from_secs(300),
        );
        (
            GatewayRepo::new(db.clone()),
            SnapshotRepo::new(db.clone()),
            SnapshotPipeline::new(
                GatewayRepo::new(db.clone()),
                SnapshotRepo::new(db.clone()),
                workers,
            ),
        )
    };
    // The boundary is the durable high-water at snapshot-start.
    let boundary = repo.durable_cursor(fixture.doc).await.expect("cursor");
    let fixture_doc = fixture.doc;
    let fixture_job = uuid::Uuid::new_v4();
    let pipeline_task = pipeline.clone();
    let build_task = tokio::spawn(async move {
        pipeline_task
            .build_at_boundary(fixture_doc, boundary, fixture_job, 1)
            .await
    });

    // Writer keeps editing while the build runs (no coordination).
    tokio::time::sleep(Duration::from_millis(40)).await;
    let killed = std::process::Command::new("pkill")
        .args(["-9", "-f", "build/native/worker/concord-worker"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    for b in 3..6u64 {
        let ops: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(9041 + b, c)).collect();
        acked.extend(write_batch_acked(&mut writer, b, &ops).await);
    }
    let build_outcome = build_task.await.expect("task join");
    match &build_outcome {
        Ok(_) => eprintln!("CH-C-WORKER-CRASH-EDITING: build finished before kill (race)"),
        Err(e) => eprintln!("CH-C-WORKER-CRASH-EDITING: build failed cleanly: {e}"),
    }

    // SNAPSHOT JOB RETRIES: a fresh build at the ORIGINAL boundary
    // finalizes (the maintenance cycle completes).
    let job = uuid::Uuid::new_v4();
    let (snap_id, digest, _v) = pipeline
        .build_at_boundary(fixture.doc, boundary, job, 2)
        .await
        .expect("retry build");
    assert!(snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("t"));
    let _ = pipeline.verify(fixture.doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));
    assert!(digest.starts_with("sha256:"));

    // NO LOST EDITS: every acked edit durable; convergence.
    let mut rows = 0i64;
    for b in 0..6i64 {
        rows += db_count(&fixture.doc, 9041 + b).await;
    }
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "worker SIGKILL mid-snapshot (killed_cmd={killed}) while 6 edit batches flowed; \
         rows={rows}/18; retry finalized snapshot @ boundary {boundary}; lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = rows == 18 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-C-WORKER-CRASH-EDITING violated: {evidence}");
    finish_scenario(record(
        "CH-C-WORKER-CRASH-EDITING",
        seed_value,
        "worker SIGKILL mid-snapshot while a writer keeps editing; snapshot job retries; no lost edits",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());

    // Cleanup the maintenance rows for this fixture doc (test hygiene).
    {
        let client = db_client().await;
        let _ = client
            .execute(
                "DELETE FROM crdt_snapshots WHERE document_id = $1;
                 DELETE FROM maintenance_jobs WHERE document_id = $1",
                &[&fixture.doc],
            )
            .await;
    }
    gw1.kill();
}
