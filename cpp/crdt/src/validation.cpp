// Shared operation validation entry points (P2-M015).
//
// The engine validates during integration; these helpers expose the same
// rules for callers that need to pre-screen input (worker boundary, tests,
// fuzz harnesses). Validation is total: any operation rejected here would
// also be rejected by Doc::apply_remote.
#include "concord/crdt/validation.hpp"

#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"

namespace concord::crdt {

void validate_operation(const Operation& op) {
    if (!op.id.is_valid()) {
        throw CrdtError(ErrorCode::InvalidReplicaId, "operation id invalid");
    }
    if (!Lamport::is_valid(op.lamport.value())) {
        throw CrdtError(ErrorCode::InvalidLamport, "lamport out of range");
    }
    switch (op.type) {
        case OpType::Insert: {
            if (op.kind == ItemKind::Text) {
                if (op.scalar == 0 || (op.scalar >= 0xD800 && op.scalar <= 0xDFFF) ||
                    op.scalar > 0x10FFFF) {
                    throw CrdtError(ErrorCode::InvalidUnicodeScalar, "invalid scalar");
                }
            }
            for (const InitialAttr& attr : op.initial_attrs) {
                if (!AllowedAttrs::is_allowed(op.kind, attr.name)) {
                    throw CrdtError(ErrorCode::UnknownAttributeName,
                                    "attribute not allowed on item kind: " + attr.name);
                }
                if (attr.value.has_value() &&
                    !AllowedAttrs::is_allowed_value(op.kind, attr.name, *attr.value)) {
                    throw CrdtError(ErrorCode::InvalidAttributeValue,
                                    "invalid value for " + attr.name);
                }
            }
            break;
        }
        case OpType::Delete:
        case OpType::SetAttr:
            if (!op.target.has_value()) {
                throw CrdtError(ErrorCode::InvalidArgument, "targeted op without target");
            }
            if (!op.target->is_valid()) {
                throw CrdtError(ErrorCode::InvalidArgument, "target id invalid");
            }
            break;
    }
}

Operation parse_validated_operation(const std::string& bytes) {
    Operation op = parse_operation(bytes);
    validate_operation(op);
    return op;
}

}  // namespace concord::crdt
