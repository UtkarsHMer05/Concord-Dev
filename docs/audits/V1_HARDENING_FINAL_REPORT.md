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
implementation SHA. The exact final main SHA is recorded by git and in the
campaign handoff that accompanies this report.

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
release traceability, and a reconciled 21-finding ledger.

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
| Documentation/truth ledger | README.md, docs/**, .env.example, CHANGELOG.md, CONTRIBUTING.md, docs/audits/V1_HARDENING_FINDINGS.md | Stale counts, terminology, deployment claims, duplicate IDs, and owner-state descriptions overstated completion | Evidence-based wording, schema-v2 unique ledger, explicit owner actions and residual risks | validate-findings: 21 unique findings, no OPEN Critical/High; report structure verified | 9640f28; 9f1f418 |

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
| HARD-IMG-001 | Medium | container security | Runtime image shipped unused npm/npx/Corepack dependency payloads; Trivy then surfaced four new High findings | Remove unused package-manager payloads from the web runtime; do not allowlist fixed findings | Final web/gateway Trivy reports: 0 vulnerabilities | CLOSED |

## 5. Previous audit findings reconciliation

The prior final report in this path was stale: it had a different title,
different branch and start/end SHAs, declared PASS, listed 19 findings, and
claimed no multi-browser Playwright suite. It also treated remote publishing,
branch protection, and tags as owner-only even though the current campaign
explicitly authorized and completed those repository/remote actions.

This report replaces that claim set with the final evidence. The current
ledger has 21 unique findings, preserves original severities, uses the
allowed CLOSED/OWNER ACTION vocabulary, and records external work without
pretending that fail-closed code alone completes it. Browser verification is
now real Playwright coverage locally; remote browser CI remains red because
its required credentials are not configured. Release claims are tied to the
exact audited SHA and immutable tag.

The historical tutorial/provenance, authentication, trusted-proxy, CSP,
container-authentication, native, metrics, documentation, and CI findings
were rechecked against the final tree. The three external owner items remain
explicit rather than being silently marked closed.

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

## 7. Clean-room reproducibility

### Fresh clone

The clean clone was created in /tmp/concord-final-clone.LQbOUX/repo, with no
pre-existing node_modules, build products, Rust target, or local environment
file. The recorded procedure cloned the repository, checked out the
immutable v1.0.0-hardened.9 tag, ran npm ci, configured and built the native
worker, ran CTest, and ran the Next production build. It installed 567
packages, passed CTest 3/3, and reported:

    concord-worker 1.0.0 (0ae5943)

The documented bootstrap path is Option B: a reviewer copies
.env.example to .env.local and supplies the explicitly documented local test
values before starting service-dependent gates. No credentials are committed.
The final GitHub CI runs on the report SHA independently repeated the web,
Rust, WASM, native, security, and distributed gates; the browser jobs
correctly require the missing Clerk values instead of silently skipping.

### Source archive without .git

The source archive was extracted in /tmp/concord-final-archive.hc4BkM and
contained no .git, .env.local, node_modules, build, or rust/target
directories. The recorded procedure ran native CMake configure/build and
CTest, npm ci, and the Next production build. CTest passed 3/3 and npm ci
installed 567 packages. The archive worker version was:

    concord-worker 1.0.0

This proves the empty-SHA bug is absent without injecting Git metadata. The
final release workflow then rebuilt from a clean git archive at
v1.0.0-hardened.10, applied web migrations to disposable PostgreSQL, booted
the gateway and web images, exercised the native worker, generated WASM,
produced SBOMs, and uploaded checksummed artifacts. The final image is
covered by release run 34751270511 and zero-vulnerability Trivy reports.

## 8. Verification results

The strict local campaign command was:

    STEPS="web native rust wasm browser provenance security" bash scripts/verify-all.sh --strict

The full strict run on the pre-release-workflow implementation completed with
PASS:25 FAIL:1 SKIP:0 and required SKIP:0. The single failure was a transient
Firefox page.goto error in the first full matrix; the immediate standalone
Firefox retry passed 1/1 in 38.7 seconds. This transient was recorded rather
than hidden.

| Gate | Environment | Command/workflow | Count/result | Status |
|---|---|---|---|---|
| Web | macOS local at a04fe1c; Ubuntu CI at 2b7232c | npm run typecheck; npm run lint; npm run test; npm run db:test:prepare; npm run test:db; npm run build; npm run test:realtime; phase6-pr-ci run 34752929757 | 180 unit, 69 DB, 21 realtime; CI web success | PASS |
| Native GCC | macOS local; Ubuntu CI at 2b7232c | scripts/verify-all.sh --strict; phase6-pr-ci native (g++) | Release build, CTest 3/3; CI success | PASS |
| Native Clang | macOS local; Ubuntu CI at 2b7232c | scripts/verify-all.sh --strict; phase6-pr-ci native (clang++) | Release build, CTest 3/3; CI success | PASS |
| Rust | macOS local at a04fe1c; Ubuntu CI at 2b7232c | (cd rust && cargo fmt --check && cargo clippy && cargo test -- --test-threads=1); phase6-pr-ci rust | 253 passed, 0 failed, 1 ignored across 35 suites; CI success | PASS |
| WASM | macOS local; Ubuntu CI at 2b7232c | scripts/verify-wasm.sh; phase6-pr-ci wasm | Emscripten 6.0.9, 30 tests; CI success | PASS |
| Browser | macOS local; protected GitHub CI at 2b7232c | Playwright Chromium/Firefox/WebKit; phase6-pr-ci run 34752929757 | Local Chromium 12/12, Firefox retry 1/1, WebKit 1/1; CI browser preflights fail on missing Clerk secrets | PARTIAL |
| Accessibility | macOS local | Playwright tests/browser/a11y.spec.ts with axe-core/playwright | 5/5; no serious/critical violations | PASS |
| Provenance | macOS local and GitHub security job | scripts/security/provenance-check.sh; scripts/security/provenance-tests.sh | 123 baseline files, 54 overlaps, 0 unallowlisted; 14 regression assertions | PASS |
| Secrets | macOS local and GitHub security job | scripts/security/secret-scan.sh --history; secret-scan-tests.sh | Working tree, SBOMs, and full history clean; injected failure exits 2 | PASS |
| Dependency/security | macOS local and GitHub security job | npm audit; cargo audit; cargo deny; scripts/security/dep-scan.sh | Production npm 0; cargo audit 0; unaccepted dependency findings 0 | PASS |
| Release | Ubuntu GitHub Actions | phase6-release-artifacts run 34751270511 | Clean archive/image smoke, SBOMs, checksums, manifest, Trivy web/gateway 0 | PASS |

The local full run occurred before the final release-only image hardening
commit. The final implementation SHA was then verified by GitHub web, Rust,
native, WASM, security, CodeQL, distributed, recovery, and release runs; the
only final required-job failures are the explicitly reported browser
credential preflights.

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

Final GitHub run 34751269064 has browser (chromium), browser (firefox), and
browser (webkit) failures. Each fails in the named step Require the
disposable Clerk E2E instance configuration because
CONCORD_E2E_CLERK_PUBLISHABLE_KEY and CONCORD_E2E_CLERK_SECRET_KEY are empty.
The optional issuer is also unset. The workflow exits before browser
execution, preserving a fail-closed gate. No local Clerk credentials were
uploaded or printed.

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

- Production npm audit: 0 vulnerabilities at every severity.
- Full npm audit: 4 accepted Moderate development-chain findings in the
  esbuild/drizzle chain; none are production dependencies.
- Cargo audit: 0 advisories across 327 dependencies.
- Cargo-deny: advisories, bans, licenses, and sources all pass.
- Container dependency scan: raw dev-only compose image findings were
  Critical 29 and High 135; all are accepted by the explicit dated,
  exact-image dev-only policy, with unaccepted findings 0 and tool errors 0.
  Release images are separately rebuilt, upgraded, scanned, and gated.
- C/C++ dependency scan: standard library only.
- Final release Trivy reports: web 0 and gateway 0 vulnerabilities.
- Secret scanning: working tree, generated SBOMs, and full git history clean.

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
b711111431f15717c2a887f81404eabce71e1046. The subsequent report-publication
checkpoint SHA 2b7232c7740ef4e037f9e95b8b6601fbd2f8231f changes only audit
documentation; its required CI runs repeated the executable gates. The
following are the completed workflow/job results on that final code/report
checkpoint:

| Workflow | Run | Result |
|---|---:|---|
| phase2-core | 34752929783 | success |
| phase3-gateway | 34752929732 | success |
| phase4-distributed | 34752929760 | success |
| phase5-recovery | 34752929878 | success |
| phase6-distributed | 34752929834 | success |
| codeql / Analyze (cpp) | 34752929781 | success |
| codeql / Analyze (javascript-typescript) | 34752929781 | success |
| phase6-pr-ci web | 34752929757 | success |
| phase6-pr-ci rust | 34752929757 | success |
| phase6-pr-ci wasm | 34752929757 | success |
| phase6-pr-ci security | 34752929757 | success |
| phase6-pr-ci native (g++) | 34752929757 | success |
| phase6-pr-ci native (clang++) | 34752929757 | success |
| phase6-pr-ci browser (chromium) | 34752929757 | failure: missing Clerk secret |
| phase6-pr-ci browser (firefox) | 34752929757 | failure: missing Clerk secret |
| phase6-pr-ci browser (webkit) | 34752929757 | failure: missing Clerk secret |
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
21 unique findings: 3 original Critical, 10 original High, and 8 original
Medium findings; 18 are CLOSED and 3 are OWNER ACTION.

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

The 18 implementation/remediation commits after the campaign start SHA, in
order, are:

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

This final report-format correction is one additional docs-only commit after
2b7232c. The exact final main SHA and total commit count are recorded in the
final campaign handoff; the resulting campaign total is 20 commits after the
start SHA.

## 20. Final repository state

The final branch is main, pushed to origin, with a clean worktree after
report publication. The audited implementation is
b711111431f15717c2a887f81404eabce71e1046. The last completed CI evidence
checkpoint before this final report-format correction was
2b7232c7740ef4e037f9e95b8b6601fbd2f8231f; this report is a docs-only
descendant and does not change executable code.

The immutable v1.0.0-hardened.10 tag and GitHub release are present. The
historical concord-v1.0.0 tag remains unchanged. Main branch protection is
strict, requires the listed web/Rust/WASM/security/native/browser/CodeQL
contexts, requires linear history and conversation resolution, and does not
require approving reviews. The final required CI state remains PARTIAL /
FAIL solely because browser contexts fail closed on missing external Clerk
secrets.

## 21. Independent reviewer commands

    git clone https://github.com/UtkarsHMer05/Concord-Dev.git
    cd Concord-Dev
    git checkout v1.0.0-hardened.10
    bash scripts/security/provenance-tests.sh
    bash scripts/security/secret-scan-tests.sh
    bash scripts/security/validate-findings.sh
    STEPS="web native rust wasm provenance security" bash scripts/verify-all.sh --strict
    gh run view 34751270511 --repo UtkarsHMer05/Concord-Dev
    gh release view v1.0.0-hardened.10 --repo UtkarsHMer05/Concord-Dev

To run the browser gate independently, provide disposable Clerk values
through the workflow's documented environment variables or repository
secrets, then run the Playwright Chromium, Firefox, and WebKit jobs. Never
replace the prerequisite with dummy credentials.

## 22. Final scorecard

| Dimension | Score | Basis |
|---|---:|---|
| Architecture | 8.5/10 | Clear gateway, worker, WASM, web, and persistence boundaries; live cloud deployment not currently present |
| Distributed systems | 8.0/10 | Multi-gateway, broker, limiter, recovery, and chaos evidence; production topology remains owner-owned |
| C++ native worker | 8.5/10 | GCC/Clang portability, root CTest, protocol and gitless release evidence |
| Rust gateway | 8.5/10 | Strict auth, limits, tests, clippy, audit, and deny gates |
| Frontend | 8.0/10 | CSP, Clerk policy, realtime UI, and production build; hosted origin is external |
| Reliability | 8.5/10 | Recovery, failure paths, fail-closed gates, and release smoke |
| Security | 8.0/10 | Strong repository and image posture; external Clerk/Dependabot settings remain |
| Testing | 9.0/10 | Unit, DB, realtime, native, Rust, WASM, browser, accessibility, provenance, and scanner regressions |
| Browser readiness | 8.0/10 | Local multi-browser evidence is green; protected remote jobs await secrets |
| Performance | 7.0/10 | Structural hot-path protections verified; no new comparable benchmark delta |
| Supply chain | 8.0/10 | Pinned actions/images, SBOM/checksums, scan gate, and traceable release |
| Documentation | 8.5/10 | Claims, labels, ledger, owner actions, and release evidence reconciled |
| Production maturity | 6.5/10 | Reproducible deployment path and hardened configs; cloud stack intentionally absent |
| Portfolio readiness | 8.5/10 | Strong evidence-backed remediation and release artifact trail; final CI is not fully green |

Overall campaign state: technically hardened and release-artifact complete,
but not eligible for an unconditional PASS until the required browser CI
contexts are green and the external owner actions are completed.
