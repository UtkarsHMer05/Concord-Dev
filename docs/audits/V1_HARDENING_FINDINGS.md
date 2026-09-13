# Concord v1 hardening finding ledger

Baseline: [V1_HARDENING_BASELINE.md](V1_HARDENING_BASELINE.md). Findings
from the owner-supplied hardening brief are hypotheses until reproduced
against this branch.

Schema (v2, reconciled 2026-09-13):

- **ID** — unique across the whole ledger (this file). Duplicates from
  the 2026-09-12 two-table format were merged; no ID is reused.
- **Severity** — the ORIGINAL severity at discovery (never rewritten).
- **Status** — exactly one of `CLOSED`, `OWNER ACTION`,
  `ACCEPTED RESIDUAL RISK`, `OPEN`. Historical meaning is preserved in
  the row's evidence/fix columns, never by inventing a status.
- **Residual limitation / Owner action** — what remains true today.

Rules: no repository-actionable Critical/High finding may remain OPEN at
a release verdict; owner-only items are never CLOSED by repository-side
fail-closed behavior alone (the fail-closed code is necessary but the
external step is tracked separately).

A ledger validation script (scripts/security/validate-findings.sh) checks
ID uniqueness, status vocabulary, severity format, and required columns
on every CI run.

| ID | Severity | Domain | Title | Discovered | Root cause | Fix (commit) | Regression evidence | Final status | Residual limitation / Owner action |
|---|---|---|---|---|---|---|---|---|---|
| HARD-NATIVE-001 | Medium | portability | GCC fails on indirect `<algorithm>` include | 2026-09-11 | Transitive include dependency in four translation units | Direct includes (hardening pass 1) | GCC 15 and Apple Clang 21 Release build + CTest each; native CI gate | CLOSED | GCC + Clang matrix is continuous since the native CI rework |
| HARD-NATIVE-002 | Medium | tooling | Root CTest discovered zero tests; corpus lookup depended on cwd | 2026-09-11 | No root `enable_testing`; corpus path resolution | Root CTest wiring, source-dir corpus (hardening pass 1) | Root CTest 3/3; fuzz corpus from `/tmp` | CLOSED | — |
| HARD-AUTH-001 | High | gateway auth | Process-lifetime JWKS refresh budget exhaustible | 2026-09-11 | Lifetime refresh counter | Async singleflight + cooldown + negative cache + TTL + bounded HTTP (bc86a63) | Rotation-after-attack, concurrent burst, oversized-response tests; Rust auth suite | CLOSED | — |
| HARD-AUTH-002 | High | gateway auth | Cloud session tokens use `aud=convex`; gateway historically accepted any audience | 2026-09-11 | Clerk default template predates Concord; old gateway had `validate_aud=false` | Strict optional `aud`/`azp` policies; cloud bundle requires explicit non-convex audience and pins `azp` to app origin (0b9ae95 + hardening pass) | strict_claims_reject_cross_service_and_cross_origin_tokens (wrong/array/missing aud, wrong/missing party, future nbf, empty sub) — all pinned | OWNER ACTION | Clerk dashboard token-template audience migration + one end-to-end cloud verification. Gateway fails closed meanwhile: the cloud bundle refuses to start with aud=convex; dev tokens remain compatible |
| HARD-WEB-001 | Medium | Clerk web middleware | No exact `authorizedParties` origin configured | 2026-09-11 | Old `src/proxy.ts` had no options | `CONCORD_APP_ORIGIN` validated and exact origin passed to Clerk in cloud mode | Mocked middleware policy tests (cloud/dev/invalid origin) | OWNER ACTION | Live hosted-origin verification is external; repository covers mocked policy + fail-closed config validation |
| HARD-WEB-002 | High | web CSP | Script-src carried `unsafe-inline`; nonce follow-up only documented | 2026-09-12 | Old next.config.ts CSP | Per-request nonce via middleware, strict-dynamic, minimal connect-src (05c9623) | tests/proxy-claim-policy.test.ts — 9 effective-header assertions + live dev-server verification | CLOSED | — |
| HARD-NET-001 | Medium | gateway limits | LB peer could collapse distinct clients into one rate bucket | 2026-09-11 | Dynamic Compose addresses + shared peer budget | Trusted-proxy CIDR config; right-to-left XFF walk; malformed/ambiguous chain rejection (02b9a80) | Direct spoof, multihop IPv4/IPv6, malformed/duplicate headers, config tests (Rust suite) | OWNER ACTION | Production cloud CIDR wiring + end-to-end verification. Implementation is verified locally/CI; production topology is an external step |
| HARD-RATE-001 | Medium | gateway limits | Configured write/malformed budgets were not enforced at the WS frame boundary | 2026-09-13 | Defaults existed in the limiter but connection, malformed-control, binary, and validated-operation paths did not all consume them | Wire all four default scopes through the ingress paths; count validated operations and rejected frames; preserve fetch budget (current hardening pass) | `ratelimit::default_write_and_malformed_scopes_are_enforced`; WS integration and full serial Rust workspace | CLOSED | — |
| HARD-NET-002 | High | infra auth | Cloud NATS anonymous, Redis unauthenticated, Grafana anonymous Admin | 2026-09-12 | Old docker-compose.cloud.yml defaults | NATS user/pass; Redis ACL restricted to the code-derived command set; Grafana real admin; segmented networks; no-new-privileges/cap-drop/pids (578bad2) | LIVE fail-closed proofs: NATS anonymous+wrong-pass rejected; Redis NOPERM on GET/SET/FLUSHALL/out-of-namespace; allowlist end-to-end | CLOSED | Compose stack is torn down by design between deploys; proofs re-run at deploy time |
| HARD-CI-001 | High | supply chain | Workflows used floating action tags, no permission blocks, no dependency automation | 2026-09-12 | Baseline CI | SHA-pinned actions + least-privilege permissions + Dependabot + CodeQL + cargo-deny (7bc8a84) | Workflow lint (no floating refs); cargo-deny 4/4; this campaign re-validated every third-party SHA | CLOSED | Dependabot covers npm/cargo/actions (see HARD-CI-003 for the docker correction) |
| HARD-CI-002 | High | release gate | Trivy scans passed unconditionally (blanket continue-on-error) | 2026-09-12 | Release workflow shape | scan-gate.sh: new critical/high fails unless allowlisted with reason/owner/review date; JSON kept as evidence (7bc8a84) | Synthetic-report tests: empty report passes, unallowlisted finding fails, missing scanner fails closed | CLOSED | — |
| HARD-CI-003 | Medium | supply chain | Dependabot claimed docker coverage but no docker ecosystem was configured | 2026-09-13 | Earlier reports described "npm/cargo/actions/docker" while only npm/cargo/actions existed | Added the docker ecosystem entry for Dockerfile directories (this campaign) | `gh api` config validation + yaml parse | CLOSED | Compose image digests are pinned directly; the Dependabot entry watches the Dockerfiles |
| HARD-IMG-001 | Medium | containers | Base images tag-pinned; reproducibility overstated; apk upgrade undocumented | 2026-09-12 | Dockerfiles + compose | Digest-pinned FROM + compose images (2026-09-12 resolution); apk upgrade documented as deliberate mutable-security tradeoff (578bad2) | Registry digest resolution recorded in commit | CLOSED | apk upgrade stays mutable by design (security-freshness over bit-reproducibility) — documented tradeoff |
| HARD-LICENSE-001 | Critical | provenance | Tutorial-derived shipped source had unresolved redistribution rights | 2026-09-11 | 16 identical + 23 changed baseline `src/` paths | Replaced SVGs/fonts, rewrote template copy, rewrote remaining identical files (37a6832, d228526), MIT LICENSE with per-path provenance (dcfff87) | provenance-check.sh CI gate (54 overlapping paths, 0 unallowlisted identical, 0 banned assets); cargo-deny licenses ok | CLOSED | shadcn/ui-derived primitives retained under MIT with NOTICE attribution — accepted and documented |
| HARD-LICENSE-002 | Critical | licensing | No root license; Cargo claimed MIT contradicting the unlicensed root (originally logged Medium as the metadata conflict, merged with the Critical no-license finding) | 2026-09-11/12 | Two ledger rows shared this ID with conflicting severity/status — reconciled here | MIT root LICENSE after provenance resolution; crate license restored; NOTICE/SBOM pointers corrected (dcfff87) | cargo-deny license check; provenance gate; ledger validation script | CLOSED | The duplicate-ID ledger defect itself is fixed by this v2 schema |
| HARD-LICENSE-003 | High | provenance | Six source files byte-identical to tutorial baseline; components.json identical | 2026-09-12 | Retained shadcn output | All rewritten as original implementations preserving public APIs; components.json regenerated (d228526) | provenance-check.sh (0 unallowlisted); unit suite green | CLOSED | — |
| HARD-DOC-001 | Medium | claims | NOTICE SBOM paths and README browser-measurement label were wrong | 2026-09-12 | Stale docs | Corrected paths; benchmark label states "Node-instrumented real-WASM proxy" exactly | Link/path audit | CLOSED | — |
| HARD-AUTH-003 | High | gateway ingest | Reserved maintenance replica IDs were client-forgeable at ingest | 2026-09-11 | Validated client decoder accepted server-owned `REST`/`SYSC` identities before the hardening fix | Reject both reserved origins at validated decode; allocate new browser identities with the high bit while preserving ordinary legacy IDs (c9ea5fd + hardening pass) | `client_ingress_rejects_both_reserved_replicas_but_allows_legacy_ids`; browser replica allocator test; native worker reserved-band tests | CLOSED | — |
| SA-PROV1 | Critical | provenance gate | Provenance gate failed OPEN: missing baseline tag scanned 0 paths and CI passed green | 2026-09-13 | `git ls-tree` in process substitution fed an empty loop; no existence precondition; no zero-path guard; tags never pushed | Fail-closed scanner (dc3cb2d): tag must resolve to a commit; enumeration into a validated temp file; zero-file baseline and zero-overlap refused; internal git failures exit 2. Authentic tags pushed to origin and verified via ls-remote | scripts/security/provenance-tests.sh — 14 assertions (valid/allowlist/unallowlisted/banned/missing/invalid/zero-file/nonzero-count/internal-git-failure), wired into PR CI security job; real-repo scan checks 54 overlapping paths | CLOSED | — |
| SA-NATV1 | High | native release | Source-archive (gitless) build printed `concord-worker 1.0.0 ()` and the worker version test failed | 2026-09-13 | `if(DEFINED CONCORD_GIT_SHA)` — an empty string is still defined; empty value wired as a compile definition | Only a non-empty sha is embedded (b95544a); CONCORD_EXPECT_GIT_SHA pins the exact form per build | Gitless archive repro: `concord-worker 1.0.0`, 52/52 worker tests; forced-empty: plain form, 52/52; git checkout: sha form, 52/52 | CLOSED | — |
| SA-SEC-001 | High | security tooling | Secret scanner could report a clean tree after an internal per-file scan failure | 2026-09-13 | Tracked-file `awk` formatting swallowed command failures; `grep` I/O errors were indistinguishable from binary-file skips | Removed swallowed failures; `awk`/`grep` internal errors now exit 2 with an actionable message; added an injected-failure regression script (this campaign) | `scripts/security/secret-scan-tests.sh` injects a tracked-file `awk` failure and requires exit 2; normal tree/history scans remain clean | CLOSED | — |
| SA-IMG-001 | High | containers | Final web-image Trivy scan found four High CVEs in unused npm runtime dependency subtrees (`CVE-2026-14257`, `CVE-2026-69152`, `CVE-2026-69192`, `CVE-2026-73566`) | 2026-09-13 | npm, npx, and Corepack were present in the runtime layer even though production starts Node directly | Removed npm, npx, and Corepack from `docker/web.Dockerfile` (b711111) | Release run 34751270511: web/gateway Trivy reports 0; local runtime probe and image smoke | CLOSED | — |

## Reconciliation notes (why rows changed)

1. **HARD-LICENSE-002 duplicate** — the 2026-09-12 ledger carried this ID
   twice (Medium/OPEN "root license pending" and Critical/CLOSED
   "resolved"). Both described the same underlying defect at different
   times. Merged into one row: original severity Critical (the release-
   blocking fact), full history in the columns, final status CLOSED with
   the resolution commit.
2. **"Open: …" statuses that were actually fixed** — HARD-AUTH-002,
   HARD-WEB-001, HARD-NET-001 were listed Open with trailing prose.
   Their repository-actionable work is done and regression-tested; the
   remaining work is genuinely external (Clerk dashboard, hosted
   origin, production CIDRs). Reclassified as **OWNER ACTION** with the
   external step named; fail-closed repository behavior documented per
   row.
3. **Owner actions are not closures** — per campaign rules, fail-closed
   code + blocked publishing is not completion. The external steps stay
   open in this ledger and in the final report's owner-action section.

## Owner actions (open, external)

| ID | Action | Current fail-closed behavior |
|---|---|---|
| HARD-AUTH-002 | Clerk dashboard: migrate the default session token template audience off `convex`, then run one end-to-end cloud verification | Cloud gateway bundle refuses aud=convex at startup; strict aud/azp tests pin the policy |
| HARD-WEB-001 | Verify `authorizedParties` against the real hosted origin once deployed | `CONCORD_APP_ORIGIN` must be a valid URL in cloud mode or the app refuses to start; mocked policy tests cover all branches |
| HARD-NET-001 | Configure production proxy CIDRs and verify the chain end-to-end in the deployed topology | XFF is honored only from configured trusted CIDRs; unconfigured = direct peer address (no spoofing possible) |

Findings will be added with exact code and test evidence as each phase is
audited. Critical/High rows cannot be silently marked complete — status
changes require the evidence columns to be updated in the same commit.
