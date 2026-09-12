//! Phase 5 recovery/snapshot/storage baselines (P5-M026).
//!
//! Reproducible benchmark: generates deterministic rich op streams via
//! the native worker's CMD_GENERATE_OPS (splitmix64 seeds — no
//! Rust-side CRDT encoding), ingests them into the live test DB as the
//! durable log would, and measures:
//!
//!   1. full replay            — reconstruct(all ops)            via worker
//!   2. snapshot build         — reconstruct(ops ≤ S) + export    via worker
//!   3. snapshot import        — import-verify(inner)             via worker
//!   4. snapshot+tail recovery — digest-after(inner, tail ops)    via worker
//!   5. payload sizes          — op bytes, snapshot bytes        local
//!
//! History sizes: 10k (small), 100k (medium). Shapes: 0 uniform.
//! The worker protocol moves RAW op batches in the generator's
//! serialize_batch frames; this harness reuses the WorkerPool adapter
//! untouched (each frame IS one batch entry of the adapter's protocol).
//!
//! Run: `cargo run --release --example recovery-bench` (from rust/).
//! Requires: docker compose up -d db; a Release worker build
//! (cmake -S cpp -B build/native -DCMAKE_BUILD_TYPE=Release).
//! Results recorded in .agent/METRICS_LEDGER.md + docs/BENCHMARKS.md.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use uuid::Uuid;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::{wrapper, SnapshotRepo};
use sync_gateway::maintenance::SnapshotPipeline;
use sync_gateway::worker::WorkerPool;

const DB_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const WORKER_TIMEOUT: Duration = Duration::from_secs(600);

fn worker_path() -> PathBuf {
    let mut root = std::env::current_dir().expect("cwd");
    for _ in 0..3 {
        for rel in [
            "build/native/concord-worker",
            "build/native/worker/concord-worker",
        ] {
            let mut path = root.clone();
            path.push(rel);
            if path.is_file() {
                return path;
            }
        }
        root.pop();
    }
    panic!("concord-worker not built — run cmake --build build/native");
}

/// Splits the generated stream into per-op payloads (unwrap each
/// serialize_batch frame into single-op batches the adapter can feed).
/// The adapter wraps raw ops again — so we UNWRAP the frames into ops,
/// then let the adapter re-wrap. (Worker response frames contain
/// serialize_batch'd ops; the DB stores one raw op per row.)
fn split_batches_to_ops(frames: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut ops = Vec::new();
    for frame in frames {
        let mut offset = 0usize;
        let read_u32 = |b: &[u8], off: usize| -> u32 {
            u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
        };
        let count = read_u32(frame, 0);
        offset += 4;
        for _ in 0..count {
            let len = read_u32(frame, offset) as usize;
            offset += 4;
            ops.push(frame[offset..offset + len].to_vec());
            offset += len;
        }
    }
    ops
}

fn percentiles(mut samples: Vec<u128>) -> (u128, u128, u128) {
    samples.sort_unstable();
    if samples.is_empty() {
        return (0, 0, 0);
    }
    let pick = |q: f64| -> u128 {
        let idx = ((samples.len() as f64 - 1.0) * q).round() as usize;
        samples[idx.min(samples.len() - 1)]
    };
    (pick(0.50), pick(0.95), pick(0.99))
}

async fn bench_db() -> Db {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: DB_URL.into(),
        clerk_issuer: "https://bench.clerk.accounts.dev".into(),
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(120),
        db_pool_size: 4,
        jwks_file: None,
        nats_url: None,
        nats_subject_prefix: "concord.bench".to_string(),
        gateway_id: 1,
        redis_url: None,
        otel_enabled: false,
        otel_endpoint: "http://127.0.0.1:4317".into(),
        otel_sample_ratio: 1.0,
        otel_exporter: "otlp".into(),
        debug_op_ids: false,
        worker_binary: None,
    };
    let db = Db::connect(&config).await.expect("test DB reachable");
    run_migrations(&db).await.expect("migrations");
    db
}

async fn fixture(db: &Db, tag: &str) -> (UserId, Uuid) {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'bench_{tag}_{org}', 'p5-bench');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'bench_{tag}_{owner}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-bench-{tag}');"
        ))
        .await
        .expect("fixture");
    (UserId(owner), doc)
}

async fn cleanup(db: &Db, owner: UserId, doc: Uuid) {
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_snapshots WHERE document_id = '{doc}';
             DELETE FROM maintenance_jobs WHERE document_id = '{doc}';
             DELETE FROM crdt_operations WHERE document_id = '{doc}';
             DELETE FROM documents WHERE id = '{doc}';
             DELETE FROM users WHERE id = '{}';",
            owner.0
        ))
        .await;
}

/// One history-size run. `runs` controls repeat count for percentiles.
async fn run_size(
    db: &Db,
    workers: &WorkerPool,
    total_ops: usize,
    snapshot_frac: f64,
    runs: usize,
) {
    let tag = format!("{total_ops}");
    let (owner, doc) = fixture(db, &tag).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    // Deterministic workload: seed = size (stable across runs).
    let generated = workers
        .generate_ops(total_ops as u64, total_ops as u32, 3, 0)
        .await
        .expect("generate");
    let ops = split_batches_to_ops(&generated.batches);
    assert_eq!(generated.digest.len(), 71, "digest is sha256:hex");
    assert_eq!(ops.len(), total_ops);
    let op_bytes: usize = ops.iter().map(|o| o.len()).sum();

    // Ingest as the durable log would (single ingest call per 512).
    let started = Instant::now();
    for chunk in ops.chunks(512) {
        let envelopes = chunk
            .iter()
            .map(|p| sync_gateway::protocol::envelope::validate_op(p).expect("valid op"))
            .collect::<Vec<_>>();
        repo.ingest_batch(owner, doc, &envelopes)
            .await
            .expect("ingest");
    }
    let ingest_ms = started.elapsed().as_millis();

    let snap_at = ((total_ops as f64) * snapshot_frac) as usize;

    let mut full_replay_samples = Vec::new();
    let mut build_samples = Vec::new();
    let mut import_samples = Vec::new();
    let mut snaptail_samples = Vec::new();
    let mut snapshot_bytes = 0usize;
    let mut boundary_final = 0i64;
    let mut digest_final = String::new();

    for run in 0..runs {
        // 1. Full replay of the whole log (ops in delivery order).
        let all: Vec<Vec<u8>> = {
            let mut out = Vec::new();
            let mut cursor = 0i64;
            loop {
                let page = repo.catchup_page(doc, cursor, 1024).await.expect("page");
                if page.ops.is_empty() {
                    break;
                }
                out.extend(page.ops.into_iter().map(|(_, _, p)| p));
                cursor = page.next_cursor;
                if !page.has_more {
                    break;
                }
            }
            out
        };
        let t = Instant::now();
        let full = workers.reconstruct(&all).await.expect("full replay");
        full_replay_samples.push(t.elapsed().as_micros());
        digest_final = full.digest;

        // 2. Snapshot build at the boundary (worker reconstruct of ops ≤ S
        //    + export). Run through the pipeline so the DB row exists for
        //    the snapshot+tail measurement.
        let _ = run;
        let t = Instant::now();
        let job = Uuid::new_v4();
        // Each run builds a FRESH attempt at the same boundary (attempt =
        // run+1): the uniqueness constraint demands distinct attempts,
        // and per-run attempts keep every timed build real.
        let attempt_no = (run + 1) as i32;
        let boundary_seq = {
            // Pin S to the durable row of the snap_at-th op.
            let client = db.get().await.expect("pool");
            let row = client
                .query_one(
                    "SELECT id FROM crdt_operations WHERE document_id = $1
                     ORDER BY id ASC LIMIT 1 OFFSET $2",
                    &[&doc, &(snap_at as i64)],
                )
                .await
                .expect("boundary row");
            row.get::<_, i64>("id")
        };
        let (snapshot_id, digest, validated) = pipeline
            .build_at_boundary(doc, boundary_seq, job, attempt_no)
            .await
            .expect("build");
        build_samples.push(t.elapsed().as_micros());
        snapshot_bytes = {
            let row = snapshots
                .get_by_snapshot_id(snapshot_id)
                .await
                .expect("fetch")
                .expect("row");
            row.payload.len()
        };
        boundary_final = validated.coverage_seq;
        // The boundary snapshot covers ops ≤ S only; its digest equals
        // full replay's digest ONLY at S == high-water. The true
        // invariant — snapshot+tail == full replay — is asserted below
        // in step 4 for every run.

        // 3. Import the inner snapshot into a fresh replica (worker
        //    process spawn included — the real per-request cost).
        let t = Instant::now();
        let inner = {
            let row = snapshots
                .get_by_snapshot_id(snapshot_id)
                .await
                .expect("fetch")
                .expect("row");
            let parts = wrapper::decode_wrapper(&row.payload).expect("decode");
            parts.inner
        };
        let imported = workers.import_digest(&inner).await.expect("import");
        import_samples.push(t.elapsed().as_micros());
        assert_eq!(
            imported.digest, digest,
            "import must reproduce the boundary state (M017 oracle a)"
        );

        // 4. Snapshot+tail recovery vs the full-replay digest.
        let tail: Vec<Vec<u8>> = {
            let mut out = Vec::new();
            let mut cursor = boundary_seq;
            loop {
                let page = repo.catchup_page(doc, cursor, 1024).await.expect("page");
                if page.ops.is_empty() {
                    break;
                }
                out.extend(page.ops.into_iter().map(|(_, _, p)| p));
                cursor = page.next_cursor;
                if !page.has_more {
                    break;
                }
            }
            out
        };
        let t = Instant::now();
        let recovered = workers.digest_after(&inner, &tail).await.expect("recover");
        snaptail_samples.push(t.elapsed().as_micros());
        assert_eq!(
            recovered.digest, digest_final,
            "snapshot+tail MUST equal full replay"
        );
    }

    let (fr50, fr95, fr99) = percentiles(full_replay_samples.clone());
    let (b50, b95, b99) = percentiles(build_samples.clone());
    let (i50, i95, i99) = percentiles(import_samples.clone());
    let (s50, s95, s99) = percentiles(snaptail_samples.clone());
    let tail_ops = total_ops - snap_at;

    println!(
        "\n=== history {total_ops} ops (snapshot at {snap_at}, tail {tail_ops}; {runs} runs) ==="
    );
    println!(
        "op log bytes (payloads)      : {op_bytes} ({:.1} B/op)",
        op_bytes as f64 / total_ops as f64
    );
    println!(
        "snapshot payload bytes       : {snapshot_bytes} ({:.3}× op log)",
        snapshot_bytes as f64 / op_bytes as f64
    );
    println!("ingest (DB, one pass)        : {ingest_ms} ms");
    println!("full replay    p50/p95/p99 µs: {fr50}/{fr95}/{fr99}");
    println!("snapshot build p50/p95/p99 µs: {b50}/{b95}/{b99}");
    println!("snapshot import p50/p95/p99 µs: {i50}/{i95}/{i99}");
    println!("snap+tail      p50/p95/p99 µs: {s50}/{s95}/{s99}");
    println!("full-replay digest           : {digest_final}");
    println!("boundary coverage_seq        : {boundary_final}");

    cleanup(db, owner, doc).await;
}

#[tokio::main]
async fn main() {
    let db = bench_db().await;
    let workers = WorkerPool::new(worker_path(), WORKER_TIMEOUT);

    // Warmup: small stream to page in the binary + steady state.
    println!("warmup…");
    let _ = workers.generate_ops(1, 1_000, 2, 0).await.expect("warmup");

    // Sizes: 10k and 100k total ops; snapshot at 50% of the history so
    // the tail is a meaningful replay distance. 5 runs each for p50/p95.
    run_size(&db, &workers, 10_000, 0.5, 5).await;
    run_size(&db, &workers, 100_000, 0.5, 5).await;
    headline_scenario(&db, &workers).await;
    storage_scenario(&db, &workers).await;

    println!("\nbenchmark complete — record into .agent/METRICS_LEDGER.md");
}

/// P5-M043 headline scenario: the production-shaped recovery race —
/// full replay vs snapshot+tail where the snapshot is FRESH (tiny
/// tail: 1% of history), which is what the trigger policy actually
/// maintains. This is the fair "before/after" the M026 50%-tail
/// numbers understate.
async fn headline_scenario(db: &Db, workers: &WorkerPool) {
    let total_ops = 100_000usize;
    let tail_ops = 1_000usize; // 1% — the trigger-policy steady state
    let tag = "headline";
    let (owner, doc) = fixture(db, tag).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    let generated = workers
        .generate_ops(total_ops as u64, total_ops as u32, 3, 0)
        .await
        .expect("generate");
    let ops = split_batches_to_ops(&generated.batches);
    assert_eq!(ops.len(), total_ops);

    for chunk in ops.chunks(512) {
        let envelopes = chunk
            .iter()
            .map(|p| sync_gateway::protocol::envelope::validate_op(p).expect("valid op"))
            .collect::<Vec<_>>();
        repo.ingest_batch(owner, doc, &envelopes)
            .await
            .expect("ingest");
    }

    // Snapshot at (total - tail): fresh tail = 1k ops.
    let snap_at = total_ops - tail_ops;
    let boundary_seq = {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT id FROM crdt_operations WHERE document_id = $1
                 ORDER BY id ASC LIMIT 1 OFFSET $2",
                &[&doc, &(snap_at as i64)],
            )
            .await
            .expect("boundary");
        row.get::<_, i64>("id")
    };
    let job = Uuid::new_v4();
    let (snapshot_id, _digest, validated) = pipeline
        .build_at_boundary(doc, boundary_seq, job, 1)
        .await
        .expect("build");

    let all: Vec<Vec<u8>> = {
        let mut out = Vec::new();
        let mut cursor = 0i64;
        loop {
            let page = repo.catchup_page(doc, cursor, 1024).await.expect("page");
            if page.ops.is_empty() {
                break;
            }
            out.extend(page.ops.into_iter().map(|(_, _, p)| p));
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        out
    };
    assert_eq!(all.len(), total_ops);

    let mut full_samples = Vec::new();
    let mut snaptail_samples = Vec::new();
    let expected_digest = {
        let mut expected = String::new();
        for _ in 0..5 {
            let t = Instant::now();
            let full = workers.reconstruct(&all).await.expect("full");
            full_samples.push(t.elapsed().as_micros());
            expected = full.digest;
        }
        expected
    };

    for _ in 0..5 {
        let tail: Vec<Vec<u8>> = {
            let mut out = Vec::new();
            let mut cursor = boundary_seq;
            loop {
                let page = repo.catchup_page(doc, cursor, 1024).await.expect("page");
                if page.ops.is_empty() {
                    break;
                }
                out.extend(page.ops.into_iter().map(|(_, _, p)| p));
                cursor = page.next_cursor;
                if !page.has_more {
                    break;
                }
            }
            out
        };
        let t = Instant::now();
        let recovered = workers
            .digest_after(&validated.inner, &tail)
            .await
            .expect("snapshot+tail");
        snaptail_samples.push(t.elapsed().as_micros());
        assert_eq!(recovered.digest, expected_digest, "correctness every run");
    }

    let (f50, _, _) = percentiles(full_samples);
    let (s50, _, _) = percentiles(snaptail_samples);
    let improvement = 100.0 - (s50 as f64 / f50 as f64) * 100.0;
    println!(
        "\n=== P5-M043 headline: 100k history, fresh snapshot, {tail_ops}-op tail (5 runs) ==="
    );
    println!(
        "full replay p50        : {f50} µs ({:.1} ms)",
        f50 as f64 / 1000.0
    );
    println!(
        "snapshot+tail p50      : {s50} µs ({:.1} ms)",
        s50 as f64 / 1000.0
    );
    println!("improvement            : {improvement:.1}% (correctness digest verified every run)");
    let _ = snapshot_id;

    cleanup(db, owner, doc).await;
}

/// P5-M044 storage scenario: compaction's storage effect with the full
/// denominator — op rows/bytes before, snapshot payload bytes, rows/
/// bytes after safe prune (floor = snapshot boundary), and the
/// post-prune recovery latency (snapshot+tail with tail 0).
async fn storage_scenario(db: &Db, workers: &WorkerPool) {
    let total_ops = 50_000usize;
    let tag = "storage";
    let (owner, doc) = fixture(db, tag).await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), workers.clone());

    let generated = workers
        .generate_ops(total_ops as u64, total_ops as u32, 3, 0)
        .await
        .expect("generate");
    let ops = split_batches_to_ops(&generated.batches);
    for chunk in ops.chunks(512) {
        let envelopes = chunk
            .iter()
            .map(|p| sync_gateway::protocol::envelope::validate_op(p).expect("valid op"))
            .collect::<Vec<_>>();
        repo.ingest_batch(owner, doc, &envelopes)
            .await
            .expect("ingest");
    }

    let before = sync_gateway::maintenance::storage_accounting(db, doc)
        .await
        .expect("accounting before");

    // Snapshot at the FULL boundary (tail 0) then prune everything.
    let boundary = repo.durable_cursor(doc).await.expect("high-water");
    let job = Uuid::new_v4();
    let (snapshot_id, _digest, validated) = pipeline
        .build_at_boundary(doc, boundary, job, 1)
        .await
        .expect("build");
    assert!(snapshots
        .transition_building_to_verifying(snapshot_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(doc, snapshot_id).await.expect("verify");
    assert!(pipeline
        .finalize(snapshot_id, None)
        .await
        .expect("finalize"));

    let deleted = sync_gateway::maintenance::prune_to_boundary(db, &snapshots, doc, boundary, 5000)
        .await
        .expect("prune");
    assert_eq!(deleted, total_ops as i64);

    let after = sync_gateway::maintenance::storage_accounting(db, doc)
        .await
        .expect("accounting after");
    let snapshot_bytes = after.snapshot_bytes;

    // Recovery latency after compaction: snapshot import + empty tail.
    let inner = validated.inner.clone();
    let t = Instant::now();
    let recovered = workers.digest_after(&inner, &[]).await.expect("recover");
    let recovery_us = t.elapsed().as_micros();

    println!(
        "\n=== P5-M044 storage: {total_ops}-op history, full compaction (retention: newest snapshot kept) ==="
    );
    println!(
        "op log before  : {rows} rows / {bytes} bytes",
        rows = before.op_rows,
        bytes = before.op_bytes
    );
    println!(
        "snapshot kept  : {snapshot_bytes} bytes ({} snapshots retained)",
        after.snapshot_count
    );
    println!(
        "op log after   : {rows} rows / {bytes} bytes",
        rows = after.op_rows,
        bytes = after.op_bytes
    );
    println!(
        "storage reduction under retention policy: {:.1}% of durable bytes remain",
        ((snapshot_bytes as f64 + after.op_bytes as f64)
            / (before.op_bytes as f64 + snapshot_bytes as f64))
            * 100.0
    );
    println!("recovery latency after compaction: {recovery_us} µs (import + 0-tail)");
    assert!(recovered.digest.starts_with("sha256:"));

    cleanup(db, owner, doc).await;
}
