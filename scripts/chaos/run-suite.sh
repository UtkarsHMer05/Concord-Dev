#!/usr/bin/env bash
# Concord chaos-suite runner (P6-M028, contract: .agent/scratch/phase-6/
# chaos-framework-contract.md "Runner").
#
# Usage: scripts/chaos/run-suite.sh <suite|all>
#   suite ∈ { chaos_gateway, chaos_broker, chaos_redis, chaos_postgres,
#             chaos_worker, chaos_compound }
#
# Boots the infra deps (docker compose up -d db nats redis), builds the
# release gateway binary (the suites exec it), then runs each requested
# Rust suite SERIALIZED with --test-threads=1 under the release profile
# (realistic timing), with CHAOS_OUT_DIR pointed at a timestamped
# per-suite run dir. Scenario JSONs land there; aggregation into
# chaos-summary.json is done by the suites themselves on process exit
# (the Rust aggregate() helper reads the same dir).
#
# Exit code: 0 iff passed == attempted - skipped for every suite that
# ran (skips are allowed — deps down; failures never are).
#
# Nightly wiring happens in M045 (SA-CI6) — this script is the
# local/CI-invocable entry point.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
RUST_DIR="$ROOT/rust"

SUITES_ALL=(chaos_gateway chaos_broker chaos_redis chaos_postgres chaos_worker chaos_compound)

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <suite|all>" >&2
  exit 2
fi
if [[ "$1" == "all" ]]; then
  SUITES=("${SUITES_ALL[@]}")
else
  SUITES=("$1")
fi

RUN_ID="$(date +%Y%m%d-%H%M%S)-chaos"
BASE_OUT="$ROOT/.agent/bench/runs/$RUN_ID"
mkdir -p "$BASE_OUT"

echo "== chaos run $RUN_ID =="
echo "== out dir: $BASE_OUT =="

# ---------------------------------------------------------------------------
# 1. Boot infra deps (idempotent; healthy already-running containers are
#    left alone by `up -d`).
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  echo "== docker compose up -d db nats redis =="
  docker compose up -d db nats redis || {
    echo "FATAL: docker compose up failed (docker down?)" >&2
    exit 1
  }
else
  echo "WARNING: docker CLI missing — assuming deps are already up" >&2
fi

# ---------------------------------------------------------------------------
# 2. Build the release gateway binary + test binaries (release profile
#    for realistic timing per the mission brief).
# ---------------------------------------------------------------------------
echo "== cargo build --release (gateway + chaos suites) =="
(cd "$RUST_DIR" && cargo build --release -p sync-gateway --bin sync-gateway) || {
  echo "FATAL: gateway release build failed" >&2
  exit 1
}
# Compile the suites first so a compile error is a clean failure, not a
# per-suite cargo test error. (Also a warm compile: `cargo test --release`
# below links the same artifacts.)
(cd "$RUST_DIR" && cargo test --release -p sync-gateway \
    --test chaos_gateway --test chaos_broker --test chaos_redis \
    --test chaos_postgres --test chaos_worker --test chaos_compound \
    --no-run) || {
  echo "FATAL: chaos suite compile failed" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 3. Run each suite serialized; per-suite CHAOS_OUT_DIR; the suite's own
#    final aggregate() writes chaos-summary.json in that dir.
# ---------------------------------------------------------------------------
FAILED_SUITES=()
for suite in "${SUITES[@]}"; do
  OUT="$BASE_OUT/$suite"
  mkdir -p "$OUT"
  echo ""
  echo "== suite $suite =="
  if (cd "$RUST_DIR" && CHAOS_OUT_DIR="$OUT" \
      cargo test --release -p sync-gateway --test "$suite" -- --test-threads=1 \
      --nocapture 2>&1 | tee "$OUT/test-output.log"); then
    echo "== suite $suite: cargo exit ok =="
  else
    # cargo test exits nonzero on any failing test OR compile error; both
    # are failures. Distinguish via the summary + log tail for the report.
    echo "== suite $suite: cargo exit NONZERO ==" >&2
    FAILED_SUITES+=("$suite")
  fi

  # Aggregate (the suite also aggregates itself at the end of its final
  # test — this is the runner-side backstop for skipped/crashed suites
  # written in jq; jq is optional, the Rust path already wrote the file).
  if command -v jq >/dev/null 2>&1 && compgen -G "$OUT/*.json" >/dev/null; then
    jq -s '
      {attempted: length,
       passed: ([.[] | select(.observedResult | startswith("PASS"))] | length),
       failed: ([.[] | select(.observedResult | startswith("FAIL"))] | length),
       skipped: ([.[] | select(.observedResult | startswith("SKIP"))] | length),
       lostDurableAckedOps: ([.[] | (.lostDurableAckedOps // 0)] | add // 0),
       divergentReplicas: ([.[] | (.divergentReplicas // 0)] | add // 0)}' \
      "$OUT"/[C]*.json > "$OUT/chaos-summary.json" 2>/dev/null || true
  fi

  if [[ -f "$OUT/chaos-summary.json" ]]; then
    echo "-- $suite summary:"
    cat "$OUT/chaos-summary.json"
  else
    echo "-- $suite: NO scenario records written (deps down before any test?)" >&2
    printf '{\n  "attempted": 0,\n  "passed": 0,\n  "failed": 0,\n  "skipped": 0,\n  "lostDurableAckedOps": 0,\n  "divergentReplicas": 0\n}\n' \
      > "$OUT/chaos-summary.json"
  fi
done

# ---------------------------------------------------------------------------
# 4. Campaign-level aggregation across every per-suite summary.
# ---------------------------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  jq -s '
    {attempted: ([.[].attempted] | add // 0),
     passed: ([.[].passed] | add // 0),
     failed: ([.[].failed] | add // 0),
     skipped: ([.[].skipped] | add // 0),
     lostDurableAckedOps: ([.[].lostDurableAckedOps] | add // 0),
     divergentReplicas: ([.[].divergentReplicas] | add // 0)}' \
    "$BASE_OUT"/*/chaos-summary.json > "$BASE_OUT/chaos-summary.json" 2>/dev/null || true
  echo ""
  echo "== campaign summary ($BASE_OUT/chaos-summary.json) =="
  cat "$BASE_OUT/chaos-summary.json" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 5. Verdict: passed == attempted - skipped for every suite that ran.
#    (Cargo's own exit already flagged hard failures; this is the
#    contract's arithmetic gate over the recorded ledger.)
# ---------------------------------------------------------------------------
VERDICT=0
for suite in "${SUITES[@]}"; do
  S="$BASE_OUT/$suite/chaos-summary.json"
  if command -v jq >/dev/null 2>&1 && [[ -f "$S" ]]; then
    A=$(jq -r '.attempted' "$S")
    P=$(jq -r '.passed' "$S")
    K=$(jq -r '.skipped' "$S")
    F=$(jq -r '.failed' "$S")
    L=$(jq -r '.lostDurableAckedOps' "$S")
    D=$(jq -r '.divergentReplicas' "$S")
    if (( P != A - K )); then
      echo "VERDICT: $suite FAILED the gate (passed=$P, attempted-skipped=$((A-K)), failed=$F)" >&2
      VERDICT=1
    fi
    if (( F > 0 || L > 0 || D > 0 )); then
      echo "VERDICT: $suite has failed=$F lostDurableAckedOps=$L divergentReplicas=$D" >&2
      VERDICT=1
    fi
  fi
done
for s in "${FAILED_SUITES[@]:-}"; do
  [[ -n "$s" ]] && { echo "VERDICT: cargo nonzero exit for $s" >&2; VERDICT=1; }
done

if (( VERDICT == 0 )); then
  echo "VERDICT: all requested suites PASS the chaos gate"
else
  echo "VERDICT: chaos gate FAILED" >&2
fi
exit $VERDICT
