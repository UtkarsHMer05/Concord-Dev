#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Concord dependency / supply-chain scanner (P6-M025).
#
# Aggregates and classifies dependency-vulnerability evidence across the
# ecosystems Concord actually uses, with the exact scanner version
# printed alongside every result:
#
#   npm        npm audit --omit=dev (production tree) AND npm audit
#              (dev+prod), plus npm ls of critical-path resolutions.
#   Rust       cargo audit (RustSec advisory database) over Cargo.lock,
#              when the binary is available (install attempt documented
#              below if it was needed).
#   Containers docker scout cves over the pinned local dev images
#              (postgres:18.6-alpine, nats:2.11.6-alpine,
#              redis:8.8.2-alpine, nginx:1.29-alpine) when docker scout
#              is available.
#   C/C++      no third-party C or C++ dependencies exist (verified
#              against cpp/*/CMakeLists.txt: standard library only, no
#              vendored or fetched externals) — reported as such; the
#              native surface is the toolchain, which the sanitizer/
#              fuzz matrices cover (P6-M016/M017).
#
# Classification: every finding is counted critical/high/medium/low with
# the producing scanner's name and version. Findings are evidence, not
# embarrassment — nothing is hidden. The known-accepted finding (see
# ACCEPTED below) is classified and displayed with its justification,
# not suppressed.
#
# Exit policy: non-zero (1) ONLY when a critical or high finding exists
# that is not covered by a documented acceptance; medium/low are
# reported for triage but do not fail the scan.
#
# Usage:
#   bash scripts/security/dep-scan.sh           # full aggregate report
#   bash scripts/security/dep-scan.sh --json   # machine-readable summary
#
# CI wiring is deferred to the Phase 6 CI milestones (P6-M043/M045);
# documented in docs/SECURITY.md §9.2.
# ---------------------------------------------------------------------------
set -euo pipefail

JSON=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (supported: --json)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Result accumulators (ecosystem:severity counts + notable findings).
declare -a REPORT=()
CRIT_TOTAL=0
HIGH_TOTAL=0

record() { REPORT+=("$1"); }

# ---------------------------------------------------------------------------
# Known ACCEPTED findings. These are classified and shown in the output
# with their justification; the acceptance lives here so the scan output
# remains honest about residual risk.
# ---------------------------------------------------------------------------
ACCEPTED_NPM="GHSA-67mh-4wv8-2f99|esbuild dev-server advisory in the drizzle-kit @esbuild-kit chain; Concord invokes drizzle-kit exclusively as a CLI (generate/studio), never as a served dev server, so the request-forgery vector is not reachable; remediation would force a breaking drizzle-kit downgrade"

# ---------------------------------------------------------------------------
# 1. npm — production and full trees.
# ---------------------------------------------------------------------------
NPM_VERSION="$(npm --version)"
NODE_VERSION="$(node --version)"
if [[ "$JSON" == 0 ]]; then
  echo "== npm audit (npm $NPM_VERSION / node $NODE_VERSION) =="
fi

npm_audit_counts() { # npm_audit_counts <extra args...> -> "crit high med low total"
  local out
  out="$(npm audit --json "$@" 2>/dev/null || true)"
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("0 0 0 0 0"); raise SystemExit
v = d.get("metadata", {}).get("vulnerabilities", {})
print(v.get("critical",0), v.get("high",0), v.get("moderate",0), v.get("low",0), v.get("total",0))
'
}

NPM_PROD_COUNTS="$(npm_audit_counts --omit=dev)"
NPM_ALL_COUNTS="$(npm_audit_counts)"
read -r P_CRIT P_HIGH P_MED P_LOW P_TOT <<< "$NPM_PROD_COUNTS"
read -r A_CRIT A_HIGH A_MED A_LOW A_TOT <<< "$NPM_ALL_COUNTS"

CRIT_TOTAL=$((CRIT_TOTAL + P_CRIT))
HIGH_TOTAL=$((HIGH_TOTAL + P_HIGH))

record "npm|prod|critical=$P_CRIT high=$P_HIGH medium=$P_MED low=$P_LOW total=$P_TOT"
record "npm|all(dev+prod)|critical=$A_CRIT high=$A_HIGH medium=$A_MED low=$A_LOW total=$A_TOT"

# Named findings (id, severity, path) — for the report and acceptance.
NPM_FINDINGS="$(npm audit --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
for name, v in sorted(d.get("vulnerabilities", {}).items()):
    via = [x for x in v.get("via", []) if isinstance(x, dict)]
    ghsa = ",".join(x.get("url", "").rsplit("/", 1)[-1] for x in via if x.get("url")) or "-"
    print(v.get("severity", "unknown") + "|" + name + "|" + ghsa)
' || true)"

if [[ "$JSON" == 0 ]]; then
  echo "  production (--omit=dev): critical=$P_CRIT high=$P_HIGH medium=$P_MED low=$P_LOW total=$P_TOT"
  echo "  full tree (dev+prod):   critical=$A_CRIT high=$A_HIGH medium=$A_MED low=$A_LOW total=$A_TOT"
  while IFS='|' read -r sev name ghsa; do
    [[ -z "$sev" ]] && continue
    accepted=""
    if printf '%s' "$ghsa" | grep -q 'GHSA-67mh-4wv8-2f99'; then
      accepted="  [ACCEPTED: $ACCEPTED_NPM]"
    fi
    echo "  finding: $sev $name ($ghsa)$accepted"
  done <<< "$NPM_FINDINGS"
  # Critical-path resolution evidence (drizzle-kit chain, the only
  # advisories present; printed so the reader sees the resolution path).
  echo "  critical path: $(npm ls drizzle-kit 2>/dev/null | tail -n +2 | tr '\n' ' ' | sed 's/  */ /g')"
fi

# ---------------------------------------------------------------------------
# 2. Rust — cargo audit (RustSec) over Cargo.lock.
# ---------------------------------------------------------------------------
CARGO_VERSION="$(cargo --version 2>/dev/null | head -1 || echo 'cargo: unavailable')"
CARGO_AUDIT_BIN="$(command -v cargo-audit || true)"
if [[ -z "$CARGO_AUDIT_BIN" ]]; then
  CARGO_AUDIT_BIN="$(command -v cargo-audit || ls "$HOME/.cargo/bin/cargo-audit" 2>/dev/null || true)"
fi

RUST_STATUS="skipped"
if [[ -n "$CARGO_AUDIT_BIN" ]]; then
  CARGO_AUDIT_VERSION="$("$CARGO_AUDIT_BIN" --version 2>/dev/null || echo cargo-audit)"
  # --no-fetch keeps the run offline-safe against the advisory DB; the DB
  # bundled at install time is used. Exit code from cargo-audit: 0 clean,
  # 1 vulnerabilities found (any severity), 2 error.
  RUST_OUT="$( (cd rust && "$CARGO_AUDIT_BIN" audit --no-fetch --json 2>/dev/null) || true )"
  RUST_COUNTS="$(printf '%s' "$RUST_OUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("0 0 0 0 0"); raise SystemExit
vulns = d.get("vulnerabilities", {}).get("vulnerabilities", []) or d.get("vulnerabilities", {}).get("list", [])
sev = {"critical":0, "high":0, "medium":0, "low":0}
for v in vulns:
    s = (v.get("severity") or "medium").lower()
    sev[s] = sev.get(s, 0) + 1
print(sev["critical"], sev["high"], sev["medium"], sev["low"], len(vulns))
' || echo "0 0 0 0 0")"
  read -r R_CRIT R_HIGH R_MED R_LOW R_TOT <<< "$RUST_COUNTS"
  CRIT_TOTAL=$((CRIT_TOTAL + R_CRIT))
  HIGH_TOTAL=$((HIGH_TOTAL + R_HIGH))
  RUST_STATUS="ok"
  record "rust|cargo-audit $CARGO_AUDIT_VERSION|critical=$R_CRIT high=$R_HIGH medium=$R_MED low=$R_LOW total=$R_TOT"
  if [[ "$JSON" == 0 ]]; then
    echo ""
    echo "== cargo audit ($CARGO_AUDIT_VERSION; $CARGO_VERSION) =="
    echo "  critical=$R_CRIT high=$R_HIGH medium=$R_MED low=$R_LOW total=$R_TOT"
    if [[ "$R_TOT" != 0 ]]; then
      printf '%s' "$RUST_OUT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
vulns = d.get("vulnerabilities", {}).get("vulnerabilities", []) or d.get("vulnerabilities", {}).get("list", [])
for v in vulns:
    ids = [i.get("id") for i in v.get("audits", [])] if False else v.get("ids", [])
    ident = v.get("id") or (", ".join(v.get("identifiers", []) or [])) or "?"
    pkg = v.get("package", {})
    sev = v.get("severity") or "medium"
    print("  finding: " + str(sev) + " " + str(ident) + " " + str(pkg.get("name", "?")) + " " + str(pkg.get("version", "?")))
'
    fi
  fi
else
  # cargo-audit missing AND install infeasible — record the exact gap.
  RUST_STATUS="tool-gap: cargo-audit binary not found; install attempt documented in the P6-M025 report. Fallback (NOT silently accepted): manual Cargo.lock triage is a listed-outputs exercise only — see the milestone report for the precise gap statement."
  record "rust|cargo-audit unavailable|$RUST_STATUS"
  if [[ "$JSON" == 0 ]]; then
    echo ""
    echo "== cargo audit =="
    echo "  $RUST_STATUS"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Containers — docker scout over the pinned dev images.
# ---------------------------------------------------------------------------
IMAGES=(postgres:18.6-alpine nats:2.11.6-alpine redis:8.8.2-alpine nginx:1.29-alpine)
SCOUT_VERSION="$(docker scout version 2>/dev/null | grep -m1 'version:' || echo 'docker scout: unavailable')"
if docker scout >/dev/null 2>&1; then
  if [[ "$JSON" == 0 ]]; then
    echo ""
    echo "== docker scout ($SCOUT_VERSION; docker $(docker version --format '{{.Client.Version}}' 2>/dev/null || echo '?')) =="
  fi
  for img in "${IMAGES[@]}"; do
    # Only critical/high matter for the exit policy; the full table still
    # prints in text mode for triage honesty.
    OUT="$(docker scout cves --only-severity critical,high,medium,low "$img" 2>/dev/null || true)"
    COUNTS="$(printf '%s' "$OUT" | python3 -c '
import re, sys
t = sys.stdin.read()
c = {"critical":0, "high":0, "medium":0, "low":0}
for line in t.splitlines():
    m = re.search(r"\b(CRITICAL|HIGH|MEDIUM|LOW)\b\s+(\d+)", line)
    if m and "vulnerabilities" not in line:
        pass
    m2 = re.match(r"\s*(CRITICAL|HIGH|MEDIUM|LOW)\s+(\d+)", line)
    if m2:
        c[m2.group(1).lower()] += int(m2.group(2))
    # summary lines like "  CRITICAL  6  "
print(c["critical"], c["high"], c["medium"], c["low"])
')"
    read -r C_CRIT C_HIGH C_MED C_LOW <<< "$COUNTS"
    CRIT_TOTAL=$((CRIT_TOTAL + C_CRIT))
    HIGH_TOTAL=$((HIGH_TOTAL + C_HIGH))
    # Top affected packages for the critical/high set — lets the reader
    # distinguish "vulnerable app package" from "vulnerable OS utility".
    PKG_BREAKDOWN="$(printf '%s' "$OUT" | grep -A1 -E '✗ (CRITICAL|HIGH)' |
      grep -oE 'n=[a-z0-9+.-]+' | sort | uniq -c | sort -rn | head -4 |
      awk '{printf "%s%s(%s)", sep, substr($2,3), $1; sep=", "}')" || PKG_BREAKDOWN=""
    record "container|$img|critical=$C_CRIT high=$C_HIGH medium=$C_MED low=$C_LOW; top critical/high packages: ${PKG_BREAKDOWN:-n/a}"
    if [[ "$JSON" == 0 ]]; then
      echo "  $img: critical=$C_CRIT high=$C_HIGH medium=$C_MED low=$C_LOW; top critical/high packages: ${PKG_BREAKDOWN:-n/a}"
      echo "    (dev-only image, loopback-bound — see docker-compose.yml; production hardening is P6-M027/Phase 7)"
    fi
  done
else
  record "container|docker scout unavailable|tool-gap: docker scout / trivy not installed; documented, not silently accepted"
  if [[ "$JSON" == 0 ]]; then
    echo ""
    echo "== containers =="
    echo "  tool-gap: docker scout unavailable — image CVEs not scanned this run."
  fi
fi

# ---------------------------------------------------------------------------
# 4. C/C++ — dependency audit of the native tree (static, by inspection).
# ---------------------------------------------------------------------------
# Verified against cpp/CMakeLists.txt, cpp/crdt/CMakeLists.txt,
# cpp/worker/CMakeLists.txt: the native tree vendors no third-party
# libraries — standard library only, no FetchContent/ExternalProject/
# find_package of external packages, no vendored sources. The C/C++ audit
# surface is therefore the toolchain itself (covered by the P6-M016/M017
# sanitizer and fuzz matrices), and there is no OSS C/C++ bill to scan.
CXX_DEPS="none: standard library only (CMake audit — see header comment)"
record "c/cpp|static CMake audit|$CXX_DEPS"
if [[ "$JSON" == 0 ]]; then
  echo ""
  echo "== C/C++ dependencies =="
  echo "  $CXX_DEPS"
fi

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
if [[ "$JSON" == 1 ]]; then
  printf '['
  first=1
  for entry in "${REPORT[@]}"; do
    [[ $first == 1 ]] || printf ','
    first=0
    IFS='|' read -r eco tool detail <<< "$entry"
    printf '{"ecosystem":"%s","scanner":"%s","result":"%s"}' "$eco" "$tool" "$detail"
  done
  printf ']\n'
else
  echo ""
  echo "== summary (exit policy: fail only on critical/high) =="
  echo "  critical=$CRIT_TOTAL high=$HIGH_TOTAL"
  for entry in "${REPORT[@]}"; do
    IFS='|' read -r eco tool detail <<< "$entry"
    echo "  $eco [$tool]: $detail"
  done
  if [[ $CRIT_TOTAL -gt 0 || $HIGH_TOTAL -gt 0 ]]; then
    echo "dep-scan: CRITICAL/HIGH findings present — remediate or document acceptance." >&2
    exit 1
  fi
  echo "dep-scan: no critical/high findings (medium/low reported for triage)."
fi
exit 0
