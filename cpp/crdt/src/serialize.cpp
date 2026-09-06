// Canonical operation serialization (PROTOCOL §7).
#include "concord/crdt/serialize.hpp"

#include "concord/crdt/errors.hpp"
#include "concord/crdt/item.hpp"

namespace concord::crdt {

namespace {
constexpr std::size_t kMaxOpBytes = 64 * 1024;      // PROTOCOL §5
constexpr std::size_t kMaxAttrNameBytes = 64;
constexpr std::size_t kMaxAttrValueBytes = 256;

void put_id(std::string& out, const OpId& id) {
    put_u64_le(out, id.replica.value());
    put_u64_le(out, id.counter.value());
}

void put_opt_id(std::string& out, const std::optional<OpId>& id) {
    if (id.has_value()) {
        put_u8(out, 1);
        put_id(out, *id);
    } else {
        put_u8(out, 0);
    }
}

void put_string(std::string& out, const std::string& value) {
    if (value.size() > 0xFFFF) {
        throw CrdtError(ErrorCode::OpTooLarge, "string field too large");
    }
    put_u64_le(out, value.size());
    out.append(value);
}

bool get_id(const std::string& bytes, std::size_t& offset, OpId& out) {
    std::uint64_t replica = 0;
    std::uint64_t counter = 0;
    if (!get_u64_le(bytes, offset, replica) || !get_u64_le(bytes, offset, counter)) {
        return false;
    }
    out = OpId{ReplicaId{replica}, Counter{counter}};
    return true;
}

bool get_opt_id(const std::string& bytes, std::size_t& offset, std::optional<OpId>& out) {
    std::uint8_t flag = 0;
    if (!get_u8(bytes, offset, flag)) {
        return false;
    }
    if (flag == 0) {
        out = std::nullopt;
        return true;
    }
    if (flag != 1) {
        return false;
    }
    OpId id = OpId::null();
    if (!get_id(bytes, offset, id)) {
        return false;
    }
    out = id;
    return true;
}

bool get_string(const std::string& bytes, std::size_t& offset, std::string& out) {
    std::uint64_t length = 0;
    if (!get_u64_le(bytes, offset, length)) {
        return false;
    }
    if (length > kMaxAttrValueBytes * 4 || bytes.size() < offset + length) {
        return false;
    }
    out.assign(bytes, offset, static_cast<std::size_t>(length));
    offset += static_cast<std::size_t>(length);
    return true;
}

void validate_operation(const Operation& op) {
    if (!op.id.is_valid()) {
        throw CrdtError(ErrorCode::InvalidReplicaId, "operation id invalid");
    }
    if (!Lamport::is_valid(op.lamport.value())) {
        throw CrdtError(ErrorCode::InvalidLamport, "lamport out of range");
    }
}

}  // namespace

bool is_valid_utf8(const std::string& bytes) {
    std::size_t offset = 0;
    while (offset < bytes.size()) {
        bool ok = false;
        decode_utf8(bytes, offset, ok);
        if (!ok) {
            return false;
        }
    }
    return true;
}

std::string serialize_operation(const Operation& op) {
    validate_operation(op);
    std::string out;
    out.reserve(64);
    put_u8(out, kProtocolVersion);
    put_u8(out, static_cast<std::uint8_t>(op.type));
    put_id(out, op.id);
    put_u64_le(out, op.lamport.value());

    switch (op.type) {
        case OpType::Insert: {
            put_opt_id(out, op.left);
            put_opt_id(out, op.right);
            put_u8(out, static_cast<std::uint8_t>(op.kind));
            if (op.kind == ItemKind::Text) {
                std::string encoded;
                append_utf8(encoded, op.scalar);
                put_u8(out, static_cast<std::uint8_t>(encoded.size()));
                out.append(encoded);
            }
            if (op.initial_attrs.size() > 255) {
                throw CrdtError(ErrorCode::OpTooLarge, "too many initial attributes");
            }
            put_u8(out, static_cast<std::uint8_t>(op.initial_attrs.size()));
            for (const InitialAttr& attr : op.initial_attrs) {
                if (attr.name.size() > kMaxAttrNameBytes) {
                    throw CrdtError(ErrorCode::OpTooLarge, "attribute name too large");
                }
                put_string(out, attr.name);
                if (attr.value.has_value()) {
                    if (attr.value->size() > kMaxAttrValueBytes) {
                        throw CrdtError(ErrorCode::OpTooLarge, "attribute value too large");
                    }
                    put_u8(out, 1);
                    put_string(out, *attr.value);
                } else {
                    put_u8(out, 0);
                }
            }
            break;
        }
        case OpType::Delete: {
            if (!op.target.has_value()) {
                throw CrdtError(ErrorCode::InvalidArgument, "delete without target");
            }
            put_id(out, *op.target);
            break;
        }
        case OpType::SetAttr: {
            if (!op.target.has_value()) {
                throw CrdtError(ErrorCode::InvalidArgument, "setattr without target");
            }
            put_id(out, *op.target);
            if (op.attr_name.size() > kMaxAttrNameBytes) {
                throw CrdtError(ErrorCode::OpTooLarge, "attribute name too large");
            }
            put_string(out, op.attr_name);
            if (op.attr_value.has_value()) {
                if (op.attr_value->size() > kMaxAttrValueBytes) {
                    throw CrdtError(ErrorCode::OpTooLarge, "attribute value too large");
                }
                put_u8(out, 1);
                put_string(out, *op.attr_value);
            } else {
                put_u8(out, 0);
            }
            break;
        }
    }

    if (out.size() > kMaxOpBytes) {
        throw CrdtError(ErrorCode::OpTooLarge, "serialized operation exceeds limit");
    }
    return out;
}

Operation parse_operation(const std::string& bytes) {
    std::size_t offset = 0;
    std::uint8_t version = 0;
    std::uint8_t type = 0;
    if (!get_u8(bytes, offset, version)) {
        throw CrdtError(ErrorCode::MalformedFrame, "empty frame");
    }
    if (version != kProtocolVersion) {
        throw CrdtError(ErrorCode::UnsupportedVersion, "unsupported protocol version");
    }
    if (!get_u8(bytes, offset, type)) {
        throw CrdtError(ErrorCode::MalformedFrame, "missing op type");
    }

    Operation op;
    OpId id = OpId::null();
    std::uint64_t lamport = 0;
    if (!get_id(bytes, offset, id) || !get_u64_le(bytes, offset, lamport)) {
        throw CrdtError(ErrorCode::MalformedFrame, "truncated header");
    }
    if (!id.is_valid()) {
        throw CrdtError(ErrorCode::InvalidReplicaId, "operation id invalid");
    }
    if (!Lamport::is_valid(lamport)) {
        throw CrdtError(ErrorCode::InvalidLamport, "lamport out of range");
    }
    op.id = id;
    op.lamport = Lamport{lamport};

    switch (static_cast<OpType>(type)) {
        case OpType::Insert: {
            op.type = OpType::Insert;
            if (!get_opt_id(bytes, offset, op.left) || !get_opt_id(bytes, offset, op.right)) {
                throw CrdtError(ErrorCode::MalformedFrame, "truncated anchors");
            }
            std::uint8_t kind = 0;
            if (!get_u8(bytes, offset, kind)) {
                throw CrdtError(ErrorCode::MalformedFrame, "missing item kind");
            }
            if (kind != static_cast<std::uint8_t>(ItemKind::Text) &&
                kind != static_cast<std::uint8_t>(ItemKind::Delimiter)) {
                throw CrdtError(ErrorCode::MalformedFrame, "unknown item kind");
            }
            op.kind = static_cast<ItemKind>(kind);
            if (op.kind == ItemKind::Text) {
                std::uint8_t scalar_length = 0;
                if (!get_u8(bytes, offset, scalar_length) ||
                    scalar_length < 1 || scalar_length > 4 ||
                    bytes.size() < offset + scalar_length) {
                    throw CrdtError(ErrorCode::MalformedFrame, "bad scalar encoding");
                }
                std::string encoded = bytes.substr(offset, scalar_length);
                // The scalar must consume exactly scalar_length bytes.
                std::size_t decoded_offset = 0;
                bool ok = false;
                const char32_t scalar = decode_utf8(encoded, decoded_offset, ok);
                if (!ok || decoded_offset != scalar_length || scalar == 0) {
                    throw CrdtError(ErrorCode::InvalidUnicodeScalar, "invalid scalar in frame");
                }
                offset += scalar_length;
                op.scalar = scalar;
            }
            std::uint8_t attr_count = 0;
            if (!get_u8(bytes, offset, attr_count)) {
                throw CrdtError(ErrorCode::MalformedFrame, "missing attr count");
            }
            for (std::uint8_t i = 0; i < attr_count; ++i) {
                InitialAttr attr;
                if (!get_string(bytes, offset, attr.name)) {
                    throw CrdtError(ErrorCode::MalformedFrame, "bad attr name");
                }
                std::uint8_t has_value = 0;
                if (!get_u8(bytes, offset, has_value)) {
                    throw CrdtError(ErrorCode::MalformedFrame, "bad attr flag");
                }
                if (has_value == 1) {
                    std::string value;
                    if (!get_string(bytes, offset, value)) {
                        throw CrdtError(ErrorCode::MalformedFrame, "bad attr value");
                    }
                    attr.value = value;
                } else if (has_value != 0) {
                    throw CrdtError(ErrorCode::MalformedFrame, "bad attr flag");
                }
                op.initial_attrs.push_back(std::move(attr));
            }
            break;
        }
        case OpType::Delete: {
            op.type = OpType::Delete;
            OpId target = OpId::null();
            if (!get_id(bytes, offset, target)) {
                throw CrdtError(ErrorCode::MalformedFrame, "truncated delete target");
            }
            op.target = target;
            break;
        }
        case OpType::SetAttr: {
            op.type = OpType::SetAttr;
            OpId target = OpId::null();
            if (!get_id(bytes, offset, target)) {
                throw CrdtError(ErrorCode::MalformedFrame, "truncated setattr target");
            }
            op.target = target;
            if (!get_string(bytes, offset, op.attr_name)) {
                throw CrdtError(ErrorCode::MalformedFrame, "bad attr name");
            }
            std::uint8_t has_value = 0;
            if (!get_u8(bytes, offset, has_value)) {
                throw CrdtError(ErrorCode::MalformedFrame, "bad attr flag");
            }
            if (has_value == 1) {
                std::string value;
                if (!get_string(bytes, offset, value)) {
                    throw CrdtError(ErrorCode::MalformedFrame, "bad attr value");
                }
                op.attr_value = value;
            } else if (has_value != 0) {
                throw CrdtError(ErrorCode::MalformedFrame, "bad attr flag");
            }
            break;
        }
        default:
            throw CrdtError(ErrorCode::UnknownOpType, "unknown op type");
    }

    if (offset != bytes.size()) {
        throw CrdtError(ErrorCode::MalformedFrame, "trailing bytes after operation");
    }
    return op;
}

std::string serialize_batch(const std::vector<Operation>& ops) {
    if (ops.size() > kMaxBatchSize) {
        throw CrdtError(ErrorCode::OpTooLarge, "batch exceeds size limit");
    }
    std::string out;
    put_u32_le(out, static_cast<std::uint32_t>(ops.size()));
    for (const Operation& op : ops) {
        const std::string encoded = serialize_operation(op);
        put_u32_le(out, static_cast<std::uint32_t>(encoded.size()));
        out.append(encoded);
    }
    return out;
}

std::vector<Operation> parse_batch(const std::string& bytes) {
    std::size_t offset = 0;
    std::uint32_t count = 0;
    if (!get_u32_le(bytes, offset, count)) {
        throw CrdtError(ErrorCode::MalformedFrame, "truncated batch header");
    }
    if (count > kMaxBatchSize) {
        throw CrdtError(ErrorCode::OpTooLarge, "batch exceeds size limit");
    }
    std::vector<Operation> ops;
    ops.reserve(count);
    for (std::uint32_t i = 0; i < count; ++i) {
        std::uint32_t length = 0;
        if (!get_u32_le(bytes, offset, length)) {
            throw CrdtError(ErrorCode::MalformedFrame, "truncated batch entry");
        }
        if (bytes.size() < offset + length) {
            throw CrdtError(ErrorCode::MalformedFrame, "batch entry exceeds frame");
        }
        ops.push_back(parse_operation(bytes.substr(offset, length)));
        offset += length;
    }
    if (offset != bytes.size()) {
        throw CrdtError(ErrorCode::MalformedFrame, "trailing bytes after batch");
    }
    return ops;
}

}  // namespace concord::crdt
