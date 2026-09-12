# CONCORD V1 HARDENING — FINAL REPORT

**Campaign:** CONCORD 9.5+ end-to-end hardening (owner master prompt,
phases A–Q)
**Start SHA:** `c2f33c7` (branch `phase/7-production-release`, post-v1
README commit)
**End SHA:** `17d5629` (branch `codex/9-5-hardening`, 21 commits)
**Date:** 2026-09-12
**Verdict inputs:** every claim below was re-verified on the final tree
this date; commands and counts are from the final runs, not reused from
earlier phases.

---

## 1. Final verdict

**CONCORD V1 HARDENING — PASS** with three explicitly documented
external prerequisites (owner actions, §9) and two honestly-labeled
methodology decisions (below). No unresolved Critical/High finding
remains in the ledger that is actionable from this repository.

Methodology decisions (not defects):
- **Browser benchmarks** stay labeled exactly as *Node-instrumented
  real-WASM proxy measurements (not real-browser latency)*. The master
  prompt (§C6/N2) allows either real Playwright measurement or the exact
  proxy label; the label is applied in README, BENCHMARKS, and
  VERIFICATION with no blurring.
- **Rust static analysis** stays clippy `-D warnings` + cargo-audit +
  cargo-deny; CodeQL covers only JS/TS + C++ (its documented language
  surface). No CodeQL-for-Rust claim exists anywhere.

---

## 2. Findings ledger summary

Full ledger: [V1_HARDENING_FINDINGS.md](V1_HARDENING_FINDINGS.md) —
19 findings, each closed with a regression test or mechanical
validation (severity per the master prompt §2.2 rules).

### Critical

| ID | Finding | Resolution |
|---|---|---|
| HARD-LICENSE-001/002 | No root license; tutorial-derived material with unverifiable redistribution rights; Cargo declared MIT contradicting the unlicensed root | Resolved by replacement + verification + license: all tutorial-identical source and assets replaced with original implementations or proven third-party (shadcn/ui, byte-verified against the MIT registry); root `LICENSE` (MIT) applied; `PROVENANCE.md` records every category; `scripts/security/provenance-check.sh` is a CI gate (0 unallowlisted identical files, banned-asset list); Cargo/npm/SBOM/NOTICE all agree |

### High (closed)

| ID | Finding | Resolution + regression |
|---|---|---|
| HARD-AUTH-001 | JWKS process-lifetime refresh budget exhaustible by 3 unknown-`kid` tokens → permanent key-rotation DoS until restart | Confirmed by failing regression FIRST; redesigned: async singleflight + cooldown + per-kid negative cache + TTL + bounded HTTP response/time + metrics; tests prove rotation survives arbitrary attack bursts and concurrent bursts coalesce |
| HARD-AUTH-002 | Gateway accepted ANY audience (`validate_aud=false`), dev tokens carry tutorial-era `aud=convex` | Optional strict `aud`/`azp` policies enforced when configured; push-bundle refuses to publish with `aud=convex`; full claim matrix tested (correct/wrong/array/missing aud, wrong/missing party, future nbf, missing sub, forged, expired, wrong alg/issuer) |
| HARD-AUTH-003 | Reserved maintenance replica IDs (`SYSC`/`REST`) client-forgeable at ingest | Rejected at validated decode; browser allocator now emits high-bit IDs (legacy compatible); protocol regression failed pre-fix, passes post-fix |
| HARD-NET-001 | Connect limiter keyed on TCP peer → LB collapses all clients into one bucket | Trusted-proxy CIDR config, right-to-left XFF walk, malformed/ambiguous chain rejection; spoof/direct-peer/multihop v4+v6/multi-gateway tests |
| HARD-WEB-002 | CSP script-src carried `'unsafe-inline'` | Per-request nonce middleware (Next 16 + Clerk verified against current docs; Clerk's built-in CSP option REJECTED with evidence — its merge keeps unsafe-inline); 9 effective-header regression tests + live dev-server verification (nonce on response + HTML scripts, rotation, real Clerk origin) |
| HARD-CI-001/002 | Floating action tags, no permissions, no dependency automation; trivy passed unconditionally | SHA-pinned actions + `persist-credentials: false` + least-privilege permissions + Dependabot (npm/cargo/actions/docker); scan-gate.sh enforces a dated allowlist (empty — any new critical/high fails) |
| HARD-NET-002 | Cloud NATS anonymous / Redis unauthenticated / Grafana anonymous Admin | NATS user-pass; Redis ACL user restricted to the code-derived command set; Grafana real admin; segmented internal networks + runtime hardening. LIVE fail-closed proofs: NATS anonymous + wrong creds rejected; Redis NOPERM for GET/SET/FLUSHALL/out-of-namespace; correct creds work end-to-end |
| HARD-LICENSE-003 | 6 source files byte-identical to the tutorial baseline | All rewritten as original implementations (commit d228526), 174→180 unit tests green throughout |

### Medium/Low (closed)

HARD-NATIVE-001/002 (GCC `<algorithm>` includes; root CTest + cwd
independence), HARD-DOC-001 (NOTICE paths + benchmark labels),
HARD-WEB-001 (authorizedParties via CONCORD_APP_ORIGIN),
HARD-IMG-001 (digest pinning + apk-upgrade tradeoff documented),
plus the observability truth batch (compaction bytes metric real;
broker lag TTL-cached off the hot path; worker gauge wired).

### Open (external prerequisites — see §9)

HARD-AUTH-002 cloud phase, HARD-WEB-001 live phase, HARD-NET-001
cloud wiring: all require the Clerk dashboard session-token template
change and/or a live cloud deployment that this machine cannot perform
(the AWS stack is intentionally torn down). The code side is complete
and tested.

---

## 3. Verification results (final tree, 2026-09-12)

**`scripts/verify-all.sh` full campaign: 6/6 PASS, 0 skipped**

| Gate | Result | Detail |
|---|---|---|
| web | PASS 58s | typecheck clean; lint 0 errors (98 pre-existing warnings); unit 180/180; db 69/69; realtime 21/21 (two-client convergence through real release gateways over real WebSockets); production build green |
| native | PASS 33s | `ctest --test-dir build/native` 3/3 (core 64 + property smoke + worker protocol incl. the new `--version` test), GCC 15.2 + Apple Clang 21 Release, cwd-independent corpus |
| rust | PASS 3m3s | fmt clean; clippy `-D warnings` clean; **serial test run 252 passed / 0 failed / 1 ignored across 35 suites**; targeted auth suite 16/16; cargo-audit 0; cargo-deny advisories+bans+licenses+sources all ok |
| wasm | PASS 8s | Emscripten build + smoke + CRDT parity tests |
| provenance | PASS | 54 baseline-overlapping paths, 0 unallowlisted identical files, 0 banned assets |
| secrets | PASS | tree + **full git history (--all)** clean |

**Additional final-tree gates:**

- Property convergence campaign, PR tier: **30/30 seeds converged, 0
  divergent replicas** (5 replicas × 2000 ops, duplicates/delays
  exercised per seed).
- Local distributed cluster: 3 gateways + nginx LB up; per-gateway
  `/api/v1/health/live` ok; `/api/v1/health/info` reports
  `1.0.0 (7a91baf, release, protocol 1)`; clean stop.
- Cloud stack auth, live-proven on this machine via Docker: NATS
  anonymous → `-ERR 'Authorization Violation'`, wrong pass rejected,
  correct creds `+OK/PONG`; Redis ACL: `NOAUTH` default user,
  `WRONGPASS` rejected, concord user PING/INCR/EXPIRE/DEL/SCAN/HSET
  allowed, GET/SET/FLUSHALL/out-of-namespace → `NOPERM`;
  `docker compose config` validates in user-data mode.
- SBOMs regenerated at version 1.0.0 (rust-gateway 327 components ==
  Cargo.lock); secret-scan over SBOMs clean.
- Nonce CSP live-verified on a running dev server: per-request nonce
  rotation (3 unique in 3 requests), nonce present in the header AND on
  Next's HTML script tags, `connect-src 'self' https://<clerk-instance>
  ws: wss:` (origin decoded from the publishable key), zero
  `unsafe-inline` in script-src.

**Pre-existing/environmental notes (not defects, documented honestly):**

- The chaos suites docker pause/kill the shared `concord-nats` /
  `concord-redis` containers and therefore REQUIRE the documented
  serial convention (`--test-threads=1`). A parallel run fails on
  cross-test interference. `verify-all.sh` now runs the Rust gate
  serially with the rationale inline (commit 7a91baf); CONTRIBUTING.md
  states the convention and the reason.
- `ch_worker_*` failures observed mid-campaign were stale
  `maintenance_jobs` debris in the shared `concord_test` DB left by
  concurrent crashed runs; reproduced identically with the changes
  stashed (baseline), cleared, then 4/4 green.
- Container base-image criticals (dev compose images) remain the
  documented §9.2 acceptance; the RELEASE path now enforces posture
  via `scan-gate.sh` on digest-pinned, apk-upgraded hardened images.

---

## 4. Performance results

No optimization claims were made in this hardening pass, so no
before/after benchmark deltas are asserted. The two perf-relevant
changes were verified structurally:

- Broker consumer-info moved off the per-message hot path (TTL cache);
  the redelivery/lag gauges now cost zero JetStream metadata requests
  per event. Regression proves the hot path reads the cache while the
  live count differs; `consumer_info_fresh()` serves probes.
- Compaction bytes metric implemented via one aggregate CTE inside the
  existing delete transaction (no extra round trip; no per-row
  RETURNING traffic). All phase-5 compaction/recovery suites green.

Headline v1 numbers (ingest p50 2.72 ms / 11.3×, 1→4 gateway zero-loss
p95 15.23 ms, recovery 98.4%, chaos 27/27) are unchanged by this pass
and remain evidence-backed by their original artifacts; nothing in
this pass touched those code paths' hot loops (the JWKS redesign is
per-unknown-kid, the audience checks are constant-time string
comparisons, and the trusted-proxy parse is per-connection).

---

## 5. Security posture changes (summary)

| Surface | Before | After |
|---|---|---|
| JWT/JWKS | lifetime refresh budget exhaustible; any audience accepted | rotation abuse-resistant; strict aud/azp; full claim matrix pinned by tests |
| Client identity | forged maintenance IDs passed ingest; LB peer keyed all clients | reserved IDs rejected at decode; trusted-proxy CIDR XFF with spoof tests |
| Web CSP | `'unsafe-inline'` scripts | per-request nonce + strict-dynamic; pinned by effective-header tests |
| Clerk parties | none configured | exact `authorizedParties` from CONCORD_APP_ORIGIN (fail-fast on bad config) |
| Cloud data plane | NATS/Redis anonymous, Grafana anonymous admin, flat network | authenticated + ACL least-commands + segmented internal networks + no-new-privileges/cap-drop/pids/stop-grace |
| Supply chain | floating tags, no permissions, blanket scan pass, tag-pinned images | SHA-pinned + least-privilege + Dependabot + CodeQL + cargo-deny + enforced scan-gate + digest-pinned images + provenance gate |
| Observability | two metrics emitted meaningless zeros | bytes-pruned real (transactional), lag off hot path, worker gauge wired |
| Licensing | unresolvable blocker | MIT root license on original work; per-path provenance; CI-enforced |

---

## 6. Known limitations remaining (explicit, deliberate)

1. **Browser numbers are Node-instrumented WASM proxy measurements** —
   labeled exactly everywhere; real-Chromium Playwright benchmarks are
   future work (not claimed today).
2. **No Playwright multi-browser E2E suite** — the shipped realtime E2E
   (21/21) drives real browser-identical sync modules against real
   gateways; a Chromium/Firefox/WebKit matrix is future work.
3. **Cloud audience migration is an owner action** — the Clerk
   dashboard session-token template still carries `aud=convex` until
   the owner changes it; push-bundle refuses to publish without an
   explicit non-convex audience, so the cloud path cannot silently
   regress.
4. **Trusted-proxy cloud wiring needs a live deploy** — CIDR policy is
   implemented + tested at unit level; the compose network addresses
   are dynamic, so the cloud bundle must pin the proxy IP before
   enabling (documented in the compose file).
5. **Dev compose base-image criticals** — documented §9.2 acceptance
   (loopback dev-only); release images are digest-pinned,
   apk-upgraded, and scan-gated.
6. **AWS is intentionally torn down** — the deployment scripts are
   reproducible from scratch, but no live cloud stack exists; the Vercel
   demo runs the web tier with local-only CRDT mode by design.

---

## 7. Commit chain (21 commits, codex/9-5-hardening)

`ee9feb5` baseline+ledger → `4851414` test-scope fix → `1ba260c` GCC +
root CTest → `bc86a63` JWKS redesign → `c9ea5fd` reserved replicas →
`02b9a80` trusted proxy + budgets → `a034abb` strict audience/azp →
`37a6832` artwork + inventory → `879918b` authorizedParties →
`578bad2` cloud auth + segmentation + digest pins + pinned actions +
Dependabot + scan-gate → `d228526` tutorial-identical rewrites →
`dcfff87` MIT license + provenance gate → `05c9623` nonce CSP →
`5a5ad9e` changelog/contributing/security/templates/docs-index/
engineering-brief → `7bc8a84` CI gates wired + findings recorded →
`30c4a1b` metrics made real → `365d290` version 1.0.0 + build metadata
+ bootstrap/verify-all → `1d15849` README license/provenance/badges →
`fcc127f` editor chrome rewrite → `7a91baf` serial verify fix →
`17d5629` chrome polish.

---

## 8. Owner-only actions (external to this repository)

1. **Clerk dashboard**: migrate the session-token template to a
   Concord-specific audience (then set GATEWAY_CLERK_AUDIENCE +
   CONCORD_APP_ORIGIN in the cloud env). push-bundle enforces this
   sequence — it refuses `convex`.
2. **Branch push + merge**: `codex/9-5-hardening` is local only.
   Pushing, merging to `main`, tagging `v1.0.0-hardened` (or
   fast-forwarding `concord-v1.0.0`), and enabling the GitHub settings
   in `docs/GITHUB_SETTINGS_CHECKLIST.md` (default branch, protection,
   topics, security tab) require explicit authorization per house rule
   — no push was made.
3. **Cloud re-deploy** (if/when): re-run `scripts/deploy/push-bundle.sh`
   on an AWS stack rebuilt from the repo; it now generates and
   SSM-reuses NATS/Redis/Grafana credentials and renders the Redis ACL.
4. **Domain/TLS** (unchanged prerequisite): the WSS upgrade path needs a
   user-owned domain; the CSP ships `upgrade-insecure-requests` in
   production for that eventuality.
5. **Demo video** — explicitly out of scope for this campaign.
