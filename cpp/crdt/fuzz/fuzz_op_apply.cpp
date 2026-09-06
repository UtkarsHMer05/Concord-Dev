// Fuzz target: operation application sequence (P2-M025).
// Contract: a byte string is treated as a length-prefixed sequence of frames;
// each frame either parses or aborts the run (structured rejection), and
// applying parsed ops to a document must never crash. Invariant smoke: the
// document remains internally consistent (digest stable under no-op replay).
#include <cstdint>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    if (size > 16384) {
        return 0;
    }
    const std::string bytes(reinterpret_cast<const char*>(data), size);

    std::vector<concord::crdt::Operation> ops;
    {
        std::size_t offset = 0;
        while (offset + 2 <= bytes.size() && ops.size() < 256) {
            const std::uint8_t length = static_cast<std::uint8_t>(bytes[offset]);
            ++offset;
            if (length == 0 || offset + length > bytes.size()) {
                break;
            }
            try {
                ops.push_back(concord::crdt::parse_operation(bytes.substr(offset, length)));
            } catch (const concord::crdt::CrdtError&) {
                break;  // malformed tail: stop consuming (fail closed)
            }
            offset += length;
        }
    }

    try {
        concord::crdt::Doc doc(concord::crdt::ReplicaId{1});
        for (const concord::crdt::Operation& op : ops) {
            doc.apply_remote(op);
        }
        const std::string digest = doc.canonical_digest();
        // Idempotency: replaying everything must not change the digest.
        for (const concord::crdt::Operation& op : ops) {
            doc.apply_remote(op);
        }
        if (doc.canonical_digest() != digest) {
            // Digest instability is a correctness violation — abort for the
            // fuzzer to capture.
            __builtin_trap();
        }
    } catch (const concord::crdt::CrdtError&) {
    }
    return 0;
}
