# Native test executable for the Concord CRDT core.

add_executable(concord_crdt_tests
  main.cpp
  test_ids.cpp
  test_doc.cpp
  test_integration.cpp
  test_property_sim.cpp
  test_seed_corpus.cpp
  test_fuzz_regressions.cpp
  test_serialize.cpp
  test_snapshot.cpp
  test_digest.cpp
  test_executor.cpp
)

target_compile_features(concord_crdt_tests PRIVATE cxx_std_20)
target_link_libraries(concord_crdt_tests PRIVATE concord::crdt)
target_compile_options(concord_crdt_tests PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(concord_crdt_tests PRIVATE ${CONCORD_SANITIZER_FLAGS})
target_compile_definitions(concord_crdt_tests PRIVATE
  CONCORD_CORPUS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../fuzz/corpus"
)

add_test(NAME concord_crdt_tests COMMAND concord_crdt_tests)
set_tests_properties(concord_crdt_tests PROPERTIES LABELS "core;smoke" TIMEOUT 120)

# P6-M015: randomized convergence campaign runner (one scenario per
# process; machine-readable JSON on the last stdout line). Invoked by
# scripts/native/campaign.sh — not part of the core test binary because a
# campaign is parameterized, long-running, and reported per-seed.
add_executable(property_campaign property_campaign.cpp)
target_compile_features(property_campaign PRIVATE cxx_std_20)
target_link_libraries(property_campaign PRIVATE concord::crdt)
target_compile_options(property_campaign PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(property_campaign PRIVATE ${CONCORD_SANITIZER_FLAGS})

# Default smoke campaign as a ctest entry (tiny: 300 ops, 3 replicas) so
# ctest trees exercise the harness itself; the real matrices run via
# scripts/native/campaign.sh.
add_test(NAME property_campaign_smoke
         COMMAND property_campaign --seed 12345 --replicas 3 --ops 300 --burst 8)
set_tests_properties(property_campaign_smoke PROPERTIES LABELS "core;property;smoke" TIMEOUT 60)

# Golden-vector generator (P2-M032): emits the parity fixture to stdout.
add_executable(golden_gen golden_gen.cpp)
target_compile_features(golden_gen PRIVATE cxx_std_20)
target_link_libraries(golden_gen PRIVATE concord::crdt)
target_compile_options(golden_gen PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(golden_gen PRIVATE ${CONCORD_SANITIZER_FLAGS})
