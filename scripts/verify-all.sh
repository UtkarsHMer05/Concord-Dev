#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Concord verification orchestrator.
#
# The default developer mode is explicit about unavailable optional
# prerequisites. `--strict` is the release/audit mode: every selected gate
# must run, and a missing database, broker, browser, tag, or scanner is a
# failure. No nested test suite is allowed to turn a prerequisite skip into a
# green aggregate result.
#
# Usage:
#   bash scripts/verify-all.sh
#   bash scripts/verify-all.sh --strict
#   STEPS="web native" bash scripts/verify-all.sh --strict
#
# STEPS values: web native rust wasm browser provenance security
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

STRICT=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    -h|--help)
      sed -n '2,24p' "$0"
      exit 0
      ;;
    *)
      echo "verify-all: unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

# Load local development variables without printing them. CI supplies its
# variables explicitly. The Node test runners independently load .env.local;
# this shell load keeps service and tool prerequisites consistent with them.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

ALL_STEPS="web native rust wasm browser provenance security"
STEPS="${STEPS:-$ALL_STEPS}"

declare -a SUMMARY_STATUS=()
declare -a SUMMARY_NAME=()
declare -a SUMMARY_DURATION=()
declare -a SUMMARY_NOTE=()
declare -i FAILED=0
declare -i SKIPPED=0
declare -i REQUIRED_SKIPPED=0
declare -i PASSED=0

human_duration() {
  local seconds="$1"
  awk -v s="$seconds" 'BEGIN {
    if (s >= 60) printf "%dm%.0fs", int(s/60), s%60
    else printf "%.1fs", s
  }'
}

record() {
  # record <status> <name> <start-epoch> [note] [required]
  local status="$1"
  local name="$2"
  local start="$3"
  local note="${4:-}"
  local required="${5:-0}"
  local duration
  duration="$(human_duration "$(awk -v a="$start" -v b="$(date +%s)" 'BEGIN { print b-a }')")"

  SUMMARY_STATUS+=("$status")
  SUMMARY_NAME+=("$name")
  SUMMARY_DURATION+=("$duration")
  SUMMARY_NOTE+=("$note")
  printf '%s: %s (%s)' "$status" "$name" "$duration"
  [ -n "$note" ] && printf ' — %s' "$note"
  printf '\n'

  case "$status" in
    PASS) PASSED=$((PASSED + 1)) ;;
    FAIL) FAILED=$((FAILED + 1)) ;;
    SKIP)
      SKIPPED=$((SKIPPED + 1))
      [ "$required" -eq 1 ] && REQUIRED_SKIPPED=$((REQUIRED_SKIPPED + 1))
      ;;
  esac
}

in_steps() {
  local wanted="$1"
  local item
  local IFS=' ,'
  for item in $STEPS; do
    [ "$item" = "$wanted" ] && return 0
  done
  return 1
}

run_cmd() {
  # run_cmd <summary-name> <command> [args...]
  local name="$1"
  shift
  local start
  start="$(date +%s)"
  if "$@"; then
    record PASS "$name" "$start"
  else
    record FAIL "$name" "$start"
  fi
}

missing_required() {
  # missing_required <name> <reason>
  local name="$1"
  local reason="$2"
  local start
  start="$(date +%s)"
  if [ "$STRICT" -eq 1 ]; then
    record FAIL "$name" "$start" "$reason"
  else
    record SKIP "$name" "$start" "$reason" 1
  fi
}

compose_service_available() {
  local service="$1"
  command -v docker >/dev/null 2>&1 || return 1
  local status
  status="$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' "$service" 2>/dev/null)" || return 1
  printf '%s\n' "$status" | grep -Eiq 'running|up|healthy'
}

db_available() {
  [ -n "${DATABASE_TEST_URL:-}" ] || return 1
  printf '%s' "$DATABASE_TEST_URL" | grep -q 'concord_test' || return 1
  compose_service_available db || return 1
  # A running container is not enough: prove PostgreSQL accepts connections.
  docker compose exec -T db pg_isready -U "${POSTGRES_USER:-concord}" -d postgres >/dev/null 2>&1
}

infra_available() {
  db_available || return 1
  compose_service_available nats || return 1
  compose_service_available redis || return 1
}

run_rust_cmd() {
  ( cd rust && "$@" )
}

run_native_compiler() {
  local label="$1"
  local compiler="$2"
  local start
  start="$(date +%s)"

  if ! command -v "$compiler" >/dev/null 2>&1; then
    if [ "$STRICT" -eq 1 ]; then
      record FAIL "native/$label" "$start" "$compiler is not installed"
    else
      record SKIP "native/$label" "$start" "$compiler is not installed" 1
    fi
    return
  fi
  if ! command -v cmake >/dev/null 2>&1; then
    record FAIL "native/$label" "$start" "cmake is not installed"
    return
  fi
  if ! command -v ninja >/dev/null 2>&1; then
    record FAIL "native/$label" "$start" "ninja is not installed"
    return
  fi

  local build_dir
  build_dir="$(mktemp -d "${TMPDIR:-/tmp}/concord-verify-${label}.XXXXXX")" || {
    record FAIL "native/$label" "$start" "could not create an isolated build directory"
    return
  }
  if cmake -S cpp -B "$build_dir" -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CXX_COMPILER="$compiler" \
      -DCONCORD_WARNINGS_AS_ERRORS=ON \
      -DCONCORD_BUILD_TESTS=ON \
      -DCONCORD_BUILD_FUZZ=OFF \
    && cmake --build "$build_dir" --parallel 2 \
    && ctest --test-dir "$build_dir" --output-on-failure --parallel 1; then
    record PASS "native/$label" "$start" "isolated build: $build_dir"
  else
    record FAIL "native/$label" "$start" "isolated build: $build_dir"
  fi
}

run_web() {
  run_cmd web/typecheck npm run typecheck
  run_cmd web/lint npm run lint
  run_cmd web/unit npm run test

  if db_available; then
    local start
    start="$(date +%s)"
    if npm run db:test:prepare && npm run test:db; then
      record PASS web/db "$start"
    else
      record FAIL web/db "$start"
    fi
  else
    missing_required web/db "DATABASE_TEST_URL must target concord_test and the compose PostgreSQL service must be healthy"
  fi

  run_cmd web/build npm run build

  if infra_available \
      && [ -x rust/target/release/sync-gateway ] \
      && [ -f .agent/scratch/phase-3/e2e-jwks.json ] \
      && [ -f .agent/scratch/phase-3/e2e-key.der ]; then
    run_cmd web/realtime npm run test:realtime
  else
    missing_required web/realtime "requires healthy db+nats+redis, the release gateway, and the local E2E JWKS fixture"
  fi
}

run_native() {
  run_native_compiler gcc g++
  run_native_compiler clang clang++
}

run_rust() {
  if ! command -v cargo >/dev/null 2>&1; then
    missing_required rust/toolchain "cargo is not installed"
    return
  fi

  if infra_available; then
    record PASS rust/prerequisites "$(date +%s)" "PostgreSQL, NATS and Redis are reachable"
  else
    missing_required rust/prerequisites "requires healthy db+nats+redis for integration and distributed suites"
  fi

  run_cmd rust/fmt run_rust_cmd cargo fmt --all --check
  run_cmd rust/clippy run_rust_cmd cargo clippy --all-targets --all-features --quiet -- -D warnings
  run_cmd rust/tests run_rust_cmd cargo test --quiet -- --test-threads=1
}

run_wasm() {
  if ! command -v emcc >/dev/null 2>&1; then
    missing_required wasm/build "emcc is not installed"
    return
  fi
  run_cmd wasm/build-and-smoke bash scripts/verify-wasm.sh
}

run_browser() {
  local reason=""
  if ! command -v npx >/dev/null 2>&1; then
    reason="npx is not installed"
  elif ! infra_available; then
    reason="requires healthy db+nats+redis"
  elif [ -z "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}" ] || [ -z "${CLERK_SECRET_KEY:-}" ]; then
    reason="requires NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY for the documented disposable Clerk test instance"
  elif [ ! -x rust/target/release/sync-gateway ] || [ ! -x build/native/worker/concord-worker ]; then
    reason="requires the release gateway and native worker binaries"
  elif [ ! -f public/crdt-worker.js ]; then
    reason="public/crdt-worker.js is missing; run npm run wasm:build && npm run worker:bundle"
  fi

  if [ -n "$reason" ]; then
    missing_required browser/prerequisites "$reason"
    return
  fi

  run_cmd browser/chromium npm run test:browser
  run_cmd browser/firefox npm run test:browser:smoke:firefox
  run_cmd browser/webkit npm run test:browser:smoke:webkit
}

run_provenance() {
  run_cmd provenance/scan bash scripts/security/provenance-check.sh
  run_cmd provenance/regression bash scripts/security/provenance-tests.sh
  run_cmd provenance/ledger bash scripts/security/validate-findings.sh
}

run_security() {
  run_cmd security/secrets bash scripts/security/secret-scan.sh
  run_cmd security/secrets-history bash scripts/security/secret-scan.sh --history
  run_cmd security/npm-audit npm audit --audit-level=high

  if cargo audit --version >/dev/null 2>&1; then
    run_cmd security/cargo-audit run_rust_cmd cargo audit
  else
    missing_required security/cargo-audit "cargo-audit is not installed"
  fi
  if cargo deny --version >/dev/null 2>&1; then
    run_cmd security/cargo-deny run_rust_cmd cargo deny --workspace check
  else
    missing_required security/cargo-deny "cargo-deny is not installed"
  fi

  if command -v trivy >/dev/null 2>&1 || (command -v docker >/dev/null 2>&1 && docker scout >/dev/null 2>&1); then
    run_cmd security/dependency-scan bash scripts/security/dep-scan.sh
  else
    missing_required security/container-scanner "trivy or docker scout is not installed"
  fi
}

printf 'verify-all: mode=%s steps=[%s]\n\n' "$([ "$STRICT" -eq 1 ] && printf strict || printf developer)" "$STEPS"

if in_steps web; then run_web; fi
if in_steps native; then run_native; fi
if in_steps rust; then run_rust; fi
if in_steps wasm; then run_wasm; fi
if in_steps browser; then run_browser; fi
if in_steps provenance; then run_provenance; fi
if in_steps security; then run_security; fi

printf '\n==================== verify-all summary ====================\n'
printf '%-10s %-28s %-8s %s\n' "STATUS" "GATE" "TIME" "NOTE"
printf '%-10s %-28s %-8s %s\n' "------" "----" "----" "----"
i=0
while [ "$i" -lt "${#SUMMARY_STATUS[@]}" ]; do
  printf '%-10s %-28s %-8s %s\n' \
    "${SUMMARY_STATUS[$i]}" "${SUMMARY_NAME[$i]}" "${SUMMARY_DURATION[$i]}" "${SUMMARY_NOTE[$i]}"
  i=$((i + 1))
done
printf '=============================================================\n'
printf 'PASS: %d\nFAIL: %d\nSKIP: %d\nrequired SKIP: %d\n' "$PASSED" "$FAILED" "$SKIPPED" "$REQUIRED_SKIPPED"

if [ "$FAILED" -gt 0 ] || { [ "$STRICT" -eq 1 ] && [ "$REQUIRED_SKIPPED" -gt 0 ]; }; then
  exit 1
fi
exit 0
