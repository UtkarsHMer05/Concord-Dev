# Changelog

All notable changes to Concord are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

Evidence policy: every change below is backed by a commit, a test, or a
measured benchmark in this repository. Deep dives live in
[docs/](docs/README.md); the finding ledger for the hardening pass is
[docs/audits/V1_HARDENING_FINDINGS.md](docs/audits/V1_HARDENING_FINDINGS.md).

Current audit notice (2026-09-14): the dated entries below are historical
release/campaign records tied to their named commits. They do not certify a
current deployment or replace the fresh candidate evidence. Use the canonical
handoff and machine-readable ledger for current status:
[`docs/audits/CANONICAL_RELEASE_REPORT.md`](docs/audits/CANONICAL_RELEASE_REPORT.md)
and [`CANONICAL_RELEASE_LEDGER.json`](docs/audits/CANONICAL_RELEASE_LEDGER.json).

## [Unreleased]

### 1.0.1 candidate (not published)

The current compatibility-preserving hardening candidate is version 1.0.1.
Its source, Rust workspace, CMake worker identity, package lock, and generated
SBOM metadata are synchronized, but the candidate is not a release: the
canonical tag and artifact set remain gated on fresh exact-SHA evidence,
trusted Clerk browser credentials, and remote CI conclusions.

### Historical v1 hardening pass (branch `codex/9-5-hardening`, 2026-09-12)

Security fixes, portability repairs, and supply-chain hardening applied
after the v1.0.0 release. Findings are tracked in
[docs/audits/V1_HARDENING_FINDINGS.md](docs/audits/V1_HARDENING_FINDINGS.md);
each historical closed finding carries a regression test. This entry is not a
current release statement; current closure requires candidate-bound evidence.

### Fixed

- **Native GCC portability + root CTest** (HARD-NATIVE-001/002): direct
  `<algorithm>` includes in the translation units that use `std::shuffle`
  (GCC 15 failed where Apple Clang passed via transitive includes), root
  `enable_testing()` wiring, and a source-dir corpus definition so root
  CTest discovers the core, property-smoke, and worker-protocol suites
  and the fuzz corpus resolves from any working directory. Verified: GCC
  15 and Apple Clang 21 Release builds + 3/3 CTest.
- **JWKS refresh cannot be exhausted by unknown-key bursts**
  (HARD-AUTH-001, High): the process-lifetime JWKS refresh budget was a
  fixed counter that an attacker sending unknown `kid` values could burn,
  permanently breaking key rotation. Replaced with async singleflight,
  cooldown, negative caching, TTL, and bounded HTTP response/time; new
  regression test fails against the old lifetime counter (rotation after
  attack, concurrent burst, oversized response).
- **Reserved maintenance replica IDs are no longer client-forgeable**
  (HARD-AUTH-003, High): the gateway now rejects `REST`/`SYSC` origin
  identities before ingest (a forged maintenance source could previously
  pass the validated client decoder). Browser replica IDs are allocated
  with the high bit set; legacy ordinary IDs still work. Protocol
  regression failed pre-fix, passes post-fix.
- **Vitest database-migration setup scoped to the DB suite**: the unit
  project no longer runs (or resets) PostgreSQL migrations when
  `DATABASE_TEST_URL` happens to be set locally.
- **NOTICE SBOM paths and README measurement label** (HARD-DOC-001):
  corrected `sbom/` → `scripts/sbom/`; the browser-path numbers are now
  explicitly labeled Node-instrumented WASM proxy measurements.

### Security

- **Strict JWT audience / authorized-party enforcement**
  (HARD-AUTH-002, High): the gateway previously validated the Clerk
  issuer and signature but accepted **any** audience
  (`validation.validate_aud = false`). Optional exact `aud` and `azp`
  policies are now enforced; the cloud bundle requires a non-`convex`
  audience and pins `azp` to the app origin. Covered by strict
  correct/wrong/array/missing audience, wrong/missing party, future
  `nbf`, and missing-`sub` tests. Related web fix: Clerk middleware
  `authorizedParties` is now validated against `CONCORD_APP_ORIGIN`
  (HARD-WEB-001).
- **Trusted-proxy rate limiting** (HARD-NET-001): `X-Forwarded-For` is
  honored only from configured trusted CIDRs (`GATEWAY_TRUSTED_PROXY_CIDRS`),
  walked right-to-left, with malformed/ambiguous chains rejected — a load
  balancer peer can no longer collapse distinct clients into one rate
  bucket, and spoofed headers from untrusted peers are ignored.
- **Cloud data-plane authentication** (hardening E1–E3): NATS requires
  credentials, Redis requires an ACL user restricted to the exact command
  set the gateway issues (INCR, EXPIRE, DEL, SCAN, HSET), Grafana cloud
  mode requires a real admin login (anonymous auth is local-dev-only),
  and the cloud compose stack uses explicit segmented networks (edge,
  gateway, durable, event, observability) with runtime hardening
  (no-new-privileges, cap-drop ALL, bounded pids/memory, read-only
  rootfs where tolerated) — `docker-compose.cloud.yml`.
- **Supply-chain hardening**: all GitHub Actions pinned to full commit
  SHAs with least-privilege `permissions:` blocks; Dependabot covers npm,
  cargo, github-actions, and docker; CodeQL added for JS/TS and C++
  (`rust/deny.toml` covers the Rust lane via cargo-deny); release images
  scan-gated by `scripts/security/scan-gate.sh` (trivy; new critical/high
  findings fail except dated allowlist entries); cloud compose images are
  digest-pinned.
- **License and provenance work at the historical checkpoint**
  (HARD-LICENSE-001/002): the repository recorded MIT metadata (`LICENSE`,
  copyright 2026 Utkarsh Khajuria) with third-party attribution in `NOTICE`;
  the historical pass recorded replacement of tutorial-inherited artwork,
  fonts, and selected source, plus a rewritten editor chrome. A CI provenance gate
  (`scripts/security/provenance-check.sh`) fails on any shipped file
  byte-identical to the `antonio-original-baseline` tag without a
  verified, permissively-licensed allowlist entry — see
  [docs/PROVENANCE.md](docs/PROVENANCE.md). This is not blanket authorship or
  current legal-clearance evidence; the candidate-bound review remains
  explicit there.

## [1.0.0] - 2026-09-11 (historical tag record)

First historical tagged release (`concord-v1.0.0`): a local-first
collaborative document workspace with the synchronization engine implemented
in this repository. Delivered as eight gated phases
(2026-09-06 → 2026-09-11); phase-by-phase milestones, gates, and
decisions are recorded in [docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/DECISIONS.md](docs/DECISIONS.md) (DEC-001…DEC-050).

### Phases 0–1 — PostgreSQL control plane (2026-09-06)

- Modernized the product shell; removed Liveblocks (smoke tests assert
  its old endpoints 404) and Convex (verified data migration); introduced
  the vendor-neutral collaboration seam.
- PostgreSQL 18 + Drizzle data layer; deny-by-default RBAC
  (OWNER/EDITOR/COMMENTER/VIEWER) with live revocation, IDOR-hardened
  routes (denial indistinguishable from not-found), append-only audit
  table; Clerk handles identity only — all authorization is
  Concord-owned.

### Phase 2 — C++20 CRDT core + WASM + local-first client (2026-09-06)

- One C++20 sequence CRDT (YATA-style origin anchoring, tombstones, LWW
  attribute registers, canonical digests, snapshots), compiled native
  **and** to WebAssembly from a single source; native/WASM golden-vector
  parity asserted by every correctness suite.
- Browser Web Worker runtime with an IndexedDB durable op-log (edits
  durable before ack, reload restoration, corrupted-entry rejection);
  TipTap reconciliation adapter over the collaborative subset with
  honest whole-document fallback outside it.
- Deterministic simulator, seeded property corpus, fuzz targets, and
  ASan/UBSan/TSan-clean builds were recorded in the historical phase gates.

### Phase 3 — Rust sync gateway + wire protocol (2026-09-06 → 09-07)

- Rust/Tokio/Axum gateway; hybrid wire protocol v1 (JSON control frames +
  binary op frames) with cross-language golden parity (TS ⇄ Rust ⇄ C++).
- Clerk RS256 verification with JWKS rotation; per-batch authorization
  recheck (live downgrade denied); durable `crdt_operations` op-log with
  DB-enforced idempotency (`INSERT … ON CONFLICT DO NOTHING`) and
  **commit-before-ACK** durability.
- Bounded queues, slow-consumer containment, heartbeats, graceful
  drain; two-client E2E incl. offline reconciliation, duplicate resends,
  kill-9 recovery; adversarial security suite.

### Phase 4 — Distributed 3-gateway cluster (2026-09-07)

- nginx round-robin LB (no sticky sessions) over N gateways; NATS
  JetStream inter-gateway fanout (batch-granular, msg-id dedup,
  post-commit publish, poison termination) — transport only, never
  truth; Redis ephemeral tier (TTL presence, distributed rate limits
  with local fallback; FLUSHALL-safe by design).
- Crash isolation, reconnect-storm containment, slow-consumer
  isolation, broker lag drain, NATS restart, and compound failures all
  E2E-proven; 1→3 gateway scale-out measured with zero loss.

### Phase 5 — Snapshots, recovery, compaction, history (2026-09-07 → 09-08)

- PostgreSQL-stored versioned snapshots with SHA-256 checksums and a
  guarded build → verify → finalize lifecycle; native C++ recovery
  worker (bounded, deterministic, content-silent) spawned per request.
- **Snapshot+tail recovery: 98.6 % faster than full replay** (100 k-op
  history, 1 k tail; 5 runs, digest-verified every run); crash-safe
  staged compaction (50.1 % durable bytes retained after full
  compaction of a 50 k-op document); stale-client resync below the
  compaction floor.
- Version history: boundary-referencing revisions, read-only
  reconstruction, and restore-as-forward-ops (owner-only, auditable,
  never discards acknowledged edits); lease-fenced maintenance jobs.

### Phase 6 — Historical proof phase (2026-09-09)

- 32-row threat model fully mapped to controls, with executable tests or
  explicitly planned extended-fuzz coverage recorded for every row
  ([docs/SECURITY.md](docs/SECURITY.md) §8) — no unmapped rows.
- Historical records report 27/27 deterministic chaos scenarios (gateway,
  NATS, Redis, PostgreSQL, worker, compound faults): **0 lost
  durable-ACKed operations, 0 divergent replicas**; 181/181 correctness
  scenarios; and a 130-seed randomized campaign (1.06 M operations).
- Historical records report 5 M fuzz executions across 5 native targets + 5
  Rust decoder targets, zero crashes, and corpus regressions for fixed
  crashes (including FUZZ-2026-09-001).
- Historical records report ASan/UBSan and TSan green across the native
  matrix; secret/dependency scans, deterministic SBOMs, multi-stage non-root
  release images, and observability evidence. No current sanitizer, fuzz,
  deployment, or live-observability result is implied.

### Phase 7 — Historical production release + deployment record (2026-09-09 → 09-11)

- Profiling-driven ingest optimization: durable-ACK p50 31.45 → 2.72 ms
  (−91.4 %), throughput 771 → 8,685 ops/s (11.3×) — replay digests
  identical before/after.
- Historical records describe staging → production on AWS EC2 (Graviton, one
  compose stack per environment, ALB for TLS/WSS, no Kubernetes) with the
  10-service compose stack, SSM-delivered secrets, measured graceful drain
  (~2.2–3 s), and browser E2E on the release build. This is not current
  runtime proof.
- CSP/CSWSH live fixes found on production (pinned CSP incl.
  `wasm-unsafe-eval`; `GATEWAY_ALLOWED_ORIGINS` enforced at the WS
  upgrade); OpenSSL CVE patches in release images; final benchmark
  reruns on the exact shipped tree (recovery 98.4 % faster, 4th
  consecutive reproduction: 98.6/98.5/98.6/98.4 %).
- A prior project state described the web tier as Vercel + Neon PostgreSQL +
  Clerk (free tier) at
  [concord-dev.vercel.app](https://concord-dev.vercel.app); it also records
  the AWS gateway stack as torn down. Neither the URL nor a current deployed
  version/auth/realtime state is claimed by this changelog.

[Unreleased]: https://github.com/UtkarsHMer05/Concord-Dev/compare/concord-v1.0.0...HEAD
[1.0.0]: https://github.com/UtkarsHMer05/Concord-Dev/releases/tag/concord-v1.0.0
