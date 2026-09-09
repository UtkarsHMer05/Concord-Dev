//! CH-NATS — broker chaos suite (P6-M030).
//!
//! Faults against the live JetStream container: restart, pause/unpause
//! (temp disconnect — a different code path than restart), consumer lag
//! storm (SIGSTOPped gateway under load), forced redelivery, and storage
//! loss (volume rm + fresh NATS). Invariant (FAILURE_MODEL §7.2): no
//! durable state is affected by ANY broker fault; writes keep
//! durable-ACKing through outages (PG is truth); eventual catch-up; no
//! duplicate durable rows (identity uniqueness); cross-gateway fanout
//! resumes after restore; stream/consumer re-provision idempotently on
//! connect.
//!
//! This suite extends the existing multi_gateway nats_restart test with
//! scenario records + observed-ack counting; it does not duplicate its
//! raw assertions where a scenario fully covers them (its added value =
//! the ledger + acked-op counting + storage-loss + pause paths).
//!
//! Divergence method: set-equality of op identities via fresh
//! sync_request(cursor 0) per surviving gateway.
//!
//! SERIALIZED: cargo test --test chaos_broker -- --test-threads=1.
//! Skips cleanly when deps are down. Ports 941x (94 10-19).
//!
//! NATS JETSTREAM VOLUME RESTORATION (CH-NATS-STORAGE-LOSS): the
//! scenario removes the `concord_nats` volume. Restoration = docker
//! volume create concord_nats + docker start concord-nats — the compose
//! service auto-recreates the volume mount on next `up -d`, and this
//! suite performs both steps inline so the environment is healthy for
//! every subsequent test (documented in the scenario record + report).

mod chaos_common;

use std::time::Duration;

use chaos_common::*;

const P_GW1: u16 = 9411;
const P_GW2: u16 = 9412;

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
        precondition: "2 gateways ready, writer on gw1, reader on gw2, doc joined".into(),
        fault: fault.into(),
        expectedDegradedBehavior:
            "cross-gateway realtime degrades; local writes + durable ACKs continue".into(),
        durabilityExpectation: "zero durable impact: PG is truth; one row per identity".into(),
        recoveryExpectation:
            "after restore, subscriptions resume without duplication; catch-up recovers everything"
                .into(),
        invariant: "no lost observed-ACKed ops; no duplicate durable rows; convergence".into(),
        timeoutMs: 90_000,
        observedResult: format!("PASS: {evidence}"),
        lostDurableAckedOps: lost,
        divergentReplicas: divergent,
    }
}

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

/// Reads one gateway's stderr into a String (best-effort, non-blocking for
/// the test flow — used to prove the gateway survived a broker fault).
async fn gateway_alive(port: u16) -> bool {
    ready_now(port).await
}

// ---------------------------------------------------------------------------
// CH-NATS-RESTART
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_nats_restart() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-NATS-RESTART").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 701, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 702, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    let mut reader = connect(P_GW2).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;

    // Pre-restart durable history (observed acks).
    let pre: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(7011, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &pre).await;

    // FAULT: docker restart concord-nats mid-traffic.
    assert!(docker(&["restart", DOCKER_NATS]), "docker restart nats");
    // During the outage window writes still durable-ACK (PG truth).
    let mid: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(7012, c)).collect();
    let mid_ids = write_batch_acked(&mut writer, 2, &mid).await;
    acked.extend(mid_ids);

    assert!(wait_nats_up(60_000).await, "nats back after restart");
    tokio::time::sleep(Duration::from_secs(2)).await; // gateway reconnect window

    // Cross-gateway realtime RESUMES: a fresh write flows gw1 → gw2.
    let post: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(7013, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 3, &post).await);
    let resumed = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let bytes = match next_binary(&mut reader).await {
                Ok(b) => b,
                Err(_) => break,
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.ops.len() == 3 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    // One row per identity across the whole incident.
    let n_pre = db_count(&fixture.doc, 7011).await;
    let n_mid = db_count(&fixture.doc, 7012).await;
    let n_post = db_count(&fixture.doc, 7013).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "rows pre/mid/post={n_pre}/{n_mid}/{n_post} (2/2/3); fanout_resumed={resumed}; \
         lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n_pre == 2
        && n_mid == 2
        && n_post == 3
        && resumed
        && lost.is_empty()
        && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(ok, "CH-NATS-RESTART violated: {evidence}");
    finish_scenario(record(
        "CH-NATS-RESTART",
        seed_value,
        "docker restart concord-nats mid-traffic (writer + reader on 2 gateways)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-NATS-PAUSE — temp disconnect WITHOUT container restart
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_nats_pause() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-NATS-PAUSE").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 711, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 712, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    let mut reader = connect(P_GW2).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;

    // FAULT: docker pause concord-nats 5s (process freeze — the broker
    // TCP connections hang, no container restart: a different code path
    // from restart; the gateways see connection stalls, not resets).
    assert!(docker(&["pause", DOCKER_NATS]), "docker pause nats");
    let paused_at = std::time::Instant::now();

    // Writes during the pause: durable-ACK must continue (PG is truth —
    // the publish is best-effort AFTER commit and may fail benignly).
    let mut acked: Vec<String> = Vec::new();
    let mut err_seen = 0u32;
    for b in 0..2u64 {
        let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(7021 + b, c)).collect();
        send_binary(&mut writer, client_ops_frame(b, &ops)).await;
        match try_next_control(&mut writer, Duration::from_secs(10)).await {
            Ok(f) if f["type"] == "durable_ack" => {
                acked.extend(ack_op_ids(&f));
            }
            Ok(_) => err_seen += 1, // error frame legal — batch stays client-side
            Err(_) => err_seen += 1, // silence legal (bounded timeout)
        }
    }

    // Unpause after >= 5s.
    while paused_at.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(docker(&["unpause", DOCKER_NATS]), "docker unpause nats");
    assert!(wait_nats_up(30_000).await, "nats responsive after unpause");
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Drain check: the consumer drains the backlog without duplication —
    // exactly one durable row per identity, whether the paused-window
    // batches acked or errored (resent below if not).
    let n_a = db_count(&fixture.doc, 7021).await;
    let n_b = db_count(&fixture.doc, 7022).await;

    // Resend any batch that did not receive an observed durable_ack (the
    // client-side pending contract — FAILURE_MODEL 2.3).
    let mut resent: Vec<String> = Vec::new();
    for b in 0..2u64 {
        let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(7021 + b, c)).collect();
        send_binary(&mut writer, client_ops_frame(100 + b, &ops)).await;
        match try_next_control(&mut writer, Duration::from_secs(10)).await {
            Ok(f) if f["type"] == "durable_ack" => {
                resent.extend(ack_op_ids(&f));
            }
            _ => panic!("resend after unpause must durable_ack"),
        }
    }
    acked.extend(resent);

    let n_a2 = db_count(&fixture.doc, 7021).await;
    let n_b2 = db_count(&fixture.doc, 7022).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "err_frames_during_pause={err_seen}; rows_during_pause={n_a}/{n_b}; after_resend={n_a2}/{n_b2} \
         (exactly 2 each — no duplication); lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n_a2 == 2 && n_b2 == 2 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(ok, "CH-NATS-PAUSE violated: {evidence}");
    finish_scenario(record(
        "CH-NATS-PAUSE",
        seed_value,
        "docker pause concord-nats 5s then unpause (temp disconnect, no restart)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-NATS-LAG — paused consumer under load (SIGSTOP the gateway process)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_nats_lag() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-NATS-LAG").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 721, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 722, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;

    // FAULT: SIGSTOP gw2 (its JetStream consumer stops acking; 50+
    // batches publish from gw1 while the consumer is frozen).
    assert!(gw2.stop_process(), "SIGSTOP gw2");
    let mut acked: Vec<String> = Vec::new();
    for b in 0..12u64 {
        let ops: Vec<Vec<u8>> = (1..=5u64).map(|c| op_bytes(7031 + b, c)).collect();
        acked.extend(write_batch_acked(&mut writer, b, &ops).await);
    }

    // SIGCONT gw2: it drains the backlog in bounded batches.
    assert!(gw2.cont_process(), "SIGCONT gw2");
    assert!(
        wait_ready(P_GW2, 20_000).await,
        "gw2 responsive after SIGCONT"
    );

    // A reader on the RESUMED gateway converges (broker backlog drains;
    // the DB floor guarantees the full set regardless).
    let mut reader = connect(P_GW2).await;
    handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;
    send_text(
        &mut reader,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got = 0usize;
    loop {
        let bytes = next_binary(&mut reader).await.expect("catch-up");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            got += f.ops.len();
            if !f.has_more {
                break;
            }
        }
    }
    let done = next_control(&mut reader).await;
    assert_eq!(done["type"], "sync_done");

    // No duplicate durable rows: exactly 5 per replica.
    let mut total_rows = 0i64;
    let mut dup_rows = 0u32;
    for b in 0..12i64 {
        let n = db_count(&fixture.doc, 7031 + b).await;
        total_rows += n;
        if n != 5 {
            dup_rows += 1;
        }
    }
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "60 ops published while consumer SIGSTOPped; catchup={got}/60; rows={total_rows}/60; \
         replicas_off_count={dup_rows}; lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok =
        got == 60 && total_rows == 60 && dup_rows == 0 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-NATS-LAG violated: {evidence}");
    finish_scenario(record(
        "CH-NATS-LAG",
        seed_value,
        "SIGSTOP gateway B (consumer frozen) while gateway A publishes 60 ops; SIGCONT drains backlog",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-NATS-REDELIVERY — restart while acks are in flight (at-least-once)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_nats_redelivery() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-NATS-REDELIVERY").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 731, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 732, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    let mut reader = connect(P_GW2).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;

    // Publish batches; restart NATS immediately after the last observed
    // durable_ack — racing the consumer's acks for the in-flight events
    // (at-least-once: the consumer will see redeliveries after restart).
    let mut acked: Vec<String> = Vec::new();
    for b in 0..4u64 {
        let ops: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(7041 + b, c)).collect();
        acked.extend(write_batch_acked(&mut writer, b, &ops).await);
    }
    docker_ok(&["restart", DOCKER_NATS]); // acks for the last events in flight

    assert!(wait_nats_up(60_000).await, "nats back");
    tokio::time::sleep(Duration::from_secs(3)).await; // redelivery window (ack_wait is 30s;
                                                      // redelivered messages MAY appear later; rows cannot change though)

    // Idempotent processing: durable rows unique — exactly 3 per replica
    // regardless of how many times events redeliver (DB identity unique
    // + client-visible duplication bounded by CRDT idempotence).
    let mut total = 0i64;
    let mut bad = 0u32;
    for b in 0..4i64 {
        let n = db_count(&fixture.doc, 7041 + b).await;
        total += n;
        if n != 3 {
            bad += 1;
        }
    }

    // Post-restart realtime path still works (new writes flow).
    let after: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(7045, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 10, &after).await);
    let delivered = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let bytes = match next_binary(&mut reader).await {
                Ok(b) => b,
                Err(_) => break,
            };
            if let Ok(sync_gateway::protocol::data::DataFrame::ClientOps(f)) =
                sync_gateway::protocol::data::DataFrame::decode(&bytes)
            {
                if f.ops.len() == 2 {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "12 ops, restart racing consumer acks; rows={total}/12 (unique); bad_replicas={bad}; \
         post_restart_fanout={delivered}; lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = total == 12 && bad == 0 && delivered && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(ok, "CH-NATS-REDELIVERY violated: {evidence}");
    finish_scenario(record(
        "CH-NATS-REDELIVERY",
        seed_value,
        "docker restart nats while gateway consumer acks are in flight (forced at-least-once redelivery)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-NATS-STORAGE-LOSS — volume rm; recovery from the PG floor ONLY
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_nats_storage_loss() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-NATS-STORAGE-LOSS").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 741, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 742, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;

    // Durable history BEFORE the storage loss.
    let mut acked: Vec<String> = Vec::new();
    for b in 0..5u64 {
        let ops: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(7051 + b, c)).collect();
        acked.extend(write_batch_acked(&mut writer, b, &ops).await);
    }

    // FAULT: stop nats, REMOVE the JetStream data volume, recreate +
    // start. The broker loses EVERYTHING (stream, consumers, backlog).
    assert!(docker(&["stop", DOCKER_NATS]), "stop nats");
    docker_ok(&["volume", "rm", "-f", NATS_JETSTREAM_VOLUME]);
    assert!(
        docker(&["volume", "create", NATS_JETSTREAM_VOLUME]),
        "recreate volume"
    );
    assert!(docker(&["start", DOCKER_NATS]), "start nats");
    assert!(wait_nats_up(60_000).await, "fresh nats up");

    // PG floor intact: every acked op still durable.
    let mut n_durable: i64 = 0;
    for b in 0..5i64 {
        n_durable += db_count(&fixture.doc, 7051 + b).await;
    }
    assert_eq!(n_durable, 15, "PG floor intact through storage loss");

    // A gateway connecting to the FRESH broker re-provisions its
    // stream/consumer idempotently (broker_integration proves the
    // get_or_create path; here a fresh GATEWAY proves it end-to-end).
    let mut gw3 = GatewayProcess::spawn(P_GW2 + 1, 743, Some(NATS_URL));
    let port3 = P_GW2 + 1;
    assert!(
        wait_ready(port3, 20_000).await,
        "gw3 provisions on fresh nats"
    );

    // Catch-up via sync_request recovers EVERYTHING from PG alone.
    let mut late = connect(port3).await;
    handshake_and_join(&mut late, &fixture.clerk, &fixture.doc.to_string()).await;
    send_text(
        &mut late,
        r#"{"v":1,"type":"sync_request","payload":{"cursor":"0"}}"#.into(),
    )
    .await;
    let mut got = 0usize;
    loop {
        let bytes = next_binary(&mut late).await.expect("catch-up");
        if let Ok(sync_gateway::protocol::data::DataFrame::SyncBatch(f)) =
            sync_gateway::protocol::data::DataFrame::decode(&bytes)
        {
            got += f.ops.len();
            if !f.has_more {
                break;
            }
        }
    }
    let done = next_control(&mut late).await;
    assert_eq!(done["type"], "sync_done");

    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2, port3], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "JetStream volume rm'd; durable_rows={n_durable}/15; catchup_via_sync={got}/15; \
         fresh_gateway_provisioned={}; lost={}; divergent={}",
        gateway_alive(port3).await,
        lost.len(),
        divergent.len()
    );
    let ok = n_durable == 15 && got == 15 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(ok, "CH-NATS-STORAGE-LOSS violated: {evidence}");
    finish_scenario(record(
        "CH-NATS-STORAGE-LOSS",
        seed_value,
        "docker stop concord-nats; volume rm concord_nats (JetStream data); volume create + start (fresh broker)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
    gw3.kill();
}
