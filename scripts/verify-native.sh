#!/bin/bash
# Phase 2 native gate: build + full native test suite (optionally with sanitizers).
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD_TYPE="${1:-Debug}"
cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
      -DCMAKE_OSX_ARCHITECTURES=arm64 -DCONCORD_BUILD_BENCHMARKS=ON
cmake --build build/native
./build/native/crdt/tests/concord_crdt_tests
echo "Native gate PASSED."
