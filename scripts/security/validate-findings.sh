#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Findings-ledger validator (docs/audits/V1_HARDENING_FINDINGS.md).
#
# The 2026-09-12 ledger shipped with a duplicated ID carrying two
# different severities and two different statuses — the kind of internal
# contradiction that makes an audit ledger unusable as evidence. This
# script fails the build on:
#   - duplicate finding IDs
#   - a status outside {CLOSED, OWNER ACTION, ACCEPTED RESIDUAL RISK, OPEN}
#   - a severity outside {Critical, High, Medium, Low}
#   - an empty cell in any required column of the main findings table
#   - an OPEN repository-actionable Critical/High finding (release verdict
#     requires OWNER ACTION or better for every Critical/High row)
#
# It parses the FIRST markdown table whose header starts with "| ID |".
# Exit: 0 valid, 1 invalid (with per-error messages), 2 ledger missing.
# ---------------------------------------------------------------------------
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEDGER="$ROOT/docs/audits/V1_HARDENING_FINDINGS.md"

[ -f "$LEDGER" ] || { echo "validate-findings: ledger not found: $LEDGER" >&2; exit 2; }

errors=0

# Extract data rows of the main findings table (lines starting with '|'
# after the header row, skipping the separator). The main table's header
# begins "| ID | Severity |".
rows="$(awk '
  /^\| *ID *\|/ { intable=1; next }
  intable && /^\|[- ]+\|/ { inseparator=1; next }
  intable && inseparator && /^\|/ { print; next }
  intable && !/^\|/ { exit }
' "$LEDGER")"

if [ -z "$rows" ]; then
  echo "validate-findings: FAIL — no findings table found (expected header '| ID | Severity | ...')" >&2
  exit 1
fi

row_count="$(printf '%s\n' "$rows" | wc -l | tr -d ' ')"

# 1. Duplicate IDs.
dups="$(printf '%s\n' "$rows" | awk -F'|' '{ gsub(/^ +| +$/, "", $2); print $2 }' | sort | uniq -d)"
if [ -n "$dups" ]; then
  while IFS= read -r d; do
    [ -n "$d" ] && echo "validate-findings: FAIL — duplicate finding ID: $d" >&2
  done <<< "$dups"
  errors=$((errors + 1))
fi

# 2/3/4. Status vocabulary, severity format, required columns.
# Field layout after IFS='|' split: 1 empty, 2 ID, 3 Severity, 4 Domain,
# 5 Title, 6 Discovered, 7 Root cause, 8 Fix, 9 Regression evidence,
# 10 Status, 11 Residual/Owner action.
printf '%s\n' "$rows" | while IFS='|' read -r _ id sev _dom title disc rc fix re status _rest; do
  id="$(printf '%s' "$id" | sed 's/^ *//; s/ *$//')"
  sev="$(printf '%s' "$sev" | sed 's/^ *//; s/ *$//')"
  status="$(printf '%s' "$status" | sed 's/^ *//; s/ *$//')"
  [ -z "$id" ] && { echo "validate-findings: FAIL — empty finding ID in a data row" >&2; exit 1; }
  case "$sev" in
    Critical|High|Medium|Low) ;;
    *) echo "validate-findings: FAIL — $id: invalid severity '$sev'" >&2; exit 1 ;;
  esac
  case "$status" in
    "CLOSED"|"OWNER ACTION"|"ACCEPTED RESIDUAL RISK"|"OPEN") ;;
    *) echo "validate-findings: FAIL — $id: invalid status '$status'" >&2; exit 1 ;;
  esac
  # Required non-empty columns: title, discovered, root cause, fix,
  # regression evidence (fields 5-9 by the split above).
  for col in "$title" "$disc" "$rc" "$fix" "$re"; do
    col="$(printf '%s' "$col" | sed 's/^ *//; s/ *$//')"
    if [ -z "$col" ]; then
      echo "validate-findings: FAIL — $id: required column is empty" >&2
      exit 1
    fi
  done
  # 5. No repository-actionable Critical/High may sit OPEN.
  if { [ "$sev" = Critical ] || [ "$sev" = High ]; } && [ "$status" = OPEN ]; then
    echo "validate-findings: FAIL — $id ($sev) is OPEN: repository-actionable Critical/High findings cannot remain OPEN at a release verdict" >&2
    exit 1
  fi
done || errors=$((errors + 1))

if [ "$errors" -ne 0 ]; then
  exit 1
fi

echo "validate-findings: OK — $row_count findings, unique IDs, valid statuses/severities, no OPEN Critical/High"
exit 0
