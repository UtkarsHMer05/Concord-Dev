# Concord `1.0.1` candidate evidence

Status: `CANDIDATE_PENDING` · not a release
Captured: 2026-09-14 (Asia/Kolkata)
Implementation candidate: `42dcb17dd26c11a05dd20109102f37ea3fb5135a`

This directory contains fresh, candidate-bound local evidence for the
implementation commit above. It does not contain credentials, does not create
or imply a `v1.0.1` tag, and does not prove a GitHub Release, deployment, URL,
live Clerk session, or persistent realtime runtime.

The canonical interpretation is in:

- [`docs/audits/CANONICAL_RELEASE_REPORT.md`](../../docs/audits/CANONICAL_RELEASE_REPORT.md)
- [`docs/audits/CANONICAL_RELEASE_LEDGER.json`](../../docs/audits/CANONICAL_RELEASE_LEDGER.json)
- [`docs/audits/CANONICAL_FRESH_EVIDENCE.md`](../../docs/audits/CANONICAL_FRESH_EVIDENCE.md)

## Recorded local results

- Web typecheck, lint, unit tests, coverage, disposable PostgreSQL DB tests,
  realtime tests, and production build passed.
- Native Release/CTest, WASM parity/smoke, Rust workspace tests, property
  campaign, bounded native fuzz campaign, ASan/UBSan, and TSan passed.
- The refreshed authenticated local NATS/JetStream and Redis ACL negative
  tests passed; the isolated E2E compose project was removed afterward.
- The 27-scenario local chaos run passed with zero lost durable-ACKed
  operations and zero divergent replicas.
- The exact image smoke, SBOM regeneration, secret scan, provenance checks,
  findings validation, and immutable-image-pin validation passed.

## Blocking or external results

- The strict local dependency/container scan remains red: `44 Critical` and
  `180 High` container findings are unaccepted across the refreshed dev/cloud
  image inventory. No broad allowlist was used.
- The secret-backed authenticated Chromium/Firefox/WebKit jobs and
  `browser gate` were removed from current CI at the owner's request. No
  `concord-e2e` Clerk values are required by the current workflow; no remote
  authenticated-browser result is claimed.
- Current CI-policy commit `bd0c3c099bc32d9fa296c8fafb7d6888df1fa1bf` passed
  phase6-pr-ci run `34808535778`, CodeQL, and the phase2/3/4/5/6 supporting
  workflows. The public Chromium job was skipped on the protected-branch
  push; no secret-backed browser jobs or `browser gate` ran. Nightly release
  contexts, artifacts, checksums, attestations, and a GitHub Release remain
  pending. Exact run `34807277532` on
  `110881d6b2c9fdc1d3b4f2da26676d7fdf602f2a` remains historical pre-removal
  evidence of the old empty-Clerk preflight.
- GitHub Dependabot vulnerability alerts and automated security fixes were
  observed disabled/unverified at account level; checked-in configuration is
  not a substitute for that setting.
- No AWS or Vercel/live-runtime verification was requested or claimed.

Four development-only npm Moderate findings remain in the Drizzle/esbuild
tooling chain. A forced audit repair would introduce a breaking Drizzle
tooling downgrade; the advisory's dev server is not started or reachable in
production. This is documented in `docs/SECURITY.md` and remains a precise
residual, not a hidden clean result.
