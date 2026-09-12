# Concord v1 hardening finding ledger

Baseline: [V1_HARDENING_BASELINE.md](V1_HARDENING_BASELINE.md). Findings
from the owner-supplied hardening brief are hypotheses until reproduced
against this branch. A status of open is not a release approval.

| ID | Severity | Domain | Finding | Evidence | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| HARD-NATIVE-001 | Medium | portability | GCC fails on indirect `<algorithm>` include | Baseline GCC compile at `test_property_sim.cpp:73` | Direct includes in four translation units/header | GCC 15 and Apple Clang 21 Release build + 3/3 CTest each | Closed |
| HARD-NATIVE-002 | Medium | tooling | Root CTest discovers zero tests; corpus lookup depends on cwd | Baseline `ctest --test-dir build/native -N` reports zero | Root `enable_testing`, source-dir corpus definition, three labeled/time-limited tests | Root CTest 3/3; direct fuzz test from `/tmp`, 7 corpus inputs, 64/64 core | Closed |
| HARD-AUTH-001 | High | gateway auth | Process-lifetime JWKS refresh budget can be exhausted | New regression failed against the old lifetime counter | Async singleflight, cooldown, negative cache, TTL, bounded HTTP response/time, fixed-cardinality metrics | Rotation after attack, concurrent burst, oversized response; Rust auth 12/12 and clippy | Closed |
| HARD-AUTH-002 | High | gateway auth | Cloud session tokens historically use `aud=convex`; gateway accepted any audience | Previous `validation.validate_aud = false`; live claim migration not yet verified | Optional exact `aud` and `azp` policies; new cloud bundle requires explicit non-`convex` audience and pins `azp` to app origin | Strict correct/wrong/array/missing audience, wrong/missing party, future nbf, missing sub; dev compatibility | Open: Clerk dashboard claim migration and end-to-end cloud proof |
| HARD-AUTH-003 | High | gateway ingest | Reserved maintenance replica IDs were client-forgeable | Validated client decoder accepted both IDs before fix | Reject `REST`/`SYSC` origin before ingest; allocate new browser IDs with high bit, preserve ordinary legacy IDs | Protocol regression failed pre-fix, passes post-fix; browser allocator unit test; Rust lib 66 passed/1 ignored and web 171/171 | Closed |
| HARD-NET-001 | Medium | gateway limits | LB peer may collapse distinct clients into one bucket | Cloud nginx/gateway use dynamic Compose addresses; default shared peer budget | Gateway accepts XFF only from configured trusted CIDRs, walks from right to left, and rejects malformed/ambiguous chains; cloud must pin and verify the proxy topology before enabling it | Direct spoof, multihop IPv4/IPv6, malformed/duplicate headers, configuration tests; Rust lib 70 passed/1 ignored and clippy | Open: cloud wiring and end-to-end verification |
| HARD-LICENSE-001 | Critical | provenance | Tutorial-derived shipped files have unresolved redistribution rights | `NOTICE`, baseline diff, no root LICENSE | Inventory and replace/resolve retained derivatives | Path/hash inventory and attribution review | Open |
| HARD-LICENSE-002 | Medium | metadata | Cargo workspace says MIT while root declares no redistribution license | `rust/Cargo.toml`, `NOTICE` | Reconcile metadata after provenance decision | Manifest/SBOM check | Open |
| HARD-DOC-001 | Medium | claims | NOTICE SBOM paths and README browser measurement label are wrong | `NOTICE` uses `sbom/`; actual path `scripts/sbom/` | Correct measured provenance wording | Link/path and methodology audit | Open |

Further findings will be added with exact code and test evidence as each
phase is audited. Critical/High rows cannot be silently marked complete.
