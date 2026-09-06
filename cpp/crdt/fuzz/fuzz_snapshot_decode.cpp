// Fuzz target: snapshot decoder (P2-M025).
// Contract: any byte string either imports or throws a structured error.
#include <cstdint>
#include <string>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    if (size > 8192) {
        return 0;
    }
    const std::string bytes(reinterpret_cast<const char*>(data), size);
    try {
        auto doc = concord::crdt::Doc::import_snapshot(concord::crdt::ReplicaId{1}, bytes);
        // Imported snapshots must expose consistent diagnostics (sanity).
        (void)doc.stream_size();
    } catch (const concord::crdt::CrdtError&) {
    }
    return 0;
}
