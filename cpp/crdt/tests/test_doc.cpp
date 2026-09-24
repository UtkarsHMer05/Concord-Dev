// P2-M010 + M018: document value model, generation APIs, canonical views.
#include "test_harness.hpp"

#include <string>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"

using namespace concord::crdt;

namespace {

std::string to_utf8(const std::vector<VisibleBlock>& blocks) {
    std::string out;
    for (const auto& block : blocks) {
        out += "[" + block.type + "]";
        for (const auto& ch : block.chars) {
            append_utf8(out, ch.scalar);
        }
    }
    return out;
}

}  // namespace

CONCORD_TEST(empty_document_view) {
    Doc doc(ReplicaId{1});
    const auto blocks = doc.visible_document();
    CHECK(blocks.size() == 1);          // implicit root block
    CHECK(blocks[0].type == "paragraph");
    CHECK(blocks[0].chars.empty());
    CHECK(doc.stream_size() == 0);
}

CONCORD_TEST(single_paragraph_text) {
    Doc doc(ReplicaId{1});
    const std::u32string text = U"hello";
    for (std::size_t i = 0; i < text.size(); ++i) {
        const Operation op = doc.local_insert_text(i, text[i]);
        CHECK(op.id.is_valid());
        CHECK(op.id.replica == ReplicaId{1});
        CHECK_EQ(op.id.counter.value(), i + 1);
    }
    const auto blocks = doc.visible_document();
    CHECK(blocks.size() == 1);
    CHECK(to_utf8(blocks) == "[paragraph]hello");
    CHECK(doc.stream_size() == 5);
    CHECK(doc.diagnostics().visible_char_count == 5);
}

CONCORD_TEST(multiple_blocks_and_types) {
    Doc doc(ReplicaId{1});
(void)    doc.local_insert_delimiter(0, "paragraph");   // block 1 delimiter (start)
    for (std::size_t i = 0; i < 3; ++i) (void)doc.local_insert_text(1 + i, U"abc"[i]);
(void)    doc.local_insert_delimiter(4, "heading-1");   // block 2 delimiter
(void)    doc.local_insert_text(5, U'x');

    const auto blocks = doc.visible_document();
    // The stream opens with a delimiter: it defines block 0 (no ghost root).
    CHECK(blocks.size() == 2);
    CHECK(blocks[0].type == "paragraph");
    CHECK(to_utf8(std::vector<VisibleBlock>{blocks[0]}) == "[paragraph]abc");
    CHECK(blocks[1].type == "heading-1");
    CHECK(to_utf8(std::vector<VisibleBlock>{blocks[1]}) == "[heading-1]x");
}

CONCORD_TEST(unicode_content) {
    Doc doc(ReplicaId{1});
    // 'é' U+00E9, '€' U+20AC, '😀' U+1F600, '日' U+65E5
    const std::vector<char32_t> scalars = {0x00E9, 0x20AC, 0x1F600, 0x65E5};
    for (std::size_t i = 0; i < scalars.size(); ++i) {
(void)        doc.local_insert_text(i, scalars[i]);
    }
    const auto blocks = doc.visible_document();
    CHECK(blocks.size() == 1);
    CHECK(blocks[0].chars.size() == 4);
    CHECK(blocks[0].chars[0].scalar == 0x00E9);
    CHECK(blocks[0].chars[1].scalar == 0x20AC);
    CHECK(blocks[0].chars[2].scalar == 0x1F600);
    CHECK(blocks[0].chars[3].scalar == 0x65E5);
}

CONCORD_TEST(rejects_invalid_scalars) {
    Doc doc(ReplicaId{1});
    CHECK_THROW(doc.local_insert_text(0, 0xD800), CrdtError);   // surrogate
    CHECK_THROW(doc.local_insert_text(0, 0x110000), CrdtError); // beyond range
    CHECK_THROW(doc.local_insert_text(0, 0), CrdtError);        // NUL
}

CONCORD_TEST(rejects_out_of_range_positions) {
    Doc doc(ReplicaId{1});
(void)    doc.local_insert_text(0, U'a');
    CHECK_THROW(doc.local_insert_text(2, U'b'), CrdtError);
    CHECK_THROW(doc.local_delete(1), CrdtError);
    CHECK_THROW(doc.local_set_attr(1, "bold", std::nullopt), CrdtError);
}

CONCORD_TEST(counter_and_lamport_allocation) {
    Doc doc(ReplicaId{9});
    const Operation a = doc.local_insert_text(0, U'a');
    const Operation b = doc.local_insert_text(1, U'b');
    CHECK_EQ(a.id.counter.value(), 1u);
    CHECK_EQ(b.id.counter.value(), 2u);
    CHECK_EQ(a.lamport.value(), 1u);
    CHECK_EQ(b.lamport.value(), 2u);
    CHECK_EQ(doc.state_summary().at(ReplicaId{9}), 2u);
}

CONCORD_TEST(block_attribute_registers) {
    Doc doc(ReplicaId{1});
    (void)doc.local_insert_delimiter(0, "heading-1");
    (void)doc.local_set_attr(0, "align", std::string{"center"});
    const auto entry = doc.stream_entry(0);
    CHECK(entry.attrs.at("type") == "heading-1");
    CHECK(entry.attrs.at("align") == "center");

    CHECK_THROW(doc.local_set_attr(0, "bold", std::string{"1"}), CrdtError);   // wrong kind
    (void)doc.local_set_attr(0, "align", std::nullopt);                        // clear
    const auto cleared = doc.stream_entry(0);
    CHECK(cleared.attrs.find("align") == cleared.attrs.end());
}

CONCORD_TEST(stream_export_matches_indexed_entries) {
    Doc doc(ReplicaId{1});
    (void)doc.local_insert_text(0, U'a');
    (void)doc.local_insert_delimiter(1, "heading-1");
    (void)doc.local_insert_text(2, U'b');
    (void)doc.local_set_attr(1, "align", std::string{"center"});
    (void)doc.local_delete(0);
    const auto entries = doc.stream_entries();
    CHECK_EQ(entries.size(), doc.stream_size());
    for (std::size_t i = 0; i < entries.size(); ++i) {
        CHECK(entries[i] == doc.stream_entry(i));
    }
}

CONCORD_TEST(text_mark_registers) {
    Doc doc(ReplicaId{1});
(void)    doc.local_insert_text(0, U'a');
(void)    doc.local_set_attr(0, "bold", std::string{"1"});
    CHECK(doc.stream_entry(0).attrs.at("bold") == "1");
    CHECK_THROW(doc.local_set_attr(0, "type", std::string{"heading-1"}), CrdtError);
    CHECK_THROW(doc.local_set_attr(0, "bold", std::string{"yes"}), CrdtError); // bad value
}
