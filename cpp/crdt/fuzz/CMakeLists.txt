# Fuzz targets (P2-M025).
#
# Two driver modes:
# 1. libFuzzer (CONCORD_FUZZ_STANDALONE=OFF): configure with a toolchain that
#    ships the libFuzzer runtime, e.g.
#      cmake -S cpp -B build/fuzz -G Ninja -DCONCORD_BUILD_FUZZ=ON \
#            -DCONCORD_FUZZ_STANDALONE=OFF \
#            -DCMAKE_CXX_COMPILER=<llvm>/bin/clang++ \
#            -DCMAKE_CXX_FLAGS="-fsanitize=fuzzer,address"
# 2. Standalone driver (default): a deterministic seeded mutational loop —
#      ./build/fuzz/crdt/fuzz_op_decode <corpus-file> <runs>
#    (Used on this host: Apple's toolchain lacks the libFuzzer runtime and the
#    Homebrew runtime hangs at startup — documented platform limitation.)
# A bounded smoke session does NOT prove exhaustive security.

option(CONCORD_FUZZ_STANDALONE "Build fuzz targets with the standalone driver" ON)

set(CONCORD_FUZZ_TARGETS fuzz_op_decode fuzz_snapshot_decode fuzz_op_apply)

if(NOT CONCORD_FUZZ_STANDALONE)
  foreach(target ${CONCORD_FUZZ_TARGETS})
    add_executable(${target} ${target}.cpp)
    target_compile_features(${target} PRIVATE cxx_std_20)
    target_link_libraries(${target} PRIVATE concord::crdt)
    target_compile_options(${target} PRIVATE ${CONCORD_WARNING_FLAGS})
    target_link_options(${target} PRIVATE -fsanitize=fuzzer)
  endforeach()
else()
  foreach(target ${CONCORD_FUZZ_TARGETS})
    add_executable(${target} ${target}.cpp standalone_driver.cpp)
    target_compile_features(${target} PRIVATE cxx_std_20)
    target_link_libraries(${target} PRIVATE concord::crdt)
    target_compile_options(${target} PRIVATE ${CONCORD_WARNING_FLAGS})
  endforeach()
endif()
