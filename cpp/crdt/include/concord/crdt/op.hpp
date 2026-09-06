// Operation definitions (docs/PROTOCOL.md §3). An Operation is the unit of
// generation, delivery, and idempotent application.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "concord/crdt/ids.hpp"
#include "concord/crdt/item.hpp"

namespace concord::crdt {

enum class OpType : std::uint8_t {
    Insert = 1,
    Delete = 2,
    SetAttr = 3,
};

// A single attribute write carried by an insert op (initial registers).
struct InitialAttr {
    std::string name;
    std::optional<std::string> value;  // nullopt = cleared register

    friend bool operator==(const InitialAttr&, const InitialAttr&) = default;
};

struct Operation {
    OpType type = OpType::Insert;
    OpId id;                        // unique operation identity
    Lamport lamport{0};

    // --- Insert ---
    std::optional<OpId> left;       // left anchor (nullopt = sequence start)
    std::optional<OpId> right;      // right anchor (nullopt = sequence end)
    ItemKind kind = ItemKind::Text;
    char32_t scalar = 0;            // kind == Text
    std::vector<InitialAttr> initial_attrs;

    // --- Delete ---
    std::optional<OpId> target;

    // --- SetAttr ---
    std::string attr_name;
    std::optional<std::string> attr_value;  // nullopt = clear register

    friend bool operator==(const Operation&, const Operation&) = default;
};

// ---------------------------------------------------------------------------
// State summary (version vector): highest contiguous integrated counter per
// replica (docs/PROTOCOL.md §6).
// ---------------------------------------------------------------------------
struct StateSummary {
    // replica → highest contiguous counter (0 if nothing seen).
    std::map<std::uint64_t, std::uint64_t> contiguous;

    [[nodiscard]] std::uint64_t at(const ReplicaId& replica) const {
        const auto it = contiguous.find(replica.value());
        return it == contiguous.end() ? 0 : it->second;
    }

    enum class Relation { Equal, Less, Greater, Mixed };

    [[nodiscard]] Relation compare(const StateSummary& other) const;

    // Replicas present in either summary, union of keys.
    [[nodiscard]] std::vector<ReplicaId> replicas() const;

    friend bool operator==(const StateSummary&, const StateSummary&) = default;
};

}  // namespace concord::crdt
