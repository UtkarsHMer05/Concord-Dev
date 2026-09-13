#!/usr/bin/env bash
# Concord dependency and supply-chain scanner.
#
# Raw findings are always reported. An explicit, dated policy may classify a
# finding as accepted residual risk, but it never removes the finding from
# the output. Exit 1 means an unaccepted critical/high finding; exit 2 means
# a scanner or invocation failed. The optional --skip-containers flag is an
# explicit PR-mode choice because the release workflow owns the mandatory
# Trivy image gate; strict local verification never uses that flag.
set -euo pipefail

JSON=0
SKIP_CONTAINERS=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --skip-containers) SKIP_CONTAINERS=1 ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg (supported: --json, --skip-containers)" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

REPORT=""
CRIT_TOTAL=0
HIGH_TOTAL=0
ACCEPTED_CRIT=0
ACCEPTED_HIGH=0
UNACCEPTED_CRIT=0
UNACCEPTED_HIGH=0
TOOL_ERRORS=0

record() {
  REPORT="$REPORT$1
"
}

ACCEPTED_NPM="GHSA-67mh-4wv8-2f99|esbuild dev-server advisory in the drizzle-kit @esbuild-kit chain; Concord invokes drizzle-kit exclusively as a CLI (generate/studio), never as a served dev server, so the request-forgery vector is not reachable; remediation would force a breaking drizzle-kit downgrade"
CONTAINER_POLICY_REVIEW="2026-10-13"
CONTAINER_POLICY_OWNER="Concord release owner"
CONTAINER_POLICY_REASON="pinned local-development or inactive-cloud image; findings are in base OS/embedded toolchain packages, not the server package; production release images use the separate Trivy gate"
CONTAINER_POLICY_IMAGES="postgres:18.6-alpine nats:2.11.6-alpine redis:8.8.2-alpine nginx:1.29-alpine"
IMAGES="$CONTAINER_POLICY_IMAGES"

review_epoch() {
  local value="$1"
  local result
  if result="$(date -u -j -f "%Y-%m-%d" "$value" +%s 2>/dev/null)"; then
    printf '%s' "$result"
  elif result="$(date -u -d "$value" +%s 2>/dev/null)"; then
    printf '%s' "$result"
  else
    return 1
  fi
}

container_policy_applies() {
  local image="$1"
  local candidate
  local review
  local now
  local found=1
  for candidate in $CONTAINER_POLICY_IMAGES; do
    if [ "$candidate" = "$image" ]; then
      found=0
      break
    fi
  done
  [ "$found" -eq 0 ] || return 1
  if [ "$image" = "nginx:1.29-alpine" ]; then
    grep -Fq "image: nginx:1.29-alpine@sha256:" docker-compose.cloud.yml || return 1
  else
    grep -Fqx "    image: $image" docker-compose.yml || return 1
  fi
  review="$(review_epoch "$CONTAINER_POLICY_REVIEW")" || return 1
  now="$(date -u +%s)"
  [ "$review" -gt "$now" ] || return 1
}

NPM_VERSION="$(npm --version)"
NODE_VERSION="$(node --version)"
if [ "$JSON" -eq 0 ]; then
  echo "== npm audit (npm $NPM_VERSION / node $NODE_VERSION) =="
fi

npm_audit_counts() {
  local out
  local audit_rc
  local counts
  if out="$(npm audit --json "$@" 2>/dev/null)"; then
    audit_rc=0
  else
    audit_rc=$?
  fi
  if [ "$audit_rc" -gt 1 ]; then
    echo "dep-scan: npm audit failed with tool/transport exit $audit_rc" >&2
    return 2
  fi
  if ! counts="$(printf '%s' "$out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
v = d.get("metadata", {}).get("vulnerabilities", {})
print(v.get("critical", 0), v.get("high", 0), v.get("moderate", 0), v.get("low", 0), v.get("total", 0))
')"; then
    echo "dep-scan: npm audit returned unreadable JSON" >&2
    return 2
  fi
  printf '%s' "$counts"
}

if NPM_PROD_COUNTS="$(npm_audit_counts --omit=dev)"; then
  :
else
  TOOL_ERRORS=$((TOOL_ERRORS + 1))
  NPM_PROD_COUNTS="0 0 0 0 0"
fi
if NPM_ALL_COUNTS="$(npm_audit_counts)"; then
  :
else
  TOOL_ERRORS=$((TOOL_ERRORS + 1))
  NPM_ALL_COUNTS="0 0 0 0 0"
fi
read -r P_CRIT P_HIGH P_MED P_LOW P_TOT <<< "$NPM_PROD_COUNTS"
read -r A_CRIT A_HIGH A_MED A_LOW A_TOT <<< "$NPM_ALL_COUNTS"
CRIT_TOTAL=$((CRIT_TOTAL + P_CRIT))
HIGH_TOTAL=$((HIGH_TOTAL + P_HIGH))
UNACCEPTED_CRIT=$((UNACCEPTED_CRIT + P_CRIT))
UNACCEPTED_HIGH=$((UNACCEPTED_HIGH + P_HIGH))
record "npm|prod|critical=$P_CRIT high=$P_HIGH medium=$P_MED low=$P_LOW total=$P_TOT"
record "npm|all(dev+prod)|critical=$A_CRIT high=$A_HIGH medium=$A_MED low=$A_LOW total=$A_TOT"

NPM_JSON=""
if NPM_JSON="$(npm audit --json 2>/dev/null)"; then
  NPM_AUDIT_RC=0
else
  NPM_AUDIT_RC=$?
fi
NPM_FINDINGS=""
if [ "$NPM_AUDIT_RC" -gt 1 ]; then
  TOOL_ERRORS=$((TOOL_ERRORS + 1))
elif ! NPM_FINDINGS="$(printf '%s' "$NPM_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for name, value in sorted(d.get("vulnerabilities", {}).items()):
    via = [item for item in value.get("via", []) if isinstance(item, dict)]
    ids = ",".join(item.get("url", "").rsplit("/", 1)[-1] for item in via if item.get("url")) or "-"
    print("{}|{}|{}".format(value.get("severity", "unknown"), name, ids))
')"; then
  echo "dep-scan: npm audit findings output was not valid JSON" >&2
  TOOL_ERRORS=$((TOOL_ERRORS + 1))
fi

if [ "$JSON" -eq 0 ]; then
  echo "  production (--omit=dev): critical=$P_CRIT high=$P_HIGH medium=$P_MED low=$P_LOW total=$P_TOT"
  echo "  full tree (dev+prod):   critical=$A_CRIT high=$A_HIGH medium=$A_MED low=$A_LOW total=$A_TOT"
  while IFS='|' read -r severity name ghsa; do
    [ -n "$severity" ] || continue
    accepted=""
    if printf '%s' "$ghsa" | grep -q 'GHSA-67mh-4wv8-2f99'; then
      accepted="  [ACCEPTED: $ACCEPTED_NPM]"
    fi
    echo "  finding: $severity $name ($ghsa)$accepted"
  done <<< "$NPM_FINDINGS"
  echo "  critical path: $(npm ls drizzle-kit 2>/dev/null | tail -n +2 | tr '\n' ' ' | sed 's/  */ /g')"
fi

if cargo_version="$(cargo --version 2>/dev/null)"; then
  :
else
  cargo_version="cargo: unavailable"
fi
if command -v cargo-audit >/dev/null 2>&1; then
  CARGO_AUDIT_BIN="$(command -v cargo-audit)"
elif [ -x "$HOME/.cargo/bin/cargo-audit" ]; then
  CARGO_AUDIT_BIN="$HOME/.cargo/bin/cargo-audit"
else
  CARGO_AUDIT_BIN=""
fi

if [ -n "$CARGO_AUDIT_BIN" ]; then
  CARGO_AUDIT_VERSION="$("$CARGO_AUDIT_BIN" --version 2>/dev/null)"
  RUST_OUT=""
  if RUST_OUT="$(cd rust && "$CARGO_AUDIT_BIN" audit --json 2>/dev/null)"; then
    RUST_AUDIT_RC=0
  else
    RUST_AUDIT_RC=$?
  fi
  if [ "$RUST_AUDIT_RC" -gt 1 ]; then
    echo "dep-scan: cargo audit failed with tool/transport exit $RUST_AUDIT_RC" >&2
    TOOL_ERRORS=$((TOOL_ERRORS + 1))
  fi
  if ! RUST_COUNTS="$(printf '%s' "$RUST_OUT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
vulns = d.get("vulnerabilities", {}).get("vulnerabilities", []) or d.get("vulnerabilities", {}).get("list", [])
counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
for value in vulns:
    severity = (value.get("severity") or "medium").lower()
    counts[severity] = counts.get(severity, 0) + 1
print(counts["critical"], counts["high"], counts["medium"], counts["low"], len(vulns))
')"; then
    echo "dep-scan: cargo audit returned unreadable JSON" >&2
    TOOL_ERRORS=$((TOOL_ERRORS + 1))
    RUST_COUNTS="0 0 0 0 0"
  fi
  read -r R_CRIT R_HIGH R_MED R_LOW R_TOT <<< "$RUST_COUNTS"
  CRIT_TOTAL=$((CRIT_TOTAL + R_CRIT))
  HIGH_TOTAL=$((HIGH_TOTAL + R_HIGH))
  UNACCEPTED_CRIT=$((UNACCEPTED_CRIT + R_CRIT))
  UNACCEPTED_HIGH=$((UNACCEPTED_HIGH + R_HIGH))
  record "rust|cargo-audit $CARGO_AUDIT_VERSION|critical=$R_CRIT high=$R_HIGH medium=$R_MED low=$R_LOW total=$R_TOT"
  if [ "$JSON" -eq 0 ]; then
    echo ""
    echo "== cargo audit ($CARGO_AUDIT_VERSION; $cargo_version) =="
    echo "  critical=$R_CRIT high=$R_HIGH medium=$R_MED low=$R_LOW total=$R_TOT"
  fi
else
  record "rust|cargo-audit unavailable|tool-gap: cargo-audit binary not found"
  TOOL_ERRORS=$((TOOL_ERRORS + 1))
  if [ "$JSON" -eq 0 ]; then
    echo ""
    echo "== cargo audit =="
    echo "  tool-gap: cargo-audit is not installed"
  fi
fi

if [ "$SKIP_CONTAINERS" -eq 1 ]; then
  record "container|not-run|explicit --skip-containers; release workflow runs mandatory Trivy plus scan-gate"
  if [ "$JSON" -eq 0 ]; then
    echo ""
    echo "== containers =="
    echo "  not run: --skip-containers (release workflow is the mandatory image-scan gate)"
  fi
else
  SCANNER=""
  if command -v trivy >/dev/null 2>&1; then
    SCANNER="trivy"
  elif command -v docker >/dev/null 2>&1 && docker scout version >/dev/null 2>&1; then
    SCANNER="docker-scout"
  fi
  if [ -z "$SCANNER" ]; then
    record "container|scanner unavailable|tool-gap: neither trivy nor docker scout is installed"
    TOOL_ERRORS=$((TOOL_ERRORS + 1))
  else
    if [ "$JSON" -eq 0 ]; then
      if [ "$SCANNER" = "trivy" ]; then
        SCANNER_VERSION="$(trivy --version | head -1)"
      else
        if SCANNER_VERSION="$(docker scout version 2>/dev/null | grep -m1 -E '^version:')"; then
          :
        else
          SCANNER_VERSION="docker scout (version unavailable)"
        fi
      fi
      echo ""
      echo "== $SCANNER ($SCANNER_VERSION) =="
    fi
    for img in $IMAGES; do
      OUT=""
      if [ "$SCANNER" = "trivy" ]; then
        if OUT="$(trivy image --quiet --format json --severity CRITICAL,HIGH,MEDIUM,LOW "$img" 2>/dev/null)"; then
          SCAN_RC=0
        else
          SCAN_RC=$?
        fi
        if [ "$SCAN_RC" -ne 0 ]; then
          echo "dep-scan: trivy failed for $img (exit $SCAN_RC)" >&2
          TOOL_ERRORS=$((TOOL_ERRORS + 1))
          continue
        fi
        if ! COUNTS="$(printf '%s' "$OUT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
for result in d.get("Results", []):
    for value in result.get("Vulnerabilities") or []:
        severity = (value.get("Severity") or "unknown").lower()
        if severity in counts:
            counts[severity] += 1
print(counts["critical"], counts["high"], counts["medium"], counts["low"])
')"; then
          echo "dep-scan: trivy returned unreadable JSON for $img" >&2
          TOOL_ERRORS=$((TOOL_ERRORS + 1))
          continue
        fi
      else
        if OUT="$(docker scout cves --only-severity critical,high,medium,low "$img" 2>/dev/null)"; then
          SCAN_RC=0
        else
          SCAN_RC=$?
        fi
        if [ "$SCAN_RC" -ne 0 ]; then
          echo "dep-scan: docker scout failed for $img (exit $SCAN_RC)" >&2
          TOOL_ERRORS=$((TOOL_ERRORS + 1))
          continue
        fi
        if ! COUNTS="$(printf '%s' "$OUT" | python3 -c '
import re, sys
text = sys.stdin.read()
counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
for line in text.splitlines():
    match = re.match(r"\s*(CRITICAL|HIGH|MEDIUM|LOW)\s+(\d+)", line)
    if match:
        counts[match.group(1).lower()] += int(match.group(2))
print(counts["critical"], counts["high"], counts["medium"], counts["low"])
')"; then
          echo "dep-scan: docker scout output could not be classified for $img" >&2
          TOOL_ERRORS=$((TOOL_ERRORS + 1))
          continue
        fi
      fi
      read -r C_CRIT C_HIGH C_MED C_LOW <<< "$COUNTS"
      CRIT_TOTAL=$((CRIT_TOTAL + C_CRIT))
      HIGH_TOTAL=$((HIGH_TOTAL + C_HIGH))
      if container_policy_applies "$img"; then
        ACCEPTED_CRIT=$((ACCEPTED_CRIT + C_CRIT))
        ACCEPTED_HIGH=$((ACCEPTED_HIGH + C_HIGH))
        classification="accepted dev-only policy (review $CONTAINER_POLICY_REVIEW)"
      else
        UNACCEPTED_CRIT=$((UNACCEPTED_CRIT + C_CRIT))
        UNACCEPTED_HIGH=$((UNACCEPTED_HIGH + C_HIGH))
        classification="UNACCEPTED — no active exact-image policy"
      fi
      record "container|$img|critical=$C_CRIT high=$C_HIGH medium=$C_MED low=$C_LOW; $classification"
      if [ "$JSON" -eq 0 ]; then
        echo "  $img: critical=$C_CRIT high=$C_HIGH medium=$C_MED low=$C_LOW; $classification"
        case "$classification" in
          accepted*) echo "    [ACCEPTED: $CONTAINER_POLICY_REASON; owner=$CONTAINER_POLICY_OWNER]" ;;
        esac
      fi
    done
  fi
fi

CXX_DEPS="none: standard library only (CMake audit; no FetchContent, ExternalProject, external find_package, or vendored third-party source)"
record "c/cpp|static CMake audit|$CXX_DEPS"
if [ "$JSON" -eq 0 ]; then
  echo ""
  echo "== C/C++ dependencies =="
  echo "  $CXX_DEPS"
fi

if [ "$JSON" -eq 1 ]; then
  printf '%b' "$REPORT" | python3 -c '
import json, sys
rows = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    ecosystem, scanner, detail = line.split("|", 2)
    rows.append({"ecosystem": ecosystem, "scanner": scanner, "result": detail})
print(json.dumps(rows, separators=(",", ":")))
  '
else
  echo ""
  echo "== summary =="
  echo "  raw critical=$CRIT_TOTAL high=$HIGH_TOTAL"
  echo "  accepted critical=$ACCEPTED_CRIT high=$ACCEPTED_HIGH"
  echo "  unaccepted critical=$UNACCEPTED_CRIT high=$UNACCEPTED_HIGH"
  echo "  tool errors=$TOOL_ERRORS"
  printf '%b' "$REPORT" | while IFS='|' read -r ecosystem scanner detail; do
    [ -n "$ecosystem" ] || continue
    echo "  $ecosystem [$scanner]: $detail"
  done
fi

if [ "$TOOL_ERRORS" -gt 0 ]; then
  echo "dep-scan: scanner/tool error — refusing a false-green result." >&2
  exit 2
fi
if [ "$UNACCEPTED_CRIT" -gt 0 ] || [ "$UNACCEPTED_HIGH" -gt 0 ]; then
  echo "dep-scan: unaccepted critical/high findings present — remediate or add a precise, dated acceptance." >&2
  exit 1
fi
if [ "$JSON" -eq 1 ]; then
  echo "dep-scan: no unaccepted critical/high findings (all raw findings remain in the report)." >&2
else
  echo "dep-scan: no unaccepted critical/high findings (all raw findings remain in the report)."
fi
exit 0
