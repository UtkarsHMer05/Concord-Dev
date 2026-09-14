# Native benchmark executables (P2-M029). Baselines, not claims: fixed
# workloads, multiple runs, median recorded in .agent/METRICS_LEDGER.md.

add_executable(bench_core bench_core.cpp)
target_compile_features(bench_core PRIVATE cxx_std_20)
target_link_libraries(bench_core PRIVATE concord::crdt)
target_compile_options(bench_core PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(bench_core PRIVATE ${CONCORD_SANITIZER_FLAGS})
