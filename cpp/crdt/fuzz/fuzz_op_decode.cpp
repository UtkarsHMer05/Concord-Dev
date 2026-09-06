// Fuzz target: serialized operation decoder (P2-M025).
// Contract: any byte string either parses or throws a structured CrdtError —
// never a crash, never undefined behavior.
#include <cstdint>
#include <string>

#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    if (size > 4096) {
        return 0;  // beyond the protocol's own op size limit
    }
    const std::string bytes(reinterpret_cast<const char*>(data), size);
    try {
        const concord::crdt::Operation op = concord::crdt::parse_operation(bytes);
        (void)op;
    } catch (const concord::crdt::CrdtError&) {
        // Structured rejection is the expected path for malformed input.
    }
    return 0;
}
