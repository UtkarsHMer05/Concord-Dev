//! Redis ephemeral-tier integration tests (P4-M021/M022/M023/M024/M037).
//!
//! Runs against the live Docker Redis (compose `redis`). Unique namespace
//! per test; skips when Redis is down. Proves: connection lifecycle +
//! bounded ops, TTL presence (upsert/count/remove), cross-gateway rate
//! limiting (two limiter instances sharing Redis see ONE counter), local
//! fallback on a dead Redis URL, and the FLUSHALL wipe (M037: no durable
//! impact — this file only owns ephemeral keys; the durable-side proof
//! lives in the DB tests, unaffected by Redis).

use std::time::Duration;

use uuid::Uuid;

use sync_gateway::ephemeral::presence::PresenceStore;
use sync_gateway::ephemeral::ratelimit::{RateLimitOutcome, RateLimiter};
use sync_gateway::ephemeral::{RedisConfig, RedisHandle};

const REDIS_URL: &str = "redis://127.0.0.1:6379";

async fn handle(ns: &str) -> Option<RedisHandle> {
    RedisHandle::connect(&RedisConfig {
        url: REDIS_URL.to_owned(),
        namespace: ns.to_owned(),
    })
    .await
    .ok()
}

/// FLUSHALL in the wipe test is global — serialize the whole file so the
/// wipe cannot race the other Redis tests inside this binary.
static FILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn file_lock() -> std::sync::MutexGuard<'static, ()> {
    FILE_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

#[tokio::test]
async fn presence_upsert_count_remove_with_ttl() {
    let _guard = file_lock();
    let ns = format!("it{}", Uuid::new_v4().simple());
    let Some(redis) = handle(&ns).await else {
        eprintln!("SKIP: redis down");
        return;
    };
    let store = PresenceStore::new(redis);
    let doc = Uuid::new_v4();
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();

    // Empty initially.
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 0);

    // Upsert two users; count reflects them.
    store.upsert(doc, a, 1).await.unwrap();
    store.upsert(doc, b, 2).await.unwrap();
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 2);

    // Remove one; count drops.
    store.remove(doc, a).await.unwrap();
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 1);

    // TTL is set: the key has an expiry (authoritative staleness floor).
    // (Verified indirectly: the ops succeed; TTL asserted via the Redis
    // TTL command in the raw handle below.)
    let mut conn = raw_redis_conn();
    let key = format!("concord:{ns}:presence:{doc}:{}", b);
    let ttl: i64 = redis::cmd("TTL")
        .arg(&key)
        .query(&mut conn)
        .expect("ttl query");
    assert!(ttl > 0 && ttl <= 60, "presence TTL present (got {ttl})");
}

fn raw_redis_conn() -> redis::Connection {
    let client = redis::Client::open(REDIS_URL).expect("client");
    client.get_connection().expect("conn")
}

#[tokio::test]
async fn distributed_rate_limit_across_instances() {
    let _guard = file_lock();
    let ns = format!("it{}", Uuid::new_v4().simple());
    let Some(redis) = handle(&ns).await else {
        eprintln!("SKIP: redis down");
        return;
    };
    // TWO limiter instances (as two gateways would have) sharing Redis.
    let mut policies = sync_gateway::ephemeral::ratelimit::default_policies();
    policies.insert(
        "test",
        sync_gateway::ephemeral::ratelimit::RateLimitPolicy {
            max_events: 3,
            window: Duration::from_secs(60),
        },
    );
    let l1 = RateLimiter::new(Some(redis.clone()), policies.clone());
    let l2 = RateLimiter::new(Some(redis), policies);

    // A client alternating between "gateways" hits ONE global budget.
    for i in 0..3 {
        assert_eq!(
            l1.check("test", "user-1").await,
            RateLimitOutcome::Allowed,
            "event {i}"
        );
    }
    // The 4th event — seen through the OTHER instance — is limited:
    // the budget cannot be evaded by landing on another gateway (M023).
    assert_eq!(l2.check("test", "user-1").await, RateLimitOutcome::Limited);

    // A different principal has an independent budget.
    assert_eq!(l2.check("test", "user-2").await, RateLimitOutcome::Allowed);
}

#[tokio::test]
async fn local_fallback_when_redis_is_down() {
    // A limiter pointed at a DEAD Redis: every op fails → local fallback.
    let dead = RedisHandle::connect(&RedisConfig {
        url: "redis://127.0.0.1:59999".to_owned(),
        namespace: "dead".to_owned(),
    })
    .await;
    assert!(
        dead.is_err(),
        "dead redis must fail connect (explicit degraded start)"
    );

    // Construct a limiter with NO Redis (the degraded runtime state) and
    // prove the local window still bounds abuse (M024).
    let mut policies = sync_gateway::ephemeral::ratelimit::default_policies();
    policies.insert(
        "test",
        sync_gateway::ephemeral::ratelimit::RateLimitPolicy {
            max_events: 2,
            window: Duration::from_secs(60),
        },
    );
    let limiter = RateLimiter::new(None, policies);
    assert_eq!(
        limiter.check("test", "abuser").await,
        RateLimitOutcome::Allowed
    );
    assert_eq!(
        limiter.check("test", "abuser").await,
        RateLimitOutcome::Allowed
    );
    assert_eq!(
        limiter.check("test", "abuser").await,
        RateLimitOutcome::Limited
    );
    // Different principal unaffected.
    assert_eq!(
        limiter.check("test", "other").await,
        RateLimitOutcome::Allowed
    );
}

#[tokio::test]
async fn full_wipe_loses_nothing_durable_and_presence_rebuilds() {
    let _guard = file_lock();
    // M037 (ephemeral side): FLUSHALL clears presence + counters only;
    // they REBUILD from live traffic immediately; nothing durable is
    // stored in Redis by design (document/ACL/op-log never touch it).
    let ns = format!("wipe{}", Uuid::new_v4().simple());
    let Some(redis) = handle(&ns).await else {
        eprintln!("SKIP: redis down");
        return;
    };
    let store = PresenceStore::new(redis.clone());
    let doc = Uuid::new_v4();
    store.upsert(doc, Uuid::new_v4(), 1).await.unwrap();
    assert!(store.document_presence_count(doc).await.unwrap() >= 1);

    // WIPE everything.
    let mut conn = raw_redis_conn();
    redis::cmd("FLUSHALL")
        .query::<()>(&mut conn)
        .expect("flush");

    // Presence gone (ephemeral by definition).
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 0);

    // Rebuilds immediately from live heartbeats/upserts.
    store.upsert(doc, Uuid::new_v4(), 2).await.unwrap();
    store.upsert(doc, Uuid::new_v4(), 3).await.unwrap();
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 2);

    // Durable proof (outside Redis by design): a Postgres row count is
    // unaffected by the wipe — demonstrated in db tests; here we assert
    // the Redis key space contains ONLY concord-ephemeral keys.
    let keys: Vec<String> = redis::cmd("KEYS").arg("*").query(&mut conn).expect("keys");
    for key in &keys {
        assert!(
            key.starts_with("concord:"),
            "no un-namespaced keys allowed: {key}"
        );
    }
}
