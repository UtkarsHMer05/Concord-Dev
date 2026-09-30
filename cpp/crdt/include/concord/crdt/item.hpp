// Canonical document value model: items, attributes, blocks (DEC-023,
// docs/PROTOCOL.md §2).
#pragma once

#include <cassert>
#include <algorithm>
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
                   name == "strikethrough" || name == "code" || name == "link" ||
                   name == "linkTarget" || name == "linkRel" || name == "color" ||
                   name == "fontFamily" || name == "fontSize" || name == "highlight";
        }
        // `lineHeight` completes the registry to match the product editor and
        // the TypeScript adapter (pm-model.ts) — values are a fixed set.
        return name == "type" || name == "align" || name == "lineHeight" ||
               name == "list" || name == "depth" || name == "checked" ||
               name == "listStart" || name == "contentType";
    }

    static bool is_allowed_value(ItemKind kind, const std::string& name,
                                 const std::string& value) {
        if (value.empty() || value.size() > 256 || std::any_of(value.begin(), value.end(),
                [](unsigned char ch) { return ch < 0x20 || ch == 0x7f; })) return false;
        if (kind == ItemKind::Text) {
            const auto ascii_alnum = [](unsigned char ch) {
                return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
                       (ch >= '0' && ch <= '9');
            };
            if (name == "link") {
                std::string lower = value;
                for (char& ch : lower) if (ch >= 'A' && ch <= 'Z') ch += 'a' - 'A';
                const bool scheme = lower.starts_with("https://") || lower.starts_with("http://") ||
                    lower.starts_with("mailto:") || lower.starts_with("tel:") ||
                    (lower.starts_with('/') && !lower.starts_with("//")) || lower.starts_with('#');
                return scheme && value.find_first_of(" <>\\\t\r\n") == std::string::npos;
            }
            if (name == "linkTarget") return value == "_blank" || value == "_self" || value == "_parent" || value == "_top";
            if (name == "linkRel") {
                std::size_t start = 0;
                while (start < value.size()) {
                    const auto end = value.find(' ', start);
                    const auto token = value.substr(start, end == std::string::npos ? end : end - start);
                    if (token != "noopener" && token != "noreferrer" && token != "nofollow") return false;
                    if (end == std::string::npos) return true;
                    start = end + 1;
                }
                return false;
            }
            if (name == "fontSize") {
                if (!value.ends_with("px")) return false;
                const auto number = value.substr(0, value.size() - 2);
                const auto dot = number.find('.');
                const auto whole = number.substr(0, dot);
                if (whole.empty() || whole.size() > 3 || whole[0] == '0') return false;
                if (dot != std::string::npos && (number.size() - dot - 1 < 1 || number.size() - dot - 1 > 2)) return false;
                for (std::size_t i = 0; i < number.size(); ++i)
                    if (i != dot && (number[i] < '0' || number[i] > '9')) return false;
                return std::stod(number) <= 400;
            }
            if (name == "fontFamily" || name == "color" || name == "highlight") {
                const std::string punctuation = name == "fontFamily" ? " ,'\"-" : "#(),.% -";
                return std::all_of(value.begin(), value.end(), [&](unsigned char ch) {
                    return ascii_alnum(ch) || punctuation.find(static_cast<char>(ch)) != std::string::npos;
                });
            }
            return is_allowed(kind, name) && value == "1";
        }
        if (name == "type" || name == "contentType") {
            return value == "paragraph" || value == "heading-1" || value == "heading-2" ||
                   value == "heading-3" || value == "heading-4" || value == "heading-5" ||
                   value == "heading-6" || (name == "type" && (value == "list-item" || value == "list-continuation"));
        }
        if (name == "list") return value == "bullet" || value == "ordered" || value == "task";
        if (name == "depth") return value.size() == 1 && value[0] >= '0' && value[0] <= '8';
        if (name == "checked") return value == "yes" || value == "no";
        if (name == "listStart") return value.size() <= 6 && value[0] >= '1' && value[0] <= '9' &&
            std::all_of(value.begin(), value.end(), [](char ch) { return ch >= '0' && ch <= '9'; });
        if (name == "align") {
            return value == "left" || value == "center" || value == "right" ||
                   value == "justify";
        }
        if (name == "lineHeight") {
            // The product toolbar's fixed value set (toolbar.tsx lineHeights).
            return value == "normal" || value == "1" || value == "1.15" ||
                   value == "1.5" || value == "2";
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
