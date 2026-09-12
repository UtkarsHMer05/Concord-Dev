#!/usr/bin/env bash
# PROVENANCE gate (hardening G2/G6): no file in the shipped tree may be
# byte-identical to the tutorial baseline (antonio-original-baseline)
# unless it is on the explicit allowlist below with a verified upstream
# license. A changed blob does not prove independence — this gate only
# catches exact retention; the per-file carried-content audit lives in
# docs/PROVENANCE.md (manual, reviewed per file).
#
# The gate is the mechanical floor; the allowlist is the paper trail.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG="antonio-original-baseline"

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
while IFS= read -r path; do
  # Skip the .agent/ private state (never shipped) and lockfiles' churn.
  case "$path" in
    .agent/*|.agents/*|.claude/*) continue ;;
  esac
  if [ ! -f "$path" ]; then continue; fi  # removed since baseline — fine
  checked=$((checked+1))
  base_blob=$(git rev-parse "$TAG:$path" 2>/dev/null || true)
  head_blob=$(git hash-object "$path")
  if [ "$base_blob" = "$head_blob" ]; then
    if allowlisted "$path"; then
      echo "provenance: ALLOWED identical $path (see allowlist)"
    else
      echo "provenance: FAIL $path is byte-identical to the tutorial baseline and not allowlisted" >&2
      failures=$((failures+1))
    fi
  fi
done < <(git ls-tree -r --name-only "$TAG")

# Known baseline binary/static assets must never reappear.
for banned in public/file.svg public/globe.svg public/next.svg public/vercel.svg public/window.svg src/app/favicon.ico; do
  if git ls-files --error-unmatch "$banned" >/dev/null 2>&1; then
    echo "provenance: FAIL banned baseline asset $banned is tracked" >&2
    failures=$((failures+1))
  fi
done

echo "provenance: $checked baseline-overlapping paths checked, $failures unallowlisted identical files"
[ "$failures" -eq 0 ]
