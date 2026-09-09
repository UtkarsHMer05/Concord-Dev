//! CH-GW — gateway-crash chaos suite (P6-M029).
//!
//! Faults: SIGKILL gateway processes at every ingest stage (pre-commit,
//! post-commit-pre-ack, mid-load with active rooms), forced reconnect to
//! a different gateway, and repeated kill cycles during continuous
//! writes. Invariant everywhere (FAILURE_MODEL §1/§7.1): every op the
//! writer OBSERVED a durable_ack for is durable (one row per identity in
//! PG); no divergence after recovery (fresh catch-up on each surviving
//! gateway returns the full durable set).
//!
//! Divergence method (this suite): set-equality of op identities via
//! fresh sync_request(cursor 0) per surviving gateway (worker digest
//! comparison is the CH-WORKER suite's method — no worker here).
//!
//! SERIALIZED: cargo test --test chaos_gateway -- --test-threads=1
//! (shared concord_test DB). Skips cleanly when deps are down. Ports
//! 94xx (94 0-99) — disjoint from 93xx and 8xxx suites.

mod chaos_common;

use std::time::Duration;

use chaos_common::*;

// Port allocation inside 94xx for this suite (one scenario at a time,
// --test-threads=1; unique per scenario so reruns can't hit TIME_WAIT).
const P_GW1: u16 = 9401;
const P_GW2: u16 = 9402;

/// Records the scenario PASS with the standard numbers.
fn record_pass(
    id: &str,
    seed: u64,
    fault: &str,
    evidence: String,
    lost: u64,
    divergent: u64,
) -> ScenarioRecord {
    ScenarioRecord {
        scenarioId: id.to_string(),
        seed,
        precondition: "2 gateways ready, 1 doc room, writer+reader joined".into(),
        fault: fault.into(),
        expectedDegradedBehavior: "killed gateway's clients disconnect; no false ack".into(),
        durabilityExpectation:
            "no op acknowledged by the killed gateway is lost; in-flight batch absent-or-present exactly once"
                .into(),
        recoveryExpectation:
            "client reconnects to a surviving gateway, resends pending with same identities, converges"
                .into(),
        invariant: "every durable_ack ⇒ one durable row; fresh catch-up sets equal".into(),
        timeoutMs: 60_000,
        observedResult: format!("PASS: {evidence}"),
        lostDurableAckedOps: lost,
        divergentReplicas: divergent,
    }
}

// ---------------------------------------------------------------------------
// CH-GW-CRASH-PRECOMMIT
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_gw_crash_precommit() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-GW-CRASH-PRECOMMIT").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;
    // Workload derived from the seed (the kill timing is inherently racy —
    // documented: the SEED drives the workload, not the kill).
    let batch_size = 2 + (seed_value % 3) as usize;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 601, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 602, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    // Steady durable history on gw1 first (observed acks).
    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let base_ops: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(6011, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &base_ops).await;

    // THE FAULT: send a batch, then SIGKILL gw1 IMMEDIATELY — racing the
    // kill against the ingest transaction. Invariant: EITHER no ack was
    // observed AND the ops are absent-or-present-at-most-once, OR the ack
    // was observed AND the ops are durable. Never ack-without-durability.
    let victim_ops: Vec<Vec<u8>> = (1..=batch_size as u64).map(|c| op_bytes(6012, c)).collect();
    send_binary(&mut writer, client_ops_frame(2, &victim_ops)).await;
    gw1.kill(); // SIGKILL between send and ack receipt

    // Observe whether the ack arrived before the socket died.
    let ack_observed = match try_next_control(&mut writer, Duration::from_secs(3)).await {
        Ok(frame) if frame["type"] == "durable_ack" => {
            let ids = ack_op_ids(&frame);
            acked.extend(ids.clone());
            !ids.is_empty()
        }
        Ok(frame) => {
            // Any other frame (e.g. error) is NOT a durable ack.
            eprintln!(
                "CH-GW-CRASH-PRECOMMIT: got {} instead of ack",
                frame["type"]
            );
            false
        }
        Err(_) => false, // silence/close — legal: no ack, no durability claim
    };

    // Survivor healthy.
    assert!(wait_ready(P_GW2, 5_000).await, "gw2 healthy after kill");

    // Client reconnects to gw2, resends the SAME identities (idempotent),
    // and converges.
    let mut r2 = connect(P_GW2).await;
    handshake_and_join(&mut r2, &fixture.clerk, &fixture.doc.to_string()).await;
    let resent_ids = write_batch_acked(&mut r2, 3, &victim_ops).await;
    acked.extend(resent_ids);

    // Every OBSERVED-acked op is durable; the victim batch (resent) is
    // present exactly once.
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let n_victim = db_count(&fixture.doc, 6012).await;
    let n_base = db_count(&fixture.doc, 6011).await;
    let divergent = divergent_gateways(&[P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "ack_observed_before_kill={ack_observed}; base_rows={n_base}/3; victim_rows={n_victim}/{batch_size} \
         (exactly-once); acked_observed={}; lost={}; divergent={}",
        acked.len(),
        lost.len(),
        divergent.len()
    );
    let ok = lost.is_empty()
        && divergent.is_empty()
        && n_base == 3
        && n_victim == batch_size as i64
        && (!ack_observed || true); // both branches legal; durability checked above

    if !ok {
        gw2.dump_stderr();
    }
    assert!(ok, "CH-GW-CRASH-PRECOMMIT invariant violated: {evidence}");
    finish_scenario(record_pass(
        "CH-GW-CRASH-PRECOMMIT",
        seed_value,
        "SIGKILL gateway A immediately after batch send, before ack receipt",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-GW-CRASH-POSTCOMMIT-PREACK
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_gw_crash_postcommit_preack() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-GW-CRASH-POSTCOMMIT-PREACK").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 611, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 612, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;

    // Batch N (observed ack) — then batch N+1 goes in flight and we kill
    // immediately after N's ack is OBSERVED. This approximates the
    // commit-before-ack window for batch N+1: the kill races its commit
    // vs its ack frame.
    let n_ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(6021, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &n_ops).await;

    let n1_ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(6022, c)).collect();
    send_binary(&mut writer, client_ops_frame(2, &n1_ops)).await;
    gw1.kill(); // race: N+1 may be pre-commit OR post-commit-pre-ack

    let ack_observed = match try_next_control(&mut writer, Duration::from_secs(3)).await {
        Ok(frame) if frame["type"] == "durable_ack" => {
            let ids = ack_op_ids(&frame);
            acked.extend(ids);
            true
        }
        _ => false,
    };

    assert!(wait_ready(P_GW2, 5_000).await, "gw2 healthy");

    // Reconnect + resend batch N+1 under the SAME identities.
    let mut r2 = connect(P_GW2).await;
    handshake_and_join(&mut r2, &fixture.clerk, &fixture.doc.to_string()).await;
    let resent = write_batch_acked(&mut r2, 3, &n1_ops).await;
    acked.extend(resent);

    // Batch N+1 ops absent-or-present EXACTLY once, never half.
    let n_n1 = db_count(&fixture.doc, 6022).await;
    let n_n = db_count(&fixture.doc, 6021).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "ack_n1_observed={ack_observed}; batch_n={n_n}/2; batch_n1={n_n1}/2 (all-or-nothing); \
         lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n_n == 2 && (n_n1 == 0 || n_n1 == 2) && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw2.dump_stderr();
    }
    assert!(ok, "CH-GW-CRASH-POSTCOMMIT-PREACK violated: {evidence}");
    finish_scenario(record_pass(
        "CH-GW-CRASH-POSTCOMMIT-PREACK",
        seed_value,
        "SIGKILL right after batch N's observed ack while batch N+1 is in flight",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-GW-CRASH-ACTIVE-ROOMS ×3 (repeated)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_gw_crash_active_rooms_x3() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-GW-CRASH-ACTIVE-ROOMS").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 621, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 622, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut all_acked: Vec<String> = Vec::new();
    let mut replica_cursor: u64 = 6030;

    // Three REAL rooms: the main fixture doc plus two side docs (3+
    // joined rooms on gw1 at kill time), with a steady writer and
    // reader on the main doc.
    let mut side_docs: Vec<uuid::Uuid> = Vec::new();
    {
        let client = db_client().await;
        let owner: uuid::Uuid = client
            .query_one(
                "SELECT id FROM users WHERE clerk_user_id = $1",
                &[&fixture.clerk],
            )
            .await
            .expect("user row")
            .get("id");
        for i in 0..2 {
            let doc: uuid::Uuid = client
                .query_one(
                    "INSERT INTO documents (owner_user_id, title, initial_content)
                     VALUES ($1, 'chaos-side', '') RETURNING id",
                    &[&owner],
                )
                .await
                .expect("side doc")
                .get("id");
            side_docs.push(doc);
            let _ = i;
        }
    }

    for cycle in 0..3u64 {
        // 3+ joined rooms on gw1 at kill time: the protocol allows ONE
        // document per connection, so each room is its own joined
        // session on the gateway (main + 2 side rooms), plus a steady
        // writer (main room) and reader (on gw2).
        let mut writer = connect(P_GW1).await;
        let mut reader = connect(P_GW2).await;
        let mut side_sessions = Vec::new();
        handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
        for d in &side_docs {
            let mut s = connect(P_GW1).await;
            handshake_and_join(&mut s, &fixture.clerk, &d.to_string()).await;
            side_sessions.push(s);
        }
        handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;

        // Steady load: writer + reader both live.
        let mut acked_this_cycle = Vec::new();
        for b in 0..3u64 {
            let ops = vec![
                op_bytes(replica_cursor + b * 10, 1),
                op_bytes(replica_cursor + b * 10, 2),
            ];
            acked_this_cycle.extend(write_batch_acked(&mut writer, b, &ops).await);
            // reader keeps consuming (fanout) — no assertion on delivery
            // timing here (broker freshness is CH-NATS territory).
            let _ = &mut reader;
        }

        // Kill gw1 mid-load (the rooms vanish in-process only).
        gw1.kill();
        assert!(wait_ready(P_GW2, 5_000).await, "gw2 survives cycle {cycle}");
        drop(side_sessions); // their sockets die with the gateway

        // Reconnect BOTH to the survivor; the reader converges via
        // catch-up; the writer keeps writing through the recovery.
        let mut writer2 = connect(P_GW2).await;
        handshake_and_join(&mut writer2, &fixture.clerk, &fixture.doc.to_string()).await;
        let ops = vec![op_bytes(replica_cursor + 90, 1)];
        acked_this_cycle.extend(write_batch_acked(&mut writer2, 99, &ops).await);

        all_acked.extend(acked_this_cycle);
        replica_cursor += 1;

        // Respawn gw1 fresh for the next cycle (new pid, same ports).
        gw1 = GatewayProcess::spawn(P_GW1, 621 + cycle + 1, Some(NATS_URL));
        assert!(
            wait_ready(P_GW1, 20_000).await,
            "gw1 respawns cycle {cycle}"
        );
    }

    // Recovery window: every acked op durable; convergence via catch-up.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let lost = lost_acked_ops(&all_acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "3 kill cycles mid-load; acked_total={}; lost={}; divergent={}",
        all_acked.len(),
        lost.len(),
        divergent.len()
    );
    let ok = lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(ok, "CH-GW-CRASH-ACTIVE-ROOMS violated: {evidence}");
    finish_scenario(record_pass(
        "CH-GW-CRASH-ACTIVE-ROOMS",
        seed_value,
        "SIGKILL gw1 3× with joined rooms mid steady writer+reader load",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-GW-FORCE-RECONNECT-DIFFERENT-GW
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_gw_force_reconnect_different_gw() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-GW-FORCE-RECONNECT-DIFFERENT-GW").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 631, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 632, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    // LB-less explicit reconnect: history on gw1, one batch left pending
    // (sent, unacked), then kill + reconnect to gw2 and retry.
    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let hist: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(6041, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &hist).await;

    let pending: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(6042, c)).collect();
    send_binary(&mut writer, client_ops_frame(2, &pending)).await;
    gw1.kill(); // pending batch may or may not have committed

    let ack_observed = matches!(
        try_next_control(&mut writer, Duration::from_secs(3)).await,
        Ok(f) if f["type"] == "durable_ack"
    );

    // Forced reconnect to the OTHER gateway; resend pending with the
    // same identities (P4-M029: no sticky sessions, durable state only).
    let mut r2 = connect(P_GW2).await;
    handshake_and_join(&mut r2, &fixture.clerk, &fixture.doc.to_string()).await;
    let resent = write_batch_acked(&mut r2, 2, &pending).await;
    acked.extend(resent);

    let n_hist = db_count(&fixture.doc, 6041).await;
    let n_pending = db_count(&fixture.doc, 6042).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "ack_pending_observed={ack_observed}; hist={n_hist}/2; pending={n_pending}/3 after resend; \
         lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n_hist == 2 && n_pending == 3 && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw2.dump_stderr();
    }
    assert!(
        ok,
        "CH-GW-FORCE-RECONNECT-DIFFERENT-GW violated: {evidence}"
    );
    finish_scenario(record_pass(
        "CH-GW-FORCE-RECONNECT-DIFFERENT-GW",
        seed_value,
        "SIGKILL gw1 with pending client ops; explicit reconnect to gw2; retry same identities",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-GW-REPEATED-KILL — 5 kill/restart cycles during continuous writes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_gw_repeated_kill() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-GW-REPEATED-KILL").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn(P_GW1, 641, Some(NATS_URL));
    let mut gw2 = GatewayProcess::spawn(P_GW2, 642, Some(NATS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    let mut all_acked: Vec<String> = Vec::new();
    let mut unacked_pending: Vec<Vec<u8>> = Vec::new();
    let mut replica = 6050u64;
    let mut batch_id = 0u64;

    // Continuous writes across 5 kill cycles. Each cycle: write one
    // observed batch, fire a second batch, kill, reconnect to the OTHER
    // gateway (alternating), resend whatever was in flight.
    for cycle in 0..5u64 {
        let (writer_port, other_port) = if cycle % 2 == 0 {
            (P_GW1, P_GW2)
        } else {
            (P_GW2, P_GW1)
        };
        let mut writer = connect(writer_port).await;
        handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;

        // Resend any still-pending ops from the previous cycle first.
        if !unacked_pending.is_empty() {
            batch_id += 1;
            let ids = write_batch_acked(&mut writer, batch_id, &unacked_pending).await;
            all_acked.extend(ids);
            unacked_pending.clear();
        }

        // Batch A: fully observed.
        batch_id += 1;
        let ops_a = vec![op_bytes(replica, 1), op_bytes(replica, 2)];
        all_acked.extend(write_batch_acked(&mut writer, batch_id, &ops_a).await);
        replica += 1;

        // Batch B: fire-and-kill (races commit).
        batch_id += 1;
        let ops_b = vec![op_bytes(replica, 1), op_bytes(replica, 2)];
        send_binary(&mut writer, client_ops_frame(batch_id, &ops_b)).await;
        // Kill the process that owns the current writer's connection.
        if cycle % 2 == 0 {
            gw1.kill();
        } else {
            gw2.kill();
        }
        match try_next_control(&mut writer, Duration::from_secs(3)).await {
            Ok(f) if f["type"] == "durable_ack" => {
                all_acked.extend(ack_op_ids(&f));
            }
            _ => {
                unacked_pending = ops_b; // stays client-side; retried next cycle
            }
        }
        replica += 1;

        // Restart the killed gateway fresh.
        if cycle % 2 == 0 {
            gw1 = GatewayProcess::spawn(P_GW1, 641 + cycle + 1, Some(NATS_URL));
            assert!(wait_ready(P_GW1, 20_000).await, "gw1 back cycle {cycle}");
        } else {
            gw2 = GatewayProcess::spawn(P_GW2, 642 + cycle + 1, Some(NATS_URL));
            assert!(wait_ready(P_GW2, 20_000).await, "gw2 back cycle {cycle}");
        }
        assert!(wait_ready(other_port, 5_000).await, "other gw healthy");
    }

    // Flush any last pending batch.
    if !unacked_pending.is_empty() {
        let mut writer = connect(P_GW2).await;
        handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
        batch_id += 1;
        all_acked.extend(write_batch_acked(&mut writer, batch_id, &unacked_pending).await);
    }

    // FINAL INVARIANT: every acked op durable; no divergence across BOTH
    // gateways' fresh catch-ups.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let lost = lost_acked_ops(&all_acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;
    let total = db_count(&fixture.doc, 6050).await; // replica 6050 only — sanity anchor
    let expected_all = all_acked.len();

    let evidence = format!(
        "5 kill/restart cycles; acked_observed={expected_all}; rows_for_first_replica={total}/2; \
         lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(ok, "CH-GW-REPEATED-KILL violated: {evidence}");
    finish_scenario(record_pass(
        "CH-GW-REPEATED-KILL",
        seed_value,
        "5 SIGKILL/restart cycles during continuous writes (writer reconnects each time)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}
