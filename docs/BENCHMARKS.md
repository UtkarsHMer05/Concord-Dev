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
