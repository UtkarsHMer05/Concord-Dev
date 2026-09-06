// Canonical visible-document JSON rendering (shared native/WASM).
#include "concord/crdt/json.hpp"

#include <cstdio>

namespace concord::crdt {

namespace {
void append_json_escaped(std::string& out, const std::string& text) {
    for (const char ch : text) {
        if (static_cast<unsigned char>(ch) < 0x20) {
            char escape[8];
            std::snprintf(escape, sizeof(escape), "\\u%04x", ch);
            out += escape;
        } else {
            out += ch;
        }
    }
}

void append_json_string(std::string& out, const std::string& value) {
    out += '"';
    append_json_escaped(out, value);
    out += '"';
}
}  // namespace

std::string doc_to_json(const Doc& doc) {
    const auto blocks = doc.visible_document();
    std::string json;
    json.reserve(256);
    json += "{\"blocks\":[";
    bool first_block = true;
    for (const auto& block : blocks) {
        if (!first_block) {
            json += ",";
        }
        first_block = false;
        json += "{\"type\":";
        append_json_string(json, block.type);
        json += ",\"attrs\":{";
        bool first_attr = true;
        for (const auto& [name, value] : block.attrs) {
            if (!first_attr) {
                json += ",";
            }
            first_attr = false;
            append_json_string(json, name);
            json += ":";
            append_json_string(json, value);
        }
        json += "},\"runs\":[";
        // Group consecutive chars with identical marks into runs.
        bool first_run = true;
        for (std::size_t i = 0; i < block.chars.size();) {
            const auto& marks = block.chars[i].marks;
            std::string text;
            std::size_t j = i;
            while (j < block.chars.size() && block.chars[j].marks == marks) {
                append_utf8(text, block.chars[j].scalar);
                ++j;
            }
            if (!first_run) {
                json += ",";
            }
            first_run = false;
            json += "{\"t\":";
            append_json_string(json, text);
            json += ",\"m\":{";
            bool first_mark = true;
            for (const auto& [mark, value] : marks) {
                if (!first_mark) {
                    json += ",";
                }
                first_mark = false;
                append_json_string(json, mark);
                json += ":";
                append_json_string(json, value);
            }
            json += "}}";
            i = j;
        }
        json += "]}";
    }
    json += "]}";
    return json;
}

}  // namespace concord::crdt
