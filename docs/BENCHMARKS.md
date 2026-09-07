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
