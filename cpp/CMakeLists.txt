cmake_minimum_required(VERSION 3.24)

project(concord-crdt
  VERSION 0.1.0
  DESCRIPTION "Concord collaborative document CRDT core"
  LANGUAGES CXX)

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(CONCORD_WARNINGS_AS_ERRORS "Treat compiler warnings as errors (project code)" ON)
option(CONCORD_BUILD_TESTS "Build native test executables" ON)
option(CONCORD_BUILD_FUZZ "Build fuzz targets (requires libFuzzer-compatible tooling)" OFF)
option(CONCORD_BUILD_BENCHMARKS "Build native benchmark executables" OFF)
option(CONCORD_SANITIZE_ADDRESS "Instrument with AddressSanitizer" OFF)
option(CONCORD_SANITIZE_UNDEFINED "Instrument with UndefinedBehaviorSanitizer" OFF)
option(CONCORD_SANITIZE_THREAD "Instrument with ThreadSanitizer" OFF)

# Sanitizer flags apply to all Concord targets (no third-party code exists in
# this tree, so there is no third-party suppression surface).
set(CONCORD_SANITIZER_FLAGS "")
if(CONCORD_SANITIZE_ADDRESS)
  list(APPEND CONCORD_SANITIZER_FLAGS -fsanitize=address -fno-omit-frame-pointer)
endif()
if(CONCORD_SANITIZE_UNDEFINED)
  list(APPEND CONCORD_SANITIZER_FLAGS -fsanitize=undefined -fno-omit-frame-pointer)
endif()
if(CONCORD_SANITIZE_THREAD)
  list(APPEND CONCORD_SANITIZER_FLAGS -fsanitize=thread -fno-omit-frame-pointer)
endif()

add_subdirectory(crdt)
add_subdirectory(worker)
