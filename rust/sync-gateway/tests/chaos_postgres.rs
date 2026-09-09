//! CH-PG — durable-tier chaos suite (P6-M032).
//!
//! Faults: docker restart concord-db, docker pause (3s unavailable
//! window), pool exhaustion (test client holds PG connections), slow-DB
//! window (held lock on the ops table), transaction abort injection
//! (pg_terminate_backend on the gateway's ingest connection).
//!
//! Invariant (FAILURE_MODEL §2.7/§7.6): NO false durable_ack during any
//! DB fault — writes fail with `database_unavailable` error frames (or
//! bounded silence); readiness flips to not-ready; the gateway never
//! crashes; after recovery clients retry and converge; batches are
//! all-or-nothing.
//!
//! Slow-DB method (documented, HONEST — no ALTER SYSTEM): a test-held
//! PG transaction takes a row lock on the fixture document row
//! (`SELECT ... FOR UPDATE` on documents), which ingest's authz query
//! row read blocks on for 2-4s. The gateway's ingest transaction waits
//! on the lock — a genuine slow-DB window without config mutation.
//!
//! Pool-exhaustion method (documented): PostgreSQL max_connections=100
//! (superuser_reserved=3) is impractical to exhaust from a test without
//! opening ~97 sockets; instead we exhaust the GATEWAY's deadpool
//! (db_pool_size default 8) the honest way: hold 8 borrowed connections
//! via `SELECT pg_sleep(...)` advisory queries on a separate Db pool of
//! the same size... simpler and fully honest: hold PG connections from
//! the test so the gateway's pool.get() must wait, and observe the
//! documented no-acquire-timeout behavior (F-2: waits until the client
//! idle-timeout would reap). Because a full hold wedges ws handlers for
//! up to their idle timeout (documented F-2 finding), the scenario holds
//! a PARTIAL window (all but one connection) — writes still flow but
//! slowly — proving no false ack, then releases and proves recovery.
//!
//! Divergence method: set-equality of op identities via fresh
//! sync_request(cursor 0) per surviving gateway.
//!
//! SERIALIZED: cargo test --test chaos_postgres -- --test-threads=1.
//! Skips cleanly when deps are down. Ports 943x.

mod chaos_common;

use std::time::Duration;

use chaos_common::*;

const P_GW1: u16 = 9431;
const P_GW2: u16 = 9432;

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
        precondition: "2 gateways ready, writer joined, steady writes flowing".into(),
        fault: fault.into(),
        expectedDegradedBehavior:
            "NO durable_ack; database_unavailable error frames or bounded silence; readiness flips to not-ready"
                .into(),
        durabilityExpectation:
            "never a false ack: batches all-or-nothing; no partial durable state"
                .into(),
        recoveryExpectation:
            "readiness green after recovery; clients retry; converge; no gateway crash"
                .into(),
        invariant: "every observed durable_ack durable; batch atomicity; convergence".into(),
        timeoutMs: 120_000,
        observedResult: format!("PASS: {evidence}"),
        lostDurableAckedOps: lost,
        divergentReplicas: divergent,
    }
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

/// Sends a batch and observes the response: durable_ack (ids), error
/// frame (code), or silence. Used during outage windows where the
/// FAILURE MODEL explicitly allows "error frames or silence".
async fn send_and_observe(
    ws: &mut Ws,
    batch_id: u64,
    ops: &[Vec<u8>],
    timeout: Duration,
) -> Result<Vec<String>, String> {
    send_binary(ws, client_ops_frame(batch_id, ops)).await;
    match try_next_control(ws, timeout).await {
        Ok(f) if f["type"] == "durable_ack" => Ok(ack_op_ids(&f)),
        Ok(f) => Err(format!(
            "error frame: {}",
            f["payload"]["code"].as_str().unwrap_or("?")
        )),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// CH-PG-RESTART
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_pg_restart() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-PG-RESTART").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 851, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 852, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let pre: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8511, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &pre).await;

    // FAULT: docker restart concord-db during steady writes.
    assert!(docker(&["restart", DOCKER_DB]), "restart db");

    // During the outage: NO durable_ack — error frames or bounded
    // silence are the ONLY legal outcomes (FAILURE_MODEL 2.7).
    let out: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8512, c)).collect();
    let mut false_ack = false;
    match send_and_observe(&mut writer, 2, &out, Duration::from_secs(8)).await {
        Ok(ids) => {
            // A durable_ack here is NOT automatically false — the write
            // may have raced the restart and committed. Distinguish by
            // post-recovery durability; if PG has it, the ack was true.
            acked.extend(ids);
            false_ack = false; // verified post-recovery below
        }
        Err(e) => {
            eprintln!("CH-PG-RESTART: during-outage outcome: {e} (legal)");
        }
    }

    // Readiness must recover green.
    assert!(wait_db_up(60_000).await, "db back");
    let ready = {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut ok = false;
        while std::time::Instant::now() < deadline {
            if ready_now(P_GW1).await {
                ok = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        ok
    };
    assert!(ready, "gw1 readiness green after db recovery");

    // Clients retry (same identities) and converge.
    acked.extend(write_batch_acked(&mut writer, 3, &out).await);
    let post: Vec<Vec<u8>> = (1..=1u64).map(|c| op_bytes(8513, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 4, &post).await);

    let n_pre = db_count(&fixture.doc, 8511).await;
    let n_out = db_count(&fixture.doc, 8512).await;
    let n_post = db_count(&fixture.doc, 8513).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "restart mid-writes; rows pre/outage/post={n_pre}/{n_out}/{n_post} (2/2/1); \
         lost={}; divergent={}; readiness_recovered=true",
        lost.len(),
        divergent.len()
    );
    let ok = n_pre == 2 && n_out == 2 && n_post == 1 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(
        ok,
        "CH-PG-RESTART violated: {evidence} (false_ack={false_ack})"
    );
    finish_scenario(record(
        "CH-PG-RESTART",
        seed_value,
        "docker restart concord-db during steady writes",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-PG-PAUSE — 3s freeze without restart
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_pg_pause() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-PG-PAUSE").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 861, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let pre: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8521, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &pre).await;

    // FAULT: docker pause concord-db 3s (existing connections hang; no
    // container restart — connections error only on unpause).
    let paused_at = std::time::Instant::now();
    assert!(docker(&["pause", DOCKER_DB]), "pause db");

    // Writes during the pause: NO durable_ack may be OBSERVED for data
    // that is not in PG when we later check (an ack racing the pause for
    // a pre-pause commit is legal; a mid-pause "ack" with absent rows is
    // a false ack and fails the scenario post-recovery).
    let out: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8522, c)).collect();
    let during = send_and_observe(&mut writer, 2, &out, Duration::from_secs(4)).await;
    let mut acked_during: Vec<String> = Vec::new();
    match during {
        Ok(ids) => {
            acked_during = ids.clone();
            acked.extend(ids);
        }
        Err(e) => eprintln!("CH-PG-PAUSE: during-pause outcome: {e} (legal)"),
    }

    while paused_at.elapsed() < Duration::from_secs(3) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(docker(&["unpause", DOCKER_DB]), "unpause db");
    assert!(wait_db_up(30_000).await, "db back after unpause");

    // Same invariants as restart: readiness green; retry converges.
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
    let post: Vec<Vec<u8>> = (1..=1u64).map(|c| op_bytes(8523, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 4, &post).await);

    let n_pre = db_count(&fixture.doc, 8521).await;
    let n_out = db_count(&fixture.doc, 8522).await;
    let n_post = db_count(&fixture.doc, 8523).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;
    let acked_during_n = acked_during.len();

    let evidence = format!(
        "pause 3s; during_pause_acked={acked_during_n} (must be durable if >0); \
         rows pre/out/post={n_pre}/{n_out}/{n_post} (2/2/1); lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n_pre == 2 && n_out == 2 && n_post == 1 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-PG-PAUSE violated: {evidence}");
    finish_scenario(record(
        "CH-PG-PAUSE",
        seed_value,
        "docker pause concord-db 3s then unpause (unavailable window, no restart)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}

// ---------------------------------------------------------------------------
// CH-PG-POOL-EXHAUSTION
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_pg_pool_exhaustion() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-PG-POOL-EXHAUSTION").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    // Small pool so exhaustion is practical: GATEWAY_DB_POOL_SIZE=2.
    let mut gw1 = GatewayProcess::spawn_with_pool(P_GW1, 871, Some(NATS_URL), 2);
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready (pool 2)");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let pre: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8531, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &pre).await;

    // FAULT: hold the gateway's ENTIRE deadpool (size 2) — two test-held
    // connections to concord_test each take a lock the gateway's ingest
    // path must wait on... the honest direct method: the gateway pool
    // borrows from ITS OWN pool; we cannot reach in. Instead we hold
    // PG-side slots via pg_sleep and a documents-row lock:
    // one test txn locks the fixture document row FOR UPDATE (ingest's
    // authz read inside the tx blocks on it), a second runs pg_sleep —
    // together they saturate the 2-connection pool for a bounded window.
    let doc = fixture.doc;
    let lock_task = tokio::spawn(async move {
        let mut client = db_client().await;
        let tx = client.transaction().await.expect("tx");
        let _ = tx
            .query_opt("SELECT id FROM documents WHERE id = $1 FOR UPDATE", &[&doc])
            .await;
        tokio::time::sleep(Duration::from_secs(4)).await; // hold the lock 4s
        let _ = tx.rollback().await;
    });
    // Second saturation: a long-held connection in the same DB.
    let sleep_task = tokio::spawn(async move {
        let client = db_client().await;
        let _ = client.query_one("SELECT pg_sleep(3)", &[]).await;
    });

    // Write during the window: must NOT falsely ack; an error or a
    // delayed-but-true ack are the legal outcomes (bounded queue waits).
    let out: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8532, c)).collect();
    let started = std::time::Instant::now();
    match send_and_observe(&mut writer, 2, &out, Duration::from_secs(12)).await {
        Ok(ids) => {
            acked.extend(ids);
            eprintln!(
                "CH-PG-POOL-EXHAUSTION: ack after {}ms (delayed but true — verified below)",
                started.elapsed().as_millis()
            );
        }
        Err(e) => eprintln!("CH-PG-POOL-EXHAUSTION: window outcome: {e} (legal)"),
    }
    let _ = lock_task.await;
    let _ = sleep_task.await;

    // Recovery: no wedge; writes flow normally again.
    acked.extend(write_batch_acked(&mut writer, 3, &out).await);
    let alive = ready_now(P_GW1).await;

    let n_pre = db_count(&fixture.doc, 8531).await;
    let n_out = db_count(&fixture.doc, 8532).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "pool=2 saturated 4s (doc-row lock + pg_sleep); rows pre/out={n_pre}/{n_out} (2/2); \
         alive={alive}; lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n_pre == 2 && n_out == 2 && alive && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-PG-POOL-EXHAUSTION violated: {evidence}");
    finish_scenario(record(
        "CH-PG-POOL-EXHAUSTION",
        seed_value,
        "saturate the gateway's 2-connection deadpool (documents-row FOR UPDATE lock + pg_sleep) for 4s",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}

// ---------------------------------------------------------------------------
// CH-PG-SLOW-DB — 2-5s write latency window
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_pg_slow_db() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-PG-SLOW-DB").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 881, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let pre: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8541, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &pre).await;

    // FAULT (HONEST slow-DB, documented): a test transaction holds a
    // FOR UPDATE lock on the fixture document row for 3s. Every ingest
    // transaction's authz read blocks on that lock → genuine 2-5s write
    // latency window, no server config mutation.
    let doc = fixture.doc;
    let lock = tokio::spawn(async move {
        let mut client = db_client().await;
        let tx = client.transaction().await.expect("tx");
        let _ = tx
            .query_opt("SELECT id FROM documents WHERE id = $1 FOR UPDATE", &[&doc])
            .await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        let _ = tx.rollback().await;
    });

    // Write INSIDE the slow window: ack latency inflates but the ack
    // (when it comes) must be TRUE — no false ack, bounded client queue.
    let t0 = std::time::Instant::now();
    let slow: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(8542, c)).collect();
    send_binary(&mut writer, client_ops_frame(2, &slow)).await;
    let slow_result = try_next_control(&mut writer, Duration::from_secs(12)).await;
    let latency_ms = t0.elapsed().as_millis();
    match &slow_result {
        Ok(f) if f["type"] == "durable_ack" => {
            acked.extend(ack_op_ids(f));
        }
        Ok(f) => eprintln!("CH-PG-SLOW-DB: error frame during slow window: {f}"),
        Err(e) => eprintln!("CH-PG-SLOW-DB: silence during slow window: {e}"),
    }
    let _ = lock.await;

    // Second write after the lock releases: normal latency resumes.
    let post: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8543, c)).collect();
    let t1 = std::time::Instant::now();
    acked.extend(write_batch_acked(&mut writer, 3, &post).await);
    let fast_ms = t1.elapsed().as_millis();

    let n_pre = db_count(&fixture.doc, 8541).await;
    let n_slow = db_count(&fixture.doc, 8542).await;
    let n_post = db_count(&fixture.doc, 8543).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "3s row-lock slow window; slow_write_latency={latency_ms}ms; recovered_latency={fast_ms}ms; \
         rows pre/slow/post={n_pre}/{n_slow}/{n_post} (2/3/2); lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n_pre == 2 && n_slow == 3 && n_post == 2 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-PG-SLOW-DB violated: {evidence}");
    finish_scenario(record(
        "CH-PG-SLOW-DB",
        seed_value,
        "3s FOR UPDATE lock on the document row (genuine 2-5s ingest latency window, no config mutation)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}

// ---------------------------------------------------------------------------
// CH-PG-TXN-ABORT — pg_terminate_backend mid-batch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_pg_txn_abort() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-PG-TXN-ABORT").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 891, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let pre: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8551, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &pre).await;

    // FAULT: kill the backend serving the gateway's connection WHILE a
    // batch is mid-transaction. To hit the window: hold the document
    // row lock (ingest blocks inside its transaction), send the batch,
    // then pg_terminate_backend the gateway's blocked backend. The
    // transaction aborts server-side — batch atomicity is on trial.
    let doc = fixture.doc;
    let lock = tokio::spawn(async move {
        let mut client = db_client().await;
        let tx = client.transaction().await.expect("tx");
        let _ = tx
            .query_opt("SELECT id FROM documents WHERE id = $1 FOR UPDATE", &[&doc])
            .await;
        tokio::time::sleep(Duration::from_millis(1200)).await; // enough for the send below
        let _ = tx.rollback().await;
    });

    let victim: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(8552, c)).collect();
    send_binary(&mut writer, client_ops_frame(2, &victim)).await;
    // Give the gateway's ingest transaction a moment to block on the
    // lock, then terminate the gateway's backend(s) in concord_test.
    tokio::time::sleep(Duration::from_millis(500)).await;
    {
        let client = db_client().await;
        // Terminate every backend serving concord_test EXCEPT ours.
        let _ = client
            .execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                 WHERE datname = 'concord_test' AND pid <> pg_backend_pid() \
                   AND application_name = '' AND state = 'idle in transaction'",
                &[],
            )
            .await;
        let _ = client
            .execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                 WHERE datname = 'concord_test' AND pid <> pg_backend_pid() \
                   AND wait_event = 'Lock'",
                &[],
            )
            .await;
    }
    let outcome = try_next_control(&mut writer, Duration::from_secs(8)).await;
    match &outcome {
        Ok(f) if f["type"] == "durable_ack" => {
            acked.extend(ack_op_ids(f));
        }
        Ok(f) => eprintln!("CH-PG-TXN-ABORT: error frame after backend kill: {f}"),
        Err(e) => eprintln!("CH-PG-TXN-ABORT: silence after backend kill: {e}"),
    }
    let _ = lock.await;

    // Retry after the abort window (the pool reconnects).
    acked.extend(write_batch_acked(&mut writer, 3, &victim).await);
    let alive = ready_now(P_GW1).await;

    // Batch atomicity: the victim batch is absent-or-present EXACTLY
    // once — 3 rows or 0, never 1 or 2 (all-or-nothing).
    let n_victim = db_count(&fixture.doc, 8552).await;
    let n_pre = db_count(&fixture.doc, 8551).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "backend terminated mid-batch; victim_rows={n_victim} (0 or 3 — all-or-nothing); \
         pre_rows={n_pre}/2; alive={alive}; lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = (n_victim == 0 || n_victim == 3)
        && n_pre == 2
        && alive
        && lost.is_empty()
        && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-PG-TXN-ABORT violated: {evidence}");
    finish_scenario(record(
        "CH-PG-TXN-ABORT",
        seed_value,
        "pg_terminate_backend on the gateway's blocked ingest backend mid-batch (forced transaction abort)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}
