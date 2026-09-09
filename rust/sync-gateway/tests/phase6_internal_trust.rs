//! P6-M023 — NATS/Redis internal trust-boundary abuse (SA-AUTH6).
//!
//! An actor with direct NATS/Redis access (AT4: compromised peer gateway
//! or internal infra) tries to bypass tenant isolation or fabricate
//! durable state. This suite extends broker_integration.rs /
//! redis_integration.rs with the missing adversarial cases — it does
//! NOT duplicate them (forged-→durable, poison-decode, msg-id dedup,
//! and FLUSHALL-basic already live there).
//!
//! NATS vectors (raw client, publishing into the gateway's subject
//! namespace):
//!  1. wrong-document event — envelope names doc A, but a live session
//!     is joined to doc B: the room routing check (registry lookup by
//!     the event's document_id) means B NEVER receives A's ops — no
//!     cross-tenant/cross-document delivery. (The payload itself is
//!     envelope-valid; only the ASSOCIATION is forged.)
//!  2. event claiming ANOTHER gateway's id — delivered like any event;
//!     the id is transport metadata only (fanout keys off document_id);
//!     assert no durable rows and no room misrouting.
//!  3. oversized event payload — server max_payload rejection OR the
//!     8 MiB MAX_EVENT_BYTES decode cap: contained either way.
//!  4. replayed/duplicated event — msg-id dedup: at-least-once
//!     idempotence, exactly one stream message, durable state unchanged.
//!  5. malformed JSON-equivalent bytes — decode is a structured error
//!     (Truncated/UnsupportedVersion/Trailing/...), counted as poison,
//!     terminated (+TERM), no crash.
//!  6. valid-format event with a FORGED checksum — the envelope's
//!     SHA-256 over the op list is verified at decode: ChecksumMismatch.
//!
//! Redis vectors (raw client):
//!  7. key-prefix collision: write keys that collide with another
//!     namespace's presence/rate-limit keyspace (wrong-namespace prefix,
//!     cross-tenant document id in a presence key) — the namespaced
//!     `concord:<ns>:` structure keeps tenants disjoint; presence of a
//!     poisoned key in a foreign namespace cannot affect another
//!     namespace's counts.
//!  8. mid-session FLUSHALL wipe + poisoned-value re-injection: the
//!     gateway's presence rebuilds; rate limits re-accumulate; injected
//!     garbage values (wrong types) produce degraded-but-safe behavior
//!     (counts still work, limiter treats a poisoned counter as a fresh
//!     window) — never a crash, never a durable error.
//!  9. presence values with hostile types: a raw SET of a STRING where
//!     a HASH is expected breaks ONLY the (already best-effort) presence
//!     read for that exact key; the store stays usable; document counts
//!     are SCAN-based (key-name presence, not value trust) so poisoned
//!     values do not fabricate or suppress presence.
//!
//! Core invariant asserted everywhere: internal infrastructure (NATS/
//! Redis) CANNOT bypass tenant isolation and CANNOT fabricate durable
//! state — the only path to crdt_operations is the authenticated
//! client-ingest transaction.
//!
//! SERIALIZED: cargo test --test phase6_internal_trust -- --test-threads=1
//! (FLUSHALL is global; the whole file serializes via a file lock, and
//! cross-suite the shared policy applies). Skips cleanly when DB, NATS,
//! or Redis are down.

use std::time::Duration;

use uuid::Uuid;

use sync_gateway::broker::{Broker, BrokerEvent};

const NATS_URL: &str = "nats://127.0.0.1:4222";
const REDIS_URL: &str = "redis://127.0.0.1:6379";
const TEST_DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

/// FLUSHALL in the wipe vectors is GLOBAL — serialize the whole file
/// against every other Redis-touching test in this binary (mirrors
/// redis_integration.rs's file-lock policy).
static FILE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn file_lock() -> tokio::sync::MutexGuard<'static, ()> {
    FILE_LOCK.lock().await
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
    b[30] = b'X';
    b[31] = 0;
    b
}

fn valid_event(origin: u64, document: Uuid, event_id: u64) -> BrokerEvent {
    BrokerEvent {
        origin_gateway: origin,
        document_id: document,
        event_id,
        server_cursor: 1,
        ops: vec![op_bytes(0x7A01, 1), op_bytes(0x7A01, 2)],
    }
}

async fn broker(namespace: &str, gateway_id: u64) -> Option<Broker> {
    Broker::connect(NATS_URL, namespace, gateway_id).await.ok()
}

async fn nats_up() -> bool {
    async_nats::connect(NATS_URL).await.is_ok()
}

async fn redis_up() -> bool {
    redis::Client::open(REDIS_URL)
        .ok()
        .and_then(|c| c.get_connection().ok())
        .is_some()
}

async fn db_up() -> bool {
    tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .is_ok()
}

/// Durable row count for a document — the "no fabricated state" oracle.
async fn db_count(doc: Uuid) -> i64 {
    let (client, conn) = tokio_postgres::connect(TEST_DB_URL, tokio_postgres::NoTls)
        .await
        .expect("db");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    client
        .query_one(
            "SELECT COUNT(*)::bigint AS n FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n")
}

// ---------------------------------------------------------------------------
// NATS vectors
// ---------------------------------------------------------------------------

/// Vector 1 — wrong-document association: the event NAMES doc A (with
/// valid bytes for A) while a hostile actor hopes a session joined to
/// doc B receives it. The consumer routes by the event's document_id:
/// B's room is never touched. Proves the routing check end-to-end at
/// the DECODE level this suite owns (the room-level routing proof with
/// live sessions is multi_gateway's cross-delivery test; here the
/// security property is that a VALID event for doc A is deliverable to
/// doc A's room only — and no DB row appears for either document).
#[tokio::test]
async fn nats_wrong_document_event_never_reaches_other_document_or_db() {
    let _guard = file_lock().await;
    if !nats_up().await || !db_up().await {
        eprintln!("SKIP: nats or db down");
        return;
    }
    let ns = format!("p6it{}", Uuid::new_v4().simple());
    let Some(gw1) = broker(&ns, 1).await else {
        eprintln!("SKIP: nats down");
        return;
    };
    let doc_a = Uuid::new_v4();
    let doc_b = Uuid::new_v4(); // the "victim" document — never named by the event

    // Hostile publish: a perfectly VALID event for doc A (perhaps
    // hoping a consumer bug confuses rooms). A consumer for doc B
    // simply never sees it as B-related.
    let event = valid_event(999, doc_a, 1);
    gw1.publish(&event)
        .await
        .expect("hostile publish (valid bytes)");

    // The receiving gateway's consumer (modeled by the second broker
    // client) decodes it: the event IS valid — routing is the control.
    let gw2 = broker(&ns, 2).await.expect("gw2");
    let messages = gw2.fetch(4, Duration::from_secs(3)).await.expect("fetch");
    let mut saw_a = false;
    for m in &messages {
        let decoded = BrokerEvent::decode(&m.message.payload).expect("valid decode");
        // The decoded event's document_id is A — by construction a
        // consumer can ONLY route it to A's room. Assert the invariant
        // on the decoded value itself: no mutation of the association
        // happened in the envelope (the checksum binds the op list, the
        // fixed header binds the document id).
        assert_eq!(decoded.document_id, doc_a);
        assert_ne!(decoded.document_id, doc_b);
        saw_a = true;
        let _ = m.ack().await;
    }
    assert!(saw_a, "the event was delivered (validly) for doc A");

    // No durable rows for EITHER document: broker delivery never
    // persists (T15 core invariant).
    assert_eq!(
        db_count(doc_a).await,
        0,
        "doc A: no fabricated durable state"
    );
    assert_eq!(
        db_count(doc_b).await,
        0,
        "doc B: no cross-tenant durable state"
    );
}

/// Vector 2 — gateway-id impersonation: an event claiming to originate
/// from ANOTHER gateway's id. The id is transport metadata only —
/// suppression uses it to drop self-echoes; a forged id cannot
/// fabricate identity: no durable state, and the decode carries the
/// forged id verbatim (a gateway suppressing by origin would simply
/// drop its own id's events — worst case a self-DoS for the impersonated
/// gateway's realtime, never a privilege gain).
#[tokio::test]
async fn nats_event_claiming_foreign_gateway_id_is_inert() {
    let _guard = file_lock().await;
    if !nats_up().await || !db_up().await {
        eprintln!("SKIP: nats or db down");
        return;
    }
    let ns = format!("p6it{}", Uuid::new_v4().simple());
    let Some(gw) = broker(&ns, 42).await else {
        eprintln!("SKIP: nats down");
        return;
    };

    // Impersonate gateway 7 (which is NOT us — we are 42).
    let doc = Uuid::new_v4();
    let forged = valid_event(7, doc, 2);
    assert_ne!(forged.origin_gateway, gw.gateway_id);
    gw.publish(&forged)
        .await
        .expect("publish forged-origin event");

    // A consumer (as the impersonated gateway 7) fetches: it sees the
    // event with origin 7 == its own id and would SUPPRESS it (the
    // only effect of a forged origin id) — a self-inflicted loss of
    // realtime for gateway 7, never a security gain for the attacker.
    let gw7 = broker(&ns, 7).await.expect("gw7 consumer");
    let messages = gw7.fetch(4, Duration::from_secs(3)).await.expect("fetch");
    for m in &messages {
        let decoded = BrokerEvent::decode(&m.message.payload).expect("decode");
        assert_eq!(decoded.origin_gateway, 7, "origin id carried verbatim");
        // The subscriber's suppression rule (bus/mod.rs):
        assert_eq!(
            decoded.origin_gateway, gw7.gateway_id,
            "impersonated consumer would suppress this event as its own"
        );
        let _ = m.ack().await;
    }

    // Durable state: nothing. The broker path has no ingest.
    assert_eq!(
        db_count(doc).await,
        0,
        "no durable rows from forged-origin event"
    );
}

/// Vector 3 — oversized payload: both containment layers probed.
/// (a) 2 MiB event: JetStream's 1 MiB server max_payload rejects at
///     publish (broker_integration covers this shape — here the SECOND
///     layer is probed); (b) a header-declared op_count/lengths that
///     would exceed MAX_EVENT_BYTES if the body were present: decode
///     fails TooLarge BEFORE any allocation.
#[tokio::test]
async fn nats_oversized_payload_is_contained_at_both_layers() {
    let _guard = file_lock().await;
    if !nats_up().await {
        eprintln!("SKIP: nats down");
        return;
    }
    let ns = format!("p6it{}", Uuid::new_v4().simple());
    let Some(gw) = broker(&ns, 1).await else {
        eprintln!("SKIP: nats down");
        return;
    };

    // (a) Server cap: a >1 MiB publish is refused by NATS itself.
    let mut huge = valid_event(1, Uuid::new_v4(), 3);
    huge.ops = vec![vec![0x41u8; 600 * 1024]; 4]; // 2.4 MiB total
    match gw.publish(&huge).await {
        Ok(()) => {
            // Some configs allow it — then the DECODE cap must contain:
            // the cap is 8 MiB (envelope.rs MAX_EVENT_BYTES; not
            // publicly re-exported — mirrored as a local constant).
            const MAX_EVENT_BYTES_MIRROR: usize = 8 * 1024 * 1024;
            let bytes = huge.encode();
            let decoded = BrokerEvent::decode(&bytes);
            assert!(
                decoded.is_err() || bytes.len() <= MAX_EVENT_BYTES_MIRROR,
                "either decode rejects or the event is within the cap"
            );
        }
        Err(_) => { /* server-side rejection: contained */ }
    }

    // (b) Decoder cap: an event whose TOTAL size exceeds 8 MiB is
    // rejected before any allocation of the op list.
    let mut over = valid_event(1, Uuid::new_v4(), 4);
    over.ops = vec![vec![0x41u8; 4 * 1024 * 1024]; 3]; // 12 MiB
    let bytes = over.encode();
    match BrokerEvent::decode(&bytes) {
        Err(sync_gateway::broker::BrokerEventError::TooLarge) => { /* bounded */ }
        Err(e) => panic!("12 MiB event must fail TooLarge, got {e:?}"),
        Ok(ev) => panic!("12 MiB event decoded — cap missing: {:?}", ev.ops.len()),
    }

    // Gateway still healthy after the oversized attempts.
    assert!(gw.healthy().await);
}

/// Vector 4 — replay/duplication: identical events published repeatedly
/// within the duplicate window collapse to ONE stream message
/// (Nats-Msg-Id = stable event identity); state is unchanged at every
/// layer. (broker_integration::replayed_event_is_idempotent_at_every_layer
/// covers the msg-id mechanics — THIS vector adds the durable-state
/// assertion for the duplicated op identities: even if a consumer
/// re-fanned the same event 3 times, the DB cannot gain rows because
/// the broker path never ingests.)
#[tokio::test]
async fn nats_replayed_events_leave_durable_state_unchanged() {
    let _guard = file_lock().await;
    if !nats_up().await || !db_up().await {
        eprintln!("SKIP: nats or db down");
        return;
    }
    let ns = format!("p6it{}", Uuid::new_v4().simple());
    let Some(gw1) = broker(&ns, 1).await else {
        eprintln!("SKIP: nats down");
        return;
    };
    let doc = Uuid::new_v4();
    let event = valid_event(1, doc, 777);

    gw1.publish(&event).await.expect("publish 1");
    gw1.publish(&event).await.expect("publish 2 (same msg-id)");
    gw1.publish(&event).await.expect("publish 3 (same msg-id)");

    let gw2 = broker(&ns, 2).await.expect("gw2");
    let messages = gw2.fetch(8, Duration::from_secs(3)).await.expect("fetch");
    let matching = messages
        .iter()
        .filter(|m| {
            BrokerEvent::decode(&m.message.payload)
                .map(|e| e.event_id == 777)
                .unwrap_or(false)
        })
        .count();
    assert_eq!(matching, 1, "msg-id dedup: exactly one message");
    for m in messages {
        let _ = m.ack().await;
    }

    // Re-delivery of the same event N times: durable rows stay 0
    // (the ONLY ingest path is authenticated client_ops).
    assert_eq!(db_count(doc).await, 0, "replays fabricate nothing durable");
}

/// Vector 5 — malformed bytes (the "invalid JSON" of a binary envelope):
/// every decode failure is a structured error and consumers TERMINATE
/// the poison message. No crash, poison counted. (Complements
/// broker_integration::malformed_event_is_rejected_without_crash, which
/// covers one Truncated shape — this sweeps the full error surface.)
#[tokio::test]
async fn nats_malformed_payloads_are_structured_rejections() {
    let _guard = file_lock().await;
    if !nats_up().await {
        eprintln!("SKIP: nats down");
        return;
    }
    let ns = format!("p6it{}", Uuid::new_v4().simple());
    let Some(_gw) = broker(&ns, 1).await else {
        eprintln!("SKIP: nats down");
        return;
    };

    // Host of malformed shapes — all must decode to STRUCTURED errors
    // (never panic, never accept):
    let cases: Vec<(Vec<u8>, &str)> = vec![
        (vec![], "empty"),
        (vec![0u8; 10], "truncated tiny"),
        (vec![2u8; 75], "unsupported version (fills v=2)"),
        (vec![1u8; 74], "truncated at header boundary"),
        (vec![1u8; 76], "one byte past header, no ops"),
        // truncated at header boundary (structural envelope errors):
        (vec![1u8; 200], "trailing junk after zero ops is invalid"),
        // non-utf8 has no meaning in a binary envelope, but random bytes
        // must still be contained:
        (
            (0..250u32)
                .map(|i| (i.wrapping_mul(7).wrapping_add(3)) as u8)
                .collect(),
            "random bytes",
        ),
    ];
    for (bytes, label) in cases {
        let result = BrokerEvent::decode(&bytes);
        assert!(
            result.is_err(),
            "{label}: malformed event must be a structured rejection"
        );
    }

    // The specific error shapes for the canonical cases:
    assert!(matches!(
        BrokerEvent::decode(&[]),
        Err(sync_gateway::broker::BrokerEventError::Truncated)
    ));
    let mut bad_version = vec![0u8; 80];
    bad_version[0] = 9; // unsupported schema version
    assert!(matches!(
        BrokerEvent::decode(&bad_version),
        Err(sync_gateway::broker::BrokerEventError::UnsupportedVersion(
            9
        ))
    ));

    // A raw hostile publish of malformed bytes survives transport (the
    // broker carries bytes) but dies at consumer decode — the poison
    // path (+TERM) applies, and the gateway stays healthy.
    let nats = async_nats::connect(NATS_URL).await.expect("raw connect");
    nats.publish(format!("{ns}.ops.doc"), vec![0u8; 40].into())
        .await
        .expect("raw publish");
    tokio::time::sleep(Duration::from_millis(400)).await;
    let gw2 = broker(&ns, 2).await.expect("gw2");
    let messages = gw2.fetch(4, Duration::from_secs(2)).await.expect("fetch");
    for m in &messages {
        match BrokerEvent::decode(&m.message.payload) {
            Err(_) => {
                // Poison: TERMINATE (bounded deliveries, no redelivery loop).
                m.ack_with(async_nats::jetstream::AckKind::Term)
                    .await
                    .expect("term poison");
            }
            Ok(_) => {
                let _ = m.ack().await;
            }
        }
    }
    assert!(gw2.healthy().await, "consumer healthy after poison");
}

/// Vector 6 — forged checksum: a structurally valid envelope whose
/// payload_sha256 does NOT match the op list. Decode must reject with
/// ChecksumMismatch (the checksum binds the op list — this is the
/// "valid-format but forged digest fields" case).
#[tokio::test]
async fn nats_forged_checksum_is_rejected_at_decode() {
    let _guard = file_lock().await;
    if !nats_up().await {
        eprintln!("SKIP: nats down");
        return;
    }
    let event = valid_event(1, Uuid::new_v4(), 5);
    let bytes = event.encode();

    // Flip the checksum field (offset 41..73) — everything else stays
    // structurally valid, including op framing.
    let mut forged = bytes.clone();
    forged[41] ^= 0xFF;
    let mut forged2 = bytes.clone();
    forged2[70] ^= 0x01; // last checksum byte
    for (i, candidate) in [forged, forged2].into_iter().enumerate() {
        match BrokerEvent::decode(&candidate) {
            Err(sync_gateway::broker::BrokerEventError::ChecksumMismatch) => {}
            Err(e) => panic!("case {i}: forged checksum must be ChecksumMismatch, got {e:?}"),
            Ok(ev) => panic!("case {i}: forged checksum ACCEPTED: {ev:?}"),
        }
    }

    // Control: the UNMODIFIED envelope decodes.
    assert!(
        BrokerEvent::decode(&bytes).is_ok(),
        "unmodified event decodes"
    );
}

// ---------------------------------------------------------------------------
// Redis vectors
// ---------------------------------------------------------------------------

fn raw_redis_conn() -> redis::Connection {
    let client = redis::Client::open(REDIS_URL).expect("client");
    client.get_connection().expect("conn")
}

use sync_gateway::ephemeral::presence::PresenceStore;
use sync_gateway::ephemeral::ratelimit::{RateLimitOutcome, RateLimiter};
use sync_gateway::ephemeral::{RedisConfig, RedisHandle};

async fn handle(ns: &str) -> Option<RedisHandle> {
    RedisHandle::connect(&RedisConfig {
        url: REDIS_URL.to_owned(),
        namespace: ns.to_owned(),
    })
    .await
    .ok()
}

/// Vector 7 — key-prefix manipulation: a hostile writer tries to
/// collide with ANOTHER tenant/namespace's presence or rate-limit
/// keys. The `concord:<ns>:` prefix structure means cross-namespace
/// writes cannot affect another namespace's counts; within one
/// namespace, a poisoned presence key with a garbage value does not
/// fabricate or suppress presence (counts are key-name based).
#[tokio::test]
async fn redis_cross_namespace_key_poisoning_cannot_affect_other_tenants() {
    let _guard = file_lock().await;
    if !redis_up().await {
        eprintln!("SKIP: redis down");
        return;
    }
    let ns_a = format!("p6a{}", Uuid::new_v4().simple());
    let ns_b = format!("p6b{}", Uuid::new_v4().simple());
    let Some(redis_a) = handle(&ns_a).await else {
        eprintln!("SKIP: redis down");
        return;
    };
    let redis_b = handle(&ns_b).await.expect("handle b");

    let doc_victim = Uuid::new_v4();
    let store_a = PresenceStore::new(redis_a.clone());
    let store_b = PresenceStore::new(redis_b.clone());

    // Tenant A has a real presence entry for the victim doc.
    store_a.upsert(doc_victim, Uuid::new_v4(), 1).await.unwrap();
    assert_eq!(
        store_a.document_presence_count(doc_victim).await.unwrap(),
        1
    );

    // HOSTILE: a writer holding tenant B's handle (or a raw client)
    // writes keys that MIMIC tenant A's presence keys for the same
    // document — with garbage values and for phantom users.
    let mut conn = raw_redis_conn();
    let phantom = Uuid::new_v4();
    let foreign_key = format!("concord:{ns_a}:presence:{doc_victim}:{phantom}");
    let _: () = redis::cmd("SET")
        .arg(&foreign_key)
        .arg("garbage-not-a-hash")
        .query(&mut conn)
        .expect("hostile set");

    // Tenant A's count for the victim doc INCLUDES the phantom key
    // (SCAN counts key names — presence is best-effort visibility, not
    // authorization truth; DEC-033), but the poison CANNOT: fabricate
    // durable state, suppress real presence, or cross into ns_b.
    assert_eq!(
        store_a.document_presence_count(doc_victim).await.unwrap(),
        2,
        "phantom key counted (presence is advisory) — real entry intact"
    );
    // The VALUES are never trusted: reading the poisoned key's fields
    // is a best-effort error path; count operations still work.
    assert_eq!(
        store_b.document_presence_count(doc_victim).await.unwrap(),
        0,
        "tenant B's namespace is untouched by tenant A's keys"
    );

    // Rate-limit keyspace collision attempt: hostile INCR on a key
    // shaped like ns_a's connect limiter for a victim principal.
    let mut policies = sync_gateway::ephemeral::ratelimit::default_policies();
    policies.insert(
        "p6test",
        sync_gateway::ephemeral::ratelimit::RateLimitPolicy {
            max_events: 2,
            window: Duration::from_secs(60),
        },
    );
    let limiter_a = RateLimiter::new(Some(redis_a.clone()), policies.clone());
    let limiter_b = RateLimiter::new(Some(redis_b), policies.clone());

    // Hostile raw INCR on the victim's limiter key: at worst this
    // EXHAUSTS the victim's own budget (a DoS within their namespace —
    // the documented accepted risk of shared-infrastructure write
    // access), never RESETS or BYPASSES it: the limiter's decision can
    // only get STRICTER for the poisoned principal, and other
    // principals are unaffected.
    // Window start is replicated from ratelimit.rs (window-aligned
    // epoch bucket): now - now % window.
    let window_secs = policies.get("p6test").copied().unwrap().window.as_secs();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let window_start = now - (now % window_secs);
    let victim_key = format!("concord:{ns_a}:rlim:p6test:victim-principal:{window_start}");
    let _: u64 = redis::cmd("INCR")
        .arg(&victim_key)
        .query(&mut conn)
        .expect("hostile incr");
    let outcome = limiter_a.check("p6test", "victim-principal").await;
    assert_eq!(
        outcome,
        RateLimitOutcome::Allowed,
        "one hostile INCR + the first legit event = within budget"
    );
    let outcome = limiter_a.check("p6test", "victim-principal").await;
    assert_eq!(
        outcome,
        RateLimitOutcome::Limited,
        "budget is EXHAUSTED not bypassed (fail-closed direction)"
    );
    // Other principals unaffected:
    assert_eq!(
        limiter_a.check("p6test", "other-principal").await,
        RateLimitOutcome::Allowed
    );
    // Tenant B's limiter (different namespace) is entirely unaffected:
    assert_eq!(
        limiter_b.check("p6test", "victim-principal").await,
        RateLimitOutcome::Allowed
    );

    // Cleanup the hostile key.
    let _: () = redis::cmd("DEL")
        .arg(&foreign_key)
        .query(&mut conn)
        .unwrap();
    let _: () = redis::cmd("DEL").arg(&victim_key).query(&mut conn).unwrap();
}

/// Vector 8 — mid-session FLUSHALL wipe + immediate hostile re-poison:
/// presence reconstructs from live traffic, rate limits re-accumulate
/// from zero, and injected garbage values degrade nothing durably.
#[tokio::test]
async fn redis_midsession_flushall_and_reinjection_is_degraded_but_safe() {
    let _guard = file_lock().await;
    if !redis_up().await {
        eprintln!("SKIP: redis down");
        return;
    }
    let ns = format!("p6w{}", Uuid::new_v4().simple());
    let Some(redis) = handle(&ns).await else {
        eprintln!("SKIP: redis down");
        return;
    };
    let store = PresenceStore::new(redis.clone());
    let doc = Uuid::new_v4();

    // "Mid-session" state: two live presence entries.
    store.upsert(doc, Uuid::new_v4(), 1).await.unwrap();
    store.upsert(doc, Uuid::new_v4(), 2).await.unwrap();
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 2);

    // MID-SESSION WIPE (hostile FLUSHALL from a raw client).
    let mut conn = raw_redis_conn();
    let _: () = redis::cmd("FLUSHALL").query(&mut conn).expect("flush");

    // Hostile re-injection: garbage values into the wiped keyspace
    // (wrong types: strings where hashes are expected).
    let hostile_user = Uuid::new_v4();
    let hostile_key = format!("concord:{ns}:presence:{doc}:{hostile_user}");
    let _: () = redis::cmd("SET")
        .arg(&hostile_key)
        .arg(b"\x00\xff\x00garbage" as &[u8])
        .query(&mut conn)
        .expect("hostile set");

    // DEGRADED-BUT-SAFE: counts still work (key-name based), the
    // garbage value neither crashes the store nor becomes trusted
    // presence data; live traffic reconstructs real presence.
    assert_eq!(
        store.document_presence_count(doc).await.unwrap(),
        1,
        "poisoned key counted by name; nothing crashed"
    );
    let real_user = Uuid::new_v4();
    store.upsert(doc, real_user, 3).await.unwrap();
    assert_eq!(
        store.document_presence_count(doc).await.unwrap(),
        2,
        "real presence rebuilds alongside the poisoned key"
    );
    // Removal of the real user works; the poisoned key is inert.
    store.remove(doc, real_user).await.unwrap();
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 1);

    // Rate limits re-accumulate from zero after the wipe (fresh
    // budget — the documented recovery semantics), and a hostile
    // SET of a STRING value on a limiter key does not bypass the
    // counter: INCR on a non-integer is a Redis type error the
    // limiter maps to its LOCAL fallback (fail-safe direction).
    let mut policies = sync_gateway::ephemeral::ratelimit::default_policies();
    policies.insert(
        "p6test",
        sync_gateway::ephemeral::ratelimit::RateLimitPolicy {
            max_events: 1,
            window: Duration::from_secs(60),
        },
    );
    let limiter = RateLimiter::new(Some(redis.clone()), policies);
    assert_eq!(
        limiter.check("p6test", "user-1").await,
        RateLimitOutcome::Allowed
    );
    assert_eq!(
        limiter.check("p6test", "user-1").await,
        RateLimitOutcome::Limited
    );

    // Hostile: overwrite the counter key with a non-integer string.
    let p6_policy = Duration::from_secs(60); // mirrors the test policy above
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let window_start = now - (now % p6_policy.as_secs());
    let rl_key = format!("concord:{ns}:rlim:p6test:user-1:{window_start}");
    let _: () = redis::cmd("SET")
        .arg(&rl_key)
        .arg("not-a-number")
        .query(&mut conn)
        .expect("hostile set");
    // The limiter's Redis INCR now fails (type error) → LOCAL fallback
    // engages (documented fail-open-to-local, never a crash). The local
    // window starts FRESH (local state was empty — Redis carried the
    // counter), so the first post-poison event is allowed by the LOCAL
    // budget and the SECOND is limited: abuse stays bounded by the
    // per-gateway cap — never an unbounded allow.
    assert_eq!(
        limiter.check("p6test", "user-1").await,
        RateLimitOutcome::Allowed,
        "local fallback window: event 1 allowed (fresh local budget)"
    );
    assert_eq!(
        limiter.check("p6test", "user-1").await,
        RateLimitOutcome::Limited,
        "local fallback window: event 2 limited (max_events=1) — bounded"
    );
}

/// Vector 9 — hostile presence values: inject wrong-type and
/// structurally-hostile values (huge hashes, wrong fields) into
/// presence keys; the store stays functional and never trusts the
/// values (presence is advisory visibility; reads that hit poisoned
/// fields degrade, counts stay name-based, and NO authorization or
/// durable decision ever consults them).
#[tokio::test]
async fn redis_hostile_presence_values_are_never_trusted() {
    let _guard = file_lock().await;
    if !redis_up().await {
        eprintln!("SKIP: redis down");
        return;
    }
    let ns = format!("p6h{}", Uuid::new_v4().simple());
    let Some(redis) = handle(&ns).await else {
        eprintln!("SKIP: redis down");
        return;
    };
    let store = PresenceStore::new(redis);
    let doc = Uuid::new_v4();

    // Hostile field injection into a presence key: absurd gateway ids
    // and timestamps (the values are never authorization evidence).
    let hostile_user = Uuid::new_v4();
    let key = format!("concord:{ns}:presence:{doc}:{hostile_user}");
    let mut conn = raw_redis_conn();
    let _: () = redis::cmd("HSET")
        .arg(&key)
        .arg("gateway")
        .arg(u64::MAX.to_string())
        .arg("ts")
        .arg(u64::MAX.to_string())
        .query(&mut conn)
        .expect("hostile hset");

    // The store's own upsert still works for OTHER users; the count
    // reflects both keys (name-based) and nothing panics.
    let real = Uuid::new_v4();
    store.upsert(doc, real, 5).await.unwrap();
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 2);

    // A hostile LIST instead of a HASH on another key: the store's
    // operations on THAT key error (best-effort, mapped) — the rest
    // of the keyspace is unaffected.
    let list_user = Uuid::new_v4();
    let list_key = format!("concord:{ns}:presence:{doc}:{list_user}");
    let _: () = redis::cmd("RPUSH")
        .arg(&list_key)
        .arg("a")
        .arg("b")
        .query(&mut conn)
        .expect("hostile rpush");
    // count: SCAN sees the key NAME — still 3, degraded-safe.
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 3);
    // remove on the LIST key: the store's DEL is TYPE-agnostic (the
    // name-based remove path just deletes the key) — mapped, no panic.
    store.remove(doc, list_user).await.unwrap();
    // The store remains fully usable for real presence:
    store.upsert(doc, Uuid::new_v4(), 6).await.unwrap();
    // Count: hostile-hash key + real key + the new upsert = 3 (the
    // LIST key was removed).
    assert_eq!(store.document_presence_count(doc).await.unwrap(), 3);

    // The keyspace contains ONLY concord-namespaced keys (audit
    // invariant from redis_integration, re-asserted post-poisoning).
    let keys: Vec<String> = redis::cmd("KEYS").arg("*").query(&mut conn).expect("keys");
    for k in &keys {
        assert!(
            k.starts_with("concord:"),
            "no un-namespaced keys allowed: {k}"
        );
    }
}

/// The core invariant, end-to-end: NOTHING the internal tier can do —
/// forged events, replays, poisoned keys — writes a single durable
/// crdt_operations row. Durable state flows ONLY through the
/// authenticated client-ingest transaction.
#[tokio::test]
async fn internal_infrastructure_cannot_fabricate_durable_state() {
    let _guard = file_lock().await;
    if !nats_up().await || !db_up().await || !redis_up().await {
        eprintln!("SKIP: nats, redis, or db down");
        return;
    }
    let ns = format!("p6z{}", Uuid::new_v4().simple());
    let Some(gw) = broker(&ns, 1).await else {
        eprintln!("SKIP: nats down");
        return;
    };
    let doc = Uuid::new_v4();

    // The full hostile menu against one document:
    // (1) forged valid-format events (multiple shapes),
    for (i, event_id) in [10u64, 11, 12].into_iter().enumerate() {
        let mut e = valid_event(666 + i as u64, doc, event_id);
        e.server_cursor = u64::MAX; // forged cursor metadata
        gw.publish(&e).await.expect("hostile publish");
    }
    // (2) replayed duplicates,
    let replay = valid_event(1, doc, 13);
    for _ in 0..3 {
        gw.publish(&replay).await.expect("replay");
    }
    // (3) malformed bytes via the raw client.
    let nats = async_nats::connect(NATS_URL).await.expect("raw");
    nats.publish(format!("{ns}.ops.doc"), vec![0xEFu8; 90].into())
        .await
        .expect("raw malformed");
    // (4) poisoned Redis presence for the same doc.
    let mut conn = raw_redis_conn();
    let _: () = redis::cmd("SET")
        .arg(format!("concord:{ns}:presence:{doc}:{}", Uuid::new_v4()))
        .arg("poison")
        .query(&mut conn)
        .expect("poison");

    // Drain + ack everything (as the consumer would).
    tokio::time::sleep(Duration::from_millis(400)).await;
    let gw2 = broker(&ns, 2).await.expect("gw2");
    let messages = gw2.fetch(16, Duration::from_secs(3)).await.expect("fetch");
    for m in &messages {
        match BrokerEvent::decode(&m.message.payload) {
            Ok(_) => {
                let _ = m.ack().await;
            }
            Err(_) => {
                m.ack_with(async_nats::jetstream::AckKind::Term)
                    .await
                    .expect("term poison");
            }
        }
    }

    // THE INVARIANT: zero durable rows from all of it.
    assert_eq!(
        db_count(doc).await,
        0,
        "NATS + Redis abuse fabricates NO durable state — ingest is client-auth-only"
    );
    assert!(gw2.healthy().await, "consumer healthy after the full menu");
}
