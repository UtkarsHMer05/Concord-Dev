// Fuzz target: recovery / snapshot-tail stream (P6-M017).
//
// The recovery path the worker's CMD 4 (digest-after) exercises end-to-end:
//   1. import a snapshot (arbitrary bytes: truncated, corrupted, valid)
//   2. apply a tail of op frames after the snapshot
//   3. digest the result; replay the tail — the digest must be stable
//
// Contract: any byte string either imports + applies or throws a structured
// CrdtError — never a crash, never a hang, never a digest that moves under
// redelivery. Uses the CORE snapshot decode + apply path (Doc::
// import_snapshot / apply_remote) — identical semantics to the worker, which
// is a thin executor over these functions (worker/main.cpp kCmdDigestAfter:
// import_snapshot + apply_batches(doc, ...) where apply_batches is parse_batch
// + apply_remote per op).
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

    // Split point: first 4 bytes little-endian = snapshot length (bounded
    // to the input, so truncations of both halves are explored); the rest
    // is the tail op stream.
    if (size < 4) {
        return 0;
    }
    std::uint32_t snapshot_len = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        snapshot_len |= static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[i]))
                        << (8u * i);
    }
    if (snapshot_len > size - 4) {
        // Oversized declared length: treat as truncated input — import the
        // (shorter) remainder so truncation handling is exercised anyway.
        snapshot_len = static_cast<std::uint32_t>(size - 4);
    }
    const std::string snapshot = bytes.substr(4, snapshot_len);
    const std::string tail_region = bytes.substr(4 + snapshot_len);

    try {
        // Stage 1: snapshot import (the recovery base state).
        concord::crdt::Doc doc(concord::crdt::ReplicaId{1});
        doc = concord::crdt::Doc::import_snapshot(concord::crdt::ReplicaId{1}, snapshot);

        // Stage 2: tail op application. The tail is a sequence of
        // length-prefixed single-op frames (u8 len + frame, the same shape
        // fuzz_op_apply uses); a malformed tail frame stops consumption.
        std::vector<concord::crdt::Operation> tail_ops;
        std::size_t offset = 0;
        while (offset + 2 <= tail_region.size() && tail_ops.size() < 256) {
            const std::uint8_t length = static_cast<std::uint8_t>(tail_region[offset]);
            ++offset;
            if (length == 0 || offset + length > tail_region.size()) {
                break;
            }
            try {
                tail_ops.push_back(
                    concord::crdt::parse_operation(tail_region.substr(offset, length)));
            } catch (const concord::crdt::CrdtError&) {
                break;  // malformed tail: stop (fail closed)
            }
            offset += length;
        }

        // Apply the tail; ops may legitimately fail semantically (unknown
        // anchors etc. throw) — the structured-rejection contract.
        std::size_t applied = 0;
        for (const concord::crdt::Operation& op : tail_ops) {
            try {
                doc.apply_remote(op);
                ++applied;
            } catch (const concord::crdt::CrdtError&) {
                break;
            }
        }
        (void)applied;

        // Stage 3: digest + stability under replay (recovery idempotence:
        // redelivering the tail after a resync must be inert).
        const std::string digest = doc.canonical_digest();
        for (const concord::crdt::Operation& op : tail_ops) {
            try {
                doc.apply_remote(op);
            } catch (const concord::crdt::CrdtError&) {
                break;
            }
        }
        if (doc.canonical_digest() != digest) {
            // Digest instability: a correctness violation — trap for the
            // fuzzer to capture with a reproducible input.
            __builtin_trap();
        }
        // Snapshot re-export after tail application: re-import must hold
        // the same digest (compaction round-trip through the recovery
        // path).
        const std::string exported = doc.export_snapshot();
        concord::crdt::Doc reimported =
            concord::crdt::Doc::import_snapshot(concord::crdt::ReplicaId{2}, exported);
        if (reimported.canonical_digest() != digest) {
            __builtin_trap();
        }
    } catch (const concord::crdt::CrdtError&) {
        // Structured rejection is the expected path for malformed input.
    }
    return 0;
}
