#!/usr/bin/env bash
# Regression tests for scripts/security/secret-scan.sh.
#
# The scanner must fail closed when an internal command cannot read a tracked
# text file. This test injects an awk failure only for the per-file tree
# formatter; the scanner's aggregate engine remains real. A pre-fix scanner
# swallowed that failure with `|| true` and could report CLEAN.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCANNER="$ROOT/scripts/security/secret-scan.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/concord-secret-tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

REAL_AWK="$(command -v awk)"
mkdir -p "$WORK/bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'last="${!#}"' \
  'if [ -f "$last" ]; then' \
  '  echo "injected awk read failure" >&2' \
  '  exit 73' \
  'fi' \
  'exec "$SECRET_SCAN_TEST_REAL_AWK" "$@"' > "$WORK/bin/awk"
chmod +x "$WORK/bin/awk"

set +e
PATH="$WORK/bin:$PATH" SECRET_SCAN_TEST_REAL_AWK="$REAL_AWK" \
  bash "$SCANNER" > "$WORK/output.log" 2>&1
rc=$?
set -e

if [ "$rc" -ne 2 ]; then
  echo "secret-scan regression: expected internal awk failure to exit 2, got $rc" >&2
  sed -n '1,80p' "$WORK/output.log" >&2
  exit 1
fi
if ! grep -q "failed to read tracked text file" "$WORK/output.log"; then
  echo "secret-scan regression: missing actionable internal-failure message" >&2
  exit 1
fi

echo "secret-scan-tests: PASS (injected tracked-file awk failure exits 2)"
