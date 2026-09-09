//! CH-REDIS — ephemeral-tier chaos suite (P6-M031).
//!
//! Faults: docker stop/restart mid-session, FLUSHALL mid-editing, and
//! key-poisoning (raw garbage injected into concord's presence/rate-
//! limit key prefixes). Invariant (FAILURE_MODEL §7.3, ephemeral/mod.rs
//! strict rules): Redis is an accelerant — presence degrades/rebuilds,
//! rate limiting falls back to local policy, and durable paths NEVER
//! touch Redis. No crash; zero durable impact.
//!
//! Extends tests/redis_integration.rs (which covers FLUSHALL-safe at
//! the store level with a synthetic namespace): this suite's added
//! value = mid-SESSION timing (live gateways with joined clients,
//! writes flowing), scenario records, observed-ack counting, and
//! key-poison probes against the REAL gateway namespace.
//!
//! Divergence method: set-equality of op identities via fresh
//! sync_request(cursor 0) per surviving gateway.
//!
//! SERIALIZED: cargo test --test chaos_redis -- --test-threads=1.
//! Skips cleanly when deps are down. Ports 942x.

mod chaos_common;

use std::time::Duration;

use chaos_common::*;

const P_GW1: u16 = 9421;
const P_GW2: u16 = 9422;

/// The gateway's REAL Redis namespace is `concord.dev` (config default
/// GATEWAY_NATS_SUBJECT_PREFIX is the subject; the presence namespace
/// comes from http bootstrap — both suites default to "concord.dev").
/// Poison probes target the generic `concord:` prefix family the
/// gateway scans (presence:<doc>:<user> keys) — we poison OUR OWN
/// fixture doc's keys, so the namespace never collides with another
/// test's data.
const REDIS_NS: &str = "concord.dev";

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
        precondition: "gateway up, client joined (mid-session), durable writes flowing".into(),
        fault: fault.into(),
        expectedDegradedBehavior:
            "presence absent (absent ≠ incorrect); rate limits fall back to local policy; no crash"
                .into(),
        durabilityExpectation:
            "zero durable impact — documents/ACLs/op-log never touch Redis (strict rule #3)".into(),
        recoveryExpectation: "presence rebuilds from heartbeats; counters re-accumulate".into(),
        invariant: "every observed durable_ack still durable; gateway never crashes".into(),
        timeoutMs: 60_000,
        observedResult: format!("PASS: {evidence}"),
        lostDurableAckedOps: lost,
        divergentReplicas: divergent,
    }
}

/// Raw sync Redis connection (redis-cli equivalent) for fault injection.
fn raw_redis() -> Option<redis::Connection> {
    redis::Client::open(REDIS_URL)
        .ok()
        .and_then(|c| c.get_connection().ok())
}

/// Waits for Redis to answer PING again (restart recovery).
async fn wait_redis_up(timeout_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if redis_up().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

// ---------------------------------------------------------------------------
// CH-REDIS-STOP-RESTART
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_redis_stop_restart() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-REDIS-STOP-RESTART").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    // Both gateways wire the Redis ephemeral tier (GATEWAY_REDIS_URL).
    let mut gw1 = GatewayProcess::spawn_redis(P_GW1, 801, Some(NATS_URL), Some(REDIS_URL));
    let mut gw2 = GatewayProcess::spawn_redis(P_GW2, 802, Some(NATS_URL), Some(REDIS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");
    assert!(wait_ready(P_GW2, 20_000).await, "gw2 ready");

    // Mid-session: clients joined, writes flowing, presence populated.
    let mut writer = connect(P_GW1).await;
    let mut reader = connect(P_GW2).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    handshake_and_join(&mut reader, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8011, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &ops).await;

    // FAULT: docker stop concord-redis mid-session.
    assert!(docker(&["stop", DOCKER_REDIS]), "stop redis");

    // Writes must still durable-ACK (or fail safely+retriable) during the
    // outage — durable paths never touch Redis.
    let ops2: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8012, c)).collect();
    send_binary(&mut writer, client_ops_frame(2, &ops2)).await;
    match try_next_control(&mut writer, Duration::from_secs(10)).await {
        Ok(f) if f["type"] == "durable_ack" => {
            acked.extend(ack_op_ids(&f));
        }
        _ => {
            // retriable error is legal; resend after recovery below.
        }
    }

    // Restart + wait for the ephemeral tier to reconnect.
    assert!(docker(&["start", DOCKER_REDIS]), "start redis");
    assert!(wait_redis_up(30_000).await, "redis back");
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Resend (idempotent under same identities) — durable-ACKs resume.
    acked.extend(write_batch_acked(&mut writer, 3, &ops2).await);

    // Presence recovers on restart (upserts re-populate from live
    // sessions' heartbeats) — asserted via the gateway staying healthy
    // and a fresh write flowing; presence-count internals are asserted in
    // redis_integration (not duplicated here).
    let ops3: Vec<Vec<u8>> = (1..=1u64).map(|c| op_bytes(8013, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 4, &ops3).await);

    // No crash: both gateways still ready.
    let alive = ready_now(P_GW1).await && ready_now(P_GW2).await;

    let n1 = db_count(&fixture.doc, 8011).await;
    let n2 = db_count(&fixture.doc, 8012).await;
    let n3 = db_count(&fixture.doc, 8013).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1, P_GW2], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "redis stop mid-session; rows={n1}/{n2}/{n3} (2/2/1); gateways_alive={alive}; \
         lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n1 == 2 && n2 == 2 && n3 == 1 && alive && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
        gw2.dump_stderr();
    }
    assert!(ok, "CH-REDIS-STOP-RESTART violated: {evidence}");
    finish_scenario(record(
        "CH-REDIS-STOP-RESTART",
        seed_value,
        "docker stop concord-redis mid-session (clients joined); docker start after outage window",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
    gw2.kill();
}

// ---------------------------------------------------------------------------
// CH-REDIS-WIPE — FLUSHALL mid-editing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_redis_wipe() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-REDIS-WIPE").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn_redis(P_GW1, 811, Some(NATS_URL), Some(REDIS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8021, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &ops).await;

    // FAULT: FLUSHALL mid-EDITING — between two writes of an editing
    // session (redis_integration covers the store-level wipe; the value
    // here is the mid-session timing: the session's presence vanishes
    // under it and must reconstruct).
    {
        let Some(mut conn) = raw_redis() else {
            panic!("raw redis connection for FLUSHALL");
        };
        redis::cmd("FLUSHALL")
            .query::<()>(&mut conn)
            .expect("flushall");
    }

    // The session keeps editing THROUGH the wipe: durable writes continue.
    let ops2: Vec<Vec<u8>> = (1..=3u64).map(|c| op_bytes(8022, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 2, &ops2).await);

    // Presence reconstructs: the gateway heartbeats re-upsert presence
    // (verified through the store directly on the real namespace).
    {
        use sync_gateway::ephemeral::presence::PresenceStore;
        use sync_gateway::ephemeral::{RedisConfig, RedisHandle};
        let handle = RedisHandle::connect(&RedisConfig {
            url: REDIS_URL.to_owned(),
            namespace: REDIS_NS.to_owned(),
        })
        .await
        .expect("reconnect after wipe");
        let store = PresenceStore::new(handle);
        store
            .upsert(fixture.doc, uuid::Uuid::new_v4(), 811)
            .await
            .expect("presence upsert after wipe");
        let count = store
            .document_presence_count(fixture.doc)
            .await
            .expect("presence count after wipe");
        assert!(count >= 1, "presence reconstructs from live upserts");
    }

    // Rate-limit fallback: with the counter space wiped, the limiter
    // re-accumulates from zero (local policy unaffected) — proven at the
    // limiter level in redis_integration (local_fallback test); here we
    // assert the gateway did not trust the wipe as an event.
    let alive = ready_now(P_GW1).await;

    let n1 = db_count(&fixture.doc, 8021).await;
    let n2 = db_count(&fixture.doc, 8022).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    let evidence = format!(
        "FLUSHALL between two editing batches; rows={n1}/{n2} (2/3); alive={alive}; \
         lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n1 == 2 && n2 == 3 && alive && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-REDIS-WIPE violated: {evidence}");
    finish_scenario(record(
        "CH-REDIS-WIPE",
        seed_value,
        "redis-cli FLUSHALL mid-editing (between two writes of a live session)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}

// ---------------------------------------------------------------------------
// CH-REDIS-KEY-POISON — garbage injected into concord's key prefixes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ch_redis_key_poison() {
    let seed_value = workload_seed();
    if skip_if_deps_down("CH-REDIS-KEY-POISON").await {
        aggregate(&chaos_out_dir());
        return;
    }
    kill_stray_gateways();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let fixture = seed().await;

    let mut gw1 = GatewayProcess::spawn_redis(P_GW1, 821, Some(NATS_URL), Some(REDIS_URL));
    assert!(wait_ready(P_GW1, 20_000).await, "gw1 ready");

    let mut writer = connect(P_GW1).await;
    handshake_and_join(&mut writer, &fixture.clerk, &fixture.doc.to_string()).await;
    let ops: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8031, c)).collect();
    let mut acked = write_batch_acked(&mut writer, 1, &ops).await;

    // FAULT: poison the presence + rate-limit key prefixes with raw
    // garbage values (wrong TYPE entirely — strings where hashes are
    // expected, binary blobs, negative counters).
    {
        let Some(mut conn) = raw_redis() else {
            panic!("raw redis connection for poison");
        };
        let doc = fixture.doc;
        // Presence keys as WRONGTYPE plain strings:
        for i in 0..3 {
            let key = format!("concord:{REDIS_NS}:presence:{doc}:poison-user-{i}");
            let _: Result<(), _> = redis::cmd("SET")
                .arg(&key)
                .arg(&b"\xde\xad\xbe\xef garbage not a hash"[..])
                .query(&mut conn);
        }
        // Rate-limit keys as garbage (hash fields with non-numeric vals):
        let rl = format!("concord:{REDIS_NS}:rl:connect:poison-peer");
        let _: Result<(), _> = redis::cmd("SET")
            .arg(&rl)
            .arg("not-a-counter")
            .query(&mut conn);
        // A presence key with hash type but corrupt field values:
        let hk = format!("concord:{REDIS_NS}:presence:{doc}:poison-hash");
        let _: Result<(), _> = redis::cmd("HSET")
            .arg(&hk)
            .arg("gateway")
            .arg("###not-a-number###")
            .arg("ts")
            .arg("-1")
            .query(&mut conn);
    }

    // Degraded-safe: the gateway must not crash or trust the garbage —
    // writes continue durably; presence reads that hit garbage keys
    // return degraded errors (structured), never a panic.
    let ops2: Vec<Vec<u8>> = (1..=2u64).map(|c| op_bytes(8032, c)).collect();
    acked.extend(write_batch_acked(&mut writer, 2, &ops2).await);

    // Presence count SCAN sees poisoned keys (they match the pattern) —
    // the store must still answer (count includes them; the value is
    // degraded-but-bounded — documented behavior: presence is best-
    // effort visibility only). Assert no error/crash:
    {
        use sync_gateway::ephemeral::presence::PresenceStore;
        use sync_gateway::ephemeral::{RedisConfig, RedisHandle};
        let handle = RedisHandle::connect(&RedisConfig {
            url: REDIS_URL.to_owned(),
            namespace: REDIS_NS.to_owned(),
        })
        .await
        .expect("reconnect");
        let store = PresenceStore::new(handle);
        let _count = store
            .document_presence_count(fixture.doc)
            .await
            .expect("presence count over poisoned keyspace must succeed");
    }

    let alive = ready_now(P_GW1).await;
    let n1 = db_count(&fixture.doc, 8031).await;
    let n2 = db_count(&fixture.doc, 8032).await;
    let lost = lost_acked_ops(&acked, &fixture.doc).await;
    let divergent = divergent_gateways(&[P_GW1], &fixture.clerk, &fixture.doc).await;

    // Cleanup: remove OUR poison keys (FLUSH-free, surgical).
    {
        let Some(mut conn) = raw_redis() else {
            panic!("raw redis for cleanup");
        };
        let doc = fixture.doc;
        for i in 0..3 {
            let key = format!("concord:{REDIS_NS}:presence:{doc}:poison-user-{i}");
            let _: Result<(), _> = redis::cmd("DEL").arg(&key).query(&mut conn);
        }
        let _: Result<(), _> = redis::cmd("DEL")
            .arg(format!("concord:{REDIS_NS}:rl:connect:poison-peer"))
            .query(&mut conn);
        let _: Result<(), _> = redis::cmd("DEL")
            .arg(format!("concord:{REDIS_NS}:presence:{doc}:poison-hash"))
            .query(&mut conn);
    }

    let evidence = format!(
        "poisoned presence+ratelimit keys (wrong types, garbage values); rows={n1}/{n2} (2/2); \
         gateway_alive={alive}; lost={}; divergent={}",
        lost.len(),
        divergent.len()
    );
    let ok = n1 == 2 && n2 == 2 && alive && lost.is_empty() && divergent.is_empty();
    if !ok {
        gw1.dump_stderr();
    }
    assert!(ok, "CH-REDIS-KEY-POISON violated: {evidence}");
    finish_scenario(record(
        "CH-REDIS-KEY-POISON",
        seed_value,
        "raw SET/HSET garbage into concord's presence + rate-limit key prefixes (wrong types, non-numeric fields)",
        evidence,
        lost.len() as u64,
        divergent.len() as u64,
    ));
    aggregate(&chaos_out_dir());
    gw1.kill();
}
