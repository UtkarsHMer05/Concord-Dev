// Canonical visible-document JSON rendering.
//
// Shared by the WASM binding (browser reads) and the native golden-vector
// generator — one writer guarantees native/WASM byte-identical output.
#pragma once

#include <string>

#include "concord/crdt/doc.hpp"

namespace concord::crdt {

// {"blocks":[{"type":"paragraph","attrs":{...},"runs":[{"t":"...","m":{...}}]}]}
[[nodiscard]] std::string doc_to_json(const Doc& doc);

}  // namespace concord::crdt
