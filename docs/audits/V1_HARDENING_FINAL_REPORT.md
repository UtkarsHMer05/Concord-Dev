# CONCORD V1 FINAL REMEDIATION — FINAL CAMPAIGN REPORT

Campaign: CONCORD V1.0.0 final remediation, reproducibility, browser E2E,
provenance, security, release, and documentation campaign.

Campaign start SHA: 4ce066f0120d94ecdb8b1a6684f3666f9bac05ff.

Final audited implementation SHA: b711111431f15717c2a887f81404eabce71e1046.

Final audited tag: v1.0.0-hardened.10.

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

| Area | Implemented result | Evidence |
|---|---|---|
| Provenance and licensing | Fail-closed baseline/tag/path validation; original replacements; root MIT license; NOTICE and SBOM attribution | Provenance scan: 54 overlapping paths, 0 unallowlisted identical; 14 provenance regression assertions |
| Secret scanning | Tracked-file and history scanning now returns an error on internal scanner failure rather than a false clean result | Injected-failure regression requires exit 2; normal tree and history scans are clean |
| Gateway authentication | JWKS singleflight/cooldown/negative-cache/TTL and bounded fetch behavior; strict optional audience/party policy; reserved REST/SYSC replica rejection | Rust auth and ingest suites; cloud bundle refuses the legacy convex audience |
| Gateway limits | Trusted-proxy CIDR and right-to-left X-Forwarded-For handling; configured write, malformed-control, binary, validated-operation, and fetch budgets wired to frame ingress | Rust limiter and WebSocket integration tests |
| Web security | Per-request CSP nonce and strict-dynamic policy; exact Clerk authorized-party configuration; production configuration validation | Nine effective-header assertions and live dev-server nonce checks |
| Browser and accessibility | Real Playwright Chromium journey coverage plus Firefox/WebKit smoke coverage, auth isolation, reconnect, realtime, failure/offline paths, console checks, and axe checks | Local Chromium 12/12, Firefox retry 1/1, WebKit 1/1, accessibility 5/5 |
| Native and WASM | Direct standard-library includes, root CTest wiring, cwd-independent corpus lookup, gitless worker version handling, exact Emscripten toolchain | GCC and Apple Clang CTest 3/3; Emscripten 6.0.9, 30 WASM tests |
| CI and supply chain | SHA-pinned third-party actions, least privilege, no persisted credentials, Dependabot ecosystems, CodeQL, cargo-deny, digest-pinned compose images, enforced scan gate | Final CodeQL and phase workflows green; required browser jobs fail only at missing-secret preflight |
| Release artifacts | Clean archive build, generated assets, disposable PostgreSQL migration, Linux image gateway boot, exported image tags, SBOMs, traceability manifest, checksums, Trivy gate | Release run 34751270511; protocol version 1 manifest and all SHA256SUMS entries verify |
| Runtime image | Removed unused npm, npx, and Corepack payloads from the web runtime after release Trivy identified four newly failing High findings in npm's bundled dependencies | Final web image Trivy report has zero vulnerabilities |
| Documentation and audit | Reconciled stale claims, exact finding statuses, owner-only boundaries, browser labels, provenance evidence, and final report structure | 21-row schema-v2 ledger and this 22-section report |

## 4. Findings discovered during this campaign

The campaign reproduced and closed the following additional or previously
under-specified defects:

1. The provenance gate could receive an empty path stream when a baseline tag
   was absent and still exit successfully. It now requires a tag resolving to
   a commit, rejects zero-file and zero-overlap scans, and propagates internal
   git failures.
2. An empty but defined CONCORD_GIT_SHA produced a gitless worker version with
   an empty parenthesized suffix. The build now embeds only a non-empty SHA and
   tests checkout, archive, and forced-empty forms.
3. The secret scanner could treat an internal awk or grep failure as a clean
   scan. Internal errors are now actionable exit-2 failures and have an
   injected-failure regression.
4. WebSocket write, malformed-control, binary, and validated-operation paths
   did not all consume the configured frame budgets. All four scopes are now
   enforced at ingress while fetch budgeting remains intact.
5. The release workflow initially had several real reproducibility and smoke
   defects: annotated-tag metadata, absent image tags, loopback-only database
   binding, shell comments inside a continued docker command, missing schema
   migrations, and incorrect manifest image references. Each was fixed and
   rerun on a new immutable tag.
6. The enforced release Trivy gate then found four new High vulnerabilities in
   unused npm tooling bundled in the web runtime: brace-expansion
   CVE-2026-14257 and CVE-2026-69152, ip-address CVE-2026-69192, and tar
   CVE-2026-73566. Removing npm, npx, and Corepack from the runtime image
   eliminated the findings without adding an allowlist exception.

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

The following clean-room checks were completed during the campaign:

- A fresh clone at v1.0.0-hardened.9 (0ae594385966f3b43a5730b7c911efe95a86d7f4)
  contained no .env.local, installed 567 npm packages with npm ci, passed
  native CTest 3/3, built the Next production application, and reported
  concord-worker 1.0.0 (0ae5943).
- A source archive from the same tag contained no .git, .env.local,
  node_modules, build, or rust/target directories. It passed native CTest
  3/3, npm ci with 567 packages, and the Next production build. Its gitless
  worker version was the expected plain concord-worker 1.0.0 form.
- The final release workflow rebuilt from a clean git archive at
  v1.0.0-hardened.10, applied the web schema migrations to disposable
  PostgreSQL, booted the gateway and web images, exercised the native worker,
  generated the WASM package, produced SBOMs, and uploaded checksummed
  artifacts. The only code delta from the earlier clean-room checks to the
  final image was runtime removal of unused npm tooling; the final image
  itself is covered by the successful release run and zero-vulnerability
  Trivy reports.

## 8. Verification results

The strict local campaign command was:

    STEPS="web native rust wasm browser provenance security" bash scripts/verify-all.sh --strict

The full strict run on the pre-release-workflow implementation completed with
PASS:25 FAIL:1 SKIP:0 and required SKIP:0. The single failure was a transient
Firefox page.goto error in the first full matrix; the immediate standalone
Firefox retry passed 1/1 in 38.7 seconds. This transient was recorded rather
than hidden.

| Gate | Result |
|---|---|
| Web typecheck, lint, unit, database, build, and realtime | PASS; 180 web unit tests, 69 database tests, 21 realtime tests |
| Native GCC | PASS; Release build and CTest 3/3 |
| Native Apple Clang | PASS; Release build and CTest 3/3 |
| Rust | PASS; fmt and clippy clean, 253 passed, 0 failed, 1 ignored across 35 suites |
| WASM | PASS; Emscripten 6.0.9 and 30 tests |
| Browser local | Chromium 12/12; Firefox standalone retry 1/1; WebKit 1/1 |
| Accessibility | PASS; 5 Playwright/axe checks |
| Provenance | PASS; 0 unallowlisted identical files and 0 banned assets |
| Secrets | PASS; working tree and full git history clean |
| Dependency/security | PASS; production npm audit 0, cargo audit 0, cargo-deny pass, unaccepted dependency findings 0 |
| Release workflow | PASS; GitHub run 34751270511 |

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

Local results:

- Chromium: 12/12, including the full journey and accessibility suite.
- Firefox: the full matrix had one transient navigation error; an immediate
  standalone Firefox smoke retry passed 1/1.
- WebKit: 1/1.
- No unexpected fatal application console errors were accepted by the browser
  tests.

Final GitHub run 34751269064 has browser (chromium), browser (firefox), and
browser (webkit) failures. Each fails in the named step Require the
disposable Clerk E2E instance configuration because
CONCORD_E2E_CLERK_PUBLISHABLE_KEY and CONCORD_E2E_CLERK_SECRET_KEY are empty.
The optional issuer is also unset. The workflow exits before browser
execution, preserving a fail-closed gate. No local Clerk credentials were
uploaded or printed.

## 10. Accessibility verification

The accessibility suite passed five Playwright checks with axe-core. No
serious or critical violations were reported. The suite exercises the
primary application surfaces, keyboard/focus behavior, labels and roles, and
the authenticated/disconnected states available to the local fixture.

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

The final implementation SHA b711111431f15717c2a887f81404eabce71e1046 had
the following completed workflow results:

| Workflow | Run | Result |
|---|---:|---|
| phase2-core | 34751269098 | success |
| phase3-gateway | 34751269140 | success |
| phase4-distributed | 34751269222 | success |
| phase5-recovery | 34751269163 | success |
| phase6-distributed | 34751269141 | success |
| codeql | 34751269080 | success |
| phase6-release-artifacts | 34751270511 | success |
| phase6-pr-ci web | 34751269064 | success |
| phase6-pr-ci rust | 34751269064 | success |
| phase6-pr-ci wasm | 34751269064 | success |
| phase6-pr-ci security | 34751269064 | success |
| phase6-pr-ci native (g++) | 34751269064 | success |
| phase6-pr-ci native (clang++) | 34751269064 | success |
| phase6-pr-ci browser (chromium) | 34751269064 | failure: missing Clerk secret |
| phase6-pr-ci browser (firefox) | 34751269064 | failure: missing Clerk secret |
| phase6-pr-ci browser (webkit) | 34751269064 | failure: missing Clerk secret |

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

1. Add the disposable Clerk repository secrets
   CONCORD_E2E_CLERK_PUBLISHABLE_KEY and CONCORD_E2E_CLERK_SECRET_KEY, plus
   CONCORD_E2E_CLERK_ISSUER if required, then rerun the three required
   browser jobs. Use a dedicated disposable Clerk instance; do not commit or
   paste credentials.
2. In the Clerk dashboard, migrate the default session-token audience off
   convex. Set the cloud GATEWAY_CLERK_AUDIENCE and CONCORD_APP_ORIGIN
   values, then perform one authorized cloud E2E verification. The gateway
   and release bundle fail closed while the legacy audience remains.
3. Verify the live hosted origin against authorizedParties after deployment.
   Invalid or missing CONCORD_APP_ORIGIN is rejected by the repository.
4. Configure the production trusted-proxy CIDRs and verify the
   right-to-left X-Forwarded-For chain end to end.
5. If production is redeployed, recreate the AWS/domain/TLS/IAM environment
   from the reproducible deployment scripts. The previous AWS stack is
   intentionally torn down and no live cloud deployment is claimed.
6. In GitHub Settings, enable Dependabot vulnerability alerts and automated
   security fixes, then verify the settings in the GitHub security UI. The
   remote API attempt was unsuccessful and is not represented as enabled.

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

The 18 remediation commits after the campaign start SHA, in order, are:

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

This report is published by one additional docs-only commit immediately
following b711111. The exact final main SHA and total commit count are
recorded in the final campaign handoff.

## 20. Final repository state

The final branch is main, pushed to origin, with a clean worktree after
report publication. The audited implementation is
b711111431f15717c2a887f81404eabce71e1046, and the report publication is its
docs-only descendant.

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
