# WASM build of the Concord CRDT core (P2-M030).
# Configured with Emscripten: emcmake -S wasm -B build/wasm -G Ninja
# The SAME cpp/crdt sources are compiled — no semantic fork between native
# and browser builds (DEC-023, Phase 2 non-negotiable 5).

cmake_minimum_required(VERSION 3.24)
project(concord-crdt-wasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXECUTABLE_SUFFIX ".js")

set(CRDT_SOURCES
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/doc.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/errors.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/serialize.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/snapshot.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/state_vector.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/sha256.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/digest.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/json.cpp
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/src/validation.cpp
)

add_executable(concord-crdt
  ${CRDT_SOURCES}
  src/bindings.cpp
)

target_include_directories(concord-crdt PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../cpp/crdt/include
)

# Browser/worker module; no filesystem; MODULARIZE for clean import;
# exceptions are caught inside the ABI (never cross to JS).
set(EXPORTED_FUNCTIONS
  _concord_create
  _concord_destroy
  _concord_alloc
  _concord_free
  _concord_local_insert_text
  _concord_local_insert_delimiter
  _concord_local_delete
  _concord_local_set_attr
  _concord_last_op
  _concord_apply_remote
  _concord_stream_size
  _concord_visible_json
  _concord_digest
  _concord_pending_count
  _concord_export_snapshot
  _concord_import_snapshot
  _concord_create_from_snapshot
)

list(JOIN EXPORTED_FUNCTIONS "," EXPORTED_FUNCTIONSJoined)

# C++ exceptions must be enabled for every translation unit: the engine uses
# structured throws internally and the binding layer catches them at the ABI
# boundary (they never reach JS).
target_compile_options(concord-crdt PRIVATE -fexceptions)

target_link_options(concord-crdt PRIVATE
  "-sMODULARIZE=1"
  "-sEXPORT_NAME=loadConcordCrdt"
  "-sENVIRONMENT=web,worker"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sNO_FILESYSTEM=1"
  "-sWASM_BIGINT=1"
  "-fexceptions"
  "-sEXPORTED_RUNTIME_METHODS=[HEAPU8]"
  "-sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONSJoined}]"
  "-O2"
)
