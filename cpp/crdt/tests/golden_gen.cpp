// P2-M032: native golden-vector generator.
//
// Builds a deterministic multi-replica scenario (Unicode text, concurrent
// inserts, deletes, delimiters, marks), serializes every operation, and emits
// a golden fixture (ops + expected visible JSON + expected digest) to stdout.
// The TypeScript parity test replays the same ops through the WASM engine and
// must match byte-for-byte.
//
// Output shape:
// {"ops":["<hex>","<hex>",...],"visible":<json>,"digest":"sha256:..."}
#include <algorithm>
#include <cstdio>
#include <optional>
#include <random>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/json.hpp"
#include "concord/crdt/serialize.hpp"

using namespace concord::crdt;

namespace {

std::string to_hex(const std::string& bytes) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (const char byte : bytes) {
        const auto u = static_cast<unsigned char>(byte);
        out.push_back(kHex[u >> 4]);
        out.push_back(kHex[u & 0x0Fu]);
    }
    return out;
}

void append_json_string(std::string& out, const std::string& value) {
    out += '"';
    for (const char ch : value) {
        if (ch == '"' || ch == '\\') {
            out += '\\';
        }
        out += ch;
    }
    out += '"';
}

}  // namespace

int main() {
    // Deterministic scenario:
    //   replica 1000 types "Hello w rld" (missing 'o'), replica 1001
    //   concurrently inserts 'o' at the gap and a heading delimiter; replica
    //   1002 adds marks and a delete. Delivery orders differ per replica.
    std::vector<Doc> docs;
    for (const std::uint64_t id : {1000u, 1001u, 1002u}) {
        docs.emplace_back(ReplicaId{id});
    }

    std::vector<Operation> ops;
    const auto record = [&ops](std::optional<Operation> op) {
        if (op.has_value()) {
            ops.push_back(std::move(*op));
        }
    };

    // 1000: "Hello w rld!" — 'W' capital, gap between 'w' and 'rld'.
    const std::u32string base = U"Hello w rld!";
    for (const char32_t c : base) {
        record(docs[0].local_insert_text(docs[0].stream_size(), c));
    }
    // 1000 sets a heading on... no delimiter yet; add one at the end.
    record(docs[0].local_insert_delimiter(docs[0].stream_size(), "paragraph"));

    // 1001: concurrent insert of 'o' into the gap ("w rld" → "world") — after
    // the item at index 8 ('w'), i.e. stream index 9, plus a delimiter.
    {
        Doc& doc = docs[1];
        for (const Operation& op : ops) {
            doc.apply_remote(op);
        }
        record(doc.local_insert_text(9, U'o'));
        record(doc.local_insert_delimiter(9, "heading-1"));
        record(doc.local_set_attr(1, "bold", std::string{"1"}));  // mark 'e'
    }

    // 1002: deletes the '!' and bolds 'H'.
    {
        Doc& doc = docs[2];
        // Deliver everything generated so far (its causal dependencies).
        for (const Operation& op : ops) {
            doc.apply_remote(op);
        }
        record(doc.local_delete(doc.stream_size() - 2));  // trailing '!'
        record(doc.local_set_attr(0, "bold", std::string{"1"}));
        record(doc.local_set_attr(0, "italic", std::string{"1"}));
    }

    // Every replica receives every op (shuffled per replica, deterministic).
    {
        std::mt19937_64 rng{20260906};
        for (auto& doc : docs) {
            std::vector<Operation> incoming = ops;
            std::shuffle(incoming.begin(), incoming.end(), rng);
            for (const Operation& op : incoming) {
                doc.apply_remote(op);
            }
        }
    }

    // All replicas must agree — the fixture bakes in the converged oracle.
    const std::string digest = docs[0].canonical_digest();
    const std::string visible = doc_to_json(docs[0]);
    for (const auto& doc : docs) {
        if (doc.canonical_digest() != digest || doc_to_json(doc) != visible) {
            std::fprintf(stderr, "golden scenario diverged — engine bug\n");
            return 1;
        }
    }

    // Emit the fixture.
    std::string out = "{\"ops\":[";
    bool first = true;
    for (const Operation& op : ops) {
        if (!first) {
            out += ",";
        }
        first = false;
        append_json_string(out, to_hex(serialize_operation(op)));
    }
    out += "],\"visible\":";
    out += visible;
    out += ",\"digest\":";
    append_json_string(out, digest);
    out += "}";
    std::printf("%s\n", out.c_str());
    return 0;
}
