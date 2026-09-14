# Concord release and deployment status

Status: `CANDIDATE_PENDING` · not release-ready
Last updated: 2026-09-14
Candidate version: `1.0.1`
Implementation candidate: `42dcb17dd26c11a05dd20109102f37ea3fb5135a`
Canonical report: [`docs/audits/CANONICAL_RELEASE_REPORT.md`](audits/CANONICAL_RELEASE_REPORT.md)
Machine-readable ledger: [`docs/audits/CANONICAL_RELEASE_LEDGER.json`](audits/CANONICAL_RELEASE_LEDGER.json)
Fresh local evidence: [`docs/audits/CANONICAL_FRESH_EVIDENCE.md`](audits/CANONICAL_FRESH_EVIDENCE.md)
Candidate evidence bundle: [`evidence/v1.0.1/`](../evidence/v1.0.1/)

This document is the release-state boundary. The current implementation
candidate has passed the credential-free local gates that were run, but the
campaign has not produced a canonical release. The strict container scan is
red (`44 Critical / 180 High`, no broad allowlist), the trusted Clerk browser
Environment is empty, exact candidate remote CI/nightly results are pending,
and external provenance/account actions remain open.

No credential, tag, GitHub Release, registry push, AWS deployment, Vercel
deployment, URL reachability, live Clerk session, or persistent realtime
runtime is claimed.

## Current identity

| Name | Value | Meaning |
|---|---|---|
| Implementation candidate | `42dcb17dd26c11a05dd20109102f37ea3fb5135a` | Exact code/configuration SHA used by the fresh local evidence |
| Version | `1.0.1` | Synchronized package, Rust, CMake, and SBOM metadata |
| Branch | `main` | Local branch used by this campaign |
| Canonical tag | None | No tag was created or moved |
| GitHub Release | None | Publication is gated and has not occurred |
| Historical `v1.0.0-hardened.10` | `b711111431f15717c2a887f81404eabce71e1046` | Preserved historical checkpoint only |
| Historical `concord-v1.0.0` | `f9ecc6eb23ef2bbb329ae009b26f1dc0b8f7432a` | Preserved historical checkpoint only |

The canonical report and candidate evidence are documentation-only descendants
of the implementation candidate. They do not change or replace the SHA that
the tests exercised. Historical evidence under `evidence/v1.0.0/` and the
historical audit reports are preserved rather than rewritten as current proof.

## Release verdict

`PARTIAL / FAIL` for repository/release engineering and
`CANDIDATE_PENDING` for the candidate state. This means the repository work
that can be completed without external credentials or unsupported security
exceptions has been carried through and verified, while the remaining release
gates are real blockers.

### Fresh local results

- Web typecheck, lint, 209 unit tests, coverage, 69 DB tests, 21 realtime
  tests, and the Next production build passed.
- The full strict local orchestrator completed 25 PASS / 1 FAIL / 0 SKIP / 0
  required SKIP; every local browser job passed in dev mode using `.env.local`,
  while the trusted production-mode Clerk lane remains a separate unresolved
  gate.
- Apple Clang native Release/CTest 3/3, WASM smoke/parity, Rust format/lint
  and 258-test workspace run, 30/30 property seeds, and 160,000 bounded
  fuzz executions passed.
- ASan/UBSan and TSan passed locally. macOS leak detection was explicitly
  disabled because the runtime does not support it; no sanitizer diagnostic
  was emitted.
- The refreshed authenticated NATS/JetStream and Redis ACL negative tests
  passed, and chaos run `20260914-090958-chaos` passed 27/27 with zero lost
  durable-ACKed operations and zero divergent replicas.
- Image smoke passed 3/3 from an exact clean source export; SBOM generation,
  secret/history scan, provenance regression scan, findings validation, and
  immutable image-pin validation passed.

The complete command/result table is in
[`CANONICAL_FRESH_EVIDENCE.md`](audits/CANONICAL_FRESH_EVIDENCE.md).

### Remaining blockers

- Strict container scan: Postgres `6/38`, NATS `3/13`, Redis `2/10`, nginx
  `0/0`, Prometheus `11/38`, and Grafana `22/81` Critical/High findings at
  exact digest-pinned refs. These are unaccepted until fixed or resolved by
  exact advisory-level evidence. See [`docs/SECURITY.md`](SECURITY.md) §9.2.
- Trusted authenticated Chromium/Firefox/WebKit production-mode browser
  matrix: blocked by the empty GitHub `concord-e2e` Environment.
- Exact remote CI/nightly results: not observed for the candidate until it is
  pushed; historical runs do not cover this SHA or changed workflows.
- Release identity: no tag, manifest, checksum set, attestation, or GitHub
  Release may be created while required gates are unresolved.
- Dependabot vulnerability-alert and automated-fix account settings: the GitHub
  API readback reported both disabled; `.github/dependabot.yml` does not prove
  account-level enablement.
- Provenance/licensing: mechanical scan is clean, but path-specific owner/legal
  disposition is not the same as automated authorship or legal clearance.

## Required Clerk Environment

The trusted browser workflow uses GitHub Environment `concord-e2e`. Configure
these values only in that environment; never commit or paste the secret:

```text
CONCORD_E2E_CLERK_PUBLISHABLE_KEY  Environment variable (pk_test_...)
CONCORD_E2E_CLERK_AUDIENCE         Environment variable (exactly concord-e2e)
CONCORD_E2E_CLERK_ISSUER           optional Environment variable
CONCORD_E2E_CLERK_SECRET_KEY       Environment secret (sk_test_...)
```

The token template must emit the exact `concord-e2e` audience. The browser
harness then binds the authorized party and `CONCORD_APP_ORIGIN` to the exact
per-run origin, and the secret is supplied only to the final Playwright/global
setup execution path. Missing values fail closed; they are not converted to a
public-browser pass.

## Candidate verification procedure

Run from a clean checkout and bind every result to one SHA:

```bash
git status --short --branch
git diff --check
git rev-parse HEAD^{commit}
bash scripts/verify-all.sh --strict
```

The full matrix also includes:

- web typecheck/lint/unit/coverage, disposable DB migrations/tests,
  realtime, and production build;
- Linux GCC and Clang native Release/CTest, worker smoke, WASM build/parity,
  and gitless archive verification;
- Rust fmt, Clippy, workspace/integration/reliability tests, `cargo audit`,
  and `cargo deny`;
- no-retry trusted Chromium/Firefox/WebKit production-mode browser journeys,
  accessibility, realtime convergence, reconnect, local persistence, and
  negative auth-policy checks;
- fresh ASan/UBSan/TSan, property, corpus/fuzz, recovery, and chaos runs;
- secret/history, provenance, dependency, image-pin, SBOM, image smoke,
  CodeQL, release Trivy, manifest, checksum, and attestation checks; and
- exact GitHub check-run conclusions for the candidate SHA, including
  `browser gate`, trusted browser jobs, `native-sanitizers`, `native-fuzz`,
  `rust-fuzz`, and `chaos`.

No missing credential, service, browser, scanner, or remote result may be
turned into a green parent gate. No release image or dev image finding may be
hidden by a blanket allowlist.

## Canonical release gate

Only after all required gates are green may the release lead:

1. freeze the exact `releaseCommit` and verify synchronized version metadata;
2. verify every required GitHub check-run on that SHA;
3. confirm trusted Clerk production-mode browser success and release-image
   security policy;
4. generate artifacts, SBOMs, a manifest, and `SHA256SUMS` from that exact
   commit/tag;
5. independently verify artifact hashes and any supported attestation;
6. create one normal SemVer tag such as `v1.0.1` without moving historical
   tags; and
7. publish and API-verify one canonical GitHub Release.

Tag or release immutability may be claimed only if a repository ruleset or
other enforceable control is actually observed. A preserved/protected tag is
not automatically immutable. Production deployment is a separate operation.

## Hosting boundary

The former AWS environment is recorded as torn down. AWS is not a default
release target and was not reprovisioned in this campaign. If a live release
is later authorized, the selected provider must support the persistent Rust
gateways, native worker, PostgreSQL, NATS/JetStream, Redis, and proxy; a
serverless web deployment alone is not proof that the realtime stack exists.

The current public URL, if retained elsewhere in the repository, is a
configuration/historical reference only. Without a fresh authorized runtime
check recording origin, deployed SHA/image digests, health, TLS/WSS, Clerk
auth, and realtime behavior, the correct status is `NOT_DEPLOYED / NOT_CLAIMED`.

## Historical evidence policy

The historical `v1.0.0` evidence and hardening reports retain their original
results, dates, and limitations. They may explain the regression story, but
they cannot close a current gate when implementation, workflow, image,
browser, environment, or workload has changed. Current candidate evidence is
stored under `evidence/v1.0.1/` and linked to the exact implementation SHA.

See the canonical report and ledger for the complete finding taxonomy,
owner-action registry, and final evidence paths.
