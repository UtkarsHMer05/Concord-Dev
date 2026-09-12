# Concord native snapshot/recovery worker (P5-M014).
#
# A standalone, dependency-free executable that wraps the CRDT core for
# server-side reconstruction/verification: replay canonical op streams into
# a reserved-replica Doc, export/import snapshots, and compute canonical
# digests — all over a length-prefixed binary protocol on stdin/stdout
# (process-per-request; the Rust wrapper owns document identity and I/O).

add_executable(concord-worker
  main.cpp
)

target_compile_features(concord-worker PRIVATE cxx_std_20)
target_link_libraries(concord-worker PRIVATE concord::crdt)
target_compile_options(concord-worker PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(concord-worker PRIVATE ${CONCORD_SANITIZER_FLAGS})

# Release identity (cpp/CMakeLists.txt project VERSION == 1.0.0): threaded
# to the binary as a compile definition so `--version` reports it without a
# second hardcoded copy. CONCORD_GIT_SHA is optional — unset in clean
# tarball builds, where main.cpp prints the plain version.
target_compile_definitions(concord-worker PRIVATE
  CONCORD_VERSION="${CONCORD_VERSION}"
)
if(DEFINED CONCORD_GIT_SHA)
  target_compile_definitions(concord-worker PRIVATE CONCORD_GIT_SHA="${CONCORD_GIT_SHA}")
endif()

if(CONCORD_BUILD_TESTS)
  add_subdirectory(tests)
endif()
