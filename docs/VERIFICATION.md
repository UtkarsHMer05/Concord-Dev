# Concord — Verification Matrix (historical checkpoint index)

Status: Historical evidence index · not a current release verdict<br>
Last audited checkpoint: `v1.0.0-hardened.10` / `b711111431f15717c2a887f81404eabce71e1046`<br>
Last updated: 2026-09-13

This document preserves a claim-to-evidence index for named historical
checkpoints. It is not evidence that the current checkout passes: the local
checkout has advanced beyond the checkpoint and has uncommitted changes. The
current handoff and fillable evidence ledger are
[`docs/audits/CANONICAL_RELEASE_REPORT.md`](audits/CANONICAL_RELEASE_REPORT.md)
and [`docs/audits/CANONICAL_RELEASE_LEDGER.json`](audits/CANONICAL_RELEASE_LEDGER.json).

See `docs/TESTING.md` for procedures, `docs/BENCHMARKS.md` for historical
measurements and their environments, `docs/SECURITY.md` §8 for the threat
model, and `docs/FAILURE_MODEL.md` for the durability contract. No command
below is a current pass result unless it is re-run against the exact candidate
and recorded in the canonical ledger.

## 1. How to read this matrix

- **Evidence class**: `TEST` (executable suite), `BENCH` (measured, recorded
  environment + denominators), `SCAN` (tooling output), `LIVE` (executed
  system proof).
- Claims marked *within the tested fault model* define exactly what is and
  is not claimed. Concord never claims exactly-once delivery or
  unqualified zero-loss: delivery is at-least-once + idempotent, and
  durability is PostgreSQL-local under the defined fault model.

## 1.1 Public claim index (historical checkpoint evidence)

This compact index is the public entry point for claims most likely to be read
without the full phase matrix. Every row is tied to the checkpoint/SHA shown in
its last-verified column; none is promoted to current evidence by this file.
The report and evidence directory retain the complete historical context and
limitations.

| Public claim | Evidence class | Command | Artifact/result | Last verified SHA |
|---|---|---|---|---|
| Historical hardened tag resolved to the historical audited implementation | SCAN | `git rev-parse --verify v1.0.0-hardened.10^{commit}` | `b711111431f15717c2a887f81404eabce71e1046` | `b711111431f15717c2a887f81404eabce71e1046` |
| Repository provenance has no unallowlisted identical baseline files | SCAN | `bash scripts/security/provenance-check.sh` | 123 baseline files, 54 overlaps, 0 unallowlisted identical files | `1efdbfe049affc2da9b72798a4c2fbbea74ed03f` |
| Provenance and scanner failure modes are fail-closed | TEST | `bash scripts/security/provenance-tests.sh && bash scripts/security/secret-scan-tests.sh` | Provenance 14/14; injected secret-scanner failure exits 2 | `1efdbfe049affc2da9b72798a4c2fbbea74ed03f` |
| Gitless source archives build a valid native worker | TEST | `cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release -DCONCORD_BUILD_TESTS=ON && cmake --build build/native && ctest --test-dir build/native --output-on-failure --parallel 1` | CTest 3/3; archive version `concord-worker 1.0.0` | `b711111431f15717c2a887f81404eabce71e1046` |
| Production npm dependencies have no known audit vulnerabilities | SCAN | `npm audit --omit=dev` | 0 Critical, 0 High, 0 Moderate, 0 Low | `1efdbfe049affc2da9b72798a4c2fbbea74ed03f` |
| Release web and gateway images pass the enforced Trivy gate | SCAN | `gh run view 34751270511 --repo UtkarsHMer05/Concord-Dev` | Trivy web 0; gateway 0; release workflow success | `b711111431f15717c2a887f81404eabce71e1046` |
| No repository or history secrets are reported by the scanner | SCAN | `bash scripts/security/secret-scan.sh --history` | Working tree, SBOMs, and full history clean | `1efdbfe049affc2da9b72798a4c2fbbea74ed03f` |
| Local rendered-browser coverage exercises the required journeys | TEST | `npx playwright test tests/browser --project=chromium --project=firefox --project=webkit` | Chromium 12/12, Firefox retry 1/1, WebKit 1/1 | `b711111431f15717c2a887f81404eabce71e1046` |
| Accessibility checks report no serious or critical violations | TEST | `npx playwright test tests/browser/a11y.spec.ts` | 5/5; no serious/critical axe violations | `b711111431f15717c2a887f81404eabce71e1046` |
| Historical protected CI was green for non-browser required jobs | LIVE | `gh run view 34753859142 --repo UtkarsHMer05/Concord-Dev` | Web, Rust, WASM, security, native GCC, and native Clang succeeded at the named checkpoint | `1efdbfe049affc2da9b72798a4c2fbbea74ed03f` |
| Historical protected browser CI was not green | LIVE | `gh run view 34753859142 --repo UtkarsHMer05/Concord-Dev` | Chromium, Firefox, and WebKit failed the explicit missing-Clerk-secret preflight before tests at the named checkpoint | `1efdbfe049affc2da9b72798a4c2fbbea74ed03f` |

The `verifiedSha` values above identify the code or code-equivalent historical
checkpoint that produced each result. They do not identify the current dirty
checkout. A later documentation-only descendant can preserve a result only
when the tested implementation is unchanged; the current checkout requires a
fresh candidate-bound review.

## 2. Correctness claims

| Claim | Evidence class | Where |
|---|---|---|
| CRDT convergence: all replicas reach identical digests under arbitrary reorder/duplication/partition | TEST | `cpp/crdt/tests/test_seed_corpus.cpp` (8 fixed-seed scenarios × {2,5,10} replicas × ≥4 permutations; `scripts/verify-native.sh Release`) |
| Large-scale randomized convergence | TEST | `cpp/crdt/tests/property_campaign.cpp` via `scripts/native/campaign.sh` — PR tier 30/30 seeds (5 replicas × 2k ops); extended 100/100 (10 replicas × 10k ops); deterministic, reproducible by seed |
| Native/WASM parity | TEST | wasm golden tests (26) + `scripts/verify-wasm.sh`; TS↔Rust↔C++ golden fixtures (`tests/protocol/golden.test.ts`, `rust` protocol golden tests) |
| Malformed input cannot crash the C++ core/worker | TEST/FUZZ | `cpp/crdt/fuzz/*` — 5 targets, smoke tier 1M execs each, zero crashes; regression corpus + `test_fuzz_regressions.cpp` pinned mechanism |
| Malformed input cannot crash the Rust decoders | TEST/FUZZ | `rust/sync-gateway/examples/proto_fuzz.rs` (5 targets, 250k smoke + 1M extended per target) + `tests/protocol_fuzz_regressions.rs` (10 tests incl. the pinned FUZZ-2026-09-001 broker panic fix) |
| Sanitizer-clean native code | TEST | ASan+UBSan 64 core + 52 worker green; TSan 64 + 52 green (single-threaded worker contract documented); runs in sanitizer trees incl. campaign |

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
| Browser lifecycle reliability (offline, reload, multi-tab, storm) | TEST | `tests/realtime/reliability.test.ts` 10 scenarios through the real release binary; rendered Playwright Chromium journey separately covers browser persistence, two contexts, and reconnect |
| Maintenance jobs execute in the release gateway | TEST/LIVE-LOCAL | `GATEWAY_WORKER_BINARY` scheduler wiring — locally proven: claimed job → executed → snapshot FINALIZED; graceful drain on SIGTERM; no AWS environment is currently running |

## 4. Security claims

| Claim | Evidence class | Where |
|---|---|---|
| Deny-by-default, role boundaries (OWNER/EDITOR/COMMENTER/VIEWER) | TEST | `phase6_authz_matrix.rs` 7 roles × 5 surfaces; web `tests/db/idor-matrix.test.ts`; `tests/authorization.test.ts`; DB suites 69/69 |
| No IDOR / no existence oracle | TEST | Same matrix — denial frames shape-identical to nonexistent-doc; SQLi-shaped ids → malformed_frame |
| Live permission revocation immediate at next batch, all gateways, no TTL cache | TEST | `phase6_revocation.rs` A–E (both-gateway enforcement; upgrade live; 12 interleaved rounds single legal outcome) — policy in `docs/AUTHORIZATION.md` §8 |
| Internal broker/Redis cannot fabricate or leak cross-tenant | TEST | `phase6_internal_trust.rs` 10 tests — full hostile menu → 0 durable rows |
| No secrets in repo or history | SCAN | `scripts/security/secret-scan.sh` — tree + full `git log -p --all` history clean; positive control 10/10 detected with redaction |
| Dependency posture classified, criticals triaged | SCAN | `scripts/security/dep-scan.sh` — npm production 0C/0H/0M/0L; full tree 0C/0H/4M/0L in the documented dev chain; cargo-audit 0; container findings remain raw and policy-classified |
| SBOM for release candidates | SCAN | `scripts/sbom/*.cdx.json` — deterministic regeneration (CycloneDX; component counts are recorded from the current lockfiles in the final report, not copied from an earlier phase) |
| Hardened release images (multi-stage, pinned, non-root) | LIVE-LOCAL | `scripts/release/smoke-images.sh` — clean-tree builds, health checks, and non-root UID assertions; the script prints the exact image-check total |
| Logs/traces carry no secrets or token fragments | TEST | Observability log-hygiene test (token_head leak removed P6-M010) |

## 5. Observability claims

| Claim | Evidence class | Where |
|---|---|---|
| One operation traceable browser→gateway→authz→PG→ACK→NATS→peer | TEST/LIVE | correlation id `gw-<gid>-batch-<batch>` through every hop (observability_integration 5/5); `docs/OBSERVABILITY.md` trace model |
| Metrics answer engineering questions, cardinality-bounded | TEST/LIVE | Prometheus `/metrics` registry (bounded label tables, cardinality audited by test); live scrape proof 4/4 targets up, 14 series/gateway |
| Dashboards provisioned from clean setup | LIVE | Grafana compose service; 3 provisioned dashboards listed via API from clean boot |

## 6. Performance claims

See `docs/BENCHMARKS.md` for full environments, denominators and run
discipline. Numbers below are retained Phase 6 campaign results (MEASURED at
their historical checkpoints), not fresh measurements from the current
checkout.

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
- A currently running AWS production environment, or any other live
  deployment. The release-shaped images and deployment runbooks are historical
  local evidence; current hosting, DNS/TLS, and live proxy topology are not
  verified here.

## 8. Reproducing the proof gate

The historical proof procedure is the composition of:
`scripts/verify-native.sh Release` + sanitizer trees + `campaign.sh`;
`cargo fmt/clippy/test` matrix incl. all integration + chaos suites
(serialized); web typecheck/lint/build + unit/realtime/db suites;
`scripts/chaos/run-suite.sh all`; secret/dependency scans; SBOM +
`smoke-images.sh`; benchmark campaigns via `scripts/bench/` harnesses;
and `scripts/verify-all.sh --strict` for a no-silent-skip audit. Run the
procedure only after selecting a clean candidate and record its output in the
canonical ledger. CI equivalents are `.github/workflows/phase6-*.yml`; CodeQL
is a separate security workflow and is not claimed as a local substitute.
