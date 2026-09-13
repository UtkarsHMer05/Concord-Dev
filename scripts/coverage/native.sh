#!/usr/bin/env bash
# C++ coverage diagnostic using GCC's gcov format.  This is deliberately
# separate from the warnings-as-errors release gate and never changes the
# release build flags.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v gcovr >/dev/null 2>&1; then
  echo "native coverage requires gcovr; install it and rerun scripts/coverage/native.sh" >&2
  exit 2
fi

cxx="${CXX:-g++}"
gcov_bin="${GCOV:-}"
if [[ -z "$gcov_bin" ]]; then
  case "$cxx" in
    *clang++*)
      if command -v llvm-cov >/dev/null 2>&1; then
        gcov_bin="llvm-cov gcov"
      else
        echo "native coverage requires llvm-cov for a Clang build; set GCOV or install LLVM" >&2
        exit 2
      fi
      ;;
    *)
      gcc_major="$("$cxx" -dumpfullversion -dumpversion 2>/dev/null | cut -d. -f1 || true)"
      if [[ -n "$gcc_major" ]] && command -v "gcov-$gcc_major" >/dev/null 2>&1; then
        gcov_bin="gcov-$gcc_major"
      elif command -v gcov >/dev/null 2>&1; then
        gcov_bin="gcov"
      else
        echo "native coverage requires gcov matching $cxx; set GCOV or install GCC" >&2
        exit 2
      fi
      ;;
  esac
fi

out_dir="${CONCORD_COVERAGE_DIR:-coverage/native}"
build_dir="$out_dir/build"
mkdir -p "$out_dir"
cmake -S cpp -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_COMPILER="$cxx" \
  -DCMAKE_CXX_FLAGS="--coverage -O0 -g" \
  -DCMAKE_EXE_LINKER_FLAGS="--coverage" \
  -DCONCORD_BUILD_TESTS=ON \
  -DCONCORD_BUILD_FUZZ=OFF
cmake --build "$build_dir"
ctest --test-dir "$build_dir" --output-on-failure --parallel 1
gcovr --gcov-executable "$gcov_bin" --root . --object-directory "$build_dir" \
  --filter '^cpp/(crdt/src|worker)/' \
  --exclude '^cpp/.*/tests/' --exclude '^cpp/.*/fuzz/' \
  --json-summary-pretty --json-summary "$out_dir/summary.json" \
  --txt "$out_dir/summary.txt"
