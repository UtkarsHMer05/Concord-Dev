// CRDT document engine: generation, YATA-style integration, deduplication,
// pending buffering, state summaries.
//
// Integration implements the two-neighbor (left/right origin) conflict
// resolution described in docs/PROTOCOL.md §4 and DEC-023, following the
// published YATA integration rules: concurrent sibling items are ordered by
// replica identity; deeper conflicts shift the scan boundary. The rules are
// validated by the native unit suite, seeded randomized convergence tests,
// and the deterministic multi-replica simulator.
#include "concord/crdt/doc.hpp"

#include <algorithm>

namespace concord::crdt {

Doc::Doc(ReplicaId self)
    : self_(self),
      next_counter_(Counter::first()),
      lamport_(Lamport{0}) {  // last-used; first generated operation gets 1
    if (!ReplicaId::is_valid(self.value())) {
        throw CrdtError(ErrorCode::InvalidReplicaId, "replica id must be nonzero");
    }
}

// ---------------------------------------------------------------------------
// Local generation
// ---------------------------------------------------------------------------

Operation Doc::allocate(OpType type) {
    const Counter current = next_counter_;
    const auto next = current.next();
    if (!next.has_value()) {
        throw CrdtError(ErrorCode::CounterOverflow,
                        "counter exhausted; replica must not generate further operations");
    }
    next_counter_ = *next;
    // Lamport: pre-increment the last-used value; received lamports fold in
    // on integration. First generated operation has lamport 1.
    lamport_ = Lamport{lamport_.value() + 1};
    Operation op;
    op.type = type;
    op.id = OpId{self_, current};
    op.lamport = lamport_;
    return op;
}

Operation Doc::local_insert_text(std::size_t stream_index, char32_t scalar) {
    if (stream_index > size_) {
        throw CrdtError(ErrorCode::InvalidArgument, "stream index out of range");
    }
    if (scalar == 0 || (scalar >= 0xD800 && scalar <= 0xDFFF) || scalar > 0x10FFFF) {
        throw CrdtError(ErrorCode::InvalidUnicodeScalar, "invalid scalar for local insert");
    }
    // Locate the anchor items by walking the live stream.
    std::optional<OpId> left;
    std::optional<OpId> right;
    {
        std::int64_t cursor = head_;
        std::size_t position = 0;
        while (cursor != -1) {
            if (position == stream_index) {
                right = at_index(cursor).id;
                break;
            }
            left = at_index(cursor).id;
            cursor = at_index(cursor).next;
            position += 1;
        }
    }
    Operation op = allocate(OpType::Insert);
    op.left = left;
    op.right = right;
    op.kind = ItemKind::Text;
    op.scalar = scalar;
    integrate_insert(op);
    return op;
}

Operation Doc::local_insert_delimiter(std::size_t stream_index, const std::string& block_type) {
    if (stream_index > size_) {
        throw CrdtError(ErrorCode::InvalidArgument, "stream index out of range");
    }
    if (!AllowedAttrs::is_allowed_value(ItemKind::Delimiter, "type", block_type)) {
        throw CrdtError(ErrorCode::InvalidAttributeValue, "unknown block type: " + block_type);
    }
    std::optional<OpId> left;
    std::optional<OpId> right;
    {
        std::int64_t cursor = head_;
        std::size_t position = 0;
        while (cursor != -1) {
            if (position == stream_index) {
                right = at_index(cursor).id;
                break;
            }
            left = at_index(cursor).id;
            cursor = at_index(cursor).next;
            position += 1;
        }
    }
    Operation op = allocate(OpType::Insert);
    op.left = left;
    op.right = right;
    op.kind = ItemKind::Delimiter;
    op.scalar = 0;
    op.initial_attrs.push_back(InitialAttr{"type", block_type});
    integrate_insert(op);
    return op;
}

std::optional<Operation> Doc::local_delete(std::size_t stream_index) {
    if (stream_index >= size_) {
        throw CrdtError(ErrorCode::InvalidArgument, "stream index out of range");
    }
    // Walk to the target.
    std::int64_t cursor = head_;
    for (std::size_t position = 0; position < stream_index; ++position) {
        cursor = at_index(cursor).next;
    }
    Item& target = at_index(cursor);
    if (target.tombstoned) {
        // Already deleted locally: nothing to communicate (idempotent model).
        return std::nullopt;
    }
    Operation op = allocate(OpType::Delete);
    op.target = target.id;
    integrate_delete(op);
    return op;
}

Operation Doc::local_set_attr(std::size_t stream_index, const std::string& name,
                              const std::optional<std::string>& value) {
    if (stream_index >= size_) {
        throw CrdtError(ErrorCode::InvalidArgument, "stream index out of range");
    }
    std::int64_t cursor = head_;
    for (std::size_t position = 0; position < stream_index; ++position) {
        cursor = at_index(cursor).next;
    }
    Item& target = at_index(cursor);
    if (!AllowedAttrs::is_allowed(target.kind, name)) {
        throw CrdtError(ErrorCode::UnknownAttributeName, "attribute not allowed on item kind: " + name);
    }
    if (value.has_value() && !AllowedAttrs::is_allowed_value(target.kind, name, *value)) {
        throw CrdtError(ErrorCode::InvalidAttributeValue, "invalid value for " + name);
    }
    Operation op = allocate(OpType::SetAttr);
    op.target = target.id;
    op.attr_name = name;
    op.attr_value = value;
    integrate_set_attr(op);
    return op;
}

// ---------------------------------------------------------------------------
// Remote application
// ---------------------------------------------------------------------------

bool Doc::apply_remote(const Operation& op) {
    if (applied_.contains(op.id)) {
        return false;  // duplicate delivery: idempotent no-op
    }
    switch (op.type) {
        case OpType::Insert:
            integrate_insert(op);
            break;
        case OpType::Delete:
            integrate_delete(op);
            break;
        case OpType::SetAttr:
            integrate_set_attr(op);
            break;
    }
    return true;
}

std::size_t Doc::apply_batch(std::span<const Operation> ops) {
    std::size_t applied = 0;
    for (const Operation& op : ops) {
        if (apply_remote(op)) {
            applied += 1;
        }
    }
    return applied;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

bool Doc::resolve_anchor(const std::optional<OpId>& anchor, std::int64_t& out) const {
    if (!anchor.has_value()) {
        out = -1;  // boundary sentinel
        return true;
    }
    const auto it = index_.find(*anchor);
    if (it == index_.end()) {
        return false;
    }
    out = it->second;
    return true;
}

void Doc::integrate_insert(const Operation& op) {
    if (index_.contains(op.id)) {
        // Item already present (snapshot import path); still record the op id
        // for dedup semantics.
        applied_.insert(op.id);
        note_integrated(op);
        return;
    }
    if (!OpId::is_valid_counter_pair(op.id.replica.value(), op.id.counter.value())) {
        throw CrdtError(ErrorCode::InvalidCounter, "insert id out of range");
    }
    if (op.kind == ItemKind::Text) {
        if (op.scalar == 0 || (op.scalar >= 0xD800 && op.scalar <= 0xDFFF) ||
            op.scalar > 0x10FFFF) {
            throw CrdtError(ErrorCode::InvalidUnicodeScalar, "invalid scalar in remote insert");
        }
    }
    for (const InitialAttr& attr : op.initial_attrs) {
        if (!AllowedAttrs::is_allowed(op.kind, attr.name)) {
            throw CrdtError(ErrorCode::UnknownAttributeName, "attribute not allowed on item kind: " + attr.name);
        }
        if (attr.value.has_value() &&
            !AllowedAttrs::is_allowed_value(op.kind, attr.name, *attr.value)) {
            throw CrdtError(ErrorCode::InvalidAttributeValue, "invalid initial value for " + attr.name);
        }
    }

    std::int64_t left = 0;
    std::int64_t right = 0;
    if (!resolve_anchor(op.left, left) || !resolve_anchor(op.right, right)) {
        // Causally early delivery: buffer and retry when anchors arrive.
        if (pending_.size() >= kPendingLimit) {
            throw CrdtError(ErrorCode::PendingLimitExceeded, "pending operation buffer exhausted");
        }
        pending_.push_back(op);
        return;
    }

    // YATA-style conflict scan between the anchors.
    std::int64_t boundary = left;
    std::int64_t o = (left == -1) ? head_ : at_index(left).next;
    std::unordered_set<std::int64_t> conflicting;
    std::unordered_set<std::int64_t> before_origin;
    while (o != -1 && o != right) {
        before_origin.insert(o);
        conflicting.insert(o);
        const Item& other = at_index(o);
        if (other.left == op.left) {
            // Case 1: direct sibling — larger replica id integrates first.
            if (other.id.replica < op.id.replica) {
                boundary = o;
                conflicting.clear();
            }
        } else if (other.left.has_value()) {
            // Case 2: the scanned item is deeper in a preceding sibling's
            // subtree; shift the boundary only when its origin lost.
            const auto origin_it = index_.find(*other.left);
            if (origin_it != index_.end() && before_origin.contains(origin_it->second)) {
                if (!conflicting.contains(origin_it->second)) {
                    boundary = o;
                    conflicting.clear();
                }
            } else {
                break;
            }
        } else {
            break;
        }
        o = at_index(o).next;
    }

    Item item;
    item.id = op.id;
    item.left = op.left;
    item.right = op.right;
    item.kind = op.kind;
    item.scalar = op.kind == ItemKind::Text ? op.scalar : char32_t{0};
    item.tombstoned = false;

    const std::int64_t new_idx = static_cast<std::int64_t>(items_.size());
    items_.push_back(item);
    splice_after(boundary, new_idx);
    index_.emplace(op.id, new_idx);

    // Initial registers (block type on delimiters, initial marks on text).
    for (const InitialAttr& attr : op.initial_attrs) {
        Item& stored = at_index(new_idx);
        apply_register(stored, attr.name, attr.value, op.lamport, op.id.replica);
    }

    applied_.insert(op.id);
    note_integrated(op);
    retry_pending();
}

void Doc::integrate_delete(const Operation& op) {
    if (!op.target.has_value()) {
        throw CrdtError(ErrorCode::InvalidArgument, "delete without target");
    }
    const auto it = index_.find(*op.target);
    if (it == index_.end()) {
        // Delete-before-insert: retain as pending, apply on target arrival.
        if (pending_.size() >= kPendingLimit) {
            throw CrdtError(ErrorCode::PendingLimitExceeded, "pending operation buffer exhausted");
        }
        pending_.push_back(op);
        return;
    }
    at_index(it->second).tombstoned = true;
    applied_.insert(op.id);
    note_integrated(op);
    retry_pending();
}

void Doc::integrate_set_attr(const Operation& op) {
    if (!op.target.has_value()) {
        throw CrdtError(ErrorCode::InvalidArgument, "setattr without target");
    }
    const auto it = index_.find(*op.target);
    if (it == index_.end()) {
        if (pending_.size() >= kPendingLimit) {
            throw CrdtError(ErrorCode::PendingLimitExceeded, "pending operation buffer exhausted");
        }
        pending_.push_back(op);
        return;
    }
    Item& item = at_index(it->second);
    if (!AllowedAttrs::is_allowed(item.kind, op.attr_name)) {
        throw CrdtError(ErrorCode::UnknownAttributeName, "attribute not allowed on item kind: " + op.attr_name);
    }
    if (op.attr_value.has_value() &&
        !AllowedAttrs::is_allowed_value(item.kind, op.attr_name, *op.attr_value)) {
        throw CrdtError(ErrorCode::InvalidAttributeValue, "invalid value for " + op.attr_name);
    }
    apply_register(item, op.attr_name, op.attr_value, op.lamport, op.id.replica);
    applied_.insert(op.id);
    note_integrated(op);
    retry_pending();
}

void Doc::apply_register(Item& item, const std::string& name,
                         const std::optional<std::string>& value, Lamport lamport,
                         ReplicaId writer) {
    const auto it = item.attrs.find(name);
    if (it != item.attrs.end()) {
        const AttributeRegister& existing = it->second;
        // Deterministic LWW: strictly greater (lamport, writer) wins.
        if (std::make_pair(existing.lamport.value(), existing.writer.value()) >=
            std::make_pair(lamport.value(), writer.value())) {
            return;
        }
    }
    AttributeRegister reg;
    reg.value = value;
    reg.lamport = lamport;
    reg.writer = writer;
    item.attrs[name] = std::move(reg);
}

void Doc::retry_pending() {
    if (retrying_ || pending_.empty()) {
        return;
    }
    retrying_ = true;
    // Retry until no progress: pending ops may unblock each other.
    bool progress = true;
    while (progress) {
        progress = false;
        for (std::size_t i = 0; i < pending_.size();) {
            const Operation op = pending_[i];
            bool ready = false;
            switch (op.type) {
                case OpType::Insert: {
                    std::int64_t unused_left = 0;
                    std::int64_t unused_right = 0;
                    ready = resolve_anchor(op.left, unused_left) &&
                            resolve_anchor(op.right, unused_right);
                    break;
                }
                case OpType::Delete:
                case OpType::SetAttr:
                    ready = op.target.has_value() && index_.contains(*op.target);
                    break;
            }
            if (ready) {
                pending_.erase(pending_.begin() + static_cast<std::ptrdiff_t>(i));
                // apply_remote handles dedup (the op was never marked applied
                // while pending).
                if (apply_remote(op)) {
                    progress = true;
                }
            } else {
                i += 1;
            }
        }
    }
    retrying_ = false;
}

void Doc::note_integrated(const Operation& op) {
    lamport_ = Lamport{std::max(lamport_.value(), op.lamport.value())};
    // Fold the operation into the per-replica contiguous counter tracking.
    const auto replica_key = op.id.replica.value();
    const auto counter_value = op.id.counter.value();
    if (counter_value == contiguous_[replica_key] + 1) {
        contiguous_[replica_key] = counter_value;
        auto gap_it = gaps_.find(replica_key);
        if (gap_it != gaps_.end()) {
            while (gap_it->second.erase(contiguous_[replica_key] + 1) > 0) {
                contiguous_[replica_key] += 1;
            }
            if (gap_it->second.empty()) {
                gaps_.erase(gap_it);
            }
        }
    } else if (counter_value > contiguous_[replica_key] + 1) {
        gaps_[replica_key].insert(counter_value);
    }
    // (counter_value <= contiguous_: out-of-order counters are validated
    // upstream; treat as already-covered.)
}

// ---------------------------------------------------------------------------
// Structure maintenance
// ---------------------------------------------------------------------------

void Doc::splice_after(std::int64_t after, std::int64_t new_idx) {
    const std::int64_t before = (after == -1) ? head_ : at_index(after).next;
    at_index(new_idx).prev = after;
    at_index(new_idx).next = before;
    if (after == -1) {
        head_ = new_idx;
    } else {
        at_index(after).next = new_idx;
    }
    if (before == -1) {
        tail_ = new_idx;
    } else {
        at_index(before).prev = new_idx;
    }
    size_ += 1;
}

std::int64_t Doc::index_of(const std::optional<OpId>& id) const {
    if (!id.has_value()) {
        return -1;
    }
    const auto it = index_.find(*id);
    return it == index_.end() ? -1 : it->second;
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

StreamEntry Doc::make_entry(std::size_t position) const {
    std::int64_t cursor = head_;
    for (std::size_t i = 0; i < position; ++i) {
        cursor = at_index(cursor).next;
    }
    const Item& item = at_index(cursor);
    StreamEntry entry;
    entry.id = item.id;
    entry.kind = item.kind;
    entry.scalar = item.scalar;
    entry.tombstoned = item.tombstoned;
    for (const auto& [name, reg] : item.attrs) {
        if (reg.is_set()) {
            entry.attrs.emplace(name, *reg.value);
        }
    }
    return entry;
}

StreamEntry Doc::stream_entry(std::size_t index) const {
    if (index >= size_) {
        throw CrdtError(ErrorCode::InvalidArgument, "stream index out of range");
    }
    return make_entry(index);
}

std::vector<VisibleBlock> Doc::visible_document() const {
    std::vector<VisibleBlock> blocks;
    blocks.push_back(VisibleBlock{});
    blocks.back().type = AllowedAttrs::kDefaultBlockType;
    std::int64_t cursor = head_;
    while (cursor != -1) {
        const Item& item = at_index(cursor);
        if (!item.tombstoned) {
            if (item.kind == ItemKind::Delimiter) {
                VisibleBlock block;
                block.type = AllowedAttrs::kDefaultBlockType;
                for (const auto& [name, reg] : item.attrs) {
                    if (reg.is_set()) {
                        if (name == "type") {
                            block.type = *reg.value;
                        } else {
                            block.attrs.emplace(name, *reg.value);
                        }
                    }
                }
                blocks.push_back(std::move(block));
            } else {
                VisibleChar ch;
                ch.scalar = item.scalar;
                for (const auto& [name, reg] : item.attrs) {
                    if (reg.is_set()) {
                        ch.marks.emplace(name, *reg.value);
                    }
                }
                blocks.back().chars.push_back(std::move(ch));
            }
        }
        cursor = at_index(cursor).next;
    }
    return blocks;
}

void Doc::restore_allocation_state(std::uint64_t next_counter_value,
                                   std::uint64_t lamport_value) {
    if (Counter::is_valid(next_counter_value) && next_counter_value > next_counter_.value()) {
        next_counter_ = Counter{next_counter_value};
    }
    if (lamport_value <= Lamport::kMax && lamport_value > lamport_.value()) {
        lamport_ = Lamport{lamport_value};
    }
}

StateSummary Doc::state_summary() const {
    StateSummary summary;
    for (const auto& [replica_key, counter_value] : contiguous_) {
        summary.contiguous.emplace(replica_key, counter_value);
    }
    return summary;
}

DocDiagnostics Doc::diagnostics() const {
    DocDiagnostics diag;
    diag.replica_id = self_.value();
    diag.operation_count = applied_.size();
    diag.tombstone_count = 0;
    diag.visible_char_count = 0;
    diag.visible_block_count = 0;
    std::int64_t cursor = head_;
    while (cursor != -1) {
        const Item& item = at_index(cursor);
        if (item.tombstoned) {
            diag.tombstone_count += 1;
        } else if (item.kind == ItemKind::Text) {
            diag.visible_char_count += 1;
        } else {
            diag.visible_block_count += 1;
        }
        cursor = at_index(cursor).next;
    }
    diag.pending_count = pending_.size();
    diag.summary = state_summary();
    diag.canonical_digest = canonical_digest();
    return diag;
}

}  // namespace concord::crdt
