# Concord — Benchmarks

Status: Authoritative
Version: 1.0 (Phase 2)
Last updated: 2026-09-06

This document records Concord's measurement **methodology** and the
reproducible baseline commands. Headline performance claims require
BEFORE/AFTER evidence on designed workloads with repeated runs (DEC-011);
none exist yet — the numbers below are engineering baselines, not claims.

---

## 1. Native CRDT core baselines (P2-M029)

```bash
cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCONCORD_BUILD_BENCHMARKS=ON -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build build/native
./build/native/crdt/benchmarks/bench_core
```

Environment: Apple Silicon (arm64), macOS 26.5, Apple clang 21, Release
(-O2), 5 runs per workload, median reported. Machine-local, single-run
variance noted below 5%.

| Workload | Median | Notes |
|---|---|---|
| Sequential append (10k items) | 134 ms | O(n) anchor walk per op — measured, not optimized |
| Random-position insert (5k) | 92 ms | |
| Random delete (2k) | 24 ms | |
| Remote batch apply (20k shuffled ops) | 2.57 s | Dominated by the pending-scan retry loop (quadratic on large shuffled batches) — the documented bottleneck; indexed pending-by-anchor is the identified fix, deferred until a measured need |
| Snapshot export / import (10k items) | 1.3 / 1.9 ms | ~58 bytes per item serialized |

## 2. WASM / worker baselines (P2-M045)

Measured by executing the Emscripten build (Release, -O2) directly; the
worker runs the identical engine. Main-thread protection is architectural:
all CRDT work executes inside the Web Worker.

| Measurement | Result |
|---|---|
| WASM binary | ~160 KiB |
| Local insert (median, 1000 ops) | 0.003 ms/op |
| Visible JSON render (1k items) | 0.057 ms |
| Canonical digest (1k items) | 2.3 ms |

## 3. What is NOT measured yet

- Multi-client throughput/latency over a real network (Phase 3+).
- Recovery time for large update logs (Phase 5).
- Any distributed failure-scenario performance (Phase 6).

Every future public/resume metric still requires workload + environment +
run count + distribution, recorded in the private ledger first.


---

## Phase 3 — Single-gateway baseline (MEASURED, 2026-09-07)

Environment: macOS arm64 host; release build (Rust 1.98.1); Docker
postgres 18.6 @127.0.0.1:5433; pool 8; outbound queue 512; workload =
canonical 32-byte insert operations (the production envelope), client
sends a batch then waits for its durable ACK (at-least-once client
semantics — NOT pipelined). Run count: 2 (initial + gate rerun; the
rerun catch-up figure improved to 678k ops/s on a warm page cache —
both runs recorded in the private ledger).

| Metric | Value |
|---|---|
| Ingest throughput (25-op batches, sequential) | 1,085 ops/s |
| Durable-ACK latency per 25-op batch | p50 22.0 ms · p95 28.3 ms · p99 33.3 ms |
| Peer propagation (writer → 3 peers, 1 op) | p50 1.98 ms · p95 2.42 ms · p99 2.67 ms |
| Catch-up re-stream | 408k–679k ops/s (5,100 ops: 7.5–12.5 ms) |
| Concurrent connections (handshake baseline) | 50/50 established |

Honest notes: ACK latency is dominated by the client-sequential
round-trip + local TCP + WAL commit; the server-side fanout path is
~2 ms. No optimization was performed (P3-M044: profiling found no
bottleneck at the Phase 3 target workload; optimization deferred to
Phase 4 re-baselining under distribution). These are local Docker-network
numbers — informative, not promotional.


---

## Phase 4 — multi-gateway scaling baselines (MEASURED, 2026-09-07)

Workload (examples/loadgen; identical across runs): 12 clients / 4
documents / 60 ops/s target / 10s / canonical 32-byte ops; client-
sequential durable-ack loops; in-process release gateways + live NATS
(JetStream file storage) + Postgres/Redis in Docker; macOS arm64 host.
Full JSON: private scratch (not committed); summary in the metrics ledger.

| gateways | sent=acked | loss | reconnects | ACK p50 | ACK p95 | ACK p99 |
|---|---|---|---|---|---|---|
| 1 | 612/612 | 0 | 0 | 16.1 ms | 23.5 ms | 30.4 ms |
| 2 | 612/612 | 0 | 0 | 17.6 ms | 27.8 ms | 30.7 ms |
| 3 | 612/612 | 0 | 0 | 18.4 ms | 28.5 ms | 32.5 ms |

Hot-document fairness (16 clients, 1 doc, 80 ops/s): 816/816 acked,
p50 20.6 ms, p95 32.5 ms — no starvation; the load-shedding hierarchy
never engaged (no rejections recorded).

Honest reading: ACK latency growth 1→3 gateways (~2.3 ms) is the
post-commit broker publish entering the ack path — a small fixed cost per
batch on the ingress gateway, NOT contention (p95 stays flat-ish).
Optimization was deferred (P4-M043): no measured bottleneck at the
Phase 4 target workload. These are local Docker-network numbers —
informative, not promotional. NO multi-node scalability claim is made
beyond this table.

## Phase 5 — recovery/snapshot/storage baselines (MEASURED, 2026-09-07)

Methodology (reproducible): `cargo run --release --example
recovery-bench` from `rust/` (preconditions: docker compose up -d db;
Release worker via `cmake -S cpp -B build/native -G Ninja
-DCMAKE_BUILD_TYPE=Release`). Workload: deterministic rich op streams
(insert/delete/attribute-update mix over 3 replicas) generated by the
native worker's seeded generator (CMD_GENERATE_OPS) — no client,
no gateway in the loop; the durable log is populated exactly as the
gateway would ingest it. History sizes 10k/100k ops; snapshot at the
50% boundary; 5 runs per size; nearest-rank percentiles; correctness
asserted every run (snapshot+tail digest == full-replay digest;
snapshot import digest == boundary digest).

| Measurement | 10k ops | 100k ops |
|---|---|---|
| op payload bytes | 527,115 (~52.7 B/op) | 5,261,618 (~52.6 B/op) |
| snapshot payload bytes | 265,639 (0.50× log) | 2,640,056 (0.50× log) |
| full replay p50 | 624.9 ms | 62.94 s |
| snapshot build p50 (fold ≤ S + export) | 207.3 ms | 15.94 s |
| snapshot import p50 (incl. process spawn) | 8.0 ms | 59.5 ms |
| snapshot+tail replay p50 (tail = 50%) | 437.4 ms | 42.50 s |

What the numbers say (honest reading):

- **The CRDT fold dominates** every replay-shaped path and grows
  superlinearly in item-stream length (~10× ops ⇒ ~68× time at these
  shapes). This is the profiling target for P5-M040/M041; no
  optimization is performed before that evidence exists.
- **Snapshot+tail with a 50% tail saves ~32%** at 100k ops — the
  compaction win comes from FRESH snapshots keeping tails short, which
  is exactly what the trigger policy bounds (ops-since-snapshot
  threshold, docs/STORAGE.md).
- **Snapshot import is milliseconds** — stale-client resync cost is
  dominated by payload transfer, not by import.
- **Snapshot size is ~0.50× the op log** at a 50% boundary (linear in
  covered state, no blowup) — PostgreSQL remains comfortably adequate
  at Phase 5 scale (DEC-035 revisit condition not met).

Raw per-run evidence: `.agent/METRICS_LEDGER.md` (private). No
public/resume claim is made from these numbers (baseline-only; the
P5-M043 headline comparison, if any, will be computed from reproducible
aggregate values with explicit denominators).

## Phase 5 — headline recovery + compaction storage (MEASURED, 2026-09-07)

Reproducible via `cargo run --release --example recovery-bench`
(preconditions as above; the M041 optimization round attempted a fold
acceleration, measured a 4x regression on real streams, and was
reverted — the shipped code is the original, fully re-gated).

| Race (100k-op history, 5 runs) | p50 | Notes |
|---|---|---|
| Full replay (whole log) | 64.90 s | the old-only path |
| Snapshot + tail (fresh snapshot, 1,000-op tail) | **0.93 s** | import + tail fold |
| Improvement | **98.6%** | digest verified equal every run |

| Storage (50k-op history, full compaction, newest-snapshot retention) | Value |
|---|---|
| op log before | 50,000 rows / 2.63 MB |
| snapshot retained | 2.65 MB |
| op log after | 0 rows / 0 bytes |
| durable bytes remaining | 50.1% |
| recovery after compaction | 51 ms (import + 0-tail) |

Interpretation: with the trigger policy keeping snapshots fresh
(5,000-op threshold, docs/STORAGE.md), recovery cost is bounded by the
snapshot import (milliseconds) plus the bounded tail — the unbounded
full-replay growth curve is eliminated for connected history. Compaction
halves durable bytes at this scale while retaining full
historical-revision capability (protected snapshots per DEC-040 /
retention rules). All numbers: local machine, exact workload/method in
the private ledger; no production claims.
