# Concord — Documentation index

Every document in `docs/` answers a specific question. Start with the
project [README](../README.md) for the tour, then follow the category
that matches your question. Documents are authoritative for their phase
(check each one's header for status and last-updated date); when a doc
and code disagree, code wins and the doc must be fixed (the standing
rule from [CONFIGURATION.md](CONFIGURATION.md)).

Audits live in [audits/](audits/); the secret-free machine-readable v1
evidence index lives in [../evidence/v1.0.0/](../evidence/v1.0.0/).

## Start here

| Document | What it answers |
|---|---|
| [README.md](../README.md) (root) | The 30-second tour: what Concord is, what is hard about it, the measured results, and the honest scope of the live demo |
| [ENGINEERING_BRIEF.md](ENGINEERING_BRIEF.md) | The technical orientation for engineers/interviewers: the core decisions, the hardest bugs found, and where each claim is documented |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the system fits together: components, boundaries, the write path, and the distributed/storage planes (with mermaid diagrams) |

## Concepts

| Document | What it answers |
|---|---|
| [CONSISTENCY_MODEL.md](CONSISTENCY_MODEL.md) | What convergence, idempotency, and determinism mean here — the correctness contract every layer must preserve |
| [PRD.md](PRD.md) | What the product is required to do (v1 scope frozen in §25a) |
| [FAILURE_MODEL.md](FAILURE_MODEL.md) | What exactly an "acknowledged" edit means and what the system does under each failure it can suffer |

## Protocol

| Document | What it answers |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | The operation schema and the v1 wire protocol (JSON control + binary op frames) that browsers, gateways, and the C++ core speak |

## Storage & recovery

| Document | What it answers |
|---|---|
| [DATABASE.md](DATABASE.md) | The PostgreSQL schema: control plane, ACLs, audit, and the durable operation log |
| [STORAGE.md](STORAGE.md) | Snapshots, the operation log, compaction floors, and the storage lifecycle |
| [MIGRATIONS.md](MIGRATIONS.md) | The database migration runbook: expand/contract discipline, rehearsal, rollback |
| [MIGRATION_CONVEX_TO_POSTGRES.md](MIGRATION_CONVEX_TO_POSTGRES.md) | How the temporary Convex persistence was replaced by PostgreSQL (historical record) |
| [RECOVERY.md](RECOVERY.md) | How a stale client or gateway recovers: snapshot+tail, fallback chain, resync |
| [HISTORY.md](HISTORY.md) | Version history: what a revision is, how historical state is reconstructed, and how restore works without rewriting history |

## Security

| Document | What it answers |
|---|---|
| [SECURITY.md](SECURITY.md) | The full security model: trust boundaries, RBAC, input hardening, the 32-row threat model (each threat mapped to executable evidence or an explicitly documented posture limitation), scanning tooling, production configuration |
| [AUTHORIZATION.md](AUTHORIZATION.md) | The deny-by-default role model (OWNER/EDITOR/COMMENTER/VIEWER), live revocation, and IDOR masking |
| [PROVENANCE.md](PROVENANCE.md) | What was retained, replaced, and independently built relative to the tutorial baseline — and the CI gate that enforces it |

## Testing & verification

| Document | What it answers |
|---|---|
| [TESTING.md](TESTING.md) | How every layer is tested, with the exact commands (web, native, sanitizers, fuzzing, Rust, chaos) |
| [VERIFICATION.md](VERIFICATION.md) | The claim-to-evidence index: every engineering claim mapped to its test, scan, or measurement |
| [COVERAGE.md](COVERAGE.md) | How to generate diagnostic TypeScript, native, and Rust coverage without turning unavailable providers into false results |
| [TOP_TECH_REVIEW.md](TOP_TECH_REVIEW.md) | Factual review matrix across systems, AWS, product engineering, and native/toolchain lenses |
| [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md) | Which browsers can run the v1 web client, truthfully (incl. the embedded-WebView caveat) |

## Performance

| Document | What it answers |
|---|---|
| [BENCHMARKS.md](BENCHMARKS.md) | Every measured number with its methodology, environment, and run count — and what is explicitly not claimed |

## Operations

| Document | What it answers |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | Local-dev and production runbooks: graceful shutdown, backups, DR, the native worker contract |
| [DEPLOYMENT.md](DEPLOYMENT.md) | The deployment topology (one compose stack per environment, ALB for TLS/WSS, no Kubernetes) |
| [OBSERVABILITY.md](OBSERVABILITY.md) | How to see what the sync gateway is doing: correlation IDs, Prometheus metrics, OTel tracing, Grafana dashboards |
| [CONFIGURATION.md](CONFIGURATION.md) | Every environment variable: scope, format, failure mode, and the validation script |

## Decisions & history

| Document | What it answers |
|---|---|
| [DECISIONS.md](DECISIONS.md) | Why things are the way they are: DEC-001…DEC-050 with alternatives and revisit conditions |
| [HISTORY.md](HISTORY.md) | *(the product feature)* version history — see Storage & recovery above |
| [ROADMAP.md](ROADMAP.md) | The eight-phase delivery plan, each phase's objective, forbidden work, and completion gate |

## Audits ([audits/](audits/))

| Artifact | What it is |
|---|---|
| [audits/V1_HARDENING_BASELINE.md](audits/V1_HARDENING_BASELINE.md) | The toolchain and gate results captured at the start of the v1 hardening pass (2026-09-12) |
| [audits/V1_HARDENING_FINDINGS.md](audits/V1_HARDENING_FINDINGS.md) | The hardening finding ledger: severity, evidence, fix, and regression-test status per finding |
| [audits/V1_HARDENING_FINAL_REPORT.md](audits/V1_HARDENING_FINAL_REPORT.md) | The final 22-section remediation, reproducibility, browser, provenance, CI, release, and residual-risk report |
| [../evidence/v1.0.0/README.md](../evidence/v1.0.0/README.md) | Secret-free machine-readable CI, security, reproducibility, and performance evidence for v1.0.0 |
| [audits/provenance-paths.tsv](audits/provenance-paths.tsv) | Machine-readable path inventory: baseline vs current git blob ids for every in-scope `src/`/`public/` path (regenerate via `python3 scripts/audit-provenance.py`) |
