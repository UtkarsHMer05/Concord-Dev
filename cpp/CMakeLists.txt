cmake_minimum_required(VERSION 3.24)

project(concord-crdt
  VERSION 1.0.0
  DESCRIPTION "Concord collaborative document CRDT core"
  LANGUAGES CXX)

# Release identity (1.0.0) mirrors package.json "version" and the Rust
# workspace package version (rust/Cargo.toml). The FRAME protocol version is
# a separate wire contract (see cpp/crdt protocol headers) and does NOT track
# this number. Exported as CONCORD_VERSION so targets (e.g. the worker's
# --version mode) can report it without hardcoding a second copy.
if(NOT DEFINED CONCORD_VERSION)
  string(TOLOWER "${PROJECT_VERSION}" CONCORD_VERSION)
endif()

# Optional short git sha for build metadata. Policy (SA-NATV1 fix):
# the sha is build metadata ONLY — a build from a source archive or
# other gitless tree must print the plain version ("concord-worker
# 1.0.0"), never a malformed "1.0.0 ()". An empty CONCORD_GIT_SHA
# therefore means "no sha": only a NON-EMPTY value is embedded in
# targets. Override with -DCONCORD_GIT_SHA=<sha> for release packaging;
# an explicitly empty -DCONCORD_GIT_SHA= forces the plain version.
if(NOT DEFINED CONCORD_GIT_SHA)
  set(CONCORD_GIT_SHA "")
  find_package(Git QUIET)
  if(Git_FOUND)
    execute_process(
      COMMAND ${GIT_EXECUTABLE} rev-parse --short HEAD
      WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
      OUTPUT_VARIABLE _concord_git_sha_raw
      OUTPUT_STRIP_TRAILING_WHITESPACE
      ERROR_QUIET
      RESULT_VARIABLE _git_result
    )
    if(_git_result EQUAL 0 AND NOT _concord_git_sha_raw STREQUAL "")
      set(CONCORD_GIT_SHA "${_concord_git_sha_raw}")
    endif()
  endif()
endif()

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(CONCORD_WARNINGS_AS_ERRORS "Treat compiler warnings as errors (project code)" ON)
option(CONCORD_BUILD_TESTS "Build native test executables" ON)
option(CONCORD_BUILD_FUZZ "Build fuzz targets (requires libFuzzer-compatible tooling)" OFF)
option(CONCORD_BUILD_BENCHMARKS "Build native benchmark executables" OFF)
option(CONCORD_SANITIZE_ADDRESS "Instrument with AddressSanitizer" OFF)
option(CONCORD_SANITIZE_UNDEFINED "Instrument with UndefinedBehaviorSanitizer" OFF)
option(CONCORD_SANITIZE_THREAD "Instrument with ThreadSanitizer" OFF)

if(CONCORD_BUILD_TESTS)
  enable_testing()
endif()

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
