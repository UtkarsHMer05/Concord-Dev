# Concord v1 hardening baseline

Captured 2026-09-12 on `codex/9-5-hardening` at
`485141491616b70179a1e85bfb7a9bac9b8fade8` (clean working tree).
The preceding commit contains the independently verified fix that scopes
Vitest database setup to DB tests; no benchmark numbers changed.

## Toolchain

macOS Darwin 25.5.0 arm64; Apple Clang 21.0.0; Homebrew GCC 15.2.0;
CMake 4.2.1; Ninja 1.13.2; Rust/Cargo 1.98.1; Node 24.20.0;
npm 11.19.0; Docker 29.7.2 / Compose 5.4.0; Emscripten 6.0.9.

## Existing gates at baseline

| Gate | Exact command | Result |
|---|---|---|
| Web typecheck | `npm run typecheck` | PASS |
| Web lint | `npm run lint` | PASS, 0 errors and 32 warnings |
| Web unit | `npm test` | PASS, 170/170 |
| DB integration | `DATABASE_TEST_URL=<local concord_test URL> npm run test:db` | PASS, 69/69 after isolated test DB preparation |
| Realtime integration | `npm run test:realtime` | PASS, 21/21 with local PostgreSQL, NATS, Redis and release gateway |
| Web release build | `npm run build` | PASS |
| Native GCC Release | `cmake -S cpp -B build/hardening-gcc -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=g++-15 && cmake --build build/hardening-gcc -j 4` | FAIL: `test_property_sim.cpp:73` uses `std::shuffle` without `<algorithm>` |
| Root CTest discovery | `ctest --test-dir build/native -N` | FAIL: 0 tests discovered |

DB preparation used `npm run db:test:prepare` with an explicit local
`concord_test` URL. The local Compose services were stopped after the
web/realtime suite; no production service was touched. Browser demo smoke
is SKIP: this machine's FortiGuard network filter blocks the Vercel URL,
so it cannot establish current deployment health. Full native, WASM,
sanitizer, Rust, chaos, and benchmark reruns are pending the relevant
hardening phases; historical Phase 7 counts are not substituted for
final-tree results.
