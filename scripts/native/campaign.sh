#!/bin/bash
# P6-M015: randomized convergence campaign runner.
#
# Tiers:
#   (default) PR subset — 30 fixed seeds at {replicas:5, ops:2000} through
#              the release-build campaign harness. Bounded (~2-3 min in
#              Release). Reproducible: same seed ⇒ same result.
#   extended  — 100 fixed seeds at {replicas:10, ops:10000} for nightly /
#              manual deep runs.
#
# Usage:
#   scripts/native/campaign.sh [extended]
#
# Requires: build/native configured Release (scripts/verify-native.sh Release
# or the cmake invocation it uses). Each run prints the harness's
# machine-readable JSON line; the script prints a summary line at the end.
set -euo pipefail
cd "$(dirname "$0")/../.."

HARNESS="./build/native/crdt/tests/property_campaign"
if [ ! -x "$HARNESS" ]; then
  echo "campaign.sh: harness not found at $HARNESS" >&2
  echo "  configure + build first: scripts/verify-native.sh Release" >&2
  exit 2
fi

TIER="${1:-pr}"
case "$TIER" in
  pr)
    SEEDS=$(seq 1 30)
    REPLICAS=5
    OPS=2000
    BURST=16
    ;;
  extended)
    SEEDS=$(seq 1 100)
    REPLICAS=10
    OPS=10000
    BURST=32
    ;;
  *)
    echo "usage: $0 [pr|extended]" >&2
    exit 2
    ;;
esac

PASS=0
FAIL=0
FAILED_SEEDS=()
START=$(date +%s)

for SEED in $SEEDS; do
  # shellcheck disable=SC2086
  if OUT=$(./build/native/crdt/tests/property_campaign \
      --seed "$SEED" --replicas "$REPLICAS" --ops "$OPS" --burst "$BURST" 2>&1); then
    PASS=$((PASS + 1))
    # Print the JSON result line (last line of stdout) per seed for CI logs.
    echo "$OUT" | grep '^{' || true
  else
    FAIL=$((FAIL + 1))
    FAILED_SEEDS+=("$SEED")
    echo "$OUT" >&2  # divergence trace + op script + JSON, for minimization
    echo "CAMPAIGN FAILED seed=$SEED (rerun: $HARNESS --seed $SEED --replicas $REPLICAS --ops $OPS --burst $BURST)" >&2
  fi
done

END=$(date +%s)
ELAPSED=$((END - START))
echo "campaign tier=$TIER: $PASS passed, $FAIL failed (${ELAPSED}s; replicas=$REPLICAS ops=$OPS burst=$BURST)"

if [ "$FAIL" -gt 0 ]; then
  echo "failing seeds: ${FAILED_SEEDS[*]}" >&2
  exit 1
fi
