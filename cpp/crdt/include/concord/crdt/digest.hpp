// SHA-256 digest support (FIPS 180-4) for canonical CRDT state hashes.
#pragma once

#include <array>
#include <cstdint>
#include <string>

namespace concord::crypto {

[[nodiscard]] std::array<std::uint8_t, 32> sha256(const std::string& message);
[[nodiscard]] std::string to_hex(const std::array<std::uint8_t, 32>& digest);

}  // namespace concord::crypto
