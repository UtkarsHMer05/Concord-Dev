# Concord — Verification Matrix (Phase 6)

Status: Authoritative · Every major engineering claim maps to executable
evidence. Claims are stated precisely; TARGET vs MEASURED is always marked.

This document is the claim-to-evidence index. See `docs/TESTING.md` for how
to run suites, `docs/BENCHMARKS.md` for measured numbers and their
environments, `docs/SECURITY.md` §8 for the threat model, and
`docs/FAILURE_MODEL.md` for the durability contract.

## 1. How to read this matrix

- **Evidence class**: `TEST` (executable suite), `BENCH` (measured, recorded
  environment + denominators), `SCAN` (tooling output), `LIVE` (executed
  system proof).
- Claims marked *within the tested fault model* define exactly what is and
  is not claimed. Concord never claims exactly-once delivery or
  unqualified zero-loss: delivery is at-least-once + idempotent, and
  durability is PostgreSQL-local under the defined fault model.

## 2. Correctness claims

| Claim | Evidence class | Where |
|---|---|---|
| CRDT convergence: all replicas reach identical digests under arbitrary reorder/duplication/partition | TEST | `cpp/crdt/tests/test_seed_corpus.cpp` (8 fixed-seed scenarios × {2,5,10} replicas × ≥4 permutations; `scripts/verify-native.sh Release`) |
| Large-scale randomized convergence | TEST | `cpp/crdt/tests/property_campaign.cpp` via `scripts/native/campaign.sh` — PR tier 30/30 seeds (5 replicas × 2k ops); extended 100/100 (10 replicas × 10k ops); deterministic, reproducible by seed |
| Native/WASM parity | TEST | wasm golden tests (26) + `scripts/verify-wasm.sh`; TS↔Rust↔C++ golden fixtures (`tests/protocol/golden.test.ts`, `rust` protocol golden tests) |
| Malformed input cannot crash the C++ core/worker | TEST/FUZZ | `cpp/crdt/fuzz/*` — 5 targets, smoke tier 1M execs each, zero crashes; regression corpus + `test_fuzz_regressions.cpp` pinned mechanism |
| Malformed input cannot crash the Rust decoders | TEST/FUZZ | `rust/sync-gateway/examples/proto_fuzz.rs` (5 targets, 250k smoke + 1M extended per target) + `tests/protocol_fuzz_regressions.rs` (10 tests incl. the pinned FUZZ-2026-09-001 broker panic fix) |
| Sanitizer-clean native code | TEST | ASan+UBSan 64 core + 51 worker green; TSan 64 + 51 green (single-threaded worker contract documented); runs in sanitizer trees incl. campaign |

## 3. Durability / fault-tolerance claims (within the tested fault model)

| Claim | Evidence class | Where |
|---|---|---|
| Durable ACK = PostgreSQL commit (never faked) | TEST | `ws_integration` db-outage test; `chaos_postgres` CH-PG-RESTART/PAUSE/POOL/SLOW (no ack in outage windows); FAILURE_MODEL §1/2.7 |
| No lost durable-ACKed operations under component failures | TEST (27 scenarios) | Chaos campaign 20260909-084649: gateway crash ×5, NATS ×5, Redis ×3, PostgreSQL ×5, worker ×4, compound ×5 — ack-observation ∩ PG-absence counting = **0 lost** across all 27 |
| No divergent replicas after any tested failure | TEST | Same campaign — fresh-connection catch-up op-set equality on every surviving gateway (+ worker digest verifier for CH-WORKER) = **0 divergent** |
| Redis is ephemeral (wipe = not a data event) | TEST | `redis_integration` FLUSHALL-safe + `chaos_redis` CH-REDIS-WIPE mid-edit (presence reconstructs; durable rows unchanged) |
| NATS JetStream loss does not affect durable truth | TEST | `chaos_broker` CH-NATS-STORAGE-LOSS (volume removed; PG floor recovers all ops; stream/consumers auto-reprovision) |
| Interrupted compaction leaves no unrecoverable document | TEST | `chaos_worker` CH-WORKER-COMPACTION-INTERRUPTED (all 4 pipeline stages; differential verifier PASS after each) |
| Corrupted snapshots are rejected, never finalized atop | TEST | `phase5_snapshots` integrity matrix (17 tests) + `chaos_worker` CH-WORKER-CORRUPT-SNAPSHOT |
| Gateway failover / reconnect / catch-up | TEST | `multi_gateway` 9 scenarios + `chaos_gateway` CH-GW-FORCE-RECONNECT + `tests/realtime/reliability.test.ts` (failover, pending-ACK refresh, resync) |
| Batch atomicity (all-or-nothing) | TEST | `chaos_postgres` CH-PG-TXN-ABORT (pg_terminate_backend mid-batch; never partial) |
| Browser lifecycle reliability (offline, reload, multi-tab, storm) | TEST | `tests/realtime/reliability.test.ts` 10 scenarios through the real release binary; realtime project 18/18 twice |
| Maintenance jobs execute in a deployed gateway | LIVE | `GATEWAY_WORKER_BINARY` scheduler wiring — live-proven: claimed job → executed → snapshot FINALIZED; graceful drain on SIGTERM |

## 4. Security claims

| Claim | Evidence class | Where |
|---|---|---|
| Deny-by-default, role boundaries (OWNER/EDITOR/COMMENTER/VIEWER) | TEST | `phase6_authz_matrix.rs` 7 roles × 5 surfaces; web `tests/db/idor-matrix.test.ts`; `tests/authorization.test.ts`; DB suites 69/69 |
| No IDOR / no existence oracle | TEST | Same matrix — denial frames shape-identical to nonexistent-doc; SQLi-shaped ids → malformed_frame |
| Live permission revocation immediate at next batch, all gateways, no TTL cache | TEST | `phase6_revocation.rs` A–E (both-gateway enforcement; upgrade live; 12 interleaved rounds single legal outcome) — policy in `docs/AUTHORIZATION.md` §8 |
| Internal broker/Redis cannot fabricate or leak cross-tenant | TEST | `phase6_internal_trust.rs` 10 tests — full hostile menu → 0 durable rows |
| No secrets in repo or history | SCAN | `scripts/security/secret-scan.sh` — tree + full `git log -p --all` history clean; positive control 10/10 detected with redaction |
| Dependency posture classified, criticals triaged | SCAN | `scripts/security/dep-scan.sh` — npm 0C/0H (4M accepted, documented); cargo-audit 0; container criticals = base-image OS packages, documented acceptance + remediation path |
| SBOM for release candidates | SCAN | `scripts/sbom/*.cdx.json` — deterministic regeneration (CycloneDX; web 251 components, rust 331 crates, native hand-authored) |
| Hardened release images (multi-stage, pinned, non-root) | LIVE | `scripts/release/smoke-images.sh` PASS 2/2 (gateway uid 10001, web uid 1000; health checks; clean-tree builds) |
| Logs/traces carry no secrets or token fragments | TEST | Observability log-hygiene test (token_head leak removed P6-M010) |

## 5. Observability claims

| Claim | Evidence class | Where |
|---|---|---|
| One operation traceable browser→gateway→authz→PG→ACK→NATS→peer | TEST/LIVE | correlation id `gw-<gid>-batch-<batch>` through every hop (observability_integration 5/5); `docs/OBSERVABILITY.md` trace model |
| Metrics answer engineering questions, cardinality-bounded | TEST/LIVE | Prometheus `/metrics` registry (bounded label tables, cardinality audited by test); live scrape proof 4/4 targets up, 14 series/gateway |
| Dashboards provisioned from clean setup | LIVE | Grafana compose service; 3 provisioned dashboards listed via API from clean boot |

## 6. Performance claims

See `docs/BENCHMARKS.md` for full environments, denominators and run
discipline. Numbers below are the Phase 6 campaign results (MEASURED).

| Claim | Evidence class | Where |
|---|---|---|
| Snapshot+tail recovery ≫ full replay (98.6% faster at 100k/1k) | BENCH | `rust/sync-gateway/examples/recovery-bench.rs` — 5 runs, digest-verified every run; reproduced 98.5% on the Phase 5 gate rerun; Phase 6 M038 campaign |
| Durable bytes after compaction ~50.1% under keep-newest retention | BENCH | recovery-bench storage scenario; Phase 6 M038 campaign |
| Multi-gateway scaling (1→N) sustained throughput + ack latency | BENCH | `scripts/bench/run-throughput.mjs` campaign (M037) — per-cell medians in `.agent/bench/runs/` artifacts; summary in BENCHMARKS.md |
| WASM/worker browser-path latencies | BENCH | `scripts/bench/browser-profile.mjs` (M036) — typing/paste/remote-batch/import/resync + bundle size; Node-instrumented (documented proxy, not real-Chromium claims) |
| Sanitizer/fuzz/chaos scale | TEST | See §2/§3 — totals in the M039 aggregate JSON |

## 7. What is deliberately NOT claimed

- Exactly-once delivery (at-least-once + idempotent everywhere).
- Zero data loss outside the defined fault model (client-side loss before
  ingress remains the local-first client's retryable pending set;
  simultaneous catastrophic loss of all tiers is out of model).
- "Linear scaling" as a slogan — scaling behavior is whatever the M037
  campaign measured, stated per workload.
- Real-Chromium main-thread numbers (WASM measurements are
  Node-instrumented proxies, explicitly marked).
- Production deployment readiness (Phase 7 scope; images are built and
  smoke-tested locally only).

## 8. Reproducing the proof gate

The full Phase 6 proof gate (M049) is the composition of:
`scripts/verify-native.sh Release` + sanitizer trees + `campaign.sh`;
`cargo fmt/clippy/test` matrix incl. all integration + chaos suites
(serialized); web typecheck/lint/build + unit/realtime/db suites;
`scripts/chaos/run-suite.sh all`; secret/dependency scans; SBOM +
`smoke-images.sh`; benchmark campaigns via `scripts/bench/` harnesses.
CI equivalents: `.github/workflows/phase6-*.yml`.
