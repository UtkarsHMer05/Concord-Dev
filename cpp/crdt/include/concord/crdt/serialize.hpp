// Canonical wire serialization for operations and batches (docs/PROTOCOL.md
// §7). Versioned, explicit little-endian, length-prefixed strings — no host
// endianness or native memory-layout dependence.
#pragma once

#include <string>
#include <vector>

#include "concord/crdt/op.hpp"

namespace concord::crdt {

constexpr std::uint8_t kProtocolVersion = 1;

// Encodes one operation. Throws CrdtError(OpTooLarge) if the encoding
// exceeds the per-operation size limit.
[[nodiscard]] std::string serialize_operation(const Operation& op);

// Strictly decodes one operation: the frame must be consumed exactly.
// Throws CrdtError(MalformedFrame / UnsupportedVersion / ...) on bad input.
[[nodiscard]] Operation parse_operation(const std::string& bytes);

// Batch = u32 operation count, then operations back to back. Empty batches
// are legal; counts above kMaxBatchSize are rejected (resource bound).
constexpr std::uint32_t kMaxBatchSize = 1'000'000;

[[nodiscard]] std::string serialize_batch(const std::vector<Operation>& ops);
[[nodiscard]] std::vector<Operation> parse_batch(const std::string& bytes);

// UTF-8 validation (rejects surrogates, overlongs, > U+10FFFF).
[[nodiscard]] bool is_valid_utf8(const std::string& bytes);

}  // namespace concord::crdt
