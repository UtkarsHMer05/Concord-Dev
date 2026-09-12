#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Concord full verification orchestrator (release 1.0.0).
#
# Runs every quality gate in one command and prints a PASS/FAIL/SKIP line
# per step (with duration), then exits 1 if any non-SKIP step failed.
# ALL steps run regardless of earlier failures — the summary is the point.
#
# Gates:
#   web        npm run typecheck, lint, test, test:db*, test:realtime*, build
#              (* = SKIP with reason when DATABASE_TEST_URL is unset or the
#               compose db is down)
#   native     scripts/verify-native.sh Release (cmake build + ctest)
#   rust       cargo fmt --check, clippy -D warnings, test
#              (gateway tests needing the DB self-skip when it is down; the
#               runner notes when GATEWAY_DATABASE_URL is unset)
#   wasm       scripts/verify-wasm.sh (SKIP with reason when emcc is absent)
#   provenance scripts/security/provenance-check.sh
#   secrets    scripts/security/secret-scan.sh (working tree)
#
# Usage:
#   bash scripts/verify-all.sh            # everything
#   STEPS="web rust" bash scripts/verify-all.sh   # subset (comma/space list)
#
# Compatibility: bash 3.2+ (macOS), macOS + Linux.
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# Steps selected (default: all, in canonical order).
ALL_STEPS="web native rust wasm provenance secrets"
STEPS="${STEPS:-$ALL_STEPS}"

# Aggregate result bookkeeping.
declare -a SUMMARY_STATUS=()
declare -a SUMMARY_NAME=()
declare -a SUMMARY_DURATION=()
declare -a SUMMARY_NOTE=()
declare -i FAILED=0
declare -i SKIPPED=0

human_duration() {
  # seconds -> "1m23s" / "45.2s"
  local secs="$1"
  if command -v awk >/dev/null 2>&1; then
    awk -v s="$secs" 'BEGIN {
      if (s >= 60) printf "%dm%.0fs", int(s/60), s%60; else printf "%.1fs", s
    }'
  else
    printf '%ss' "$secs"
  fi
}

record() {
  # record <status> <name> <start-epoch> [note]
  local status="$1" name="$2" start="$3" note="${4:-}"
  local dur
  dur="$(human_duration "$(awk -v a="$start" -v b="$(date +%s)" 'BEGIN{print b-a}')")"
  SUMMARY_STATUS+=("$status")
  SUMMARY_NAME+=("$name")
  SUMMARY_DURATION+=("$dur")
  SUMMARY_NOTE+=("$note")
  printf '%s: %s (%s)' "$status" "$name" "$dur"
  [ -n "$note" ] && printf ' — %s' "$note"
  printf '\n'
  if [ "$status" = "FAIL" ]; then
    FAILED=$((FAILED + 1))
  elif [ "$status" = "SKIP" ]; then
    SKIPPED=$((SKIPPED + 1))
  fi
}

in_steps() {
  # in_steps <name> — true when the step was selected via $STEPS
  local want="$1" item
  local IFS=' ,'
  for item in $STEPS; do
    [ "$item" = "$want" ] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# Database availability probe (shared by the DB-dependent gates).
# The vitest db project requires DATABASE_TEST_URL to point at the isolated
# concord_test database (docker compose db on host port 5433); the realtime
# suite spawns the gateway binary against the same stack.
# ---------------------------------------------------------------------------
db_available() {
  if [ -z "${DATABASE_TEST_URL:-}" ]; then
    return 1
  fi
  # Live probe: compose reports the db container healthy?
  if command -v docker >/dev/null 2>&1 && docker compose ps db >/dev/null 2>&1; then
    if docker compose ps --format json db 2>/dev/null \
        | grep -q '"Health":"healthy"\|"State":"running"\|"Status":"running"'; then
      return 0
    fi
    # Older docker versions: fall back to the plain-text table.
    if docker compose ps db 2>/dev/null | grep -q "concord-db.*[Uu]p\|db.*healthy"; then
      return 0
    fi
  fi
  return 1
}

# ---------------------------------------------------------------------------
# web
# ---------------------------------------------------------------------------
run_web() {
  local start; start="$(date +%s)"
  local sub_fail=0

  npm run typecheck || sub_fail=1
  npm run lint      || sub_fail=1
  npm run test      || sub_fail=1

  if db_available; then
    npm run test:db || sub_fail=1
  else
    printf 'SKIP: web/test:db — DATABASE_TEST_URL unset or compose db down (try: docker compose up -d db)\n'
  fi

  if db_available; then
    npm run test:realtime || sub_fail=1
  else
    printf 'SKIP: web/test:realtime — needs the compose db stack + gateway build (DATABASE_TEST_URL unset or compose db down)\n'
  fi

  npm run build || sub_fail=1

  if [ "$sub_fail" -eq 0 ]; then
    record PASS web "$start"
  else
    record FAIL web "$start"
  fi
}

# ---------------------------------------------------------------------------
# native
# ---------------------------------------------------------------------------
run_native() {
  local start; start="$(date +%s)"
  if ./scripts/verify-native.sh Release; then
    record PASS native "$start"
  else
    record FAIL native "$start"
  fi
}

# ---------------------------------------------------------------------------
# rust
# ---------------------------------------------------------------------------
run_rust() {
  local start; start="$(date +%s)"
  local sub_fail=0

  if ! command -v cargo >/dev/null 2>&1; then
    record SKIP rust "$start" "cargo not found (install rustup)"
    return
  fi

  ( cd rust && cargo fmt --check ) || sub_fail=1
  ( cd rust && cargo clippy --all-targets --all-features --quiet -- -D warnings ) || sub_fail=1

  if [ -z "${GATEWAY_DATABASE_URL:-}" ]; then
    printf 'SKIP: rust/gateway DB-integration suites — GATEWAY_DATABASE_URL unset (tests self-skip when the DB is unreachable; unit tests still run)\n'
  fi
  # --test-threads=1 is the DOCUMENTED serial convention (CONTRIBUTING.md,
  # release prompt Q4): the chaos suites docker pause/kill the shared
  # concord-nats/concord-redis containers — a parallel run interleaves
  # those faults across tests and fails on interference, not on defects
  # (verified: the same suite is green serially, red in parallel).
  ( cd rust && cargo test --quiet -- --test-threads=1 ) || sub_fail=1

  if [ "$sub_fail" -eq 0 ]; then
    record PASS rust "$start"
  else
    record FAIL rust "$start"
  fi
}

# ---------------------------------------------------------------------------
# wasm
# ---------------------------------------------------------------------------
run_wasm() {
  local start; start="$(date +%s)"
  if ! command -v emcc >/dev/null 2>&1; then
    record SKIP wasm "$start" "emcc not found (Emscripten not installed — only the WASM build needs it)"
    return
  fi
  if ./scripts/verify-wasm.sh; then
    record PASS wasm "$start"
  else
    record FAIL wasm "$start"
  fi
}

# ---------------------------------------------------------------------------
# provenance
# ---------------------------------------------------------------------------
run_provenance() {
  local start; start="$(date +%s)"
  if ./scripts/security/provenance-check.sh; then
    record PASS provenance "$start"
  else
    record FAIL provenance "$start"
  fi
}

# ---------------------------------------------------------------------------
# secrets (secret-scan takes no args for the working tree; --json/--history
# are optional modes — the default tree scan is the gate)
# ---------------------------------------------------------------------------
run_secrets() {
  local start; start="$(date +%s)"
  if bash scripts/security/secret-scan.sh; then
    record PASS secrets "$start"
  else
    record FAIL secrets "$start"
  fi
}

# ---------------------------------------------------------------------------
# Orchestrate: run every selected step regardless of earlier failures.
# ---------------------------------------------------------------------------
printf 'verify-all: steps [%s]\n\n' "$STEPS"

if in_steps web; then run_web; fi
if in_steps native; then run_native; fi
if in_steps rust; then run_rust; fi
if in_steps wasm; then run_wasm; fi
if in_steps provenance; then run_provenance; fi
if in_steps secrets; then run_secrets; fi

# ---------------------------------------------------------------------------
# Final summary (always printed; exit code follows the failures).
# ---------------------------------------------------------------------------
printf '\n==================== verify-all summary ====================\n'
printf '%-10s %-12s %-8s %s\n' "STATUS" "STEP" "TIME" "NOTE"
printf '%-10s %-12s %-8s %s\n' "------" "----" "----" "----"
i=0
while [ "$i" -lt "${#SUMMARY_STATUS[@]}" ]; do
  printf '%-10s %-12s %-8s %s\n' \
    "${SUMMARY_STATUS[$i]}" "${SUMMARY_NAME[$i]}" "${SUMMARY_DURATION[$i]}" "${SUMMARY_NOTE[$i]}"
  i=$((i + 1))
done
printf '=============================================================\n'
printf 'verify-all: %d failed, %d skipped, %d run\n' "$FAILED" "$SKIPPED" "${#SUMMARY_STATUS[@]}"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
