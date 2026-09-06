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

echo "=== Phase 3 gateway gate ==="

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

# 7. Benchmark baseline rerun (records live in .agent/METRICS_LEDGER.md).
echo "--- benchmark rerun ---"
( cd rust && ./target/release/examples/bench )

echo "=== Phase 3 gate: ALL GREEN ==="
