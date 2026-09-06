// Structured errors implementation.
#include "concord/crdt/errors.hpp"

namespace concord::crdt {

const char* error_code_name(ErrorCode code) {
    switch (code) {
        case ErrorCode::Ok: return "Ok";
        case ErrorCode::UnsupportedVersion: return "UnsupportedVersion";
        case ErrorCode::UnknownOpType: return "UnknownOpType";
        case ErrorCode::InvalidReplicaId: return "InvalidReplicaId";
        case ErrorCode::InvalidCounter: return "InvalidCounter";
        case ErrorCode::InvalidLamport: return "InvalidLamport";
        case ErrorCode::InvalidUnicodeScalar: return "InvalidUnicodeScalar";
        case ErrorCode::InvalidString: return "InvalidString";
        case ErrorCode::UnknownAttributeName: return "UnknownAttributeName";
        case ErrorCode::InvalidAttributeValue: return "InvalidAttributeValue";
        case ErrorCode::OpTooLarge: return "OpTooLarge";
        case ErrorCode::MalformedFrame: return "MalformedFrame";
        case ErrorCode::SnapshotVersionUnsupported: return "SnapshotVersionUnsupported";
        case ErrorCode::PendingLimitExceeded: return "PendingLimitExceeded";
        case ErrorCode::CounterOverflow: return "CounterOverflow";
        case ErrorCode::InvalidArgument: return "InvalidArgument";
        case ErrorCode::StateCorruption: return "StateCorruption";
    }
    return "Unknown";
}

}  // namespace concord::crdt
