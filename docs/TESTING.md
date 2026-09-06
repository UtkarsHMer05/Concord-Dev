# Concord — Testing

Status: Authoritative
Version: 1.0 (Phase 2)
Last updated: 2026-09-06

This document records how every layer of Concord is tested, with exact
commands. All commands run from the repository root.

---

## 1. Toolchain (Phase 2 native/WASM)

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24.20.0 (`.nvmrc`) | via nvm; `nvm use` |
| npm | 11.19.0 | |
| Apple clang | 21.0.0 | native C++ builds (arm64) |
| CMake | 4.4.3 | minimum required: 3.24 |
| Ninja | 1.13.2 | |
| Emscripten | 6.0.9 | WASM build of the same core |
| Python | 3.12.8 | codegen/scripting only |

Language level: **C++20** (no C++23 feature is currently required). Build
outputs live under `build/` (git-ignored): `build/native`, `build/sanitize`,
`build/fuzz`, `build/wasm`. No absolute developer paths are committed.

## 2. TypeScript product (Next.js + PostgreSQL)

```bash
npm ci                 # clean install from the lockfile
npm run typecheck      # tsc --noEmit (strict)
npm run lint           # eslint (flat config)
npm test               # unit tests (vitest, project "unit")
npm run test:db        # PostgreSQL integration tests (project "db")
npm run test:all       # both suites
npm run build          # production build
npm run smoke          # HTTP checks against a running server (health, 401s,
                       #   removed-endpoint guards)
```

Database integration tests run against the isolated `concord_test` database
(`DATABASE_TEST_URL`) and **replay all migrations from an empty schema on
every run**. `npm run db:test:prepare` recreates it on demand.

## 3. Native CRDT core (C++20)

```bash
# Configure + build (Debug)
cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Debug \
      -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build build/native

# Full native suite (unit + integration + property seeds + simulator corpus)
./build/native/crdt/tests/concord_crdt_tests

# One test by name substring
./build/native/crdt/tests/concord_crdt_tests concurrent_inserts
```

Test areas: identity types, document model, insertion/deletion convergence,
block structure, mark registers, validation, deduplication, state summaries,
serialization round trips, snapshots, digests, seeded property corpus,
deterministic multi-replica simulator (partitions, duplication, reordering).

## 4. Sanitizers (native)

```bash
cmake -S cpp -B build/sanitize -G Ninja -DCMAKE_BUILD_TYPE=Debug \
      -DCONCORD_SANITIZE_ADDRESS=ON -DCONCORD_SANITIZE_UNDEFINED=ON \
      -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build build/sanitize
./build/sanitize/crdt/tests/concord_crdt_tests
```

ThreadSanitizer becomes applicable when the core gains threads (the Phase 2
concurrency boundary); it is configured via `CONCORD_SANITIZE_THREAD=ON` and
will be part of the gate once worker execution exists natively.

## 5. Fuzzing (native)

Targets: `fuzz_op_decode` (operation decoder), `fuzz_snapshot_decode`
(snapshot decoder), `fuzz_op_apply` (operation application sequence with a
digest-stability invariant). Each target runs under two driver modes:

- **libFuzzer** where the runtime is available:
  `-DCONCORD_FUZZ_STANDALONE=OFF` with an LLVM toolchain providing
  `libclang_rt.fuzzer`.
- **Standalone driver** (default): deterministic seeded mutational loop:
  ```bash
  ./build/fuzz/crdt/fuzz/fuzz_op_decode cpp/crdt/fuzz/corpus/ops/seed_0 50000
  FUZZ_SEED=42 ./build/fuzz/crdt/fuzz/fuzz_op_apply cpp/crdt/fuzz/corpus/ops/seed_1 30000
  FUZZ_SEED=7 ./build/fuzz/crdt/fuzz/fuzz_snapshot_decode cpp/crdt/fuzz/corpus/ops/seed_2 20000
  ```

Platform note (recorded honestly): this host's Apple toolchain ships no
libFuzzer runtime and the Homebrew LLVM 21 runtime hangs at startup on this
macOS version; the standalone driver is the smoke-run mechanism here. Bounded
smoke sessions do **not** prove exhaustive security.

## 6. WASM / browser (Phase 2)

Commands are recorded in this document as they are introduced; the WASM
build, parity vectors, worker tests, IndexedDB reload tests, and the
browser multi-replica harness are covered in the Phase 2 sections below
(see also `docs/BENCHMARKS.md` for measurement methodology).
