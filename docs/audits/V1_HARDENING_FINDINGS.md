# Concord v1 hardening finding ledger

Baseline: [V1_HARDENING_BASELINE.md](V1_HARDENING_BASELINE.md). Findings
from the owner-supplied hardening brief are hypotheses until reproduced
against this branch. A status of open is not a release approval.

| ID | Severity | Domain | Finding | Evidence | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| HARD-NATIVE-001 | Medium | portability | GCC fails on indirect `<algorithm>` include | Baseline GCC compile at `test_property_sim.cpp:73` | Direct includes in four translation units/header | GCC 15 and Apple Clang 21 Release build + 3/3 CTest each | Closed |
| HARD-NATIVE-002 | Medium | tooling | Root CTest discovers zero tests; corpus lookup depends on cwd | Baseline `ctest --test-dir build/native -N` reports zero | Root `enable_testing`, source-dir corpus definition, three labeled/time-limited tests | Root CTest 3/3; direct fuzz test from `/tmp`, 7 corpus inputs, 64/64 core | Closed |
| HARD-AUTH-001 | High | gateway auth | Process-lifetime JWKS refresh budget can be exhausted | `refresh_count` and `max_refreshes=3` in `auth/mod.rs`; exploit regression pending | Pending bounded reusable refresh design | Unknown-kid burst followed by legitimate rotation | Open |
| HARD-AUTH-002 | High | gateway auth | No strict audience policy; deployed template historically uses `aud=convex` | `validation.validate_aud = false` | Pending explicit prod contract and dev compatibility | Wrong/missing/correct audience | Open |
| HARD-AUTH-003 | High | gateway ingest | Reserved maintenance replica IDs may be client-forgeable | `history.rs` note; ingress review pending | Pending ingress rejection | Forged `REST`/`SYSC` op | Open |
| HARD-NET-001 | Medium | gateway limits | LB peer may collapse distinct clients into one bucket | `docs/SECURITY.md` documented gap; code review pending | Pending trusted-proxy policy | Spoof and multi-hop tests | Open |
| HARD-LICENSE-001 | Critical | provenance | Tutorial-derived shipped files have unresolved redistribution rights | `NOTICE`, baseline diff, no root LICENSE | Inventory and replace/resolve retained derivatives | Path/hash inventory and attribution review | Open |
| HARD-LICENSE-002 | Medium | metadata | Cargo workspace says MIT while root declares no redistribution license | `rust/Cargo.toml`, `NOTICE` | Reconcile metadata after provenance decision | Manifest/SBOM check | Open |
| HARD-DOC-001 | Medium | claims | NOTICE SBOM paths and README browser measurement label are wrong | `NOTICE` uses `sbom/`; actual path `scripts/sbom/` | Correct measured provenance wording | Link/path and methodology audit | Open |

Further findings will be added with exact code and test evidence as each
phase is audited. Critical/High rows cannot be silently marked complete.
