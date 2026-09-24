// WASM binding layer (P2-M030/M031).
//
// A deliberately narrow C ABI over the C++ engine: opaque handles, explicit
// value copies through the WebAssembly heap, no C++ exceptions crossing the
// boundary, no STL container exposure. See docs/PROTOCOL.md and the memory
// ownership table below (docs/AUTHORIZATION not applicable here).
//
// Memory ownership:
//   - Handles: created by concord_create, owned by JS, freed by
//     concord_destroy.
//   - Input buffers: JS allocates inside the module heap (concord_alloc),
//     writes bytes, calls, then frees (concord_free).
//   - Output buffers: JS allocates a buffer and passes (ptr, cap). A callee
//     returns the required size; if `cap` is insufficient it returns
//     -(required) without writing, so the caller can grow and retry.
//   - Returned buffers are valid only during the call — copy out immediately.
//
// Error model: every call returns >= 0 on success (bytes written / count) or
// a negative ErrorCode value. concord_last_error(handle) returns the message
// pointer for the most recent error (valid until the next call).
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <string>

#include <emscripten.h>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"
#include "concord/crdt/json.hpp"
#include "concord/crdt/serialize.hpp"

using concord::crdt::Doc;

namespace {

constexpr std::int32_t kErrBase = -1000;

// Last generated local operation (serialized). Single-threaded WASM runtime
// with one engine per worker makes this safe; it decouples op generation
// from output-buffer sizing so sizing retries never create extra ops.
std::string g_last_op;

std::int32_t error_code(const concord::crdt::CrdtError& error) {
    return kErrBase - static_cast<std::int32_t>(error.code());
}

struct OutBuffer {
    std::uint8_t* out;
    std::int32_t cap;

    // Sizing probe (out == nullptr): returns the required length as a
    // POSITIVE value. Negative values are reserved for error codes
    // (-1000 - ErrorCode), so large outputs (>= ~900 bytes — i.e. every real
    // document) can never be misread as failures by the caller.
    // Real call (out != nullptr): returns bytes written, or -(required)
    // when the buffer is too small (generating-call recovery convention).
    std::int32_t write(const std::string& bytes) const {
        const auto needed = static_cast<std::int32_t>(bytes.size());
        if (out == nullptr) {
            return needed;
        }
        if (cap < 0 || static_cast<std::size_t>(cap) < bytes.size()) {
            return -needed;
        }
        std::memcpy(out, bytes.data(), bytes.size());
        return needed;
    }
};

}  // namespace

extern "C" {

// ---- Lifecycle -------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE void* concord_create(std::uint64_t replica_id) {
    try {
        return new Doc(concord::crdt::ReplicaId{replica_id});
    } catch (...) {
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE void concord_destroy(void* handle) {
    delete static_cast<Doc*>(handle);
}

// ---- Allocation helpers (input buffers live in the module heap) ------------

EMSCRIPTEN_KEEPALIVE void* concord_alloc(std::size_t bytes) {
    return std::malloc(bytes == 0 ? 1 : bytes);
}

EMSCRIPTEN_KEEPALIVE void concord_free(void* pointer) {
    std::free(pointer);
}

// ---- Local generation ------------------------------------------------------

// Returns bytes written (the serialized operation), or -(required) when the
// output buffer is too small, or a negative error code.
std::int32_t concord_local_insert_text(void* handle, std::int32_t stream_index,
                                       std::uint32_t codepoint, std::uint8_t* out,
                                       std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        const auto op = doc->local_insert_text(static_cast<std::size_t>(stream_index),
                                               static_cast<char32_t>(codepoint));
        g_last_op = concord::crdt::serialize_operation(op);
        return OutBuffer{out, cap}.write(g_last_op);
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

std::int32_t concord_local_insert_delimiter(void* handle, std::int32_t stream_index,
                                            const char* block_type, std::int32_t block_type_len,
                                            std::uint8_t* out, std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        const std::string type(block_type, static_cast<std::size_t>(block_type_len));
        const auto op = doc->local_insert_delimiter(static_cast<std::size_t>(stream_index), type);
        g_last_op = concord::crdt::serialize_operation(op);
        return OutBuffer{out, cap}.write(g_last_op);
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

std::int32_t concord_local_delete(void* handle, std::int32_t stream_index, std::uint8_t* out,
                                  std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        const auto op = doc->local_delete(static_cast<std::size_t>(stream_index));
        if (!op.has_value()) {
            g_last_op.clear();
            return 0;  // idempotent no-op (already tombstoned)
        }
        g_last_op = concord::crdt::serialize_operation(*op);
        return OutBuffer{out, cap}.write(g_last_op);
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

std::int32_t concord_local_set_attr(void* handle, std::int32_t stream_index,
                                    const char* name, std::int32_t name_len,
                                    const char* value, std::int32_t value_len,
                                    std::uint8_t* out, std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        const std::string attr_name(name, static_cast<std::size_t>(name_len));
        const bool has_value = value_len >= 0;
        const std::optional<std::string> attr_value =
            has_value ? std::optional<std::string>(std::string(value, static_cast<std::size_t>(value_len)))
                      : std::nullopt;
        const auto op = doc->local_set_attr(static_cast<std::size_t>(stream_index), attr_name, attr_value);
        g_last_op = concord::crdt::serialize_operation(op);
        return OutBuffer{out, cap}.write(g_last_op);
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

// Retrieves the last generated local operation (side-effect free; may be
// called repeatedly, e.g. after a -(required) size probe).
std::int32_t concord_last_op(void* handle, std::uint8_t* out, std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    (void)doc;
    return OutBuffer{out, cap}.write(g_last_op);
}

// ---- Remote application ----------------------------------------------------

// Returns 1 = applied, 0 = duplicate (idempotent no-op), negative = error.
std::int32_t concord_apply_remote(void* handle, const std::uint8_t* bytes, std::int32_t len) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        const std::string frame(reinterpret_cast<const char*>(bytes), static_cast<std::size_t>(len));
        const auto op = concord::crdt::parse_operation(frame);
        return doc->apply_remote(op) ? 1 : 0;
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

// ---- Derived views ---------------------------------------------------------

EMSCRIPTEN_KEEPALIVE std::int32_t concord_stream_size(void* handle) {
    const auto doc = static_cast<Doc*>(handle);
    return static_cast<std::int32_t>(doc->stream_size());
}

// Writes the canonical visible document as JSON:
// {"blocks":[{"type":"paragraph","attrs":{},"text":"…","marks":{}}]}
// (marks are written per-block-run for compactness is NOT attempted — text
// chars carry marks via per-char runs: "runs":[{"t":"...","m":{"bold":"1"}}]).
std::int32_t concord_visible_json(void* handle, std::uint8_t* out, std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        return OutBuffer{out, cap}.write(concord::crdt::doc_to_json(*doc));
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

std::int32_t concord_digest(void* handle, std::uint8_t* out, std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        return OutBuffer{out, cap}.write(doc->canonical_digest());
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

std::int32_t concord_pending_count(void* handle) {
    const auto doc = static_cast<Doc*>(handle);
    return static_cast<std::int32_t>(doc->pending_count());
}

// ---- Snapshot --------------------------------------------------------------

std::int32_t concord_export_snapshot(void* handle, std::uint8_t* out, std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        return OutBuffer{out, cap}.write(doc->export_snapshot());
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

// Returns 0 on success, negative error code on failure.
std::int32_t concord_import_snapshot(void* handle, const std::uint8_t* bytes, std::int32_t len) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        const std::string data(reinterpret_cast<const char*>(bytes), static_cast<std::size_t>(len));
        // Replace-in-place: import returns a fresh Doc; swap contents via
        // destroy/create is avoided to keep the handle stable — instead the
        // binding API uses import by constructing a new handle (see
        // concord_create_from_snapshot) — this call validates only.
        Doc restored = Doc::import_snapshot(doc->replica(), data);
        (void)restored;
        return 0;
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

// Snapshot restore constructs a NEW handle (ownership stays simple: one
// handle = one engine instance; JS destroys both during restore).
void* concord_create_from_snapshot(std::uint64_t replica_id, const std::uint8_t* bytes,
                                   std::int32_t len) {
    try {
        const std::string data(reinterpret_cast<const char*>(bytes), static_cast<std::size_t>(len));
        return new Doc(Doc::import_snapshot(concord::crdt::ReplicaId{replica_id}, data));
    } catch (...) {
        return nullptr;
    }
}

// Writes the full tombstone-inclusive stream as JSON:
// [{"r":<replica>,"c":<counter>,"k":"text"|"delim","t":false,"s":"...","a":{...}}]
// (t = tombstoned, s = scalar for text items, a = winning attributes). This is
// the mapping surface the TipTap adapter uses to translate editor positions
// into CRDT anchors.
std::int32_t concord_stream_json(void* handle, std::uint8_t* out, std::int32_t cap) {
    const auto doc = static_cast<Doc*>(handle);
    try {
        std::string json = "[";
        const auto entries = doc->stream_entries();
        for (std::size_t i = 0; i < entries.size(); ++i) {
            const auto& entry = entries[i];
            if (i > 0) {
                json += ",";
            }
            json += "{\"r\":" + std::to_string(entry.id.replica.value());
            json += ",\"c\":" + std::to_string(entry.id.counter.value());
            json += ",\"k\":\"" +
                    std::string(entry.kind == concord::crdt::ItemKind::Text ? "text" : "delim") + "\"";
            json += ",\"t\":" + std::string(entry.tombstoned ? "true" : "false");
            std::string scalar;
            if (entry.kind == concord::crdt::ItemKind::Text) {
                concord::crdt::append_utf8(scalar, entry.scalar);
            }
            json += ",\"s\":\"";
            for (const char ch : scalar) {
                if (static_cast<unsigned char>(ch) < 0x20 || ch == '"' || ch == '\\') {
                    char escape[8];
                    std::snprintf(escape, sizeof(escape), "\\u%04x", ch);
                    json += escape;
                } else {
                    json += ch;
                }
            }
            json += "\"";
            json += ",\"a\":{";
            bool first = true;
            for (const auto& [name, value] : entry.attrs) {
                if (!first) {
                    json += ",";
                }
                first = false;
                json += "\"";
                json += name;
                json += "\":\"";
                json += value;
                json += "\"";
            }
            json += "}}";
        }
        json += "]";
        return OutBuffer{out, cap}.write(json);
    } catch (const concord::crdt::CrdtError& error) {
        return error_code(error);
    }
}

// Restores the replica's generator allocation state after log replay
// (counters/lamport are monotonic per replica — see Doc::restore_allocation_state).
EMSCRIPTEN_KEEPALIVE void concord_restore_allocation(void* handle, std::uint64_t next_counter,
                                                     std::uint64_t lamport) {
    auto* doc = static_cast<Doc*>(handle);
    doc->restore_allocation_state(next_counter, lamport);
}

// ---- Diagnostics -----------------------------------------------------------

EMSCRIPTEN_KEEPALIVE std::int64_t concord_next_counter(void* handle) {
    const auto doc = static_cast<Doc*>(handle);
    return static_cast<std::int64_t>(doc->diagnostics().summary.at(doc->replica()));
}

}  // extern "C"
