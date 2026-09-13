#!/usr/bin/env bash
# PROVENANCE gate (hardening G2/G6): no file in the shipped tree may be
# byte-identical to the tutorial baseline (antonio-original-baseline)
# unless it is on the explicit allowlist below with a verified upstream
# license. A changed blob does not prove independence — this gate only
# catches exact retention; the per-file carried-content audit lives in
# docs/PROVENANCE.md (manual, reviewed per file).
#
# The gate is the mechanical floor; the allowlist is the paper trail.
#
# FAIL-CLOSED CONTRACT (remediation of the false-green SA-PROV1):
#   exit 0 — scan ran, checked > 0 baseline-overlapping paths, no findings
#   exit 1 — findings (unallowlisted byte-identical file / banned asset)
#   exit 2 — the gate could NOT run honestly and therefore fails:
#            missing/invalid baseline tag, baseline tree enumerated zero
#            files, or an internal git failure during the scan. A scan
#            that checks nothing MUST NEVER pass.
#
# Usage: provenance-check.sh [baseline-tag]   (default antonio-original-baseline)
# Regression tests: scripts/security/provenance-tests.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

TAG="${1:-antonio-original-baseline}"

fail_gate() {
  # fail_gate <message> — the gate itself is broken; exit 2 (fail closed).
  echo "provenance: FAIL (gate) $1" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# A. The baseline must resolve to a real commit BEFORE anything is scanned.
#    This is the fix for the false-green: previously a missing tag made the
#    file enumeration feed an empty loop and the script exited 0.
# ---------------------------------------------------------------------------
if ! BASELINE_COMMIT="$(git rev-parse --verify --quiet "refs/tags/${TAG}^{commit}" 2>/dev/null)"; then
  fail_gate "baseline tag '${TAG}' does not resolve to a commit. Fetch tags (git fetch origin --tags) or create the tag; refusing to scan zero paths."
fi
[ -n "$BASELINE_COMMIT" ] || fail_gate "baseline tag '${TAG}' resolved to an empty commit id"

# ---------------------------------------------------------------------------
# B/D. Enumerate the baseline tree into an explicit temp file (never process
#      substitution): an enumeration failure is observable here, not an
#      empty-but-successful scan.
# ---------------------------------------------------------------------------
BASELINE_FILES="$(mktemp "${TMPDIR:-/tmp}/concord-provenance.XXXXXX")" \
  || fail_gate "cannot create temp file"
trap 'rm -f "$BASELINE_FILES"' EXIT
if ! git ls-tree -r --name-only "$BASELINE_COMMIT" > "$BASELINE_FILES" 2>/dev/null; then
  fail_gate "git ls-tree failed while enumerating baseline ${TAG} (${BASELINE_COMMIT})"
fi
BASELINE_TOTAL="$(wc -l < "$BASELINE_FILES" | tr -d ' ')"
if [ "$BASELINE_TOTAL" -eq 0 ]; then
  fail_gate "baseline ${TAG} (${BASELINE_COMMIT}) enumerated 0 files — a real baseline cannot be empty; refusing the zero-path scan"
fi

# Allowlist: path | upstream source | license | verified
# - shadcn/ui new-york registry output, verified byte-identical (up to
#   the CLI import-alias rewrite) against ui.shadcn.com registry JSON
#   on 2026-09-12. Upstream MIT. NOTICE carries the attribution.
ALLOWLIST=(
  "src/components/ui/alert-dialog.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/button.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/carousel.tsx|shadcn/ui new-york (import-alias rewrite only)|MIT|2026-09-12"
  "src/components/ui/dialog.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/dropdown-menu.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/input.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/menubar.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/separator.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/sonner.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/components/ui/table.tsx|shadcn/ui new-york|MIT|2026-09-12"
  "src/lib/utils.ts|shadcn/ui cn() helper|MIT|2026-09-12"
)

allowlisted() {
  local path="$1"
  for entry in "${ALLOWLIST[@]}"; do
    [ "${entry%%|*}" = "$path" ] && return 0
  done
  return 1
}

failures=0
checked=0

# Compare every tracked file that exists in BOTH the baseline and HEAD.
# Reads from the validated enumeration file — never a subshell feed.
while IFS= read -r path || [ -n "$path" ]; do
  # Skip the .agent/ private state (never shipped) and lockfiles' churn.
  case "$path" in
    .agent/*|.agents/*|.claude/*) continue ;;
  esac
  if [ ! -f "$path" ]; then continue; fi  # removed since baseline — fine
  checked=$((checked+1))
  base_blob="$(git rev-parse --quiet "$BASELINE_COMMIT:$path")" \
    || fail_gate "internal failure: git rev-parse could not resolve baseline blob for '$path'"
  head_blob="$(git hash-object "$path")" \
    || fail_gate "internal failure: git hash-object failed for '$path'"
  if [ "$base_blob" = "$head_blob" ]; then
    if allowlisted "$path"; then
      echo "provenance: ALLOWED identical $path (see allowlist)"
    else
      echo "provenance: FAIL $path is byte-identical to the tutorial baseline and not allowlisted" >&2
      failures=$((failures+1))
    fi
  fi
done < "$BASELINE_FILES"

# Known baseline binary/static assets must never reappear.
for banned in public/file.svg public/globe.svg public/next.svg public/vercel.svg public/window.svg src/app/favicon.ico; do
  if git ls-files --error-unmatch "$banned" >/dev/null 2>&1; then
    echo "provenance: FAIL banned baseline asset $banned is tracked" >&2
    failures=$((failures+1))
  fi
done

# C. Zero overlapping paths is only possible if HEAD shares nothing with the
#    baseline — for this repository that is impossible and must fail closed.
if [ "$checked" -eq 0 ]; then
  fail_gate "0 baseline-overlapping paths checked (baseline ${TAG} has $BASELINE_TOTAL files) — refusing the zero-path pass"
fi

echo "provenance: $checked baseline-overlapping paths checked ($BASELINE_TOTAL baseline files), $failures unallowlisted identical files"
[ "$failures" -eq 0 ]
