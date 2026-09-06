// Canonical state bytes + digest (P2-M021). The digest covers the full
// integrated CRDT state — item stream (with tombstones and register keys),
// applied-operation identity set, and the state summary — so equivalent
// replicas produce identical digests and any semantic difference changes it.
// Pending (causally-early) operations are excluded: they are transient by
// definition and not part of the converged state.
#include "concord/crdt/doc.hpp"

#include <algorithm>
#include <vector>

#include "concord/crdt/digest.hpp"

namespace concord::crdt {

std::string Doc::canonical_state_bytes() const {
    std::string out;
    out.reserve(64 + items_.size() * 32);

    put_u32_le(out, static_cast<std::uint32_t>(size_));

    for (std::int64_t cursor = head_; cursor != -1; cursor = at_index(cursor).next) {
        const Item& item = at_index(cursor);
        put_u64_le(out, item.id.replica.value());
        put_u64_le(out, item.id.counter.value());
        if (item.left.has_value()) {
            put_u8(out, 1);
            put_u64_le(out, item.left->replica.value());
            put_u64_le(out, item.left->counter.value());
        } else {
            put_u8(out, 0);
        }
        if (item.right.has_value()) {
            put_u8(out, 1);
            put_u64_le(out, item.right->replica.value());
            put_u64_le(out, item.right->counter.value());
        } else {
            put_u8(out, 0);
        }
        put_u8(out, static_cast<std::uint8_t>(item.kind));
        put_u8(out, item.tombstoned ? 1 : 0);
        if (item.kind == ItemKind::Text) {
            std::string encoded;
            append_utf8(encoded, item.scalar);
            put_u8(out, static_cast<std::uint8_t>(encoded.size()));
            out.append(encoded);
        }
        put_u32_le(out, static_cast<std::uint32_t>(item.attrs.size()));
        for (const auto& [name, reg] : item.attrs) {
            put_u64_le(out, name.size());
            out.append(name);
            if (reg.is_set()) {
                put_u8(out, 1);
                put_u64_le(out, reg.value->size());
                out.append(*reg.value);
            } else {
                put_u8(out, 0);
            }
            put_u64_le(out, reg.lamport.value());
            put_u64_le(out, reg.writer.value());
        }
    }

    put_u32_le(out, static_cast<std::uint32_t>(applied_.size()));
    {
        // Deterministic iteration: hash of a set must not depend on bucket
        // order — sort the ids.
        std::vector<OpId> ids(applied_.begin(), applied_.end());
        std::sort(ids.begin(), ids.end());
        for (const OpId& id : ids) {
            put_u64_le(out, id.replica.value());
            put_u64_le(out, id.counter.value());
        }
    }

    put_u32_le(out, static_cast<std::uint32_t>(contiguous_.size()));
    {
        // Deterministic iteration: sort replica keys (unordered_map bucket
        // order must never influence the canonical encoding).
        std::vector<std::pair<std::uint64_t, std::uint64_t>> summary_entries(
            contiguous_.begin(), contiguous_.end());
        std::sort(summary_entries.begin(), summary_entries.end());
        for (const auto& [replica_key, counter_value] : summary_entries) {
            put_u64_le(out, replica_key);
            put_u64_le(out, counter_value);
        }
    }

    return out;
}

std::string Doc::canonical_digest() const {
    return "sha256:" + concord::crypto::to_hex(concord::crypto::sha256(canonical_state_bytes()));
}

}  // namespace concord::crdt
