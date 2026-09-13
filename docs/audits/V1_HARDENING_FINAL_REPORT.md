# CONCORD V1 FINAL REMEDIATION — FINAL CAMPAIGN REPORT

Campaign: CONCORD V1.0.0 final remediation, reproducibility, browser E2E,
provenance, security, release, and documentation campaign.

Campaign start SHA: 4ce066f0120d94ecdb8b1a6684f3666f9bac05ff.

Ending implementation SHA: b711111431f15717c2a887f81404eabce71e1046.

Final audited implementation SHA: b711111431f15717c2a887f81404eabce71e1046
(the report publication commits are docs-only).

Final audited tag: v1.0.0-hardened.10.

Branch: main.

GitHub release state: v1.0.0-hardened.10 is published, non-draft, and
non-prerelease.

Toolchains recorded in the final release manifest: Node v24.20.0, npm
11.19.0, cargo 1.98.1, CMake 4.4.2, and Linux C++ compiler
13.3.0. Local portability verification additionally used GCC 15.2.0 and
Apple Clang 21.0.0.21000101. Browser verification used Playwright 1.63.0
and axe-core/playwright 4.13.0.

The report publication is a docs-only descendant of the audited
implementation SHA. The exact final main SHA is the result of `git rev-parse
HEAD` after publication and is recorded in the final response.

Date: 2026-09-13.

## 1. Final verdict

CONCORD V1 FINAL REMEDIATION — PARTIAL / FAIL.

The repository implementation and release-artifact workflow are hardened and
the final release workflow is green on the audited implementation SHA.
However, the three required GitHub Actions browser jobs are red because the
repository has no disposable Clerk E2E credentials. Those jobs fail closed at
their explicit prerequisite check before running browser tests. The master
prompt requires every required GitHub Actions workflow/job to be green before
the verdict can be PASS, so PASS is not declared.

No repository-actionable Critical or High finding is OPEN in the validated
ledger. Three genuinely external items remain OWNER ACTION: Clerk audience
migration, live hosted-origin verification, and production trusted-proxy
CIDR wiring. GitHub Dependabot vulnerability alerts also remain an external
settings action because the GitHub API returned 5xx while the campaign tried
to enable them; the repository Dependabot configuration itself is present.

## 2. Executive summary

This campaign began from a clean main checkout at
4ce066f0120d94ecdb8b1a6684f3666f9bac05ff and produced the audited hardened
implementation at b711111431f15717c2a887f81404eabce71e1046. It added
fail-closed provenance and secret gates, strict security and dependency
checks, real Playwright browser and accessibility coverage, reproducible
native/WASM/release artifacts, database-backed image smoke tests, exact
release traceability, and a reconciled 22-finding ledger.

The campaign also found and fixed defects that earlier evidence had missed:
the provenance scanner could report success when a baseline tag was missing,
gitless native builds embedded an empty version suffix, the secret scanner
could swallow an internal per-file failure, configured WebSocket frame
budgets were not consumed on every ingress path, the release workflow had
several environment and traceability defects, and the runtime web image
shipped unused npm tooling containing four newly failing High vulnerabilities.

The final release workflow run 34751270511 completed successfully on
b711111431f15717c2a887f81404eabce71e1046. Its checksums, manifest, SBOMs,
Trivy reports, worker/WASM packages, and both image archives were downloaded
and verified locally, then published to the immutable hardened GitHub
release.

## 3. Changes made

| Area | Files changed | Root cause | Implementation | Regression test/evidence | Commit SHA |
|---|---|---|---|---|---|
| Provenance/tags/licensing | scripts/security/provenance-check.sh, scripts/security/provenance-tests.sh, docs/PROVENANCE.md, LICENSE, NOTICE, release workflows | Missing/invalid baseline metadata could produce a clean zero-path scan; tutorial-derived material and tag state were not defensible | Validated commit/tag enumeration, zero-file/zero-overlap rejection, authentic remote baseline and hardened tags, original replacements, MIT/NOTICE/SBOM alignment | 14 provenance assertions; final scan 123 baseline files, 54 overlaps, 0 unallowlisted matches; remote tag verification | 2c212b7; 9f1f418; 8107592 |
| Native/CMake/WASM | cpp/worker/main.cpp, cpp/CMakeLists.txt, .github/actions/build-wasm/action.yml, scripts/verify-all.sh | Empty defined git SHA malformed gitless version output; portability and toolchain gates needed continuous coverage | Non-empty SHA embedding, stable archive version, direct includes, root CTest/cwd-independent paths, exact emsdk pin | Git checkout/archive/forced-empty version cases; GCC/Clang CTest 3/3; Emscripten 6.0.9 and 30 tests | 7aeaa88; 9f1f418 |
| Browser E2E | playwright.config.ts, scripts/browser-e2e-setup.mjs, tests/browser/{helpers,journey,smoke}.ts, src/proxy.ts | No rendered-browser coverage of the production web/gateway/Clerk path | Real Playwright Chromium journey plus Firefox/WebKit smoke, disposable Clerk/database/services, fail-closed prerequisites | Chromium 12/12; Firefox retry 1/1; WebKit 1/1; reconnect, realtime, auth isolation, network-failure, console checks | 48fe966; 44e0150 |
| Accessibility | tests/browser/a11y.spec.ts, package.json, package-lock.json | No automated representative-page accessibility gate | axe-core/playwright scans, keyboard/focus probe, named-button and landmark checks without global rule suppression | Five accessibility tests; no serious/critical violations | 48fe966 |
| Gateway/auth/security | rust/sync-gateway/src/ephemeral/ratelimit.rs, rust/sync-gateway/src/ws/mod.rs, src/proxy.ts, tests/proxy-claim-policy.test.ts, tests/browser/journey.spec.ts | Auth refresh, audience/party, trusted-proxy, CSP, and configured frame-limit paths were incomplete or under-tested | JWKS hardening, strict claim policy, reserved-ID rejection, trusted XFF parsing, nonce CSP, all configured WS budgets | Rust auth/WS suites, nine CSP assertions, browser isolation/reconnect, full serial Rust workspace | c51fff5; 48fe966; 9f1f418; 44e0150 |
| CI/strict verification | .github/workflows/*.yml, scripts/verify-all.sh, scripts/security/scan-gate.sh, scripts/security/secret-scan*.sh | Floating/weak workflow gates and swallowed prerequisite/scanner failures could false-green | SHA-pinned actions, least privilege, explicit strict mode, fail-closed scanners, enforced release scan policy | Final CI matrix, secret fail-closed injection test, security/provenance/ledger gates | 2c212b7; 7aeaa88; 9f1f418 |
| Supply chain/dependencies | .github/dependabot.yml, scripts/security/dep-scan.sh, scripts/sbom/web.cdx.json, Dockerfiles, docker-compose.yml | Dependency claims, container scans, image tags, and release security posture were inconsistent | npm/Cargo/actions/Docker Dependabot coverage, digest pins, SBOM refresh, exact dev-only policy, release Trivy enforcement | npm/cargo/cargo-deny scans; final web/gateway Trivy reports zero; unaccepted dependency findings 0 | 2c212b7; 9f1f418; b711111 |
| Release/reproducibility | .github/workflows/phase6-release-artifacts.yml, scripts/release/smoke-images.sh, scripts/release/write-manifest.mjs, release source inputs | Release metadata, image tags, DB reachability, migrations, shell command, and image smoke assumptions failed in successive candidates | Clean archive build, DB migration, image gateway boot, exported tags, manifest/checksums/SBOMs, immutable candidate tags | Release run 34751270511 passed; protocolVersion 1 manifest; all SHA256SUMS entries verify | 611cbb1; d2b705a; 32a1090; 305b6eb; a04fe1c; 1e1f819; af3df5e; e7bf71b; 0ae5943 |
| Runtime image hardening | docker/web.Dockerfile | Final Trivy gate found four High vulnerabilities in unused npm runtime tooling | Removed npm, npx, and Corepack from the Node runtime while retaining direct Node execution | Final web image Trivy report: zero vulnerabilities; local runtime probe confirms Node works and package-manager payloads are absent | b711111 |
| Infrastructure/deployment | docker-compose.cloud.yml, docker/redis/users.acl, scripts/deploy/push-bundle.sh, .env.example, scripts/bootstrap-dev.sh | Cloud defaults, Redis permissions, deployment assumptions, and local bootstrap paths needed explicit safe behavior | Authenticated internal services, restricted Redis ACLs, segmented networks, scoped bundle/deploy checks, and documented bootstrap values | Cloud configuration tests, Redis/NATS live fail-closed proofs, and release image smoke | 578bad2; 9f1f418 |
| Reproducibility/coverage | cpp/CMakePresets.json, scripts/verify-all.sh, scripts/verify-native.sh, scripts/release/smoke-images.sh, scripts/release/write-manifest.mjs, .github/workflows/phase6-release-artifacts.yml, scripts/worker-bundle.mjs | Source archives, release metadata, strict local gates, and diagnostic coverage needed repeatable commands and explicit provider behavior | Cwd-independent builds, clean archive/version handling, traceable manifests, fail-closed coverage wrappers, and public evidence index | Clone/archive CTest 3/3 and Next builds; TS/native/Rust coverage diagnostics; evidence/v1.0.0 | this campaign |
| Documentation/truth ledger | README.md, docs/**, .env.example, CHANGELOG.md, CONTRIBUTING.md, docs/audits/V1_HARDENING_FINDINGS.md | Stale counts, terminology, deployment claims, duplicate IDs, and owner-state descriptions overstated completion | Evidence-based wording, schema-v2 unique ledger, explicit owner actions and residual risks | validate-findings: 22 unique findings, no OPEN Critical/High; report structure verified | 9640f28; 9f1f418; this campaign |

## 4. Findings discovered during this campaign

The campaign reproduced and closed the following additional or previously
under-specified defects. The IDs below are the corresponding ledger entries
where the defect is independently tracked; release-candidate failures are
grouped under the existing release/container gate rows.

| ID | Severity | Area | Root cause | Fix | Regression test | Final status |
|---|---|---|---|---|---|---|
| SA-PROV1 | Critical | provenance gate | Missing baseline/tag enumeration could feed an empty scan to a successful loop | Require a commit-resolving tag, materialize enumeration, reject zero-file/zero-overlap cases, propagate git failures | scripts/security/provenance-tests.sh, 14 assertions; final scan 54 overlaps | CLOSED |
| SA-NATV1 | High | native release | An empty but defined CONCORD_GIT_SHA generated malformed gitless version output | Embed only a non-empty SHA and keep archive output as plain concord-worker 1.0.0 | Checkout, source archive, and forced-empty version tests; worker suite | CLOSED |
| SA-SEC-001 | High | security tooling | Tracked-file awk/grep failures could be swallowed as a clean secret scan | Return actionable exit 2 for internal scanner failures | Injected tracked-file failure in scripts/security/secret-scan-tests.sh | CLOSED |
| HARD-RATE-001 | Medium | gateway limits | Configured write/malformed/binary/validated-operation budgets were not all consumed at frame ingress | Wire all four scopes through the WebSocket ingress paths | Limiter scope regression and WebSocket integration suites | CLOSED |
| HARD-CI-002 | High | release gate | Release candidates exposed metadata, image-tag, DB binding/migration, shell-continuation, and manifest-reference assumptions that were not exercised together | Correct the workflow and rerun immutable candidates through clean archive image smoke | Final release run 34751270511 passed every release step | CLOSED |
| HARD-IMG-001 | Medium | container security | Base-image reproducibility and mutable `apk` security-refresh behavior needed an explicit policy | Pin image digests and document the deliberate security-freshness tradeoff for `apk upgrade` | Registry digest resolution and container policy review | CLOSED |
| SA-IMG-001 | High | container security | Final candidate Trivy output identified four High CVEs in unused npm runtime subtrees (`CVE-2026-14257`, `CVE-2026-69152`, `CVE-2026-69192`, `CVE-2026-73566`) | Remove npm, npx, and Corepack from `docker/web.Dockerfile`; retain direct Node execution and rescan the image | Release run 34751270511 web/gateway Trivy reports 0; local runtime probe and image smoke | CLOSED |

## 5. Previous audit findings reconciliation

The prior final report in this path was stale: it had a different title,
different branch and start/end SHAs, declared PASS, listed 19 findings, and
claimed no multi-browser Playwright suite. It also treated remote publishing,
branch protection, and tags as owner-only even though the current campaign
explicitly authorized and completed those repository/remote actions.

This report replaces that claim set with the final evidence. The current
ledger has 22 unique findings, preserves original severities, uses the
allowed CLOSED/OWNER ACTION vocabulary, and records external work without
pretending that fail-closed code alone completes it. Browser verification is
now real Playwright coverage locally; remote browser CI remains red because
its required credentials are not configured. Release claims are tied to the
exact audited SHA and immutable tag.

| Previous issue | Previous state | Current state | Evidence |
|---|---|---|---|
| Provenance false-green / missing baseline | Empty or missing baseline could appear clean | CLOSED | Remote baseline tag, 123 baseline files, 54 overlaps, 0 unallowlisted; 14 fail-closed assertions |
| Gitless worker version | Archive output was `concord-worker 1.0.0 ()` | CLOSED | Clone/archive versions and CTest 3/3 on `v1.0.0-hardened.10` |
| Secret scanner internal failure | Per-file failure could be swallowed | CLOSED | Injected failure requires exit 2; normal tree/history scan is clean |
| WebSocket budgets | Some configured ingress scopes were not consumed | CLOSED | Rate-limit regression plus WebSocket integration suites |
| Release candidate traceability and smoke assumptions | Image tags, DB binding/migration, shell continuation, and metadata were not jointly exercised | CLOSED | Release run 34751270511, checksums, manifest, image/database smoke |
| Runtime npm CVEs | Four High findings were present in unused runtime tooling | CLOSED | New SA-IMG-001 row; npm/npx/Corepack removed; final Trivy 0 |
| Clerk audience | Default hosted token audience still requires dashboard migration | OWNER ACTION | HARD-AUTH-002; strict claim tests and fail-closed cloud configuration |
| Live authorized parties | Real hosted origin is not available in this workspace | OWNER ACTION | HARD-WEB-001; exact origin validation and mocked policy tests |
| Production trusted proxy | Production CIDRs/topology are external | OWNER ACTION | HARD-NET-001; direct, multihop, malformed, and spoofing tests |
| Remote browser CI | Required disposable Clerk values are absent | PARTIAL / blocked external | Local multi-browser suite green; run 34753859142 fails the explicit preflight |
| Dependabot account settings | GitHub API returned 502/500 during enablement attempts | OWNER ACTION | `.github/dependabot.yml` is present; successful remote enablement is not claimed |

The historical tutorial/provenance, authentication, trusted-proxy, CSP,
container-authentication, native, metrics, documentation, and CI findings
were rechecked against the final tree. The three ledger owner-action items
remain explicit rather than being silently marked closed; the runtime-image
High finding is tracked separately from the Medium reproducibility tradeoff.

## 6. Provenance verification

The provenance baseline is the remote tag antonio-original-baseline at
942035cb8498a2de936b21425cba66c9ec7dc69e. The tag and the hardened tags were
verified against origin.

The final provenance scan found 123 baseline files, 54 overlapping paths, and
0 unallowlisted identical files. Ten retained identical paths are explicitly
allowlisted shadcn/ui-derived primitives or the shared utility:

- src/components/ui/alert-dialog.tsx
- src/components/ui/button.tsx
- src/components/ui/dialog.tsx
- src/components/ui/dropdown-menu.tsx
- src/components/ui/input.tsx
- src/components/ui/menubar.tsx
- src/components/ui/separator.tsx
- src/components/ui/sonner.tsx
- src/components/ui/table.tsx
- src/lib/utils.ts

The provenance regression script passed 14 assertions covering valid scans,
allowlisted paths, unallowlisted matches, banned assets, missing and invalid
tags, zero-file and zero-overlap cases, nonzero counts, and internal git
failures. Root licensing, NOTICE attribution, Cargo metadata, SBOM pointers,
and the provenance gate now agree.

Exact verification commands and outcomes:

    git fetch --tags origin
    git ls-remote --exit-code --refs --tags origin refs/tags/antonio-original-baseline
    git ls-remote --exit-code --refs --tags origin refs/tags/v1.0.0-hardened.10
    git rev-parse --verify antonio-original-baseline^{commit}
    git rev-parse --verify v1.0.0-hardened.10^{commit}
    bash scripts/security/provenance-check.sh
    bash scripts/security/provenance-tests.sh

Both `git ls-remote` commands exited 0. The local baseline and hardened
commit resolutions were respectively
`942035cb8498a2de936b21425cba66c9ec7dc69e` and
`b711111431f15717c2a887f81404eabce71e1046`; the annotated remote hardened tag
returned tag object `6bb7993d041acb05f9ef4ec88d083de250f0120f` and peeled to
that commit. The scanner reported `54 baseline-overlapping
paths checked (123 baseline files), 0 unallowlisted identical files`, and the
regression suite reported `14 passed, 0 failed`.

The scanner contract is explicit: a missing/invalid tag, zero-file baseline,
zero-overlap baseline, or internal Git failure exits 2 with an actionable
error; an unallowlisted identical file exits 1. Final status: PASS for the
repository provenance gate only.

## 7. Clean-room reproducibility

### Fresh clone

The clean clone was created at `/tmp/concord-v1-final-repro.Ri5wHm/clone/repo`
from the immutable `v1.0.0-hardened.10` tag, with no pre-existing dependency
tree, build products, Rust target, or local environment file. The exact
commands were:

    git clone --no-local --branch v1.0.0-hardened.10 https://github.com/UtkarsHMer05/Concord-Dev.git /tmp/concord-v1-final-repro.Ri5wHm/clone/repo
    cd /tmp/concord-v1-final-repro.Ri5wHm/clone/repo
    npm ci --ignore-scripts
    cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release -DCONCORD_BUILD_TESTS=ON
    cmake --build build/native
    ctest --test-dir build/native --output-on-failure --parallel 1
    ./build/native/worker/concord-worker --version
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_reproducibility CLERK_SECRET_KEY=sk_test_reproducibility npm run build

The clone resolved to `b711111431f15717c2a887f81404eabce71e1046`; `npm ci`
added 567 packages, the full CMake build completed, CTest passed 3/3, and
the worker reported `concord-worker 1.0.0 (b711111)`. The Next production
build passed. The two Clerk values are syntactically valid build-only
placeholders; they were never used for browser/authentication and no secret
was committed.

The documented service-dependent bootstrap remains Option B: a reviewer
copies `.env.example` to `.env.local` and supplies the explicitly documented
local test values before starting Docker-backed gates. No credentials are
committed.

### Source archive without .git

The source archive was extracted at
`/tmp/concord-v1-final-repro.Ri5wHm/archive` with the following commands:

    git archive v1.0.0-hardened.10 | tar -x -C /tmp/concord-v1-final-repro.Ri5wHm/archive
    cd /tmp/concord-v1-final-repro.Ri5wHm/archive
    test ! -e .git
    test ! -e .env.local
    npm ci --ignore-scripts
    cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release -DCONCORD_BUILD_TESTS=ON
    cmake --build build/native
    ctest --test-dir build/native --output-on-failure --parallel 1
    ./build/native/worker/concord-worker --version
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_reproducibility CLERK_SECRET_KEY=sk_test_reproducibility npm run build

The archive contained no `.git` or `.env.local`; `npm ci` added 567
packages, the full CMake build completed, CTest passed 3/3, the worker
reported:

    concord-worker 1.0.0

The Next production build also passed. This proves the empty-SHA bug is
absent without injecting Git metadata. The final release workflow then
rebuilt from a clean git archive at `v1.0.0-hardened.10`, applied web
migrations to disposable PostgreSQL, booted the gateway and web images,
exercised the native worker, generated WASM, produced SBOMs, and uploaded
checksummed artifacts. The final image is covered by release run
34751270511 and zero-vulnerability Trivy reports.

## 8. Verification results

The strict local campaign command was:

    STEPS="web native rust wasm browser provenance security" bash scripts/verify-all.sh --strict

The last complete strict local matrix, run before the release-only image
hardening commit, completed with PASS:25 FAIL:1 SKIP:0 and required SKIP:0.
The single failure was a transient Firefox page.goto error; the immediate
standalone Firefox retry passed 1/1 in 38.7 seconds. This transient was
recorded rather than hidden. The final executable-equivalent checkpoint was
then exercised by the current GitHub matrix below.

| Gate | Environment | Command/workflow | Count/result | Status |
|---|---|---|---|---|
| Web | macOS local; Ubuntu CI at code-equivalent checkpoint 1efdbfe | npm run typecheck; npm run lint; npm run test; npm run db:test:prepare; npm run test:db; npm run build; npm run test:realtime; phase6-pr-ci run 34753859142 | 180 unit, 69 DB, 21 realtime; CI web success | PASS |
| Native GCC | macOS local; Ubuntu CI at code-equivalent checkpoint 1efdbfe | scripts/verify-all.sh --strict; phase6-pr-ci native (g++) in run 34753859142 | Release build, CTest 3/3; CI success | PASS |
| Native Clang | macOS local; Ubuntu CI at code-equivalent checkpoint 1efdbfe | scripts/verify-all.sh --strict; phase6-pr-ci native (clang++) in run 34753859142 | Release build, CTest 3/3; CI success | PASS |
| Rust | macOS local; Ubuntu CI at code-equivalent checkpoint 1efdbfe | (cd rust && cargo fmt --check && cargo clippy && cargo test -- --test-threads=1); phase6-pr-ci rust in run 34753859142 | 253 passed, 0 failed, 1 ignored across 35 suites; CI success | PASS |
| WASM | macOS local; Ubuntu CI at code-equivalent checkpoint 1efdbfe | scripts/verify-wasm.sh; phase6-pr-ci wasm in run 34753859142 | Emscripten 6.0.9, 30 tests; CI success | PASS |
| Distributed reliability | Ubuntu GitHub Actions | phase6-distributed run 34753859093, attempts 1 and 2 | Attempt 1: 15/21 realtime tests passed and job failed; rerun attempt 2: all 24 steps passed and realtime 21/21 | PASS after rerun; failure retained in evidence |
| Browser | macOS local; protected GitHub CI at code-equivalent checkpoint 1efdbfe | Playwright Chromium/Firefox/WebKit; phase6-pr-ci run 34753859142 | Local Chromium 12/12, Firefox retry 1/1, WebKit 1/1; CI browser preflights fail on missing Clerk secrets | PARTIAL |
| Accessibility | macOS local | Playwright tests/browser/a11y.spec.ts with axe-core/playwright | 5/5; no serious/critical violations | PASS |
| Provenance | macOS local and GitHub security job | scripts/security/provenance-check.sh; scripts/security/provenance-tests.sh | 123 baseline files, 54 overlaps, 0 unallowlisted; 14 regression assertions | PASS |
| Secrets | macOS local and GitHub security job | scripts/security/secret-scan.sh --history; secret-scan-tests.sh | Working tree, SBOMs, and full history clean; injected failure exits 2 | PASS |
| Dependency/security | macOS local and GitHub security job | npm audit --omit=dev; npm audit; cargo audit; cargo deny; scripts/security/dep-scan.sh | Production npm 0C/0H/0M/0L; full npm 0C/0H/4M/0L (dev chain); cargo audit 0; unaccepted dependency findings 0 | PASS |
| Release | Ubuntu GitHub Actions | phase6-release-artifacts run 34751270511 | Clean archive/image smoke, SBOMs, checksums, manifest, Trivy web/gateway 0 | PASS |

The local full run occurred before the final release-only image hardening
commit. The final implementation SHA was then verified by GitHub web, Rust,
native, WASM, security, CodeQL, distributed, and recovery runs; the release
workflow verified the immutable artifact set. The only final required-job
failures are the explicitly reported browser credential preflights.

## 9. Browser verification

The shipped browser suite uses real Playwright browsers and a disposable
environment consisting of the web application, gateway, PostgreSQL, NATS,
Redis, native worker, and WASM. It covers the A/B/C/D journey, E/F/G/H
journey, realtime, reconnect, auth isolation, console hygiene, and
offline/failure behavior. Accessibility is a separate five-test suite.

Versions: Playwright 1.63.0 and axe-core/playwright 4.13.0.

Local results:

- Chromium: 12/12, including the full journey and accessibility suite.
- Firefox: the full matrix had one transient navigation error; an immediate
  standalone Firefox smoke retry passed 1/1.
- WebKit: 1/1.
- Realtime browser scenario: two browser contexts edit through the real
  gateway and converge without duplicate operations.
- Reconnect scenario: a disconnected client resumes, catches up, and
  converges after reconnect.
- No unexpected fatal application console errors were accepted by the browser
  tests.
- The transient Firefox navigation failure is recorded as a failure-and-retry,
  not hidden behind a screenshot or trace. No screenshot/trace is used as
  positive evidence.

Final GitHub run 34753859142 has browser (chromium), browser (firefox), and
browser (webkit) failures. Each fails in the named step Require the
disposable Clerk E2E instance configuration. The log shows empty
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and
`GATEWAY_CLERK_ISSUER` values, followed by the actionable error
`CONCORD_E2E_CLERK_PUBLISHABLE_KEY repository secret is required`. The
workflow exits before browser execution, preserving a fail-closed gate. No
local Clerk credentials were uploaded or printed.

## 10. Accessibility verification

Tool: Playwright 1.63.0 with @axe-core/playwright 4.13.0. The checked pages
were landing/sign-in, authenticated home/documents, and the document editor;
the same suite also checked dialogs/forms/navigation through named controls,
landmarks, keyboard tab order, and visible focus.

The accessibility suite passed five Playwright checks with axe-core. No
serious or critical violations were reported. No axe rule was globally
disabled. The fixes were the editor/home accessibility and focus/name
regressions covered by tests/browser/a11y.spec.ts; no remaining serious or
critical limitation is accepted.

The Impeccable frontend detector returned an empty issue list for
src/app/documents/[documentId]/editor.tsx. This is supporting visual
evidence, not a replacement for the automated accessibility gate.

## 11. Native portability

Both required native toolchains passed the final local portability checks:
GCC 15.2.0 and Apple Clang 21.0.0.21000101 built the Release worker and
passed root CTest 3/3. The worker protocol suite includes the version probe
and reserved-replica checks. The build is independent of the caller's
working directory and no longer depends on transitive standard-library
includes.

The gitless archive form reports concord-worker 1.0.0, while a checkout
embeds its exact SHA. The release workflow built and smoked the Linux
worker artifact. Sanitizer and fuzz campaigns are not represented as new
full-run results in this final report; their historical evidence remains
separately labeled in the repository.

## 12. Security and dependency results

The final local security evidence is:

- Production `npm audit --omit=dev`: 0 Critical, 0 High, 0 Moderate, and 0
  Low vulnerabilities.
- Full `npm audit`: 0 Critical, 0 High, 4 Moderate, and 0 Low findings in the
  accepted esbuild/drizzle development chain; none are production
  dependencies.
- Cargo audit: 0 advisories across 327 dependencies.
- Cargo-deny: advisories, bans, licenses, and sources all pass.
- Container dependency scan: raw dev-only compose image findings were
  Critical 29 and High 135; all are accepted by the explicit dated,
  exact-image dev-only policy, with unaccepted findings 0 and tool errors 0.
  Release images are separately rebuilt, upgraded, scanned, and gated.
- C/C++ dependency scan: standard library only.
- Final release Trivy reports: web 0 and gateway 0 vulnerabilities.
- Secret scanning: working tree, generated SBOMs, and full git history clean.
- CodeQL run 34753859114: `Analyze (cpp)` and
  `Analyze (javascript-typescript)` both succeeded.
- Coverage diagnostics: TypeScript 180/180 unit tests with 86.88% line
  coverage; native GCC CTest 3/3 with 84.3% production-source line coverage;
  Rust 76/76 unit tests with 39.81% line coverage. These are diagnostics,
  not release-quality thresholds; the Rust report intentionally excludes
  service-backed integration/chaos tests.

Third-party GitHub Actions are SHA pinned, workflow permissions are least
privilege, checkout credentials are not persisted, and Docker Compose
images are digest pinned. Emscripten is pinned to the exact emsdk commit
5eb0bde7585670252e8ba05e9d361627bffd08b5.

Dependabot configuration now covers npm, Cargo, GitHub Actions, and Docker.
Attempts to enable GitHub vulnerability alerts/automated fixes through the
remote API returned HTTP 502 and HTTP 500, and no successful enablement is
claimed. The owner must complete that GitHub Settings action.

## 13. CI results on final GitHub SHA

The final executable implementation SHA is
b711111431f15717c2a887f81404eabce71e1046. The current code-equivalent
checkpoint `1efdbfe049affc2da9b72798a4c2fbbea74ed03f` changes only audit
documentation relative to the executable checkpoint; its required CI runs
repeated the executable gates. The following are the completed workflow/job
results for that checkpoint:

| Workflow | Run | Result |
|---|---:|---|
| phase2-core | 34753859132 | success |
| phase3-gateway | 34753859135 | success |
| phase4-distributed | 34753859111 | success |
| phase5-recovery | 34753859144 | success |
| phase6-distributed, attempt 1 | 34753859093 | failure: 6/21 TypeScript realtime tests failed; recorded and rerun |
| phase6-distributed, attempt 2 | 34753859093 | success: all 24 steps; realtime 21/21 |
| codeql / Analyze (cpp) | 34753859114 | success |
| codeql / Analyze (javascript-typescript) | 34753859114 | success |
| phase6-pr-ci web | 34753859142 | success |
| phase6-pr-ci rust | 34753859142 | success |
| phase6-pr-ci wasm | 34753859142 | success |
| phase6-pr-ci security | 34753859142 | success |
| phase6-pr-ci native (g++) | 34753859142 | success |
| phase6-pr-ci native (clang++) | 34753859142 | success |
| phase6-pr-ci browser (chromium) | 34753859142 | failure: missing Clerk secret |
| phase6-pr-ci browser (firefox) | 34753859142 | failure: missing Clerk secret |
| phase6-pr-ci browser (webkit) | 34753859142 | failure: missing Clerk secret |
| phase6-release-artifacts on b711111 | 34751270511 | success |

The protected main branch requires strict status checks for web, rust, wasm,
security, native (g++), native (clang++), browser (chromium), browser
(firefox), browser (webkit), Analyze (javascript-typescript), and Analyze
(cpp). Strict checking, linear history, and conversation resolution are
enabled; required reviews remain 0 and admin enforcement remains false.
Because the three required browser contexts are red, the final required CI
state is not green.

## 14. Release state

The immutable tag v1.0.0-hardened.10 points to
b711111431f15717c2a887f81404eabce71e1046. The GitHub release is published,
non-draft, and non-prerelease at:

https://github.com/UtkarsHMer05/Concord-Dev/releases/tag/v1.0.0-hardened.10

Release workflow run:

https://github.com/UtkarsHMer05/Concord-Dev/actions/runs/34751270511

Published assets are concord-gateway-image.tar,
concord-web-image.tar, concord-worker-linux-amd64.tgz, concord-wasm.tgz,
release-manifest.json, SHA256SUMS, trivy-gateway.json, trivy-web.json,
native-worker.cdx.json, rust-gateway.cdx.json, and web.cdx.json. All 11
assets are present; every SHA256SUMS entry verifies. The manifest has
manifestVersion 1, protocolVersion 1, the exact commit and tag, image IDs,
artifact byte counts, SBOM digests, and the release toolchain.

The historical concord-v1.0.0 tag was not moved. Existing immutable
baseline, phase, and v1.0.0-hardened increment tags were preserved.

## 15. Performance results

No new before/after latency or throughput claim is made by this campaign.
The campaign verified structural performance properties: broker consumer
metadata is TTL-cached off the per-message hot path, and compaction bytes are
computed by one aggregate CTE inside the existing delete transaction.

Historical headline values such as ingest p50 2.72 ms, 1-to-4 gateway p95
15.23 ms, recovery 98.4 percent, and chaos 27/27 remain labeled as
historical evidence from their original artifacts. They are not presented as
new measurements from this remediation run.

## 16. Documentation truth audit

The documentation pass reconciled the README, CHANGELOG, CONTRIBUTING,
ARCHITECTURE, BENCHMARKS, BROWSER_SUPPORT, CONFIGURATION, DATABASE,
DEPLOYMENT, ENGINEERING_BRIEF, FAILURE_MODEL, GITHUB_SETTINGS_CHECKLIST,
OPERATIONS, PRD, PROVENANCE, SECURITY, TESTING, VERIFICATION, roadmap,
environment example, NOTICE, and audit files.

Browser performance language identifies Node-instrumented real-WASM proxy
measurements where applicable; real Playwright results are reported
separately. Historical AWS, fuzz, chaos, and performance values retain their
original evidence labels. Documentation does not claim a live AWS stack,
successful remote browser credentials, or successful Dependabot alert
enablement.

The findings ledger is docs/audits/V1_HARDENING_FINDINGS.md, schema v2, with
22 unique findings: 3 original Critical, 11 original High, and 8 original
Medium findings; 19 are CLOSED and 3 are OWNER ACTION.

| Claim found in prior material | Correction in this report/tree | Evidence |
|---|---|---|
| Final state was PASS with stale SHAs | Verdict is `PARTIAL / FAIL`; executable SHA, code-equivalent checkpoint, and final publication SHA are distinguished | Sections 1, 13, and 20; `evidence/v1.0.0/ci.json` |
| Provenance could be green with a missing baseline | Missing/invalid tags, zero-file/zero-overlap scans, and Git failures are fail-closed | Section 6; 14 regression assertions; remote tag refs |
| Gitless worker output was valid with an empty suffix | Archive output is plain `concord-worker 1.0.0`; checkout output embeds the short SHA | Section 7 clone/archive reproduction |
| No real multi-browser suite existed | Local Chromium/Firefox/WebKit Playwright results are recorded; protected CI remains blocked at its Clerk preflight | Section 9; run 34753859142 |
| The ledger contained 21 findings | The four runtime-image High CVEs are tracked as distinct `SA-IMG-001`; the ledger has 22 unique rows | Section 4 and `docs/audits/V1_HARDENING_FINDINGS.md` |
| Numeric scorecard implied a marketing/ranking claim | Section 22 uses factual assessments with evidence/limitations and exact required dimensions | Section 22; `docs/TOP_TECH_REVIEW.md` |
| Decoder/worker fuzzing was only planned | Nightly reliability workflow names the current 1,000,000-run Rust and 300,000-run native fuzz jobs; new full nightly results are not claimed here | `phase6-nightly-reliability.yml`; `docs/SECURITY.md` §8.5 |
| Worker queue gauge "emits 0" | Gauge is 0 between jobs and 1 during a claimed job | `docs/OBSERVABILITY.md` known-gaps wording and scheduler tests |
| Dependabot alerts were enabled | Repository configuration is present, but GitHub API attempts returned 502/500; account-level enablement remains OWNER ACTION | Section 12/17; `.github/dependabot.yml` |
| AWS production was live or verified | No live AWS stack is claimed; deployment, TLS, IAM, and proxy topology remain owner actions | Sections 17/18; `docs/TOP_TECH_REVIEW.md` |

## 17. Remaining owner-only actions

| Action | Why the agent could not perform it | Exact owner steps | Current fail-closed behavior | Risk until completed |
|---|---|---|---|---|
| Configure disposable Clerk CI secrets | The repository has no authorized Clerk credentials and secrets must not be invented or exposed | Add CONCORD_E2E_CLERK_PUBLISHABLE_KEY and CONCORD_E2E_CLERK_SECRET_KEY as repository secrets, add CONCORD_E2E_CLERK_ISSUER if needed, then rerun the three browser jobs using a disposable instance | Each browser job exits before tests when either required secret is empty | Required browser contexts remain red; browser CI cannot certify the remote environment |
| Migrate Clerk audience | This requires a Clerk dashboard/account mutation outside the repository | Change the default session-token template audience from convex to a Concord audience; set cloud GATEWAY_CLERK_AUDIENCE and CONCORD_APP_ORIGIN; run authorized cloud E2E | Cloud bundle rejects the legacy audience and strict claim tests reject wrong/missing audience/party | Cloud authentication cannot be certified and unsafe stale tokens are refused |
| Verify live authorizedParties | The hosted deployment and real origin are external and no live cloud stack is present | Deploy the web app, confirm its exact HTTPS origin, set CONCORD_APP_ORIGIN, and exercise a real authorized request | Invalid/missing origin fails configuration validation; mocked policy tests cover local branches | Hosted-origin authorization remains unverified |
| Wire production trusted-proxy CIDRs | Production load-balancer topology is external and AWS is torn down | Set the actual proxy CIDRs in the production environment and run direct, trusted-XFF, malformed, IPv4, IPv6, and spoofing checks | X-Forwarded-For is honored only from configured trusted CIDRs; otherwise the direct peer is used | Client identity/rate-limit behavior in the real topology remains unverified |
| Recreate AWS/domain/TLS/IAM deployment if needed | No cloud account mutation was requested or safely available, and the prior stack is intentionally torn down | Use the repository deployment scripts with scoped IAM, domain/TLS, logging, and the documented AWS credential hygiene; verify health and auth | Repository deployment configuration is hardened, but no live stack is claimed | Production availability, TLS, and infrastructure behavior remain untested |
| Enable Dependabot alerts/fixes | GitHub API attempts returned HTTP 502/500; settings require repository administration | Enable vulnerability alerts and automated security fixes in GitHub Settings, then verify the Security UI and keep the existing npm/Cargo/actions/Docker config | Dependabot configuration is present; no false enabled claim is made | Automatic alerting/fixes are not confirmed at the account level |

## 18. Residual risks / known limitations

- Required remote browser checks remain red until the owner supplies Clerk
  secrets; local browser evidence is green but cannot substitute for the
  protected GitHub contexts.
- The Clerk dashboard audience, live authorized-party origin, and production
  trusted-proxy topology remain unverified external state.
- AWS is torn down; no cloud NATS/Redis/Grafana or hosted TLS deployment is
  currently live.
- Development-only pinned compose images retain the documented raw
  vulnerability inventory under an explicit policy; the release images have
  zero Trivy findings. The next policy review date is 2026-10-13.
- Four accepted Moderate development npm findings remain outside production
  dependencies.
- Native macOS builds report expected ignored -arch warnings. Embedded
  WebViews and a new full sanitizer/fuzz campaign were not part of this
  final run.
- No new comparable performance benchmark delta is asserted.

## 19. Commit list

The 22 campaign implementation/remediation and report-publication commits
after the campaign start SHA, in order, are:

1. 2c212b7 fix(security): harden dependency and scan gates
2. c51fff5 fix(gateway): enforce configured WebSocket frame budgets
3. 48fe966 test(browser): add real Playwright and accessibility coverage
4. 7aeaa88 ci(release): add strict compiler browser and artifact verification
5. 9640f28 docs(audit): reconcile claims and findings ledger
6. 611cbb1 fix(release): make generated assets and archives traceable
7. 9f1f418 fix(audit): close scanner and reconcile final claims
8. 44e0150 test(browser): stabilize durable ACK gate
9. 8107592 test(provenance): set synthetic commit identity
10. d2b705a fix(release): pin a valid Trivy action dependency
11. 32a1090 fix(release): pin the Trivy tag to its commit
12. 305b6eb fix(release): derive metadata from checked-out HEAD
13. a04fe1c fix(release): make Linux image smoke boot the gateway
14. 1e1f819 fix(release): expose disposable database to Linux smoke
15. af3df5e fix(release): keep database smoke command valid
16. e7bf71b fix(release): trace the exported image tags
17. 0ae5943 fix(release): migrate disposable database before smoke
18. b711111 fix(security): remove npm tooling from web runtime

19. 2b7232c docs(audit): publish initial final remediation campaign report

20. 7d30a3a docs(audit): align final report with master format

21. 1efdbfe docs(audit): record final current-SHA verification

22. final evidence/coverage/report publication (docs and diagnostic tooling;
the full SHA is the output of `git rev-parse HEAD` after this report is
committed and pushed)

The final publication commit is not self-referentially copied into its own
contents. The exact final main SHA is therefore recorded by the final git
state and in the final response; the campaign total after the start SHA is 22
commits.

## 20. Final repository state

The final branch is main, pushed to origin, with a clean worktree after
report publication. The audited implementation is
b711111431f15717c2a887f81404eabce71e1046. The last completed CI evidence
checkpoint before this final publication is
1efdbfe049affc2da9b72798a4c2fbbea74ed03f; the final publication is a
docs/tooling descendant and does not change the audited implementation.
After publication, `git rev-parse HEAD` and
`git ls-remote origin refs/heads/main` must return the same final publication
SHA; that exact value is reported in the final response.

The immutable v1.0.0-hardened.10 tag and GitHub release are present. The
historical concord-v1.0.0 tag remains unchanged. Main branch protection is
strict, requires the listed web/Rust/WASM/security/native/browser/CodeQL
contexts, requires linear history and conversation resolution, and does not
require approving reviews. The final required CI state remains PARTIAL /
FAIL solely because browser contexts fail closed on missing external Clerk
secrets.

## 21. Independent reviewer commands

    git clone --branch v1.0.0-hardened.10 https://github.com/UtkarsHMer05/Concord-Dev.git Concord-Dev
    cd Concord-Dev
    cp .env.example .env.local
    # Fill the documented local-only values; do not commit .env.local.
    npm ci
    bash scripts/bootstrap-dev.sh
    docker compose up -d db nats redis
    npm run db:migrate
    npm run db:test:prepare
    npm run typecheck
    npm run lint
    npm test
    npm run test:db
    npm run test:realtime
    npm run build
    cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release -DCONCORD_BUILD_TESTS=ON
    cmake --build build/native
    ctest --test-dir build/native --output-on-failure --parallel 1
    npm run wasm:build
    npm run wasm:smoke
    bash scripts/coverage/ts.sh
    bash scripts/coverage/native.sh
    bash scripts/coverage/rust.sh
    bash scripts/security/provenance-tests.sh
    bash scripts/security/provenance-check.sh
    bash scripts/security/secret-scan-tests.sh
    bash scripts/security/validate-findings.sh
    STEPS="web native rust wasm provenance security" bash scripts/verify-all.sh --strict
    gh run view 34753859142 --repo UtkarsHMer05/Concord-Dev
    gh run view 34751270511 --repo UtkarsHMer05/Concord-Dev
    gh release view v1.0.0-hardened.10 --repo UtkarsHMer05/Concord-Dev

The database-backed commands require Docker and the local values documented
in `.env.example`/`docs/CONFIGURATION.md`. The Rust coverage wrapper runs the
unit-only report; service-backed Rust integration and chaos suites remain
separate gates. To run the browser gate independently, provide real
disposable Clerk values through the workflow's documented environment
variables or repository secrets, then run the Playwright Chromium, Firefox,
and WebKit jobs. Never replace the prerequisite with dummy credentials.

## 22. Final scorecard

| Dimension | Assessment | Evidence / limitation |
|---|---|---|
| Architecture | Strong | Gateway, worker, WASM, web, and persistence boundaries are documented and exercised; live cloud deployment is not present |
| Distributed systems | Strong | Multi-gateway, broker, limiter, recovery, and chaos evidence exists within the documented fault model; production topology remains owner-owned |
| C++ | Strong | GCC/Clang portability, root CTest, protocol/version tests, coverage diagnostics, and gitless release evidence |
| Rust/backend | Strong | Strict auth, limits, durable ingest, recovery tests, clippy, audit, and deny gates |
| Frontend | Good | CSP, Clerk policy, realtime UI, accessibility, browser journeys, and production build; hosted origin is external |
| Reliability | Strong | Recovery, failure paths, fail-closed gates, distributed rerun evidence, and release smoke |
| Security | Strong | Repository, dependency, provenance, secret, CodeQL, and release-image controls; Clerk/Dependabot account settings remain external |
| Testing | Strong | Unit, DB, realtime, native, Rust, WASM, browser, accessibility, provenance, scanner, and regression coverage |
| browser verification | Partial | Local Chromium/Firefox/WebKit evidence is green; all three protected remote browser jobs stop at the missing-Clerk-secret preflight |
| Performance | Partial | Structural hot-path protections are verified; no new comparable latency or throughput delta is asserted |
| Supply chain | Strong | SHA-pinned actions/images, SBOMs, checksums, scan gate, dependency policy, and traceable release |
| Documentation | Strong | Claims, labels, ledger, owner actions, report structure, and public evidence index are reconciled |
| Production maturity | Partial | Reproducible deployment path and hardened configs exist; AWS, DNS/TLS, IAM, and hosted auth are not live-verified |
| portfolio strength | Good | Evidence-backed remediation and release artifact trail are reviewable; final required CI is not fully green |

Overall campaign state: technically hardened and release-artifact complete,
but not eligible for an unconditional PASS until the required browser CI
contexts are green and the external owner actions are completed.
