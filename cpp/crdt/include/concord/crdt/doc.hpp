// The Concord CRDT document engine (docs/PROTOCOL.md, DEC-023).
//
// A Doc is one replica's CRDT state: the full item sequence (including
// tombstones), identity/counter/clock allocation, deduplication state, the
// pending-operation buffer for causally-early deliveries, and derived
// canonical views.
//
// Single-writer discipline: a Doc instance must be used from one thread at a
// time (see docs/CONSISTENCY_MODEL.md and the Phase 2 concurrency decision).
#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "concord/crdt/errors.hpp"
#include "concord/crdt/item.hpp"
#include "concord/crdt/op.hpp"

namespace concord::crdt {

// Local resource limit: operations buffered while awaiting their causal
// anchors/targets (PROTOCOL §5). Shared by the engine and snapshot format.
inline constexpr std::size_t kPendingLimit = 100'000;

// One entry of the full item stream (tombstones included) — the mapping
// surface used by the TipTap adapter to translate editor positions into
// anchors. A copyable value; internals are never exposed.
struct StreamEntry {
    OpId id;
    ItemKind kind = ItemKind::Text;
    char32_t scalar = 0;
    bool tombstoned = false;
    // Currently winning attribute values (name → value).
    std::map<std::string, std::string> attrs;

    friend bool operator==(const StreamEntry&, const StreamEntry&) = default;
};

struct DocDiagnostics {
    std::uint64_t replica_id = 0;
    std::uint64_t operation_count = 0;   // integrated operations (insert+delete+setattr)
    std::uint64_t visible_char_count = 0;
    std::uint64_t visible_block_count = 0;
    std::uint64_t tombstone_count = 0;
    std::uint64_t pending_count = 0;
    StateSummary summary;
    std::string canonical_digest;  // hex-encoded SHA-256

    friend bool operator==(const DocDiagnostics&, const DocDiagnostics&) = default;
};

class Doc final {
public:
    explicit Doc(ReplicaId self);

    [[nodiscard]] ReplicaId replica() const noexcept { return self_; }

    // ------------------------------------------------------------------
    // Local generation. Each call applies the operation locally (the
    // generating replica is always causally ready) and returns it for
    // delivery. Anchors are computed from the tombstone-inclusive stream.
    // ------------------------------------------------------------------

    // Insert a text item before the item currently at `stream_index`
    // (streamSize() = append to sequence end).
    [[nodiscard]] Operation local_insert_text(std::size_t stream_index, char32_t scalar);

    // Insert a block delimiter (starts a new block with `block_type`).
    [[nodiscard]] Operation local_insert_delimiter(std::size_t stream_index,
                                                   const std::string& block_type);

    // Tombstone the item at `stream_index`. Returns no operation when the
    // item is already tombstoned (nothing to communicate).
    [[nodiscard]] std::optional<Operation> local_delete(std::size_t stream_index);

    // Write (or clear) an attribute/mark register on the item at
    // `stream_index`. nullopt value clears.
    [[nodiscard]] Operation local_set_attr(std::size_t stream_index, const std::string& name,
                                           const std::optional<std::string>& value);

    // ------------------------------------------------------------------
    // Remote application. Validation failures throw CrdtError without
    // mutating state. Duplicate delivery returns false (idempotent no-op).
    // ------------------------------------------------------------------

    // Returns true when the operation changed state; false for duplicates.
    bool apply_remote(const Operation& op);
    std::size_t apply_batch(std::span<const Operation> ops);

    // ------------------------------------------------------------------
    // Derived views.
    // ------------------------------------------------------------------

    // Tombstone-inclusive stream length (adapter position space).
    [[nodiscard]] std::size_t stream_size() const noexcept { return size_; }
    [[nodiscard]] StreamEntry stream_entry(std::size_t index) const;

    // The visible document: blocks partitioned at delimiters (PROTOCOL §2).
    [[nodiscard]] std::vector<VisibleBlock> visible_document() const;

    [[nodiscard]] StateSummary state_summary() const;
    [[nodiscard]] DocDiagnostics diagnostics() const;

    // Canonical SHA-256 digest over the full CRDT state (M021). Equivalent
    // states on any replica produce identical digests.
    [[nodiscard]] std::string canonical_digest() const;

    // Semantic state hash input (canonical bytes of the full item stream).
    [[nodiscard]] std::string canonical_state_bytes() const;

    // ------------------------------------------------------------------
    // Persistence (M020).
    // ------------------------------------------------------------------

    // Versioned snapshot: items, tombstones, registers, applied-op ids,
    // pending ops, counters.
    [[nodiscard]] std::string export_snapshot() const;
    // Replaces state from a validated snapshot. Throws on malformed input.
    static Doc import_snapshot(ReplicaId self, const std::string& bytes);

    // ------------------------------------------------------------------
    // Test/verification access (bounded, read-only).
    // ------------------------------------------------------------------

    [[nodiscard]] std::size_t pending_count() const noexcept { return pending_.size(); }
    [[nodiscard]] bool has_applied(const OpId& id) const {
        return applied_.contains(id);
    }

private:
    // OpId → item index lookup.
    using ItemIndexMap = std::unordered_map<OpId, std::int64_t, OpIdHash>;

    [[nodiscard]] std::int64_t index_of(const std::optional<OpId>& id) const;
    void splice_after(std::int64_t after, std::int64_t new_idx);
    void integrate_insert(const Operation& op);
    void integrate_delete(const Operation& op);
    void integrate_set_attr(const Operation& op);
    void apply_register(Item& item, const std::string& name,
                        const std::optional<std::string>& value, Lamport lamport,
                        ReplicaId writer);
    void note_integrated(const Operation& op);
    void retry_pending();
    Operation allocate(OpType type);
    [[nodiscard]] bool resolve_anchor(const std::optional<OpId>& anchor,
                                      std::int64_t& out) const;
    [[nodiscard]] Item& at_index(std::int64_t index) noexcept {
        return items_[static_cast<std::size_t>(index)];
    }
    [[nodiscard]] const Item& at_index(std::int64_t index) const noexcept {
        return items_[static_cast<std::size_t>(index)];
    }
    [[nodiscard]] StreamEntry make_entry(std::size_t order_pos) const;

    ReplicaId self_;
    Counter next_counter_;
    Lamport lamport_;

    // CRDT items in document order (indices stable; tombstones retained).
    std::vector<Item> items_;
    std::int64_t head_ = -1;
    std::int64_t tail_ = -1;
    std::size_t size_ = 0;
    ItemIndexMap index_;

    // Deduplication: every integrated operation id (insert/delete/setattr).
    std::unordered_set<OpId, OpIdHash> applied_;

    // Operations whose anchors/targets have not arrived yet.
    std::vector<Operation> pending_;
    bool retrying_ = false;  // guards against reentrant retry loops

    // Per-replica contiguous-counter tracking (state summary).
    std::unordered_map<std::uint64_t, std::uint64_t> contiguous_;
    std::unordered_map<std::uint64_t, std::unordered_set<std::uint64_t>> gaps_;
};

}  // namespace concord::crdt
