#!/usr/bin/env bash
# Release image-scan verdict (hardening F8): fail on NEW critical/high
# findings except an explicit, dated allowlist entry.
#
# Usage: scan-gate.sh <trivy-json> [<trivy-json>...]
#
# Each allowlist entry must carry: vulnerability id, reason, owner,
# and expiry/review date. A finding is accepted ONLY while its entry's
# review date is in the future. Expired or missing entries fail the gate.
# Findings with no entry at all always fail the gate.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <trivy-json> [<trivy-json>...]" >&2
  exit 2
fi

# Allowlist: VULN_ID|REASON|OWNER|REVIEW-DATE (YYYY-MM-DD)
# Convention: entries are removed when the base image is refreshed or
# the review date passes; the gate then fails until the finding is
# actually resolved.
ALLOWLIST=(
  # None. Historical base-image criticals were resolved by the digest
  # refresh; any NEW finding must be triaged before release.
)

now_epoch() { date -u +%s; }
entry_date() { date -u -j -f "%Y-%m-%d" "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null; }

declare -a new_failures=()
declare -i allowed=0
declare -i checked=0

for report in "$@"; do
  if [ ! -f "$report" ]; then
    echo "scan-gate: missing report $report" >&2
    exit 2
  fi
  # Trivy JSON: Results[].Vulnerabilities[].VulnerabilityID (+ Status)
  while IFS=$'\t' read -r vuln_id status pkg severity; do
    [ -z "${vuln_id:-}" ] && continue
    checked+=1
    matched=""
    for entry in "${ALLOWLIST[@]}"; do
      entry_id="${entry%%|*}"
      rest="${entry#*|}"
      if [ "$entry_id" = "$vuln_id" ]; then
        reason="${rest%%|*}"
        rest2="${rest#*|}"
        owner="${rest2%%|*}"
        review="${rest2##*|}"
        expires=$(entry_date "$review" || echo 0)
        if [ "${expires:-0}" -ge "$(now_epoch)" ]; then
          matched="active"
          echo "scan-gate: ALLOWED $vuln_id ($pkg, $severity) — $reason (owner: $owner, review by $review)"
        else
          matched="expired"
          echo "scan-gate: EXPIRED ALLOWLIST ENTRY $vuln_id (review date $review passed) — failing" >&2
          new_failures+=("$vuln_id ($pkg, $severity) — expired allowlist entry")
        fi
        break
      fi
    done
    if [ -z "$matched" ]; then
      echo "scan-gate: FAIL $vuln_id ($pkg, $severity) — no allowlist entry" >&2
      new_failures+=("$vuln_id ($pkg, $severity)")
    elif [ "$matched" = "active" ]; then
      allowed+=1
    fi
  done < <(jq -r '.Results[]?.Vulnerabilities[]? | [.VulnerabilityID, (.Status // "-"), .PkgName, .Severity] | @tsv' "$report")
done

echo "scan-gate: $checked critical/high findings checked, $allowed allowlisted, ${#new_failures[@]} failing"
if [ "${#new_failures[@]}" -gt 0 ]; then
  exit 1
fi
