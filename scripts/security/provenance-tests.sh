#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Regression tests for scripts/security/provenance-check.sh (SA-PROV1).
#
# The provenance gate previously FAILED OPEN: a missing baseline tag made
# `git ls-tree` feed an empty process-substitution loop, the scan checked 0
# paths, and the script exited 0 (CI green). These tests pin the fail-closed
# contract from every side:
#
#   1. valid tag, real overlapping files, none identical      -> PASS (0)
#   2. valid tag, allowlisted identical file retained          -> PASS (0)
#   3. valid tag, unallowlisted identical file                 -> FAIL (1)
#   4. valid tag, banned baseline asset tracked                -> FAIL (1)
#   5. missing tag                                              -> FAIL (2)
#   6. invalid tag name                                         -> FAIL (2)
#   7. valid tag object that enumerates zero files              -> FAIL (2)
#   8. scan checks a nonzero path count (anti-zero-path pin)    -> asserted
#   9. internal git/hash-object failure                         -> FAIL (2)
#
# Each case runs the REAL scanner script against a synthetic throwaway git
# repository (created per case under a temp dir) so the tests cannot be
# polluted by, or pollute, the real working tree. The scanner's own
# allowlist (shadcn/ui paths) is exercised verbatim in case 2 — the
# synthetic repo uses exactly those paths.
#
# Usage: bash scripts/security/provenance-tests.sh
# Exit:  0 all cases behaved as pinned; 1 any case regressed.
# ---------------------------------------------------------------------------
set -uo pipefail

REAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="$REAL_ROOT/scripts/security/provenance-check.sh"
REAL_GIT="$(command -v git)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/concord-prov-tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass_n=0
fail_n=0

expect() {
  # expect <label> <wanted_exit> <actual_exit>
  local label="$1" want="$2" got="$3"
  if [ "$want" -eq "$got" ]; then
    printf '  ok    %-58s exit=%s\n' "$label" "$got"
    pass_n=$((pass_n + 1))
  else
    printf '  FAIL  %-58s exit=%s (wanted %s)\n' "$label" "$got" "$want"
    fail_n=$((fail_n + 1))
  fi
}

# Creates a synthetic repo whose BASELINE commit has:
#   keep/derived.txt   (changed in HEAD — must be checked and pass)
#   gone/removed.txt   (removed in HEAD — skipped as not-present)
# and whose HEAD commit adds the interesting file for the case at hand.
# The REAL scanner is copied to scripts/security/ inside the synthetic repo
# so its script-relative `cd ../..` resolves to the synthetic repo root —
# exactly the production invocation shape (CI runs it from its checkout).
make_repo() {
  local repo="$1"; shift
  mkdir -p "$repo/keep" "$repo/gone" "$repo/.agent" "$repo/scripts/security"
  printf 'baseline keep content\n' > "$repo/keep/derived.txt"
  printf 'baseline removed content\n' > "$repo/gone/removed.txt"
  printf 'private\n' > "$repo/.agent/state.log"
  # Real-allowlist path seeded in the baseline (shadcn shape); HEAD retains
  # it byte-identically — case 2 exercises the allowlist branch.
  mkdir -p "$repo/src/lib"
  printf 'shared cn() helper\n' > "$repo/src/lib/utils.ts"
  git -C "$repo" init -q -b main
  git -C "$repo" -c user.name=t -c user.email=t@t add -A
  git -C "$repo" -c user.name=t -c user.email=t commit -qm baseline
  git -C "$repo" tag baseline-tag
  # HEAD: change the overlapping file, remove the other, keep .agent private,
  # and add the scanner itself (HEAD-only: the baseline predates it).
  printf 'independently authored keep content\n' > "$repo/keep/derived.txt"
  cp "$SCANNER" "$repo/scripts/security/provenance-check.sh"
  rm -rf "$repo/gone"
  git -C "$repo" -c user.name=t -c user.email=t add -A
  git -C "$repo" -c user.name=t -c user.email=t commit -qm head
}

echo "provenance regression tests (scanner: $SCANNER)"

# --- Case 1: valid tag, real overlap, no identical files -> PASS -----------
R="$WORK/case1"; make_repo "$R"
mkdir -p "$R/src"; printf 'new file\n' > "$R/src/new.ts"
git -C "$R" add -A; git -C "$R" -c user.name=t -c user.email=t commit -qm add
( cd "$R" && bash scripts/security/provenance-check.sh baseline-tag >"$WORK/case1.log" 2>&1 ); expect "1 valid tag + changed overlap -> PASS" 0 $?
grep -q "baseline-overlapping paths checked" "$WORK/case1.log" \
  && grep -Eq "checked \(?[1-9]" "$WORK/case1.log" \
  && { printf '  ok    %-58s\n' "1a nonzero checked-count reported"; pass_n=$((pass_n+1)); } \
  || { printf '  FAIL  %-58s\n' "1a nonzero checked-count reported"; fail_n=$((fail_n+1)); }

# --- Case 2: allowlisted identical file retained -> PASS -------------------
# Uses the scanner's REAL allowlist path src/lib/utils.ts, re-creating the
# baseline blob exactly so it is byte-identical at HEAD.
R="$WORK/case2"; make_repo "$R"
# make_repo leaves src/lib/utils.ts byte-identical to the baseline — the
# scanner must hit the allowlist branch for it and PASS.
git -C "$R" -c user.name=t -c user.email=t commit -q --allow-empty -m allowlist
( cd "$R" && bash scripts/security/provenance-check.sh baseline-tag >"$WORK/case2.log" 2>&1 ); expect "2 allowlisted identical file -> PASS" 0 $?
grep -q "ALLOWED identical src/lib/utils.ts" "$WORK/case2.log" \
  && { printf '  ok    %-58s\n' "2a allowlist entry actually exercised"; pass_n=$((pass_n+1)); } \
  || { printf '  FAIL  %-58s\n' "2a allowlist entry actually exercised"; fail_n=$((fail_n+1)); }

# --- Case 3: unallowlisted identical file -> FAIL(1) ------------------------
R="$WORK/case3"; make_repo "$R"
baseline_blob="$(git -C "$R" rev-parse baseline-tag:keep/derived.txt)"
git -C "$R" cat-file blob "$baseline_blob" > "$R/keep/derived.txt"
git -C "$R" add -A; git -C "$R" -c user.name=t -c user.email=t commit -qm revert-to-baseline
( cd "$R" && bash scripts/security/provenance-check.sh baseline-tag >"$WORK/case3.log" 2>&1 ); expect "3 unallowlisted identical file -> FAIL(1)" 1 $?

# --- Case 4: banned baseline asset tracked -> FAIL(1) ------------------------
R="$WORK/case4"; make_repo "$R"
mkdir -p "$R/public"; printf 'svg' > "$R/public/vercel.svg"
git -C "$R" add -A; git -C "$R" -c user.name=t -c user.email=t commit -qm banned
( cd "$R" && bash scripts/security/provenance-check.sh baseline-tag >"$WORK/case4.log" 2>&1 ); expect "4 banned baseline asset -> FAIL(1)" 1 $?

# --- Case 5: missing tag -> FAIL(2) ------------------------------------------
R="$WORK/case5"; make_repo "$R"
( cd "$R" && bash scripts/security/provenance-check.sh missing-tag >"$WORK/case5.log" 2>&1 ); expect "5 missing tag -> FAIL(2) fail-closed" 2 $?
grep -q "does not resolve to a commit" "$WORK/case5.log" \
  && { printf '  ok    %-58s\n' "5a actionable error message"; pass_n=$((pass_n+1)); } \
  || { printf '  FAIL  %-58s\n' "5a actionable error message"; fail_n=$((fail_n+1)); }

# --- Case 6: invalid tag name -> FAIL(2) --------------------------------------
R="$WORK/case6"; make_repo "$R"
( cd "$R" && bash scripts/security/provenance-check.sh 'invalid..tag^' >"$WORK/case6.log" 2>&1 ); expect "6 invalid tag name -> FAIL(2)" 2 $?

# --- Case 7: zero-file baseline -> FAIL(2) ------------------------------------
R="$WORK/case7"
mkdir -p "$R/scripts/security"
cp "$SCANNER" "$R/scripts/security/provenance-check.sh"
git -C "$R" init -q -b main
printf 'readme\n' > "$R/README.md"
git -C "$R" -c user.name=t -c user.email=t add README.md
git -C "$R" -c user.name=t -c user.email=t commit -qm only-readme
git -C "$R" tag baseline-tag
# Make the baseline tag point at a commit with an EMPTY tree: create an
# orphan commit with no files.
empty_tree="$(git hash-object -t tree /dev/null)"
orphan="$(git -C "$R" commit-tree "$empty_tree" -m empty)"
git -C "$R" tag -f baseline-tag "$orphan" >/dev/null
( cd "$R" && bash scripts/security/provenance-check.sh baseline-tag >"$WORK/case7.log" 2>&1 ); expect "7 zero-file baseline -> FAIL(2) refuse zero scan" 2 $?

# --- Case 8 (guard against CI regressions): run the REAL scanner against the
# REAL repo now that the tag exists — must pass and check > 0 paths.
if git -C "$REAL_ROOT" rev-parse --verify --quiet "refs/tags/antonio-original-baseline^{commit}" >/dev/null 2>&1; then
  ( cd "$REAL_ROOT" && bash "$SCANNER" >"$WORK/case8.log" 2>&1 ); expect "8 real repo scan with real tag -> PASS" 0 $?
  if grep -Eq "[1-9][0-9]* baseline-overlapping paths checked" "$WORK/case8.log"; then
    printf '  ok    %-58s\n' "8a real scan checked nonzero paths"; pass_n=$((pass_n+1))
  else
    printf '  FAIL  %-58s %s\n' "8a real scan checked nonzero paths" "$(cat "$WORK/case8.log")"; fail_n=$((fail_n+1))
  fi
else
  printf '  SKIP  %-58s\n' "8 real repo scan (tag absent — push creates it)"
fi

# --- Case 9: scanner-internal git failure -> FAIL(2) ------------------------
# The scanner must not turn a failed hash-object invocation into a clean
# provenance result. The wrapper delegates every other git operation to the
# real binary, preserving the production invocation shape.
R="$WORK/case9"; make_repo "$R"
mkdir -p "$R/bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'for arg in "$@"; do' \
  '  [ "$arg" = "hash-object" ] && exit 73' \
  'done' \
  'exec "$PROVENANCE_TEST_REAL_GIT" "$@"' > "$R/bin/git"
chmod +x "$R/bin/git"
( cd "$R" && PATH="$R/bin:$PATH" PROVENANCE_TEST_REAL_GIT="$REAL_GIT" \
    bash scripts/security/provenance-check.sh baseline-tag >"$WORK/case9.log" 2>&1 ); expect "9 internal git failure -> FAIL(2)" 2 $?
grep -q "internal failure: git hash-object failed" "$WORK/case9.log" \
  && { printf '  ok    %-58s\n' "9a actionable internal-failure message"; pass_n=$((pass_n+1)); } \
  || { printf '  FAIL  %-58s\n' "9a actionable internal-failure message"; fail_n=$((fail_n+1)); }

echo
printf 'provenance-tests: %d passed, %d failed\n' "$pass_n" "$fail_n"
[ "$fail_n" -eq 0 ]
