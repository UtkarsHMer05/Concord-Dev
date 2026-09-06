// Structured error handling for the Concord CRDT core.
//
// Every failure crossing the API boundary is an explicit code — never an
// assertion, never silent acceptance of malformed input (PROTOCOL §5).
#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>

namespace concord::crdt {

enum class ErrorCode : std::uint8_t {
    Ok = 0,
    UnsupportedVersion,
    UnknownOpType,
    InvalidReplicaId,
    InvalidCounter,
    InvalidLamport,
    InvalidUnicodeScalar,
    InvalidString,
    UnknownAttributeName,
    InvalidAttributeValue,
    OpTooLarge,
    MalformedFrame,
    SnapshotVersionUnsupported,
    PendingLimitExceeded,
    CounterOverflow,
    InvalidArgument,
    StateCorruption,
};

const char* error_code_name(ErrorCode code);

class CrdtError final : public std::runtime_error {
public:
    CrdtError(ErrorCode code, const std::string& message)
        : std::runtime_error(std::string(error_code_name(code)) + ": " + message),
          code_(code) {}

    [[nodiscard]] ErrorCode code() const noexcept { return code_; }

private:
    ErrorCode code_;
};

}  // namespace concord::crdt
