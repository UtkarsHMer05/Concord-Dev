# Security Policy

Concord's deep security documentation is the 32-row threat model and
per-layer controls in [docs/SECURITY.md](docs/SECURITY.md) — this file
covers how to report vulnerabilities and which security gates run on
every change.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Please use GitHub's private vulnerability reporting: open the
repository's **Security** tab → **Report a vulnerability**
(GitHub Security Advisories). If that path is unavailable to you, open a
regular issue asking the maintainer to enable private reporting — do not
include vulnerability details in it.

Please include where possible:

- the affected component (browser runtime, Rust gateway, C++ core,
  deployment tooling, CI),
- reproduction steps or a PoC,
- the exact commit or release you tested.

**Response expectation:** the maintainer will acknowledge the report
within 7 days. Fixes ship as soon as practical, with a regression test
pinning the vulnerability, and are credited in
[CHANGELOG.md](CHANGELOG.md) unless you prefer otherwise. Coordinated
disclosure via the advisory is preferred; please do not publish details
before a fix is released.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x (`main`) | Yes |

The v1 milestone is tagged `concord-v1.0.0`; security fixes land on
`main` and are noted in the changelog.

## Threat model and hardening details

The full security model — trust boundaries, deny-by-default RBAC,
protocol input hardening, resource bounds, the 32-row formal threat
model where every threat is mapped to an executable test, scanning
tooling, and the production security configuration — is
[docs/SECURITY.md](docs/SECURITY.md).

## Security gates

These run in CI (`.github/workflows/phase6-pr-ci.yml`,
`.github/workflows/phase6-release-artifacts.yml`,
`.github/workflows/codeql.yml`) and locally:

| Gate | Script / workflow |
|---|---|
| Secret scan (tree; full history on release) | `scripts/security/secret-scan.sh` |
| Dependency scan (npm / cargo audit / containers) | `scripts/security/dep-scan.sh` |
| Release image scan verdict (trivy; new critical/high fails) | `scripts/security/scan-gate.sh` |
| Rust crate license/advisory policy | `rust/deny.toml` (cargo-deny) |
| Static analysis (JS/TS + C++; Rust lane is clippy + cargo-audit/deny) | CodeQL workflows |
| Provenance gate (no unlicensed tutorial-identical files) | `scripts/security/provenance-check.sh` |

Dependency findings triage and documented-accepted residual risk are
recorded in [docs/SECURITY.md](docs/SECURITY.md) §9.
