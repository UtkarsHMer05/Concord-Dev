# Native tests for the concord-worker protocol (P5-M014).
#
# The tests drive the real worker binary end-to-end: they build request
# frames, run the executable with the frame on stdin (capturing stdout,
# stderr, exit code), and assert on response bytes. Ops are constructed
# through the core's public API exactly like cpp/crdt/tests, serialized with
# serialize_batch — the same bytes the gateway stores in Postgres
# crdt_operations.payload (one op per row; each row's payload is a
# single-op batch frame, rust repo.rs ingest/catchup_page).

add_executable(concord_worker_tests worker_test.cpp)

target_compile_features(concord_worker_tests PRIVATE cxx_std_20)
target_include_directories(concord_worker_tests PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../../crdt/tests
)
target_link_libraries(concord_worker_tests PRIVATE concord::crdt)
target_compile_options(concord_worker_tests PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(concord_worker_tests PRIVATE ${CONCORD_SANITIZER_FLAGS})

# Tests run the worker binary by absolute path (generator expression), so
# the suite works from any working directory and under ctest.
target_compile_definitions(concord_worker_tests PRIVATE
  CONCORD_WORKER_TEST_BIN="$<TARGET_FILE:concord-worker>"
)

add_test(NAME concord_worker_tests COMMAND concord_worker_tests)
set_tests_properties(concord_worker_tests PROPERTIES LABELS "worker;smoke" TIMEOUT 120)
