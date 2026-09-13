#!/usr/bin/env bash
# Rust coverage diagnostic.  The tool is intentionally an explicit
# prerequisite: silently falling back to an uninstrumented cargo test would
# create a false coverage result.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v cargo-llvm-cov >/dev/null 2>&1; then
  echo "Rust coverage requires cargo-llvm-cov; install it, then rerun scripts/coverage/rust.sh" >&2
  exit 2
fi

out_dir="${CONCORD_COVERAGE_DIR:-coverage/rust}"
mkdir -p "$out_dir"
# Keep this diagnostic self-contained.  The integration and chaos tests are
# intentionally separate release gates and require Docker/PostgreSQL/NATS;
# including them here would turn an unavailable external service into a
# misleading coverage failure.  The unit-test report still covers the core
# auth, protocol, configuration, rate-limit, worker, and observability paths.
(cd rust && cargo llvm-cov --workspace --all-features --lib --lcov --output-path "../$out_dir/rust.lcov")
