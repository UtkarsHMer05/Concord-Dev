// Fuzz target: worker protocol frame parsing (P6-M017).
//
// The worker (cpp/worker/main.cpp) speaks a length-prefixed binary protocol:
//   request  = [u32 LE payload_len][payload]
//   payload  = [u32 LE command][command body]
//   body     = per command: op batches ([u32 count] + [u32 len][frame]*),
//              snapshots ([u32 len][bytes]), or generate params.
//
// The worker's own parse_request lives in an anonymous namespace inside
// main.cpp and reads from stdin via read_exact; extracting it into a linkable
// function would change the production file's shape (risk: behavior drift in
// the process-per-request executable whose byte-level behavior is pinned by
// concord_worker_tests). DOCUMENTED DECISION (per the milestone): this target
// instead fuzzes the CORE layers the worker's parser is a thin wrapper over —
// the exact same decode chain every worker request walks:
//   - frame length validation (the u32 LE length prefix: zero, oversize
//     >256 MiB, truncated payloads — the checks run_worker does inline)
//   - serialize_batch op-frame decoding (read_op_batches → parse_batch)
//   - snapshot section decoding (read_snapshot_into → import_snapshot)
// An input that survives here without UB/crash walks the worker's parse
// chain with identical bytes; anything the worker rejects structurally
// (unknown command, trailing bytes) does not reach the core decoders and is
// covered by the worker's own protocol tests.
#include <cstdint>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    if (size > 32768) {
        return 0;  // bounded: protocol frames are capped far below this
    }
    const std::string bytes(reinterpret_cast<const char*>(data), size);

    // The worker's frame bounds (mirrors of cpp/worker/main.cpp constants —
    // the parser's documented contract).
    constexpr std::uint64_t kMaxFrameBytes = 256ULL * 1024 * 1024;
    constexpr std::uint64_t kMaxOpCount = 10'000'000;
    constexpr std::uint32_t kMaxGenReplicas = 8;

    if (size < 4) {
        return 0;  // too short for a length prefix
    }

    // ---- Length-prefix validation (run_worker's framing checks) ----
    std::size_t offset = 0;
    std::uint32_t frame_len = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        frame_len |= static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[i]))
                     << (8u * i);
    }
    offset = 4;
    if (frame_len == 0 || frame_len > kMaxFrameBytes) {
        return 0;  // rejected with status 4 by the worker — structured path
    }
    if (frame_len < 4) {
        return 0;  // rejected with status 1 — structured path
    }
    // Truncated payload (frame declares more than the input holds): the
    // worker exits kExitFraming; here we simply stop (nothing more to
    // decode — the truncated-frame contract is covered in worker tests).
    if (frame_len > size - 4) {
        return 0;
    }
    const std::string frame = bytes.substr(offset, frame_len);
    offset += frame_len;

    // ---- Command word (parse_request's first 4 bytes) ----
    std::size_t foffset = 0;
    std::uint32_t command = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        command |= static_cast<std::uint32_t>(static_cast<unsigned char>(frame[foffset + i]))
                   << (8u * i);
    }
    foffset += 4;

    switch (command) {
        case 1:    // kCmdReconstruct
        case 2: {  // kCmdExportSnapshot: [u32 batch_count] + batches
            std::uint32_t batch_count = 0;
            if (foffset + 4 <= frame.size()) {
                for (std::size_t i = 0; i < 4; ++i) {
                    batch_count |= static_cast<std::uint32_t>(
                                       static_cast<unsigned char>(frame[foffset + i]))
                                   << (8u * i);
                }
                foffset += 4;
            }
            if (batch_count > kMaxOpCount) {
                return 0;  // status 4 path
            }
            std::uint64_t total_ops = 0;
            for (std::uint32_t b = 0; b < batch_count; ++b) {
                if (foffset + 4 > frame.size()) {
                    return 0;  // status 1: truncated batch length
                }
                std::uint32_t batch_len = 0;
                for (std::size_t i = 0; i < 4; ++i) {
                    batch_len |= static_cast<std::uint32_t>(
                                     static_cast<unsigned char>(frame[foffset + i]))
                                 << (8u * i);
                }
                foffset += 4;
                if (batch_len > frame.size() - foffset) {
                    return 0;  // status 1: batch exceeds frame
                }
                const std::string batch = frame.substr(foffset, batch_len);
                foffset += batch_len;
                try {
                    // read_op_batches' core decode: parse_batch (strict).
                    const std::vector<concord::crdt::Operation> ops =
                        concord::crdt::parse_batch(batch);
                    total_ops += ops.size();
                    if (total_ops > kMaxOpCount) {
                        return 0;  // status 4 path
                    }
                    // The worker applies every decoded op into a Doc; do the
                    // same through the core's apply path (structured
                    // rejections allowed).
                    concord::crdt::Doc doc(concord::crdt::ReplicaId{0x53595343ULL});
                    for (const concord::crdt::Operation& op : ops) {
                        (void)doc.apply_remote(op);
                    }
                } catch (const concord::crdt::CrdtError&) {
                    // Structured rejection mapped to a protocol status.
                }
            }
            return 0;
        }
        case 3:  // kCmdImportVerify
        case 4:  // kCmdDigestAfter
        case 5: { // kCmdVerifySnapshot: [u32 snapshot_len][snapshot bytes]
            if (foffset + 4 > frame.size()) {
                return 0;
            }
            std::uint32_t snapshot_len = 0;
            for (std::size_t i = 0; i < 4; ++i) {
                snapshot_len |= static_cast<std::uint32_t>(
                                    static_cast<unsigned char>(frame[foffset + i]))
                                << (8u * i);
            }
            foffset += 4;
            if (snapshot_len > kMaxFrameBytes || snapshot_len > frame.size() - foffset) {
                return 0;  // status 4 path
            }
            const std::string snapshot = frame.substr(foffset, snapshot_len);
            try {
                // read_snapshot_into's core decode: import_snapshot (strict).
                const concord::crdt::Doc doc =
                    concord::crdt::Doc::import_snapshot(concord::crdt::ReplicaId{0x53595343ULL},
                                                        snapshot);
                (void)doc.canonical_digest();
            } catch (const concord::crdt::CrdtError&) {
                // Structured rejection.
            }
            return 0;
        }
        case 6: {  // kCmdGenerateOps: [u64 seed][u32 op_count][u32 replicas][u32 shape]
            if (foffset + 20 > frame.size()) {
                return 0;  // status 1: truncated generate body
            }
            std::uint32_t op_count = 0;
            std::uint32_t replica_count = 0;
            std::uint32_t shape = 0;
            for (std::size_t i = 0; i < 4; ++i) {
                op_count |= static_cast<std::uint32_t>(
                                static_cast<unsigned char>(frame[foffset + 8 + i]))
                            << (8u * i);
                replica_count |=
                    static_cast<std::uint32_t>(
                        static_cast<unsigned char>(frame[foffset + 12 + i]))
                    << (8u * i);
                shape |= static_cast<std::uint32_t>(
                             static_cast<unsigned char>(frame[foffset + 16 + i]))
                         << (8u * i);
            }
            if (op_count > kMaxOpCount || replica_count < 1 || replica_count > kMaxGenReplicas ||
                shape > 3) {
                return 0;  // status 4/1 paths
            }
            return 0;
        }
        default:
            return 0;  // unknown command: status 1
    }
}
