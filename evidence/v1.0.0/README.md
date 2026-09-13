# Concord v1.0.0 public evidence

This directory contains machine-readable, secret-free evidence for the final
remediation campaign. It is a pointer set, not a replacement for the full
report or the raw GitHub workflow artifacts.

Evidence checkpoints:

- `executableSha`: `b711111431f15717c2a887f81404eabce71e1046`
- `codeEquivalentCiSha`: `1efdbfe049affc2da9b72798a4c2fbbea74ed03f`
- tag: `v1.0.0-hardened.10`
- baseline tag: `antonio-original-baseline`

Files:

- [`ci.json`](ci.json) — required workflow/job results, including both
  attempts of the distributed rerun and the browser preflight failure.
- [`security.json`](security.json) — provenance, dependency, secret, CodeQL,
  image-scan, and coverage results.
- [`reproducibility.json`](reproducibility.json) — fresh clone and gitless
  archive commands and outcomes.
- [`performance.json`](performance.json) — structural checks and historical
  measurements kept separate from new measurements.
- `SHA256SUMS` — checksums for the evidence files.

No credentials, tokens, cookies, private keys, or generated `.env.local` files
are included. Browser CI is intentionally recorded as fail-closed when the
required disposable Clerk secrets are absent; the owner must provide them to
complete the protected remote browser contexts.

The canonical narrative report is
[`docs/audits/V1_HARDENING_FINAL_REPORT.md`](../../docs/audits/V1_HARDENING_FINAL_REPORT.md).
