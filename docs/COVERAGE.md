# Concord — Coverage Diagnostics

Status: Diagnostic evidence, not a release-quality score.

Coverage is used to expose untested critical paths; it is not treated as a
vanity target or as proof of correctness. The correctness gates remain the
native property/fuzz/sanitizer campaigns, Rust protocol/auth tests, the
TypeScript database/realtime suites, and the browser/accessibility gates.

## Commands

Run from the repository root after `npm ci`:

```bash
bash scripts/coverage/ts.sh
bash scripts/coverage/native.sh       # requires gcovr
bash scripts/coverage/rust.sh         # requires cargo-llvm-cov
```

Reports are written below the ignored `coverage/` directory. Each wrapper
fails with exit 2 when its instrumentation provider is unavailable; an
uninstrumented test run is never mislabeled as coverage.

The Rust wrapper intentionally runs `cargo llvm-cov --workspace
--all-features --lib`. Integration and chaos tests are separate gates because
they require Docker, PostgreSQL, NATS, or Redis; the wrapper does not turn an
unavailable external service into a false coverage result.

## Recorded diagnostic run

On 2026-09-13, at the executable-equivalent checkpoint
`1efdbfe049affc2da9b72798a4c2fbbea74ed03f` (the coverage tooling changes were
not yet committed), the available providers produced:

- TypeScript/Vitest: 180 unit tests passed. Statements 1,040/1,197
  (86.88%), branches 540/697 (77.47%), functions 148/167 (88.62%), and lines
  1,007/1,151 (87.48%). Provider: V8 through `@vitest/coverage-v8` 5.0.0.
- C++/GCC: CTest 3/3 passed. Production sources under `cpp/crdt/src` and
  `cpp/worker` measured 1,816/2,154 lines (84.3%), 117/124 functions
  (94.4%), and 1,475/2,717 branches (54.3%), using GCC 15.2.0, `gcovr`
  8.6, and the matching `gcov-15` collector.
- Rust: 76 unit tests passed and 1 protocol-fixture generator remained
  intentionally ignored. `cargo-llvm-cov` 0.9.1 reported 7,499/12,013 lines
  (39.81%) and 306/699 functions (43.78%). This is the unit-only report;
  service-backed integration and chaos coverage is represented by their
  separate CI/reliability gates, not silently included here.

## Critical-path review

The review targets are:

- TypeScript: `src/lib/sync/transport.ts`, `src/lib/sync/sync-session.ts`,
  `src/lib/sync/snapshot-resync.ts`, and `src/proxy.ts`.
- Rust: authentication/JWKS refresh, protocol decoding, durable ingest,
  snapshot validation, compaction, and restore.
- C++: operation validation, snapshot decoding, document mutation, and
  worker framing.

The final campaign generated the TypeScript unit coverage report and the
native/Rust wrappers are available for a host with `gcovr` and
`cargo-llvm-cov`. No global percentage is claimed; future comparisons must
use the same source SHA and instrumentation toolchain.
