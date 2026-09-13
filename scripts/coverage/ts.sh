#!/usr/bin/env bash
# TypeScript/Vitest coverage diagnostic.  Coverage is evidence, not a release
# quality target: the report is intentionally kept in the ignored coverage/
# directory and critical modules are reviewed in docs/COVERAGE.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm run test:coverage -- --coverage.reportsDirectory="${CONCORD_COVERAGE_DIR:-coverage/ts}"
