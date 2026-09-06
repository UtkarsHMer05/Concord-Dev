# Native test executable for the Concord CRDT core.

add_executable(concord_crdt_tests
  main.cpp
  test_ids.cpp
  test_doc.cpp
  test_integration.cpp
  test_serialize.cpp
  test_snapshot.cpp
  test_digest.cpp
)

target_compile_features(concord_crdt_tests PRIVATE cxx_std_20)
target_link_libraries(concord_crdt_tests PRIVATE concord::crdt)
target_compile_options(concord_crdt_tests PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(concord_crdt_tests PRIVATE ${CONCORD_SANITIZER_FLAGS})

add_test(NAME concord_crdt_tests COMMAND concord_crdt_tests)
