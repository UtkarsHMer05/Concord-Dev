// StateSummary semantics (docs/PROTOCOL.md §6).
#include "concord/crdt/op.hpp"

namespace concord::crdt {

StateSummary::Relation StateSummary::compare(const StateSummary& other) const {
    bool less = false;
    bool greater = false;
    auto consider = [&](std::uint64_t mine, std::uint64_t theirs) {
        if (mine < theirs) {
            less = true;
        } else if (mine > theirs) {
            greater = true;
        }
    };
    for (const auto& [replica, counter] : contiguous) {
        consider(counter, other.at(ReplicaId{replica}));
    }
    for (const auto& [replica, counter] : other.contiguous) {
        consider(at(ReplicaId{replica}), counter);
    }
    if (less && greater) {
        return Relation::Mixed;
    }
    if (less) {
        return Relation::Less;
    }
    if (greater) {
        return Relation::Greater;
    }
    return Relation::Equal;
}

std::vector<ReplicaId> StateSummary::replicas() const {
    std::vector<ReplicaId> out;
    out.reserve(contiguous.size());
    for (const auto& [replica, counter] : contiguous) {
        out.push_back(ReplicaId{replica});
    }
    return out;
}

}  // namespace concord::crdt
