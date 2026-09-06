// Snapshot export/import (docs/PROTOCOL.md §7; PROTOCOL/CONSISTENCY snapshot
// parity invariant). A snapshot carries the full replica state: item
// sequence with tombstones and registers, applied-operation ids (dedup
// state), pending operations, and counter/clock allocation — so a restored
// replica continues editing and remains replay-safe.
#include "concord/crdt/doc.hpp"

#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"

namespace concord::crdt {

namespace {
constexpr std::uint8_t kSnapshotVersion = 1;

void put_opt_id_field(std::string& out, const std::optional<OpId>& id) {
    if (id.has_value()) {
        put_u8(out, 1);
        put_u64_le(out, id->replica.value());
        put_u64_le(out, id->counter.value());
    } else {
        put_u8(out, 0);
    }
}

bool read_opt_id(const std::string& bytes, std::size_t& offset, std::optional<OpId>& out) {
    std::uint8_t flag = 0;
    std::uint64_t replica = 0;
    std::uint64_t counter = 0;
    if (!get_u8(bytes, offset, flag)) {
        return false;
    }
    if (flag == 0) {
        out = std::nullopt;
        return true;
    }
    if (flag != 1 || !get_u64_le(bytes, offset, replica) ||
        !get_u64_le(bytes, offset, counter)) {
        return false;
    }
    out = OpId{ReplicaId{replica}, Counter{counter}};
    return true;
}

void put_attr_map(std::string& out, const AttrMap& attrs) {
    put_u32_le(out, static_cast<std::uint32_t>(attrs.size()));
    for (const auto& [name, reg] : attrs) {
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

bool read_attr_map(ItemKind kind, const std::string& bytes, std::size_t& offset, AttrMap& out) {
    std::uint32_t count = 0;
    if (!get_u32_le(bytes, offset, count)) {
        return false;
    }
    for (std::uint32_t i = 0; i < count; ++i) {
        std::uint64_t name_len = 0;
        if (!get_u64_le(bytes, offset, name_len) || bytes.size() < offset + name_len) {
            return false;
        }
        std::string name(bytes, offset, static_cast<std::size_t>(name_len));
        offset += static_cast<std::size_t>(name_len);
        AttributeRegister reg;
        std::uint8_t has_value = 0;
        std::uint64_t value_len = 0;
        if (!get_u8(bytes, offset, has_value)) {
            return false;
        }
        if (has_value == 1) {
            std::string value;
            if (!get_u64_le(bytes, offset, value_len) ||
                bytes.size() < offset + value_len) {
                return false;
            }
            value.assign(bytes, offset, static_cast<std::size_t>(value_len));
            offset += static_cast<std::size_t>(value_len);
            reg.value = value;
        } else if (has_value != 0) {
            return false;
        }
        std::uint64_t lamport = 0;
        std::uint64_t writer = 0;
        if (!get_u64_le(bytes, offset, lamport) || !get_u64_le(bytes, offset, writer)) {
            return false;
        }
        if (!Lamport::is_valid(lamport) || !ReplicaId::is_valid(writer)) {
            return false;
        }
        reg.lamport = Lamport{lamport};
        reg.writer = ReplicaId{writer};
        // Import re-validation (SA-SEC3 F2): a snapshot is untrusted input —
        // attribute names/values must satisfy the same registry that local
        // and remote ops are validated against (fail closed).
        if (!AllowedAttrs::is_allowed(kind, name)) {
            return false;
        }
        if (reg.value.has_value() && !AllowedAttrs::is_allowed_value(kind, name, *reg.value)) {
            return false;
        }
        out.emplace(std::move(name), std::move(reg));
    }
    return true;
}
}  // namespace

std::string Doc::export_snapshot() const {
    std::string out;
    put_u8(out, kSnapshotVersion);
    put_u64_le(out, self_.value());
    put_u64_le(out, next_counter_.value());
    put_u64_le(out, lamport_.value());

    // Items in stream order (linked list defines the canonical order).
    put_u32_le(out, static_cast<std::uint32_t>(size_));
    for (std::int64_t cursor = head_; cursor != -1; cursor = at_index(cursor).next) {
        const Item& item = at_index(cursor);
        put_u64_le(out, item.id.replica.value());
        put_u64_le(out, item.id.counter.value());
        put_opt_id_field(out, item.left);
        put_opt_id_field(out, item.right);
        put_u8(out, static_cast<std::uint8_t>(item.kind));
        put_u8(out, item.tombstoned ? 1 : 0);
        if (item.kind == ItemKind::Text) {
            std::string encoded;
            append_utf8(encoded, item.scalar);
            put_u8(out, static_cast<std::uint8_t>(encoded.size()));
            out.append(encoded);
        }
        put_attr_map(out, item.attrs);
    }

    // Applied operation ids (dedup state — replay safety after import).
    put_u32_le(out, static_cast<std::uint32_t>(applied_.size()));
    for (const OpId& id : applied_) {
        put_u64_le(out, id.replica.value());
        put_u64_le(out, id.counter.value());
    }

    // Pending operations (causally early deliveries), serialized as a batch.
    const std::string pending_batch = serialize_batch(pending_);
    put_u32_le(out, static_cast<std::uint32_t>(pending_batch.size()));
    out.append(pending_batch);

    // Per-replica contiguous counters (state summary base).
    put_u32_le(out, static_cast<std::uint32_t>(contiguous_.size()));
    for (const auto& [replica_key, counter_value] : contiguous_) {
        put_u64_le(out, replica_key);
        put_u64_le(out, counter_value);
    }
    return out;
}

Doc Doc::import_snapshot(ReplicaId self, const std::string& bytes) {
    std::size_t offset = 0;
    std::uint8_t version = 0;
    std::uint64_t stored_replica = 0;
    std::uint64_t next_counter = 0;
    std::uint64_t lamport = 0;
    if (!get_u8(bytes, offset, version)) {
        throw CrdtError(ErrorCode::MalformedFrame, "empty snapshot");
    }
    if (version != kSnapshotVersion) {
        throw CrdtError(ErrorCode::SnapshotVersionUnsupported, "unsupported snapshot version");
    }
    if (!get_u64_le(bytes, offset, stored_replica) ||
        !get_u64_le(bytes, offset, next_counter) || !get_u64_le(bytes, offset, lamport)) {
        throw CrdtError(ErrorCode::MalformedFrame, "truncated snapshot header");
    }
    if (!ReplicaId::is_valid(stored_replica) || !Counter::is_valid(next_counter) ||
        lamport > Lamport::kMax) {
        throw CrdtError(ErrorCode::MalformedFrame, "snapshot header out of range");
    }

    Doc doc(ReplicaId{stored_replica});
    doc.self_ = self;  // restoring replica keeps its own identity
    doc.next_counter_ = Counter{next_counter};
    doc.lamport_ = Lamport{lamport};

    std::uint32_t item_count = 0;
    if (!get_u32_le(bytes, offset, item_count)) {
        throw CrdtError(ErrorCode::MalformedFrame, "truncated item count");
    }
    for (std::uint32_t i = 0; i < item_count; ++i) {
        Item item;
        std::uint64_t replica = 0;
        std::uint64_t counter = 0;
        std::uint8_t kind = 0;
        std::uint8_t tombstone = 0;
        if (!get_u64_le(bytes, offset, replica) || !get_u64_le(bytes, offset, counter) ||
            !read_opt_id(bytes, offset, item.left) || !read_opt_id(bytes, offset, item.right) ||
            !get_u8(bytes, offset, kind) || !get_u8(bytes, offset, tombstone)) {
            throw CrdtError(ErrorCode::MalformedFrame, "truncated item");
        }
        if (!OpId::is_valid_counter_pair(replica, counter) ||
            (kind != static_cast<std::uint8_t>(ItemKind::Text) &&
             kind != static_cast<std::uint8_t>(ItemKind::Delimiter))) {
            throw CrdtError(ErrorCode::MalformedFrame, "item out of range");
        }
        item.id = OpId{ReplicaId{replica}, Counter{counter}};
        item.kind = static_cast<ItemKind>(kind);
        item.tombstoned = tombstone == 1;
        if (item.kind == ItemKind::Text) {
            std::uint8_t scalar_length = 0;
            if (!get_u8(bytes, offset, scalar_length) || scalar_length < 1 ||
                scalar_length > 4 || bytes.size() < offset + scalar_length) {
                throw CrdtError(ErrorCode::MalformedFrame, "bad scalar in snapshot");
            }
            std::string encoded = bytes.substr(offset, scalar_length);
            std::size_t decoded_offset = 0;
            bool ok = false;
            item.scalar = decode_utf8(encoded, decoded_offset, ok);
            if (!ok || decoded_offset != scalar_length) {
                throw CrdtError(ErrorCode::MalformedFrame, "invalid scalar in snapshot");
            }
            offset += scalar_length;
        }
        if (!read_attr_map(item.kind, bytes, offset, item.attrs)) {
            throw CrdtError(ErrorCode::MalformedFrame, "bad attributes in snapshot");
        }
        const std::int64_t idx = static_cast<std::int64_t>(doc.items_.size());
        doc.items_.push_back(std::move(item));
        doc.splice_after(doc.tail_, idx);
        doc.index_.emplace(doc.at_index(idx).id, idx);
    }

    std::uint32_t applied_count = 0;
    if (!get_u32_le(bytes, offset, applied_count)) {
        throw CrdtError(ErrorCode::MalformedFrame, "truncated applied count");
    }
    for (std::uint32_t i = 0; i < applied_count; ++i) {
        std::uint64_t replica = 0;
        std::uint64_t counter = 0;
        if (!get_u64_le(bytes, offset, replica) || !get_u64_le(bytes, offset, counter) ||
            !OpId::is_valid_counter_pair(replica, counter)) {
            throw CrdtError(ErrorCode::MalformedFrame, "bad applied id");
        }
        doc.applied_.insert(OpId{ReplicaId{replica}, Counter{counter}});
        // Keep the state summary consistent with applied ids.
        Operation note;
        note.type = OpType::Insert;
        note.id = OpId{ReplicaId{replica}, Counter{counter}};
        note.lamport = Lamport{1};
        doc.note_integrated(note);
    }

    std::uint32_t pending_bytes_len = 0;
    if (!get_u32_le(bytes, offset, pending_bytes_len) ||
        bytes.size() < offset + pending_bytes_len) {
        throw CrdtError(ErrorCode::MalformedFrame, "truncated pending section");
    }
    {
        const std::string pending_bytes = bytes.substr(offset, pending_bytes_len);
        offset += pending_bytes_len;
        doc.pending_ = parse_batch(pending_bytes);
        if (doc.pending_.size() > kPendingLimit) {
            throw CrdtError(ErrorCode::OpTooLarge, "pending section exceeds limit");
        }
    }

    std::uint32_t summary_count = 0;
    if (!get_u32_le(bytes, offset, summary_count)) {
        throw CrdtError(ErrorCode::MalformedFrame, "truncated summary section");
    }
    for (std::uint32_t i = 0; i < summary_count; ++i) {
        std::uint64_t replica = 0;
        std::uint64_t counter = 0;
        if (!get_u64_le(bytes, offset, replica) || !get_u64_le(bytes, offset, counter)) {
            throw CrdtError(ErrorCode::MalformedFrame, "bad summary entry");
        }
        doc.contiguous_[replica] = counter;
    }

    if (offset != bytes.size()) {
        throw CrdtError(ErrorCode::MalformedFrame, "trailing bytes after snapshot");
    }
    return doc;
}

}  // namespace concord::crdt
