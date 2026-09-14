# Concord `1.0.1` candidate — fresh local evidence

Status: `CANDIDATE_PENDING` · not a release verdict
Run date: 2026-09-14 (Asia/Kolkata)
Implementation candidate: `42dcb17dd26c11a05dd20109102f37ea3fb5135a`

This is the candidate-bound local evidence record for the Concord remediation
implementation. It is deliberately separate from the preserved
`evidence/v1.0.0/` checkpoint and from the final documentation commit that
publishes this record. No credential, release tag, GitHub Release, deployment,
or live-runtime state is claimed.

## Identity and source fence

The executable/configuration candidate is commit
`42dcb17dd26c11a05dd20109102f37ea3fb5135a`. The only implementation changes
between the preceding candidate `8731dbe` and this SHA are:

1. the native benchmark random-delete denominator now reports the configured
   `kRandomDeletes` value;
2. digest-pinned Compose/security image references were refreshed (NATS
   `2.12`, nginx `1.31.5`, Grafana `12.3.0`, with Postgres, Redis, and
   Prometheus refs retained after comparison); and
3. release image smoke/dependency-scan metadata now uses the exact exported
   tree and refreshed image references.

The canonical documents and `evidence/v1.0.1/` files are documentation-only
descendants created after the candidate-bound runs. They do not change the
implementation under test. The initial canonical evidence bundle is committed
at `d38541330909c063926eaa02c179ba6136004a43`; later remote-state updates, if any, remain descendants and must
not replace the implementation SHA.

## Fresh local gates

| Area | Exact command or workload | Result | Candidate-bound evidence and limitation |
|---|---|---|---|
| TypeScript | `npm run typecheck` | `PASS` | Next.js 16.3.5; local candidate |
| Lint | `npm run lint` | `PASS` | Local candidate |
| Unit | `npm test` | `PASS` · 16 files / 209 tests | Vitest unit project; DB setup is isolated |
| Coverage | `npm run test:coverage` | `PASS` · statements 86.96%, branches 78.51%, functions 88.20%, lines 87.50% | V8 report; not used as a weak correctness threshold |
| Database | `npm run db:test:prepare && npm run db:migrate:test && npm run test:db` | `PASS` · 7 files / 69 tests | Disposable local PostgreSQL 18.6 |
| Realtime | `npm run test:realtime` | `PASS` · 3 files / 21 tests | Release Rust gateway plus real WebSockets, local JWKS, PostgreSQL, NATS, and Redis |
| Web build | `CONCORD_REQUIRE_TLS=0 NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dummy CLERK_SECRET_KEY=sk_test_dummy NEXT_PUBLIC_SYNC_GATEWAY_URL=ws://127.0.0.1:8791 GATEWAY_CLERK_ISSUER=https://e2e.clerk.accounts.dev DATABASE_URL=postgres://concord:concord_local_dev@127.0.0.1:5433/concord npm run build` | `PASS` | Build-time inert Clerk values only; no live auth claim |
| Public browser | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dummy CLERK_SECRET_KEY='' DATABASE_URL='' NEXT_PUBLIC_SYNC_GATEWAY_URL=ws://127.0.0.1:1 npx playwright test --config=playwright.public.config.ts` | `PASS` · 1 Chromium test | Secretless production surface; no Clerk session, DB, gateway, or broker |
| Local dev-mode browser matrix | `STEPS="web native rust wasm browser provenance security" bash scripts/verify-all.sh --strict` | `PASS` for all browser jobs | Full local Chromium journey/accessibility plus Firefox/WebKit smoke completed using the local `.env.local` and default dev-mode configuration; this is diagnostic local evidence, not the trusted production-mode remote Clerk gate |
| Native Release | `bash scripts/verify-native.sh Release` | `PASS` · CTest 3/3 | Apple Clang 21 / CMake 4.2.1; core, property smoke, worker. The Linux GCC lane remains a remote-CI requirement |
| WASM | `bash scripts/verify-wasm.sh` | `PASS` · WASM smoke + 5 files / 31 CRDT tests | Emscripten 6.0.9; local parity/runtime gate |
| Rust format/lint | `cargo fmt --all --check`; `cargo clippy --workspace --all-targets --all-features -- -D warnings` | `PASS` | Local Rust toolchain; exact outputs are not a remote check conclusion |
| Rust workspace | `cargo test --manifest-path rust/Cargo.toml --workspace -- --test-threads=1` | `PASS` · 258 passed / 1 ignored / 0 failed | Full workspace, including DB, broker, chaos, recovery, authz, protocol, Redis, and WebSocket suites |
| Property | `bash scripts/native/campaign.sh pr` | `PASS` · 30/30 seeds | 5 replicas × 2,000 operations/seed = 60,000 generated operations; all converged |
| Native fuzz | Five standalone targets with 20,000–50,000 executions each | `PASS` · 160,000 executions | `op_decode`, `snapshot_decode`, `op_apply`, `recovery_stream`, `worker_protocol`; bounded campaign, not exhaustive libFuzzer coverage |
| ASan/UBSan | `ASAN_OPTIONS=detect_leaks=0:halt_on_error=1 UBSAN_OPTIONS=print_stacktrace=1 bash scripts/verify-native.sh asan-ubsan` | `PASS` · CTest 3/3; 153.59s total | macOS runtime does not support the required leak mode, so leak detection was explicitly disabled; no sanitizer diagnostic |
| TSan | `TSAN_OPTIONS=halt_on_error=1 bash scripts/verify-native.sh tsan` | `PASS` · CTest 3/3; 428.18s total | No TSan diagnostic; remote Linux/nightly lane remains required |
| Chaos/reliability | `bash scripts/chaos/run-suite.sh all` | `PASS` · 27 attempted / 27 passed / 0 failed / 0 skipped | Run `20260914-090958-chaos`; lost durable-ACKed ops 0; divergent replicas 0 |
| Internal service auth | Isolated `docker-compose.e2e.yml` plus `node scripts/e2e/verify-infra-auth.mjs` | `PASS` | Authenticated NATS JetStream/pubsub and Redis ACL allow/deny checks; project was cleaned afterward |
| Image smoke | `CONCORD_RELEASE_GIT_SHA=$(git rev-parse HEAD) scripts/release/smoke-images.sh` | `PASS` · 3/3 | Gateway health/live, web HTTP, worker `generate_ops`, non-root IDs, graceful termination; exact exported source tree |
| SBOM | `bash scripts/security/sbom.sh` | `PASS` | Web 194, Rust 327, native 7 components; JSON parse and secret scan clean; deterministic outputs unchanged |
| Image pins | `bash scripts/security/validate-image-pins.sh` | `PASS` | 19 immutable refs checked; 7 runtime inputs deferred by design |
| Secret history | `bash scripts/security/secret-scan.sh --history` | `PASS` | Zero non-allowlisted findings; values are not stored in this evidence |
| Provenance | `bash scripts/security/provenance-check.sh && bash scripts/security/provenance-tests.sh` | `PASS` | 54 baseline-overlapping paths; 0 unallowlisted identical; 14 regression assertions |
| Findings registry | `bash scripts/security/validate-findings.sh` | `PASS` | 22 historical findings; unique IDs; no historical OPEN Critical/High |
| Dependency/security aggregate | `bash scripts/security/dep-scan.sh` | `FAIL` · release blocker | Production npm 0/0/0/0; full npm tree 0/0/4/0 Moderate; Cargo 0/0/0/0; refreshed containers 44 Critical / 180 High / 158 Moderate / 20 Low; tool errors 0; no broad allowlist |

The complete strict local orchestrator finished with **25 PASS / 1 FAIL / 0
SKIP / 0 required SKIP**. Every web, native, Rust, WASM, browser, provenance,
and security sub-gate passed except `security/dependency-scan`; its exact
failure is the unaccepted container inventory recorded above. The browser
passes in that aggregate used local development credentials/configuration and
must not be relabeled as trusted production-mode Clerk evidence.

The full current image inventory, immutable references, scanner version, and
per-image remediation notes are in
[`evidence/v1.0.1/container-scan.json`](../../evidence/v1.0.1/container-scan.json)
and in [`docs/SECURITY.md`](../SECURITY.md) §9.2. The NATS and nginx refreshes
reduced the prior inventory, but the remaining Critical/High findings are not
accepted and prevent a canonical release.

## External and unresolved gates

1. **Secret-backed authenticated browser CI — intentionally removed.** Per
   the current owner request, the CI jobs that provisioned Clerk-backed
   Chromium/Firefox/WebKit coverage and the aggregate `browser gate` were
   deleted. The GitHub `concord-e2e` Environment is therefore no longer a CI
   prerequisite. The public secretless Chromium smoke and the local
   explicitly provisioned browser matrix remain available; no current remote
   authenticated-browser result is claimed.
2. **Remote exact-SHA CI — pending after the CI-policy change.** The earlier
   candidate run `34807277532` on `110881d6b2c9fdc1d3b4f2da26676d7fdf602f2a`
   is retained as historical pre-removal evidence: web, Rust, WASM, security,
   and native GCC/Clang passed, while the then-existing trusted browser jobs
   failed closed at the empty Clerk preflight. A new workflow commit must
   produce the current non-browser check conclusions; CodeQL and the
   phase2/3/4/5/6 supporting runs remain separate evidence. Nightly
   `native-sanitizers`, `native-fuzz`, `rust-fuzz`, and `chaos` conclusions
   remain pending.
3. **Release identity/artifacts — pending.** No `v1.0.1` tag, release manifest,
   checksum set, artifact attestation, registry push, or GitHub Release exists.
   These cannot be produced honestly while required gates remain unresolved.
4. **Dependabot account settings — owner action.** GitHub API readback reported
   vulnerability alerts disabled and automated security fixes disabled.
   `.github/dependabot.yml` is present but does not prove account-level
   enablement.
5. **Provenance/licensing — owner/legal action.** Mechanical provenance checks
   pass, but the retained tutorial baseline and third-party/generated paths
   still require path-specific review; scanner cleanliness is not blanket
   legal clearance.
6. **Live runtime — not claimed.** No AWS, Vercel, Neon, URL, TLS, deployed
   SHA, live Clerk, or persistent realtime verification was performed. AWS is
   not to be reprovisioned as a documentation shortcut.

The stale browser contexts on protected `main` were removed during this
campaign. GitHub API readback now shows strict required contexts only for the
web, Rust, WASM, security, native GCC/Clang, and CodeQL checks; no browser
context is required and no other branch-protection settings were changed.

## Credential action

No Clerk secret or `concord-e2e` Environment configuration is required for
the current GitHub CI policy. Authenticated browser coverage remains an
explicitly provisioned local/developer option, but it is not represented as
current remote release evidence. The candidate remains `CANDIDATE_PENDING`
for the independent container, nightly, account, provenance, and release
artifact gates documented above.
