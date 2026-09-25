//! Jepsen-lite convergence checker (Feature 3).
//!
//! A seeded, deterministic adversarial schedule driven against the REAL
//! `GatewayRepo` + Postgres test DB, asserting the invariants that actually
//! matter for a durable CRDT log:
//!
//!   A. exactly-once durability — a fresh full catch-up from cursor 0 returns
//!      every acked op exactly once; idempotent duplicate re-sends never
//!      create a second row.
//!   B. gapless prefix — a reader doing INCREMENTAL catch-up with a rolling
//!      cursor CONCURRENTLY with the ingests, then draining, still observes
//!      every acked op in a strictly-increasing, monotone-cursor stream. This
//!      is the systemic regression guard for the per-document advisory-lock
//!      commit-ordering fix: without id-order == commit-order, a reader that
//!      advanced its cursor over a high id could permanently skip a lower id
//!      that commits late (id < cursor is invisible to delta catch-up).
//!   C. convergence — a rich generated op stream carries a ground-truth
//!      digest; after ingesting it (in causal order, with adversarial
//!      batching + concurrent duplicate retries) the durable log must
//!      reconstruct straight from Postgres to exactly that digest, and the
//!      duplicate retries must add no rows. The native batch `reconstruct`
//!      folds in the given order (unlike the live applyRemote buffer it is
//!      NOT reorder-independent — verified), so the property under test is
//!      that the durable `id` order the advisory lock keeps gapless IS a
//!      faithful causal order that round-trips to the canonical state.
//!
//! Skips (does not fail) when the test DB or the native worker binary are
//! absent — same gate contract as db_integration.rs / chaos_worker.rs. The
//! outcome is deterministic (the invariants must hold on every interleaving);
//! the seed only shapes the schedule and is printed so a failure reproduces.
//! Run serially (`--test-threads=1`).

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::protocol::envelope::{validate_op, OpEnvelope};
use sync_gateway::protocol::golden;
use sync_gateway::worker::WorkerPool;

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

fn test_url() -> String {
    std::env::var("DATABASE_TEST_URL").unwrap_or_else(|_| TEST_URL.into())
}

/// Deterministic, dependency-free PRNG (splitmix64). Seeded per schedule so a
/// failing interleaving reproduces from the printed seed.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Inclusive range [lo, hi].
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        debug_assert!(hi >= lo);
        lo + self.next_u64() % (hi - lo + 1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next_u64() % 100 < percent
    }
}

fn test_config() -> Config {
    Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: test_url(),
        clerk_issuer: "https://fun-blowfish-5798.clerk.accounts.dev".into(),
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
        db_pool_size: 8,
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

async fn test_db() -> Option<Db> {
    match Db::connect(&test_config()).await {
        Ok(db) => {
            run_migrations(&db).await.expect("migrations");
            Some(db)
        }
        Err(_) => {
            eprintln!("SKIP: concord_test DB unreachable");
            None
        }
    }
}

/// Locate the native worker binary (same walk-up as chaos_worker.rs).
fn live_worker_pool() -> Option<WorkerPool> {
    let mut root = std::env::current_dir().expect("cwd");
    for _ in 0..3 {
        for rel in [
            "build/native/concord-worker",
            "build/native/worker/concord-worker",
        ] {
            let mut path: PathBuf = root.clone();
            path.push(rel);
            if path.is_file() {
                return Some(WorkerPool::new(path, Duration::from_secs(300)));
            }
        }
        if !root.pop() {
            break;
        }
    }
    eprintln!("SKIP: concord-worker binary not built");
    None
}

fn op_with_identity(replica: u64, counter: u64) -> OpEnvelope {
    // Root-anchored inserts only (left = right = None): every op is
    // dependency-free, so ANY delivery order integrates the whole set and the
    // RGA total order — hence the digest — is a function of the op SET, not
    // the schedule. That is precisely the convergence property invariant C
    // asserts, with no pending-op ambiguity to muddy it. Identity is patched
    // into the fixed replica/counter byte slots exactly like chaos_worker's
    // `ops_at`.
    let mut bytes = golden::golden_insert_op();
    bytes[2..10].copy_from_slice(&replica.to_le_bytes());
    bytes[10..18].copy_from_slice(&counter.to_le_bytes());
    validate_op(&bytes).expect("golden insert with patched identity is valid")
}

async fn seed_owner_document(db: &Db, tag: &str) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO users (id, clerk_user_id) VALUES ('{owner}', 'conv_{tag}_{owner}');
             INSERT INTO documents (id, owner_user_id, title, initial_content)
               VALUES ('{doc}', '{owner}', 'convergence-{tag}', '');"
        ))
        .await
        .expect("seed owner + document");
    (UserId(owner), doc)
}

async fn cleanup(db: &Db, owner: UserId, doc: Uuid) {
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_operations WHERE document_id = '{doc}';
             DELETE FROM crdt_replica_owners WHERE document_id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{}';",
            owner.0
        ))
        .await;
}

/// Full paged catch-up from cursor 0: (operation_id, server_seq, payload) in
/// ascending seq order. Panics on any protocol/ordering violation it can see.
async fn full_catchup(repo: &GatewayRepo, doc: Uuid) -> Vec<(String, i64, Vec<u8>)> {
    let mut cursor = 0i64;
    let mut all = Vec::new();
    loop {
        let page = repo
            .catchup_page(doc, cursor, 16)
            .await
            .expect("catchup page");
        for entry in &page.ops {
            assert!(
                entry.1 > cursor,
                "catch-up returned a seq <= its after_cursor"
            );
        }
        if let Some(last) = page.ops.last() {
            cursor = last.1;
        }
        all.extend(page.ops);
        if !page.has_more {
            break;
        }
    }
    all
}

/// Split worker `generate_ops` batch frames into individual op payloads
/// (each frame is `[u32 count]` then `count × [u32 len][bytes]`; matches
/// phase5_equivalence.rs). Generation order is a valid causal order.
fn split_frames(frames: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut ops = Vec::new();
    for frame in frames {
        let mut offset = 0usize;
        let count = u32::from_le_bytes(frame[0..4].try_into().expect("count")) as usize;
        offset += 4;
        for _ in 0..count {
            let len =
                u32::from_le_bytes(frame[offset..offset + 4].try_into().expect("len")) as usize;
            offset += 4;
            ops.push(frame[offset..offset + len].to_vec());
            offset += len;
        }
    }
    ops
}

/// One seeded adversarial schedule end-to-end against the real repo + DB
/// (durability invariants A + B; no CRDT fold here).
async fn run_one_seed(db: &Db, seed: u64) {
    let repo = GatewayRepo::new(db.clone());
    let (owner, doc) = seed_owner_document(db, &format!("s{seed}")).await;
    let mut rng = Rng::new(seed);
    const N_REPLICAS: u64 = 4;

    // 1. Generate per-replica batches with monotonic counters (one writer/user
    //    on several replicas — the offline multi-tab/multi-device case).
    let mut acked: BTreeSet<String> = BTreeSet::new();
    let mut batches: Vec<Vec<OpEnvelope>> = Vec::new();
    for replica in 1..=N_REPLICAS {
        let replica_id = 900 + replica;
        let batch_count = rng.range(2, 5);
        let mut counter = 1u64;
        for _ in 0..batch_count {
            let ops_in_batch = rng.range(2, 5);
            let mut batch = Vec::new();
            for _ in 0..ops_in_batch {
                let env = op_with_identity(replica_id, counter);
                acked.insert(env.identity.to_wire());
                batch.push(env);
                counter += 1;
            }
            batches.push(batch);
        }
    }
    // 2. Seeded Fisher–Yates shuffle so replicas interleave adversarially.
    for i in (1..batches.len()).rev() {
        let j = rng.range(0, i as u64) as usize;
        batches.swap(i, j);
    }

    // 3. A reader doing INCREMENTAL catch-up with a rolling cursor, running
    //    concurrently with the ingests (invariant B). It finishes only once it
    //    is told to stop AND has drained — so a permanently-skipped op (id <
    //    its advanced cursor) would be missing from `seen` and fail below.
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let repo = repo.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut cursor = 0i64;
            let mut seen: BTreeSet<String> = BTreeSet::new();
            loop {
                let page = repo
                    .catchup_page(doc, cursor, 5)
                    .await
                    .expect("reader page");
                for (op_id, seq, _payload) in &page.ops {
                    assert!(
                        *seq > cursor,
                        "reader page seq must exceed its after_cursor"
                    );
                    seen.insert(op_id.clone());
                }
                if let Some(last) = page.ops.last() {
                    cursor = last.1;
                }
                if !page.has_more {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            }
            seen
        })
    };

    // 4. Drive the batches in rounds: 2–3 concurrent ingests per round, and a
    //    concurrent duplicate re-send in ~40% of rounds (idempotency stress).
    let mut index = 0usize;
    while index < batches.len() {
        let round = (rng.range(2, 3) as usize).min(batches.len() - index);
        let mut handles = Vec::new();
        for k in 0..round {
            let batch = batches[index + k].clone();
            let repo_first = repo.clone();
            handles.push(tokio::spawn(async move {
                repo_first.ingest_batch(owner, doc, &batch).await
            }));
            if rng.chance(40) {
                let batch = batches[index + k].clone();
                let repo_dup = repo.clone();
                handles.push(tokio::spawn(async move {
                    repo_dup.ingest_batch(owner, doc, &batch).await
                }));
            }
        }
        for handle in handles {
            handle
                .await
                .expect("ingest task joined")
                .expect("ingest ok");
        }
        index += round;
    }
    stop.store(true, Ordering::SeqCst);
    let reader_seen = reader.await.expect("reader task joined");

    // ----- Invariant A: exactly-once durability (fresh full catch-up) -----
    let catchup = full_catchup(&repo, doc).await;
    let catchup_ids: Vec<String> = catchup.iter().map(|o| o.0.clone()).collect();
    let unique: BTreeSet<String> = catchup_ids.iter().cloned().collect();
    assert_eq!(
        unique.len(),
        catchup_ids.len(),
        "seed {seed}: full catch-up returned a duplicate operation row (idempotency broken)"
    );
    assert_eq!(
        unique, acked,
        "seed {seed}: full catch-up set must equal the acked op set (no loss, no phantom rows)"
    );
    let seqs: Vec<i64> = catchup.iter().map(|o| o.1).collect();
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "seed {seed}: catch-up seqs must be strictly increasing (gapless ordered prefix)"
    );

    // ----- Invariant B: the concurrent incremental reader lost nothing -----
    assert_eq!(
        reader_seen, acked,
        "seed {seed}: an incremental reader with a rolling cursor skipped an acked op — \
         the advisory-lock commit-ordering guarantee regressed"
    );

    cleanup(db, owner, doc).await;
    eprintln!(
        "seed {seed}: durability OK — {} acked ops across {N_REPLICAS} replicas",
        acked.len()
    );
}

/// Multi-thread runtime so the spawned ingests + reader run with real
/// parallelism against Postgres, not merely interleaved at await points.
///
/// Invariants A (exactly-once durability) and B (gapless prefix under a
/// concurrent rolling-cursor reader). These are row/cursor-level properties,
/// independent of CRDT fold semantics, so the schedule is maximally
/// adversarial: concurrent cross-replica ingests + duplicate re-sends.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn durability_invariants_under_adversarial_schedules() {
    let Some(db) = test_db().await else { return };
    // A handful of seeds — bounded so the whole suite stays well under 30s.
    for seed in [1u64, 42, 1337, 90125] {
        run_one_seed(&db, seed).await;
    }
}

/// Invariant C (convergence): the durable log must round-trip through Postgres
/// to the canonical CRDT digest.
///
/// The native worker's batch `reconstruct` folds ops in the given order and,
/// unlike the live `applyRemote` buffer, is NOT order-independent (verified:
/// reversing a generated stream changes the digest). The durable log's whole
/// job is to preserve a causal delivery order so this fold is exact — server
/// `id` is that order, kept gapless by the per-document advisory lock. So the
/// meaningful, honest convergence check is: generate a rich op stream with a
/// ground-truth digest, ingest it (in causal order, with adversarial batching
/// and concurrent duplicate retries), then reconstruct straight from the DB
/// catch-up and assert the digest matches — and that duplicate retries added
/// no rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn convergence_round_trips_through_the_durable_log() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    for seed in [3u64, 21, 4242] {
        let repo = GatewayRepo::new(db.clone());
        let (owner, doc) = seed_owner_document(&db, &format!("c{seed}")).await;

        // A causally-valid stream from 4 replicas + its ground-truth digest.
        let generated = workers
            .generate_ops(seed, 60, 4, 0)
            .await
            .expect("generate op stream");
        let ops = split_frames(&generated.batches);
        assert_eq!(ops.len(), 60, "seed {seed}: generated op count");

        // Ingest in generation (causal) order so server id order stays causal;
        // random contiguous batch sizes + a concurrent duplicate retry per
        // batch (idempotency) keep it adversarial without inverting causality.
        let mut rng = Rng::new(seed ^ 0xA5A5_A5A5);
        let mut index = 0usize;
        while index < ops.len() {
            let size = (rng.range(1, 6) as usize).min(ops.len() - index);
            let batch: Vec<OpEnvelope> = ops[index..index + size]
                .iter()
                .map(|p| validate_op(p).expect("generated op validates"))
                .collect();
            let repo_dup = repo.clone();
            let batch_dup = batch.clone();
            let retry = rng.chance(50);
            let dup = retry.then(|| {
                tokio::spawn(async move { repo_dup.ingest_batch(owner, doc, &batch_dup).await })
            });
            repo.ingest_batch(owner, doc, &batch)
                .await
                .expect("ingest ok");
            if let Some(dup) = dup {
                dup.await.expect("dup joined").expect("dup ok");
            }
            index += size;
        }

        // Reconstruct straight from the durable catch-up (server id order).
        let catchup = full_catchup(&repo, doc).await;
        assert_eq!(
            catchup.len(),
            ops.len(),
            "seed {seed}: duplicate retries must not add rows (idempotency)"
        );
        let payloads: Vec<Vec<u8>> = catchup.into_iter().map(|o| o.2).collect();
        let digest = workers
            .reconstruct(&payloads)
            .await
            .expect("reconstruct from durable log")
            .digest;
        assert_eq!(
            digest, generated.digest,
            "seed {seed}: durable log reconstructed to a divergent state"
        );

        cleanup(&db, owner, doc).await;
        eprintln!("seed {seed}: convergence OK — durable log folds to {digest}");
    }
}
