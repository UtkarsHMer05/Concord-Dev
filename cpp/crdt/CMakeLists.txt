# Concord CRDT core library + native test/bench/fuzz targets.

add_library(concord_crdt STATIC
  src/doc.cpp
  src/validation.cpp
  src/serialize.cpp
  src/snapshot.cpp
  src/state_vector.cpp
  src/sha256.cpp
  src/digest.cpp
  src/json.cpp
  src/errors.cpp
  src/executor.cpp
)

add_library(concord::crdt ALIAS concord_crdt)

target_compile_features(concord_crdt PUBLIC cxx_std_20)
target_include_directories(concord_crdt
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

set(CONCORD_WARNING_FLAGS
  -Wall
  -Wextra
  -Wpedantic
  -Wshadow
  -Wnon-virtual-dtor
  -Wcast-align
  -Wunused
  -Woverloaded-virtual
  -Wconversion
  -Wsign-conversion
  -Wdouble-promotion
  -Wold-style-cast
)

if(CONCORD_WARNINGS_AS_ERRORS)
  list(APPEND CONCORD_WARNING_FLAGS -Werror)
endif()

target_compile_options(concord_crdt PRIVATE ${CONCORD_WARNING_FLAGS} ${CONCORD_SANITIZER_FLAGS})
target_link_options(concord_crdt INTERFACE ${CONCORD_SANITIZER_FLAGS})

if(CONCORD_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)
endif()

if(CONCORD_BUILD_FUZZ)
  add_subdirectory(fuzz)
endif()

if(CONCORD_BUILD_BENCHMARKS)
  add_subdirectory(benchmarks)
endif()
