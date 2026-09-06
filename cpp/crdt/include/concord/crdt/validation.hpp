// Pre-screening validation (P2-M015) — same rules the engine applies during
// integration, exposed for worker/fuzz/test boundaries.
#pragma once

#include "concord/crdt/op.hpp"

namespace concord::crdt {

// Throws CrdtError with a structured code when the operation is invalid.
void validate_operation(const Operation& op);

// Parse + validate in one step (decode errors are structured too).
[[nodiscard]] Operation parse_validated_operation(const std::string& bytes);

}  // namespace concord::crdt
