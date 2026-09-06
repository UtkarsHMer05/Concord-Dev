// Canonical document value model: items, attributes, blocks (DEC-023,
// docs/PROTOCOL.md §2).
#pragma once

#include <cassert>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "concord/crdt/ids.hpp"

namespace concord::crdt {

enum class ItemKind : std::uint8_t {
    Text = 1,
    Delimiter = 2,
};

// Attribute/mark names allowed per item kind (PROTOCOL §5 registry).
// Values are short strings; cleared = register tombstone (value ignored).
struct AllowedAttrs {
    static bool is_allowed(ItemKind kind, const std::string& name) {
        if (kind == ItemKind::Text) {
            return name == "bold" || name == "italic" || name == "underline" ||
                   name == "strikethrough";
        }
        return name == "type" || name == "align";
    }

    static bool is_allowed_value(ItemKind kind, const std::string& name,
                                 const std::string& value) {
        if (kind == ItemKind::Text) {
            return value == "1";
        }
        if (name == "type") {
            return value == "paragraph" || value == "heading-1" || value == "heading-2" ||
                   value == "heading-3" || value == "heading-4" || value == "heading-5" ||
                   value == "heading-6";
        }
        if (name == "align") {
            return value == "left" || value == "center" || value == "right" ||
                   value == "justify";
        }
        return false;
    }

    // Block type applied to a fresh delimiter when no explicit attribute is
    // given.
    static constexpr const char* kDefaultBlockType = "paragraph";
};

// One attribute register: current winning value + the logical order key that
// produced it. Deterministic LWW: a write wins iff (lamport, writer) is
// strictly greater than the stored key.
struct AttributeRegister {
    std::optional<std::string> value;  // nullopt = cleared
    Lamport lamport{0};
    ReplicaId writer{0};

    [[nodiscard]] bool is_set() const noexcept { return value.has_value(); }

    friend constexpr bool operator==(const AttributeRegister&,
                                     const AttributeRegister&) = default;
};

using AttrMap = std::map<std::string, AttributeRegister>;  // ordered → canonical iteration

// A single item in the document sequence. Items are never removed (tombstone
// model); `prev`/`next` are document-owned vector indices (-1 = none).
struct Item {
    OpId id;
    std::optional<OpId> left;   // left origin anchor (PROTOCOL §3.1)
    std::optional<OpId> right;  // right origin anchor
    ItemKind kind = ItemKind::Text;
    char32_t scalar = 0;  // valid when kind == Text (Unicode scalar, no surrogates)
    bool tombstoned = false;
    AttrMap attrs;
    std::int64_t prev = -1;
    std::int64_t next = -1;
};

// ---------------------------------------------------------------------------
// Derived canonical views (what the rest of the app consumes).
// ---------------------------------------------------------------------------

struct VisibleChar {
    char32_t scalar = 0;
    std::map<std::string, std::string> marks;  // set mark name → value

    friend bool operator==(const VisibleChar&, const VisibleChar&) = default;
};

struct VisibleBlock {
    std::string type;                          // e.g. "paragraph", "heading-1"
    std::map<std::string, std::string> attrs;  // non-type block attributes
    std::vector<VisibleChar> chars;

    friend bool operator==(const VisibleBlock&, const VisibleBlock&) = default;
};

// Encode one Unicode scalar as UTF-8 (1–4 bytes). Scalar must be valid
// (validated upstream); this is a pure deterministic encoder.
inline void append_utf8(std::string& out, char32_t scalar) {
    assert(!(scalar >= 0xD800 && scalar <= 0xDFFF));  // surrogates rejected upstream
    if (scalar <= 0x7F) {
        out.push_back(static_cast<char>(scalar));
    } else if (scalar <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | (scalar >> 6)));
        out.push_back(static_cast<char>(0x80 | (scalar & 0x3F)));
    } else if (scalar <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | (scalar >> 12)));
        out.push_back(static_cast<char>(0x80 | ((scalar >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (scalar & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (scalar >> 18)));
        out.push_back(static_cast<char>(0x80 | ((scalar >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((scalar >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (scalar & 0x3F)));
    }
}

// Decode one UTF-8 scalar starting at offset; advances offset. Returns 0 with
// `ok=false` on malformed input (strict: no overlongs, no surrogates, no
// > U+10FFFF).
inline char32_t decode_utf8(const std::string& bytes, std::size_t& offset, bool& ok) {
    ok = true;
    if (offset >= bytes.size()) {
        ok = false;
        return 0;
    }
    const auto b0 = static_cast<unsigned char>(bytes[offset]);
    if (b0 < 0x80) {
        offset += 1;
        return b0;
    }
    std::size_t length = 0;
    char32_t scalar = 0;
    if ((b0 & 0xE0) == 0xC0) {
        length = 2;
        scalar = b0 & 0x1Fu;
    } else if ((b0 & 0xF0) == 0xE0) {
        length = 3;
        scalar = b0 & 0x0Fu;
    } else if ((b0 & 0xF8) == 0xF0) {
        length = 4;
        scalar = b0 & 0x07u;
    } else {
        ok = false;
        return 0;
    }
    if (offset + length > bytes.size()) {
        ok = false;
        return 0;
    }
    for (std::size_t i = 1; i < length; ++i) {
        const auto cont = static_cast<unsigned char>(bytes[offset + i]);
        if ((cont & 0xC0) != 0x80) {
            ok = false;
            return 0;
        }
        scalar = (scalar << 6) | (cont & 0x3Fu);
    }
    offset += length;
    if ((length == 2 && scalar < 0x80) || (length == 3 && scalar < 0x800) ||
        (length == 4 && scalar < 0x10000) || (scalar >= 0xD800 && scalar <= 0xDFFF) ||
        scalar > 0x10FFFF) {
        ok = false;
        return 0;
    }
    return scalar;
}

}  // namespace concord::crdt
