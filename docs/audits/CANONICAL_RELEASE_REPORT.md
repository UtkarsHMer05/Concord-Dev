# CONCORD — FINAL COMPLETION REPORT

> [!WARNING]
> This campaign completed the repository-side remediation and the fresh local
> evidence that does not require external credentials, but it did not reach a
> releasable state. The exact candidate is blocked by unaccepted container
> Critical/High findings, pending nightly gates, and unresolved external
> provenance/account actions. The secret-backed authenticated browser jobs
> were removed from CI by explicit owner request; their earlier failed
> preflight is historical, not a current gate. No credential, tag, GitHub
> Release, deployment,
> or live-runtime result is fabricated here.

## 1. Verdict

| Claim | Verdict |
|---|---|
| Repository/release engineering | `PARTIAL / FAIL` — candidate work is implemented and locally verified in scope, but canonical release gates remain blocked |
| Current candidate state | `CANDIDATE_PENDING` |
| Live production deployment | `NOT DEPLOYED / NOT CLAIMED` |
| Canonical stable release | Not published; no `v1.0.1` tag or GitHub Release exists |

The work is complete up to the real blockers that cannot be bypassed safely.
The strict local dependency scan is red with `44 Critical / 180 High` image
findings and no broad allowlist. The exact remote candidate run
`34807277532` is historical evidence from before the authenticated browser
jobs were removed; its core non-browser checks passed and its then-existing
trusted browser preflight failed closed because the GitHub `concord-e2e`
Environment was empty. The remaining nightly/release checks, artifacts, and
account/legal decisions therefore cannot be certified as green.

## 2. Identity

| Field | Exact value or disposition |
|---|---|
| Campaign-start snapshot | `6f7799d287a8fb05037a8757aa98e55845a75d62` (the pre-remediation local checkpoint) |
| Implementation candidate (`releaseCommit` if later accepted) | `42dcb17dd26c11a05dd20109102f37ea3fb5135a` |
| Source-fence base | `8731dbe` (`8731dbe..42dcb17` contains only the benchmark denominator correction, image-pin refresh, and exact-image-smoke/dependency-scan metadata changes) |
| Candidate version | `1.0.1` (synchronized package, Rust, CMake, and SBOM metadata) |
| Canonical tag | None; no tag was created or moved |
| Report/evidence relation | This report and `evidence/v1.0.1/` are documentation-only descendants of `releaseCommit`; the report commit must not be confused with the executable candidate SHA |
| Initial canonical evidence commit | `d38541330909c063926eaa02c179ba6136004a43` (documentation-only descendant; not used as the implementation SHA) |
| Branch | `main` |
| Remote verification snapshot | `110881d6b2c9fdc1d3b4f2da26676d7fdf602f2a` (exact ref verified by run `34807277532`; later documentation descendants do not change the implementation) |
| Audit date | 2026-09-14 (Asia/Kolkata) |

Preserved historical references:

| Historical name | Commit | Disposition |
|---|---|---|
| `v1.0.0-hardened.10` | `b711111431f15717c2a887f81404eabce71e1046` | Historical checkpoint only |
| `concord-v1.0.0` | `f9ecc6eb23ef2bbb329ae009b26f1dc0b8f7432a` | Historical release checkpoint only |
| `antonio-original-baseline` | `942035cb8498a2de936b21425cba66c9ec7dc69e` | Historical provenance reference |

No historical tag was rewritten, deleted, or repurposed. The canonical
candidate is normal SemVer `1.0.1`; no new `v1.0.0-hardened.N` tag was made.

## 3. Subagent execution

The final pass used independent read-only subagent audits in addition to the
implementation workers used earlier in the campaign:

| Worker | Scope | Result |
|---|---|---|
| Popper (`01a09dd7-11ca-7090-8014-264aec69f95b`) | Final documentation, SHA/date/status claims, historical-artifact preservation, and unsupported release/deployment wording | Read-only audit; findings were reconciled in the canonical documents |
| Socrates (`01a09dda-e622-7731-b808-9ad507ecb08b`) | Dev-container CVE inventory and upstream image-refresh options | Read-only inventory; exact refreshed pins and the remaining strict blocker are recorded below |
| Earlier delegated implementation workers | Auth boundaries, browser CI/harness, native/WASM gates, release workflow, supply-chain scripts, and runtime Compose hardening | Changes grouped into the implementation commits listed in §5; no credentials were requested or fabricated |

Subagent results are advisory evidence and do not replace exact local command
outputs or remote check conclusions.

## 4. Inherited blockers and their disposition

| Inherited issue | Reproduced/root cause | Repository work completed | Current status |
|---|---|---|---|
| Secret-backed browser jobs failed before Clerk authentication | GitHub `concord-e2e` had no dedicated publishable key, secret key, or audience variable | Removed the authenticated Chromium/Firefox/WebKit matrix and aggregate `browser gate`; retained the public secretless Chromium smoke and local harness | `CLOSED` as a current CI blocker; no remote authenticated-browser claim |
| Browser CI was unsafe for public fork PRs | Secret-backed jobs were treated as universally required | Current CI exposes only `browser (public chromium)` to untrusted fork pull requests; no job receives Clerk secrets | `CLOSED` by workflow review |
| Main branch protection required browser contexts that no longer exist | Protection previously required split trusted browser names and `browser gate` | Removed all browser contexts from protected `main`, preserving strict protection and existing non-status settings | `CLOSED` by GitHub API readback on 2026-09-14 |
| Release workflow could rely on a different SHA | Artifact workflow lacked strict exact-check-run identity | Release workflow now validates normal SemVer, event SHA, check-run name/head SHA/Actions app, non-browser reliability gates, CodeQL, and core gates | `PASS_LOCAL` static review; post-change exact run pending |
| Web/gateway trust-boundary drift | Origin, CSP, Clerk party, TLS mode, and internal-service assumptions were not all exact | Added shared security configuration, per-request CSP nonce, HTTPS-only HSTS, exact `authorizedParties`, fail-closed TLS and internal-service requirements | Local tests/build pass; live/cloud auth remains unverified |
| Native parity/sanitizer/fuzz evidence was incomplete or weakly bound | Sanitizer exclusivity, timeout, signed-byte, and campaign issues | Hardened CMake/worker/fuzz paths and reran Release, ASan/UBSan, TSan, property, and bounded fuzz campaigns | Fresh local pass; remote nightly still required |
| Dev-container CVE inventory was high | Old pinned NATS/nginx/Grafana refs and no strict current inventory | Refreshed NATS, nginx, Grafana pins; retained exact Postgres/Redis/Prometheus refs after comparison; removed broad allowlist behavior | `FAIL_RELEASE_BLOCKER`; exact counts in §15 |
| Four npm development Moderates | Drizzle/esbuild toolchain advisory chain | Attempted safe remediation; did not use a breaking `npm audit fix --force` downgrade | Exact residual documented; production audit clean |
| “Immutable” and live-deployment language could outrun evidence | Historical tags/URLs were read as current proof | Reconciled current docs; preserved historical files byte-for-byte; removed unsupported immutability/live claims | `PASS_LOCAL` claim-boundary and diff checks; release identity still pending |
| Dependabot account state was not proven | GitHub API readback reported vulnerability alerts disabled and automated security fixes disabled | Checked repository configuration and bounded account-state check | `OWNER_ACTION` / blocking for release policy |

## 5. New findings and implementation commits

Implementation commits, in root-cause order:

1. `546fafb` — `fix(auth): enforce exact web and gateway trust boundaries`
2. `5d3360f` — `test(native): harden parity, sanitizer, and fuzz gates`
3. `1e0e132` — `test(browser): split trusted and secretless E2E lanes`
4. `c8c3505` — `ci(release): make candidate artifacts traceable and fail closed`
5. `04b7779` — `fix(release): correct image label assertions`
6. `8731dbe` — `fix(release): regenerate Rust SBOM identity`
7. `ed4fa15de78868e96bb180e0e1bb58c6dc0b6d4f` — `fix(bench): report the correct random-delete denominator`
8. `42dcb17dd26c11a05dd20109102f37ea3fb5135a` — `fix(security): refresh infrastructure image pins`

The final documentation/evidence change is intentionally separate from these
implementation commits. The machine-readable finding registry in
[`CANONICAL_RELEASE_LEDGER.json`](CANONICAL_RELEASE_LEDGER.json) is the
authoritative status map.

## 6. Clerk and authenticated-browser result

Repository-side policy remains exact and fail-closed for any explicitly
provisioned local/developer run:

- the gateway requires the configured Clerk issuer and audience;
- the web middleware uses exact `authorizedParties` and
  `CONCORD_APP_ORIGIN` values;
- authenticated E2E requires the dedicated audience `concord-e2e`, exact
  allocated web origin, and `CONCORD_E2E_REQUIRE_CLAIM_POLICY=1` when run
  locally with explicit credentials; and
- NATS/Redis internal-auth mode and negative authorization checks are enabled
  by explicit E2E flags.

The secret-backed authenticated browser jobs and the aggregate `browser gate`
were removed from GitHub Actions by explicit owner request. The external
`concord-e2e` Environment is therefore not a current CI prerequisite, and no
Clerk secret is reproduced in this report. The local harness documentation
still describes how an authorized developer may provision a disposable
non-production instance when authenticated browser diagnostics are needed.

The local public-browser smoke uses inert values and proves only the compiled
anonymous surface. It is not a real Clerk authentication result.

## 7. Browser result

| Lane | Current result | Interpretation |
|---|---|---|
| Public secretless Chromium | `PASS` · 1/1 | Production surface smoke with no DB, gateway, broker, or Clerk secret |
| Local dev-mode browser matrix | `PASS_LOCAL` | The full strict local run completed its Chromium journey/accessibility and Firefox/WebKit smoke jobs; it used local `.env.local` and default dev mode, so it is not trusted production-mode evidence |
| Authenticated production-mode Chromium/Firefox/WebKit | `NOT_CLAIMED` | Secret-backed CI matrix was intentionally removed; local diagnostics remain available with explicit credentials |
| Current accessibility journey | `NOT_CLAIMED` | No current remote authenticated-browser claim is made; old 5/5 result is historical |
| Local realtime convergence | `PASS_LOCAL` | Realtime suite 3 files / 21 tests; authenticated browser convergence is optional local diagnostic coverage |
| Remote GitHub browser gate | `NOT_CLAIMED` | The aggregate gate and trusted browser jobs no longer exist in current CI; run `34807277532` is historical pre-removal evidence |

The dev-mode and secretless browser paths remain useful diagnostics. No
authenticated remote-browser result is labeled as current release evidence.
The aggregate local strict result was 25 PASS / 1 FAIL / 0 SKIP, with only the
strict dependency scan failing.

## 8. Internal service authentication

The isolated E2E Compose stack now exercises the hardened internal topology:

- NATS JetStream with credential-bearing URL and authenticated pub/sub;
- wrong/missing NATS credentials rejected;
- Redis ACL with the restricted E2E user and allow/deny checks;
- wrong/missing Redis credentials rejected; and
- explicit project cleanup after the run.

The exact refreshed local run passed `node scripts/e2e/verify-infra-auth.mjs`
and the realtime suite. This is local infrastructure evidence, not a cloud
deployment claim.

## 9. Native and WASM

| Gate | Result |
|---|---|
| Apple Clang Release / CTest | `PASS_LOCAL` · `bash scripts/verify-native.sh Release`; CTest 3/3 |
| Native worker identity/smoke | `PASS_LOCAL` · version `1.0.1 (42dcb17)` and exact image smoke worker probe |
| Linux GCC Release | `PASS_REMOTE` · exact candidate phase6-pr-ci run `34807277532` |
| Linux Clang Release | `PASS_REMOTE` · exact candidate phase6-pr-ci run `34807277532` |
| Gitless source export | `PASS_LOCAL` for the exact export used by image smoke; a separate clean-clone release gate remains remote/pending |
| WASM build/smoke/parity | `PASS_LOCAL` · WASM smoke plus 5 files / 31 CRDT tests |
| Warnings-as-errors | `PASS_LOCAL` in the native verification script; CI also configures it explicitly |

No GCC pass is inferred from the local Apple Clang result.

## 10. Rust/backend

`cargo test --manifest-path rust/Cargo.toml --workspace -- --test-threads=1`
passed on the implementation candidate with **258 passed, 1 ignored, 0
failed**. The ignored test is the intentional golden-fixture regeneration
helper. The run covers unit, broker, chaos, database, lifecycle,
multi-gateway, observability, compaction/recovery/restore, authorization,
protocol, Redis, and WebSocket suites.

`cargo fmt --all --check` and the workspace Clippy command passed locally. The
Rust integration run used disposable local PostgreSQL/NATS/Redis services;
remote CI and nightly/reliability conclusions remain separate gates.

## 11. Fresh sanitizers

- ASan + UBSan: `PASS_LOCAL`, CTest 3/3, 153.59 seconds total. macOS leak
  detection was explicitly disabled with `detect_leaks=0` because the runtime
  does not support that mode; no sanitizer diagnostic was emitted.
- TSan: `PASS_LOCAL`, CTest 3/3, 428.18 seconds total; no diagnostic.
- Remote Linux/nightly sanitizer checks: `PENDING_REMOTE`; no historical run
  is promoted to current proof.

## 12. Fresh fuzzing

The current candidate completed five bounded standalone native targets for a
total of **160,000 executions**, with no crash or non-zero target result:
`op_decode`, `snapshot_decode`, `op_apply`, `recovery_stream`, and
`worker_protocol`. The deterministic property campaign passed **30/30 seeds**
with five replicas and 60,000 generated operations.

This is fresh local evidence, not an exhaustive libFuzzer claim. The remote
Rust/native fuzz lanes remain pending until exact candidate CI completes.

## 13. Reliability and chaos

Chaos run `20260914-090958-chaos` on the implementation candidate:

```text
attempted=27  passed=27  failed=0  skipped=0
lostDurableAckedOps=0  divergentReplicas=0
```

The run used PostgreSQL 18.6, NATS 2.12, and Redis 8.8.2. It is recorded in
[`evidence/v1.0.1/chaos-summary.json`](../../evidence/v1.0.1/chaos-summary.json).
Remote `chaos` and nightly reliability contexts are still pending.

## 14. Security and supply chain

| Area | Current result |
|---|---|
| Production npm audit | `PASS_LOCAL` · 0 Critical / 0 High / 0 Moderate / 0 Low |
| Full npm tree | `PASS_POLICY_WITH_RESIDUAL` · 0 Critical / 0 High / 4 Moderate / 0 Low; exact dev-only chain documented |
| Cargo audit | `PASS_LOCAL` · 0 findings |
| Cargo deny | `PASS_LOCAL` · warnings only, no failure |
| Secret scan tree/history | `PASS_LOCAL` · no non-allowlisted findings |
| Provenance mechanical scan | `PASS_LOCAL` · 54 baseline-overlapping paths, 0 unallowlisted identical, 14 regression assertions |
| Findings validator | `PASS_LOCAL` · 22 historical findings, unique IDs, no historical OPEN Critical/High |
| Immutable image-pin validation | `PASS_LOCAL` · 19 refs checked, 7 runtime inputs deferred by design |
| SBOM generation | `PASS_LOCAL` · web 194, Rust 327, native 7; JSON parse and deterministic regeneration clean |
| Container dependency gate | `FAIL_RELEASE_BLOCKER` · 44 Critical / 180 High unaccepted; no broad allowlist |
| CodeQL | `PASS_REMOTE` · exact candidate workflow run `34807277478` |
| Artifact checksum/attestation | `PENDING` · no release artifacts created while gates are blocked |

The strict container result is not softened by loopback binding or dev-only
classification. Those facts describe exercised exposure; they do not resolve
unpatched Critical/High packages.

## 15. Dev-container CVE inventory

Fresh `docker scout v1.24.0` scan, captured 2026-09-14 on `linux/arm64`, over
the exact digest-pinned image inputs:

| Image | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|
| `postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2` | 6 | 38 | 21 | 5 |
| `nats:2.12-alpine@sha256:b270f5e2428354c0335612694d7dd2fb588148e567a5757fdff325ef9c9332e6` | 3 | 13 | 4 | 0 |
| `redis:8.8.2-alpine@sha256:96cb544fa0af5aa898d160cffb7dae70c3df117190fc123831c64712cda425ff` | 2 | 10 | 2 | 0 |
| `nginx:1.31.5-alpine-slim@sha256:3b171d7224b669faa3cc2137fea0a65301791df1ec1f271ebd2a2b7461f7fade` | 0 | 0 | 0 | 0 |
| `prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996` | 11 | 38 | 48 | 3 |
| `grafana/grafana:12.3.0@sha256:70d9599b186ce287be0d2c5ba9a78acb2e86c1a68c9c41449454d0fc3eeb84e8` | 22 | 81 | 83 | 12 |
| **Total** | **44** | **180** | **158** | **20** |

The prior four-image inventory was 29 Critical / 135 High; that comparison is
not a complete before/after total because this fresh scan includes the
Prometheus and Grafana cloud/observability refs as well. The NATS refresh
reduced its known 13/52 inventory to 3/13, and the nginx refresh reduced 8/35
to 0/0. Postgres and Redis were retained after upstream comparison; Prometheus
was retained because the tested newer tag did not reduce the strict count;
Grafana 12.3 reduced the earlier High count but remains blocked.

No residual Critical/High finding is accepted in the current ledger. Required
action is an upstream patched digest or a deliberately rebuilt and validated
image, followed by a fresh strict scan. The exact machine-readable inventory
is [`evidence/v1.0.1/container-scan.json`](../../evidence/v1.0.1/container-scan.json).

## 16. Performance

A fresh native baseline was run on the implementation candidate. The raw
output, workload denominators, five-run medians, and environment pointer are
in [`evidence/v1.0.1/native-benchmark.txt`](../../evidence/v1.0.1/native-benchmark.txt).
Notable current values include:

```text
sequential append       137.400 ms  (10000 units, 5 runs)
random-position insert   93.456 ms  ( 5000 units, 5 runs)
random delete            23.768 ms  ( 2000 units, 5 runs)
remote batch apply     2530.292 ms  (19998 units, 5 runs)
snapshot export           1.215 ms
snapshot import           1.834 ms
```

The random-delete denominator is explicitly 2,000 configured deletions per
run. No cross-version delta or promotional throughput claim is derived from
this single local environment. Historical performance tables remain
checkpoint evidence.

## 17. Clean-room reproducibility

The release image smoke built from a clean `git archive` export of the exact
implementation candidate and passed gateway, web, and worker probes with
non-root IDs. This proves the source-export path used by that smoke helper.

A separately cloned, fully clean working tree with all required release gates
is not certified by the push workflows alone: the historical candidate run
completed its core non-browser jobs, while the then-existing trusted browsers
failed closed at the Clerk preflight; the post-change and nightly/release
artifact gates remain pending. No generated artifact is treated as a release
artifact yet.

## 18. GitHub CI on `releaseCommit`

The exact pushed candidate `110881d6b2c9fdc1d3b4f2da26676d7fdf602f2a` was
observed remotely before the CI-policy change. Push run `34807277532`
concluded `failure`: `web`, `rust`, `wasm`, `security`, native GCC/Clang, and
the source-side checks completed successfully, while the then-existing
trusted browser jobs failed closed before authentication because the Clerk
Environment was empty. That run is historical; a post-change exact-SHA run
must be observed for the current check set. The separate exact-SHA CodeQL run
`34807277478` and the phase2/3/4/5/6 supporting runs also concluded success.
The nightly `native-sanitizers`, `native-fuzz`, `rust-fuzz`, and `chaos`
contexts required by the release workflow have not yet produced current
conclusions.

The release workflow is configured to require exact successful check runs for:

```text
web
rust
wasm
security
native (g++)
native (clang++)
Analyze (javascript-typescript)
Analyze (cpp)
native-sanitizers
native-fuzz
rust-fuzz
chaos
```

The candidate cannot receive a green remote verdict until the strict container
gate is resolved and the nightly/release contexts conclude successfully. The
observed browser preflight failure is retained only as historical evidence of
the pre-removal workflow, not as a current blocker.

The protected `main` branch now requires only the current non-browser status
contexts `web`, `rust`, `wasm`, `security`, `native (g++)`, `native (clang++)`,
`Analyze (javascript-typescript)`, and `Analyze (cpp)`. The readback preserved
strict checks, linear history, conversation resolution, force-push/deletion
protections, and the existing review/signature settings.

## 19. Release integrity

No canonical stable tag, manifest, `SHA256SUMS`, artifact attestation,
registry push, or GitHub Release was created. This is intentional: the
release workflow must first see the exact candidate non-browser check-runs,
release-image policy pass, supply-chain evidence, and the remaining
owner/legal decisions. Historical tags and evidence remain preserved and are
not moved.

## 20. Owner actions

The remaining actions are explicit and structured in the JSON ledger:

1. Resolve the strict container inventory with patched upstream/custom
   validated images or exact advisory-level owner disposition. No broad
   allowlist is allowed.
2. Enable and read back GitHub Dependabot vulnerability alerts and automated
   security fixes, or record the platform failure after bounded retries.
3. Complete path-specific provenance/licensing review and any permission/legal
   decisions. Mechanical scanner cleanliness is not legal clearance.
4. After all blockers close, run the clean-room candidate workflow, generate
   manifest/SBOM/checksum/attestation artifacts, verify them independently,
   and only then create/publish `v1.0.1`.
5. If a live deployment is desired, choose and explicitly authorize a provider
   that supports persistent Rust gateways, the worker, PostgreSQL,
   NATS/JetStream, Redis, and the proxy. Do not reprovision AWS merely to
   manufacture evidence.

## 21. Evidence paths

- Current local evidence index:
  [`CANONICAL_FRESH_EVIDENCE.md`](CANONICAL_FRESH_EVIDENCE.md)
- Machine-readable findings and owner actions:
  [`CANONICAL_RELEASE_LEDGER.json`](CANONICAL_RELEASE_LEDGER.json)
- Candidate bundle:
  [`../../evidence/v1.0.1/`](../../evidence/v1.0.1/)
- Historical release evidence (preserved):
  [`../../evidence/v1.0.0/`](../../evidence/v1.0.0/)
- Historical hardening report (preserved):
  [`V1_HARDENING_FINAL_REPORT.md`](V1_HARDENING_FINAL_REPORT.md)
- Historical findings ledger (preserved):
  [`V1_HARDENING_FINDINGS.md`](V1_HARDENING_FINDINGS.md)

## 22. Final rating

`CANDIDATE_PENDING — NOT RELEASE-READY`.

Repository engineering made substantial progress: the implementation
candidate is synchronized and passes the credential-free local build,
database/realtime, Rust, native, WASM, property, fuzz, sanitizer, chaos,
secret, provenance, SBOM, image-pin, and image-smoke checks. The result is
not a canonical release because the strict container gate is red, current
remote/nightly results are absent, Dependabot/account settings are not
enabled, and provenance/legal disposition is not an automated fact. The
pre-removal browser failure is retained as historical evidence rather than
silently relabeled as a current green result.

Live production deployment: `NOT DEPLOYED / NOT CLAIMED`. No AWS or Vercel
runtime, URL, deployed SHA, TLS, live Clerk, or persistent realtime claim is
made.
