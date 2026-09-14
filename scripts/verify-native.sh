#!/bin/bash
# Native gate: configure + build + the complete registered CTest suite.
#
# Usage:
#   scripts/verify-native.sh [Debug|Release] [none|asan|ubsan|asan-ubsan|tsan]
#   scripts/verify-native.sh asan-ubsan
#   scripts/verify-native.sh tsan
#
# The sanitizer names are aliases for separate, cache-safe trees. A requested
# sanitizer that the host toolchain cannot link is a failure, never a skip.
# Fresh randomized campaigns remain intentionally separate and can use the
# Release harness produced here:
#   scripts/native/campaign.sh pr
#   scripts/native/campaign.sh extended
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,18p' "$0"
  exit 0
fi

BUILD_TYPE="${1:-Debug}"
SANITIZER="${2:-${CONCORD_SANITIZER:-none}}"

# Permit the concise `verify-native.sh tsan` form while preserving the
# existing `verify-native.sh Release` interface.
case "$BUILD_TYPE" in
  asan|ubsan|asan-ubsan|tsan)
    if [ "$SANITIZER" != "none" ] && [ "$SANITIZER" != "$BUILD_TYPE" ]; then
      echo "verify-native: build type '$BUILD_TYPE' conflicts with sanitizer '$SANITIZER'" >&2
      exit 2
    fi
    SANITIZER="$BUILD_TYPE"
    BUILD_TYPE=Debug
    ;;
esac

SANITIZE_ADDRESS=OFF
SANITIZE_UNDEFINED=OFF
SANITIZE_THREAD=OFF
case "$SANITIZER" in
  none) ;;
  asan) SANITIZE_ADDRESS=ON ;;
  ubsan) SANITIZE_UNDEFINED=ON ;;
  asan-ubsan)
    SANITIZE_ADDRESS=ON
    SANITIZE_UNDEFINED=ON
    ;;
  tsan) SANITIZE_THREAD=ON ;;
  *)
    echo "usage: $0 [Debug|Release] [none|asan|ubsan|asan-ubsan|tsan]" >&2
    exit 2
    ;;
esac

if [ -n "${CONCORD_NATIVE_BUILD_DIR:-}" ]; then
  BUILD_DIR="$CONCORD_NATIVE_BUILD_DIR"
else
  case "$SANITIZER" in
    asan|ubsan|asan-ubsan) BUILD_DIR=build/sanitize ;;
    tsan) BUILD_DIR=build/tsan ;;
    *) BUILD_DIR=build/native ;;
  esac
fi

command -v cmake >/dev/null 2>&1
command -v ninja >/dev/null 2>&1
cmake -S cpp -B "$BUILD_DIR" -G Ninja \
      -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
      -DCONCORD_BUILD_TESTS=ON \
      -DCONCORD_BUILD_BENCHMARKS=ON \
      -DCONCORD_BUILD_FUZZ=OFF \
      -DCONCORD_WARNINGS_AS_ERRORS=ON \
      -DCONCORD_SANITIZE_ADDRESS="$SANITIZE_ADDRESS" \
      -DCONCORD_SANITIZE_UNDEFINED="$SANITIZE_UNDEFINED" \
      -DCONCORD_SANITIZE_THREAD="$SANITIZE_THREAD"
cmake --build "$BUILD_DIR"
ctest --test-dir "$BUILD_DIR" --output-on-failure --no-tests=error --parallel 1

version_output="$($BUILD_DIR/worker/concord-worker --version)"
if [[ "$version_output" == *" ()" ]]; then
  echo "Native worker version is malformed: $version_output" >&2
  exit 1
fi
printf 'Native worker version: %s\n' "$version_output"
echo "Native gate PASSED (sanitizer=$SANITIZER, ctest=$BUILD_DIR)."
