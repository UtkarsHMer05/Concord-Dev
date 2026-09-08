#!/usr/bin/env bash
# Phase 3 full gateway verification gate (P3-M046/M049 runner).
#
# Runs, from a clean build: Rust fmt/clippy/unit, DB migrations from the
# live test DB, operation-log + authz + WS + security integration suites,
# protocol golden parity (Rust + TS), web typecheck/unit/realtime E2E
# against the release binary, and the benchmark baseline rerun.
#
# Preconditions (documented): docker compose up -d db; Node 24 via nvm;
# Rust toolchain per rust/rust-toolchain.toml.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Phase 3+4 gateway gate (single + distributed) ==="

# 1. Rust: fmt + clippy + unit (incl. Rust-side golden fixtures).
echo "--- rust: fmt/clippy/unit ---"
( cd rust
  cargo fmt --all --check
  cargo clippy --all-targets -- -D warnings
  cargo test --lib )

# 2. DB integration: migrations + op-log + authorization (serialized).
echo "--- rust: db integration ---"
( cd rust && cargo test --test db_integration -- --test-threads=1 )

# 3. WebSocket integration + security (serialized).
echo "--- rust: ws integration + security ---"
( cd rust && cargo test --test ws_integration -- --test-threads=1 )

# 4. Release build for E2E + benchmarks.
echo "--- rust: release build ---"
( cd rust && cargo build --release --example bench )

# 5. Web: typecheck + unit (incl. TS golden parity).
echo "--- web: typecheck + unit ---"
source "$HOME/.nvm/nvm.sh" && nvm use 24 >/dev/null
npm run typecheck
npx vitest run --project unit

# 6. Realtime E2E: real gateway binary, two clients, faults, drain.
echo "--- web: realtime E2E ---"
npx vitest run --project realtime

# 7. Broker + Redis distributed suites (live compose services).
echo "--- distributed: broker + redis ---"
( cd rust
  cargo test --test broker_integration -- --test-threads=1
  cargo test --test redis_integration -- --test-threads=1 )

# 8. Multi-gateway E2E: REAL processes, faults, restarts, compound failures.
echo "--- distributed: multi-gateway E2E ---"
( cd rust && cargo test --test multi_gateway -- --test-threads=1 )

# 9. Benchmark baseline rerun (records live in .agent/METRICS_LEDGER.md).
echo "--- benchmark rerun ---"
( cd rust && ./target/release/examples/bench )

# 10. Phase 5 recovery gate: native worker build + suites, then every
#     phase5 integration suite (serialized against the live test DB).
echo "--- phase 5: native worker gate ---"
( cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release
  cmake --build build/native
  ./build/native/crdt/tests/concord_crdt_tests
  ./build/native/worker/tests/concord_worker_tests )

echo "--- phase 5: recovery suites ---"
( cd rust
  cargo test --test phase5_migrations -- --test-threads=1
  cargo test --test phase5_snapshots -- --test-threads=1
  cargo test --test phase5_pipeline -- --test-threads=1
  cargo test --test phase5_recovery -- --test-threads=1
  cargo test --test phase5_jobs -- --test-threads=1
  cargo test --test phase5_compaction -- --test-threads=1
  cargo test --test phase5_equivalence -- --test-threads=1
  cargo test --test phase5_crash -- --test-threads=1
  cargo test --test phase5_resync -- --test-threads=1
  cargo test --test phase5_history -- --test-threads=1
  cargo test --test phase5_restore_concurrency -- --test-threads=1
  cargo test --test phase5_retention -- --test-threads=1
  cargo test --test phase5_races -- --test-threads=1
  cargo test --test phase5_security -- --test-threads=1 )

# 11. Phase 5 web: client resync suite + live client resync E2E.
echo "--- phase 5: web resync suite ---"
source "$HOME/.nvm/nvm.sh" && nvm use 24 >/dev/null
npx vitest run --project unit
npx vitest run --project realtime

echo "=== Phase 4+5 gate: ALL GREEN ==="
