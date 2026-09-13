#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Concord secret scanner (P6-M024).
#
# Multi-pattern, high-confidence secret scanner over:
#   - the tracked working tree (including examples, docs, CI workflows,
#     and compose files), and
#   - optionally the full git history (--history).
#
# Output discipline (non-negotiable): a finding prints file + line +
# pattern name + a REDACTED value — the first 4 characters and the total
# length of the match, nothing more. The matched value is never printed,
# never written to a log, and never embedded in the JSON output.
#
# Exit status: 0 = clean (only allowlisted/documented findings), 1 = at
# least one non-allowlisted finding, 2 = usage error or an internal scan
# command failure. A scanner that cannot read a tracked file must fail
# closed instead of reporting a clean tree.
#
# Usage:
#   bash scripts/security/secret-scan.sh               # working tree
#   bash scripts/security/secret-scan.sh --history      # tree + git history
#   bash scripts/security/secret-scan.sh --json         # machine-readable array
#   bash scripts/security/secret-scan.sh --json --history
#
# Design notes:
#   - One streaming engine handles both scopes: the tree phase emits
#     (file, line, text, origin) records from tracked files; the history
#     phase emits the same records from `git log -p --all` diff content
#     with line numbers reconstructed from hunk headers (see HISTORY).
#   - Placeholders (replace_me / nobody / nopass) and the documented
#     dev credential concord_local_dev are dropped BEFORE the allowlist
#     (they are non-secrets by construction), so allowlist noise stays
#     reviewable.
#   - The engine is a single awk program (patterns are passed as -v
#     variables from the single shell-side definitions below) — one
#     process for the whole scan, fast enough for the full git history.
#   - The allowlist is per-FILE-per-PATTERN with a written reason for
#     every entry. Nothing is allowlisted wholesale.
#
# PR CI runs the tree scan; the strict local verifier runs both tree and
# history modes. The contract is documented in docs/SECURITY.md §9.1.
# ---------------------------------------------------------------------------
set -euo pipefail
# Byte-locale: the history stream contains non-UTF-8 bytes (binary diffs);
# a UTF-8 locale makes BWK awk abort on multibyte conversion. All patterns
# are ASCII — run the whole scanner in the C locale for byte-exact matching.
export LC_ALL=C

JSON=0
HISTORY=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --history) HISTORY=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (supported: --json, --history)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---------------------------------------------------------------------------
# Patterns (POSIX ERE — single source of truth, passed into the engine).
# ---------------------------------------------------------------------------
#
# Clerk secret keys. Rationale: Clerk documents its key families as
# pk_<env>_... (publishable, safe for the browser) and sk_<env>_...
# (secret, server-only), where <env> is "test" or "live" and the body is
# a long random string. We match ONLY the sk_ family and require at least
# 20 body chars so the documented placeholder (sk_test_replace_me — 10
# body chars, dropped anyway by the placeholder guard) and prose mentions
# cannot match. A real Clerk secret key in a repo is CRITICAL — it can
# mint sessions for the whole application.
CLERK_SECRET_RE='sk_(test|live)_[A-Za-z0-9_-]{20,}'
# Liveblocks secret keys are documented as sk_dev_<body> / sk_prod_<body>
# with a long body; publishable keys are pk_dev_/pk_prod_ (public).
LIVEBLOCKS_RE='sk_(dev|prod)_[A-Za-z0-9_-]{20,}'
# AWS access key IDs: documented fixed format — AKIA + 16 chars of [0-9A-Z].
AWS_AKID_RE='AKIA[0-9A-Z]{16}'
# Private-key PEM header lines (RSA/EC/DSA/OpenSSH/PGP variants).
PEM_RE='-----BEGIN( RSA| EC| DSA| OPENSSH| ENCRYPTED)? PRIVATE KEY( BLOCK)?-----'
# Convex deploy keys: documented convex_<long random> shape.
CONVEX_RE='convex_[A-Za-z0-9_-]{30,}'
# JWTs: three dot-separated base64url segments. A real session JWT in a
# repo is a finding even when expired — it may embed identity claims.
# Minimum segment lengths keep prose/fixture noise out of this pattern.
# PORTABILITY: this pattern is consumed BOTH by grep -E (where \. is a
# literal dot) and by the awk engine via `awk -v` (where BWK awk already
# unescapes \. to . once during -v assignment — making the dot a metachar
# and letting two-segment prose cross-match). The awk-side fix doubles
# the backslash at build time (see run_engine); this definition stays in
# the canonical grep -E form. The repo's two-segment wire fixtures
# ("header-only.test-token") cannot match by construction; they are
# additionally allowlisted as documentation of that intent.
JWT_RE='eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
# A NEXT_PUBLIC_* variable whose name contains SECRET — the Next.js public
# bundle is world-readable by construction; any such assignment is a
# bundle-leak finding regardless of the value's entropy.
NEXT_PUBLIC_SECRET_RE='NEXT_PUBLIC_[A-Z0-9_]*SECRET[A-Z0-9_]*[[:space:]]*='
# postgres:// URLs with an embedded password (scheme://user:pass@...).
# The documented dev credential is dropped by the dev-credential guard;
# the u:p / nobody:nopass unit-test literals are dropped by the
# placeholder guard; any other password-bearing DSN is a finding.
PG_URL_RE='postgres(ql)?://[^:/@[[:space:]]+:[^@[[:space:]"'"'"']{4,}@'

# Non-secret markers: a match containing one of these is a documented
# placeholder, not a credential. `dummy`/`placeholder` cover CI and
# Dockerfile build-time stand-ins (e.g. sk_test_dummy_ci_placeholder in
# phase6-pr-ci.yml / web.Dockerfile — never a real credential; the SAME
# lines carry comments stating dummy intent; real secrets never use
# these words in their value).
PLACEHOLDER_RE='replace_me|nobody|nopass|CHANGEME|<your[._-]|dummy|placeholder'

# ---------------------------------------------------------------------------
# Allowlist — "<path>:<pattern-name>:<reason>".
#   path = repo-relative file path, or a directory prefix ending in "/"
#          (matches every file below it)
#   pat  = CLERK_SECRET | LIVEBLOCKS | AWS_AKID | PEM | CONVEX | JWT |
#          NEXT_PUBLIC_SECRET | PG_URL
# Every entry carries its reason inline. No wholesale file allowlists.
# ---------------------------------------------------------------------------
  ALLOWLIST=(
  ".env.example:PG_URL:env template documents the dev DSN (names, not secrets)"
  "docker-compose.yml:PG_URL:documented loopback dev credential (compose header comment)"
  ".github/workflows/:PG_URL:CI uses the documented dev credential against loopback containers"
  "README.md:PG_URL:documents the dev default DSN"
  "drizzle.config.ts:PG_URL:dev default DSN (localhost)"
  "docs/:PG_URL:documentation references the documented dev DSN"
  "scripts/:PG_URL:dev/CI scripts use the documented dev DSN"
  "rust/sync-gateway/examples/:PG_URL:bench/loadgen examples use the dev test DSN"
  "rust/sync-gateway/src/config.rs:PG_URL:u:p unit-test literal (also dropped by the placeholder guard)"
  "rust/sync-gateway/src/db/pool.rs:PG_URL:u:p URL-parser unit-test literals (also dropped by the placeholder guard)"
  "rust/sync-gateway/tests/:PG_URL:integration fixtures use the documented dev DSN"
  "fixtures/:JWT:protocol golden vectors carry a two-segment header-only token shape, not a credential"
  "rust/sync-gateway/src/protocol/golden.rs:JWT:golden vector emits the two-segment header-only fixture"
  "rust/sync-gateway/src/protocol/tests.rs:JWT:decoder test fixture token (no signature/claims)"
  "rust/sync-gateway/src/auth/:PEM:TEST-ONLY RSA keys compiled in as the local JWKS fixture (unit and integration suites); never a production signing key - production verifies against the live issuer over HTTPS"
  "scripts/security/secret-scan.sh:PG_URL:this scanner documents its own patterns and guards"
  "scripts/security/secret-scan.sh:NEXT_PUBLIC_SECRET:this scanner defines the pattern name NEXT_PUBLIC_SECRET_RE in its own source; it assigns no NEXT_PUBLIC_* variable"
  "scripts/security/sbom.sh:NEXT_PUBLIC_SECRET:the SBOM generator references the pattern name while invoking this scanner; it assigns no NEXT_PUBLIC_* variable"
)

# ---------------------------------------------------------------------------
# Engine (single awk program). Reads (file \037 line \037 text \037 origin)
# records on stdin; appends redacted findings to the file named by argv[1].
#
# Redaction contract: only file, line, origin, pattern name, the first 4
# characters of the match, and the match length are ever written. The
# full match stays in awk memory and dies with the process.
# ---------------------------------------------------------------------------
FINDINGS_FILE="$(mktemp)"; FINDINGS_FILE="${FINDINGS_FILE}.concord-secrets"
: > "$FINDINGS_FILE"
trap 'rm -f "$FINDINGS_FILE"' EXIT

# ---------------------------------------------------------------------------
# Engine invocation. A single awk program (patterns and the allowlist are
# passed in as -v variables from the single shell-side definitions above)
# so one process scans the whole record stream.
# ---------------------------------------------------------------------------
run_engine() { # run_engine <findings-file>  (records arrive on stdin)
  local allow_raw all_re_combined
  # Tab-joined allowlist: a tab never appears in paths/pattern names, and
  # (unlike a newline) it survives `awk -v` assignment on this awk build.
  allow_raw="$(printf '%s\t' "${ALLOWLIST[@]}")"
  # PORTABILITY (BWK awk / macOS): an `awk -v` value is unescape-processed
  # once, so a regex written "\." arrives as "." — a metacharacter. That
  # made the JWT pattern match across "eyJ…Ni9.test-token`…" prose. Fix:
  # double every backslash before assignment so the awk-side regex keeps
  # its literal-dot meaning. Patterns are defined ONCE above in canonical
  # grep -E form; this is the only place the awk form is derived.
  awk_regex() { printf '%s' "$1" | sed 's/\\/\\\\/g'; }
  all_re_combined="${CLERK_SECRET_RE}|${LIVEBLOCKS_RE}|${AWS_AKID_RE}|${PEM_RE}|${CONVEX_RE}|$(awk_regex "$JWT_RE")|${NEXT_PUBLIC_SECRET_RE}|${PG_URL_RE}"
  awk -F'\037' -v OUT="$1" \
      -v re_clerk="$CLERK_SECRET_RE" -v re_lb="$LIVEBLOCKS_RE" \
      -v re_aws="$AWS_AKID_RE" -v re_pem="$PEM_RE" -v re_convex="$CONVEX_RE" \
      -v re_jwt="$(awk_regex "$JWT_RE")" -v re_nps="$NEXT_PUBLIC_SECRET_RE" -v re_pg="$PG_URL_RE" \
      -v re_ph="$PLACEHOLDER_RE" -v re_all="$all_re_combined" -v allow_raw="$allow_raw" '
    BEGIN {
      n = split(allow_raw, A, "\t")
      for (i = 1; i <= n; i++) { split(A[i], p, ":"); apath[i] = p[1]; apat[i] = p[2] }
    }
    function allowed(file, pat,   i) {
      for (i = 1; i <= n; i++)
        if (apat[i] == pat && (apath[i] == file || substr(file, 1, length(apath[i])) == apath[i]))
          return 1
      return 0
    }
    function classify(m) {
      if      (m ~ re_clerk)  return "CLERK_SECRET"
      else if (m ~ re_lb)     return "LIVEBLOCKS"
      else if (m ~ re_aws)    return "AWS_AKID"
      else if (m ~ re_pem)    return "PEM"
      else if (m ~ re_convex) return "CONVEX"
      else if (m ~ re_jwt)    return "JWT"
      else if (m ~ re_nps)    return "NEXT_PUBLIC_SECRET"
      else if (m ~ re_pg)     return "PG_URL"
      return "UNKNOWN"
    }
    function scan_all(file, line, origin, text,   s, m, pat) {
      s = text
      while (match(s, re_all)) {
        m = substr(s, RSTART, RLENGTH)
        s = substr(s, RSTART + RLENGTH)
        if (m ~ re_ph) continue                       # documented placeholder
        if (m ~ /concord_local_dev/) continue          # documented dev DSN credential
        pat = classify(m)
        if (allowed(file, pat)) continue
        printf "%s\t%s\t%s\t%s\t%s\t%d\n", file, line, origin, pat, substr(m, 1, 4), length(m) >> OUT
      }
    }
    { scan_all($1, $2, $4, $3) }
  '
}

# ---------------------------------------------------------------------------
# Phase 1: tracked working tree.
# ---------------------------------------------------------------------------
emit_tree_records() {
  git -C "$REPO_ROOT" ls-files -z |
  while IFS= read -r -d '' f; do
    [[ -f "$REPO_ROOT/$f" ]] || continue
    # Noise-free surface: skip lockfile digests and known binary blobs.
    # (The DER test keys are binary — a PEM text header cannot appear in
    # them; their allowlist entry covers the textual references instead.)
    case "$f" in
      package-lock.json|*.png|*.jpg|*.ico|*.der|*.wasm) continue ;;
    esac
    if grep -Iq . "$REPO_ROOT/$f" 2>/dev/null; then
      if awk -v file="$f" '{ printf "%s\037%d\037%s\037tree\n", file, NR, $0 }' \
          "$REPO_ROOT/$f" 2>/dev/null; then
        :
      else
        rc=$?
        echo "secret-scan: failed to read tracked text file '$f' (awk exit $rc)" >&2
        return 2
      fi
    else
      rc=$?
      # grep -I returns 1 for binary/empty input, which is an expected skip;
      # every other status is an I/O or execution failure and must be fatal.
      if [ "$rc" -gt 1 ]; then
        echo "secret-scan: failed to classify tracked file '$f' (grep exit $rc)" >&2
        return 2
      fi
    fi
  done
}

# ---------------------------------------------------------------------------
# Phase 2 (--history): git history, diff-content-scoped.
#
# Approach (documented for the milestone): `git log -p --all --no-color
# --no-ext-diff --diff-filter=AM` is streamed through an awk state machine
# that tracks the current file (from the `+++ b/<path>` header) and the
# new-file line number (from `@@` hunk headers). Only ADDED (+) diff
# content lines become scan records: a secret deleted from HEAD but
# present anywhere in history was an added line in some ancestor commit,
# so added-line coverage is complete for "did this ever enter git?".
# This is line-scoped over the repository's actual diff volume — bounded
# by history size, not quadratic per-commit file rescans. History
# findings carry origin="history:+" to distinguish them from tree ones.
# ---------------------------------------------------------------------------
emit_history_records() {
  git -C "$REPO_ROOT" log -p --all --no-color --no-ext-diff --diff-filter=AM |
    awk '
      /^diff --git /  { path = ""; next }
      /^\+\+\+ b\//   { path = substr($0, 7); next }
      /^@@/           {
        # New-file start line = the integer after the first "+" in the
        # hunk header ("@@ -a,b +c,d @@"). `line` tracks the NEW file.
        match($0, /\+[0-9]+/)
        line = substr($0, RSTART + 1, RLENGTH - 1) + 0
        next
      }
      path == ""      { next }
      /^---/          { next }   # old-file header
      /^\+/           {          # added content line
        printf "%s\037%d\037%s\037history:+\n", path, line, substr($0, 2)
        line++
        next
      }
      /^-/            { next }   # removed lines: not re-scanned (rationale:
                                # every historical line was once an added
                                # line; added-scan is complete and avoids
                                # double-reporting one logical line)
      { line++ }
    ' | sed $'s/\r$//'
}

# ---------------------------------------------------------------------------
# Run the phases, then report.
# ---------------------------------------------------------------------------
emit_tree_records | run_engine "$FINDINGS_FILE"
if [[ "$HISTORY" == "1" ]]; then
  emit_history_records | run_engine "$FINDINGS_FILE"
fi

# ---------------------------------------------------------------------------
# Report (redacted). FINDINGS_FILE columns (tab-separated):
#   file \t line \t origin \t pattern \t 4-char-prefix \t length
# ---------------------------------------------------------------------------
if [[ "$JSON" == "1" ]]; then
  printf '['
  first=1
  while IFS=$'\t' read -r file lineno origin pat prefix len; do
    [[ -z "$file" ]] && continue
    [[ $first == 1 ]] || printf ','
    first=0
    jfile="$(printf '%s' "$file" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    jorigin="$(printf '%s' "$origin" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    printf '{"file":"%s","line":"%s","source":"%s","pattern":"%s","redacted":"%s...(len=%s)"}' \
      "$jfile" "$lineno" "$jorigin" "$pat" "$prefix" "$len"
  done < "$FINDINGS_FILE"
  printf ']\n'
else
  count=0
  while IFS=$'\t' read -r file lineno origin pat prefix len; do
    [[ -z "$file" ]] && continue
    printf 'FINDING %-18s %s:%s  [%s]  value=%s... (len %s, REDACTED)\n' \
      "$pat" "$file" "$lineno" "$origin" "$prefix" "$len"
    count=$((count + 1))
  done < "$FINDINGS_FILE"
  scope="working tree"
  [[ "$HISTORY" == "1" ]] && scope="working tree + full git history (--all)"
  if [[ $count -eq 0 ]]; then
    printf 'secret-scan: CLEAN — 0 non-allowlisted findings (%s).\n' "$scope"
  else
    printf 'secret-scan: %d non-allowlisted finding(s) (%s). Values are redacted; review and remediate.\n' \
      "$count" "$scope" >&2
  fi
fi

[[ -s "$FINDINGS_FILE" ]] && exit 1
exit 0
