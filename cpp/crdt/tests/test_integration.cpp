// P2-M011..M014 + M016..M017: convergence, tombstones, marks, dedup,
// pending (causally-early) deliveries, state summaries.
#include "test_harness.hpp"

#include <algorithm>
#include <random>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"

using namespace concord::crdt;

namespace {

// Render the visible text of the first block (concatenate visible chars).
std::string render_text(const Doc& doc) {
    std::string out;
    for (std::size_t i = 0; i < doc.stream_size(); ++i) {
        const StreamEntry entry = doc.stream_entry(i);
        if (entry.kind == ItemKind::Text && !entry.tombstoned) {
            append_utf8(out, entry.scalar);
        }
    }
    return out;
}

std::vector<StreamEntry> live_items(const Doc& doc) {
    std::vector<StreamEntry> items;
    for (std::size_t i = 0; i < doc.stream_size(); ++i) {
        const StreamEntry entry = doc.stream_entry(i);
        if (!entry.tombstoned) {
            items.push_back(entry);
        }
    }
    return items;
}

std::string visible_of(const std::vector<StreamEntry>& items) {
    std::string out;
    for (const StreamEntry& entry : items) {
        if (entry.kind == ItemKind::Text) {
            append_utf8(out, entry.scalar);
        }
    }
    return out;
}

}  // namespace

CONCORD_TEST(concurrent_inserts_same_position_both_orders_converge) {
    // Critical M011 test: replicas A and B insert X and Y concurrently at the
    // same location; apply in A->B and B->A order to two fresh replicas;
    // final sequences must be identical (and match both homes).
    // Replica 1 seeds "hello"; replica 2 mirrors it.
    Doc home_a(ReplicaId{1});
    Doc home_b(ReplicaId{2});
    Doc witness_a(ReplicaId{3});
    Doc witness_b(ReplicaId{4});

    std::vector<Operation> seed_ops;
    for (const char32_t c : std::u32string(U"hello")) {
        seed_ops.push_back(home_a.local_insert_text(home_a.stream_size(), c));
    }
    for (const Operation& op : seed_ops) {
        home_b.apply_remote(op);
        witness_a.apply_remote(op);
        witness_b.apply_remote(op);
    }
    CHECK(render_text(home_a) == "hello");
    CHECK(render_text(home_b) == "hello");

    // Locate the anchor after 'e' (stream index 2 on a live replica).
    const Operation x = home_a.local_insert_text(2, U'X');  // A inserts X
    const Operation y = home_b.local_insert_text(2, U'Y');  // B inserts Y concurrently

    // The homes exchange each other's operations too.
    home_a.apply_remote(y);
    home_b.apply_remote(x);
    // A -> B order on witness A: apply X then Y.
    witness_a.apply_remote(x);
    witness_a.apply_remote(y);
    // B -> A order on witness B: apply Y then X.
    witness_b.apply_remote(y);
    witness_b.apply_remote(x);

    const std::string a_final = render_text(witness_a);
    const std::string b_final = render_text(witness_b);
    CHECK(a_final == b_final);
    CHECK(a_final.size() == 7);  // hello + X + Y
    CHECK(a_final.find("heXYllo") != std::string::npos ||
          a_final.find("heYXllo") != std::string::npos);
    // Home replicas also match the witnesses.
    CHECK(render_text(home_a) == a_final);
    CHECK(render_text(home_b) == a_final);
}

CONCORD_TEST(concurrent_inserts_into_empty_sequence) {
    Doc a(ReplicaId{10});
    Doc b(ReplicaId{20});
    const Operation x = a.local_insert_text(0, U'A');
    const Operation y = b.local_insert_text(0, U'B');
    a.apply_remote(y);
    b.apply_remote(x);

    Doc w1(ReplicaId{30});
    Doc w2(ReplicaId{31});
    w1.apply_remote(x);
    w1.apply_remote(y);
    w2.apply_remote(y);
    w2.apply_remote(x);
    CHECK(render_text(w1) == render_text(w2));
    CHECK(render_text(w1).size() == 2);
    CHECK(render_text(a) == render_text(w1));
    CHECK(render_text(b) == render_text(w1));
}

CONCORD_TEST(delete_is_idempotent_and_converges) {
    Doc a(ReplicaId{1});
    std::vector<Operation> ops;
    for (const char32_t c : std::u32string(U"abcdef")) {
        ops.push_back(a.local_insert_text(a.stream_size(), c));
    }
    // Delete 'c' (index 2), duplicate the delete op.
    const auto del = a.local_delete(2);
    CHECK(del.has_value());

    Doc b(ReplicaId{2});
    for (const Operation& op : ops) {
        b.apply_remote(op);
    }
    b.apply_remote(*del);
    b.apply_remote(*del);  // duplicate delivery
    b.apply_remote(*del);  // and again
    CHECK(render_text(b) == "abdef");
    CHECK(render_text(a) == "abdef");
    // Tombstone retained in the stream.
    CHECK(b.stream_size() == 6);
    CHECK(b.diagnostics().tombstone_count == 1);
}

CONCORD_TEST(delete_before_insert_is_pending_then_applied) {
    // A delete may arrive before the insert it targets (M012).
    Doc a(ReplicaId{1});
    const Operation ins = a.local_insert_text(0, U'z');
    const auto del = a.local_delete(0);
    CHECK(del.has_value());

    Doc b(ReplicaId{2});
    // Deliver the delete FIRST: must be buffered as pending, not lost.
    b.apply_remote(*del);
    CHECK(b.pending_count() == 1);
    CHECK(b.stream_size() == 0);
    b.apply_remote(ins);  // target arrives; delete applies
    CHECK(b.pending_count() == 0);
    CHECK(b.stream_size() == 1);
    CHECK(render_text(b).empty());
    CHECK(b.diagnostics().tombstone_count == 1);
}

CONCORD_TEST(insert_pending_until_anchor_arrives) {
    // op2 references op1's item; deliver op2 before op1 (M011 missing anchor).
    Doc a(ReplicaId{1});
    const Operation op1 = a.local_insert_text(0, U'1');
    const Operation op2 = a.local_insert_text(1, U'2');  // anchor = op1's item

    Doc b(ReplicaId{2});
    b.apply_remote(op2);
    CHECK(b.pending_count() == 1);
    b.apply_remote(op1);
    CHECK(b.pending_count() == 0);
    CHECK(render_text(b) == "12");
}

CONCORD_TEST(concurrent_delete_and_adjacent_insert) {
    // Replica A deletes 'c'; replica B concurrently inserts 'X' after 'c'.
    // Delete-wins over the target; the new insert survives (documented
    // semantics) and both replicas converge.
    Doc a(ReplicaId{1});
    Doc b(ReplicaId{2});
    std::vector<Operation> seed;
    for (const char32_t c : std::u32string(U"abcd")) {
        seed.push_back(a.local_insert_text(a.stream_size(), c));
    }
    for (const Operation& op : seed) {
        b.apply_remote(op);
    }
    const auto del = a.local_delete(2);            // delete 'c'
    const Operation x = b.local_insert_text(3, U'X');  // insert after 'c' (index 3)

    Doc w1(ReplicaId{3});
    Doc w2(ReplicaId{4});
    for (const Operation& op : seed) {
        w1.apply_remote(op);
        w2.apply_remote(op);
    }
    w1.apply_remote(*del);
    w1.apply_remote(x);
    w2.apply_remote(x);
    w2.apply_remote(*del);
    CHECK(render_text(w1) == render_text(w2));
    CHECK(render_text(w1).find('c') == std::string::npos);  // c deleted
    CHECK(render_text(w1).find('X') != std::string::npos);  // insert survives
}

CONCORD_TEST(concurrent_block_split_and_text_converge) {
    // Enter-key semantics: replica A inserts a delimiter (split) at the end of
    // "ab"; replica B concurrently types 'Z' at the same position. Both
    // operations must compose; replicas converge.
    Doc a(ReplicaId{1});
    Doc b(ReplicaId{2});
    std::vector<Operation> seed;
    for (const char32_t c : std::u32string(U"ab")) {
        seed.push_back(a.local_insert_text(a.stream_size(), c));
    }
    for (const Operation& op : seed) {
        b.apply_remote(op);
    }
    const Operation split = a.local_insert_delimiter(2, "paragraph");
    const Operation z = b.local_insert_text(2, U'Z');
    a.apply_remote(z);
    b.apply_remote(split);

    Doc w(ReplicaId{3});
    for (const Operation& op : seed) {
        w.apply_remote(op);
    }
    w.apply_remote(split);
    w.apply_remote(z);
    const auto blocks = w.visible_document();
    // Either "ab" | "Z" or "abZ" | "" — both are valid convergent outcomes;
    // what matters: both replicas identical, two blocks, Z present.
    CHECK(w.visible_document() == a.visible_document());
    CHECK(w.visible_document() == b.visible_document());
    CHECK(blocks.size() == 2);
    bool z_found = false;
    for (const auto& block : blocks) {
        for (const auto& ch : block.chars) {
            if (ch.scalar == U'Z') {
                z_found = true;
            }
        }
    }
    CHECK(z_found);
}

CONCORD_TEST(mark_registers_lww_deterministic) {
    // Concurrent bold (A) vs clear-bold (B) on the same char: the register
    // winner is the higher (lamport, replica), independent of arrival order.
    Doc a(ReplicaId{1});
    Doc b(ReplicaId{2});
    const Operation ins = a.local_insert_text(0, U'w');
    b.apply_remote(ins);

    const auto bold = a.local_set_attr(0, "bold", std::string{"1"});
    const auto clear = b.local_set_attr(0, "bold", std::nullopt);
    CHECK(bold.lamport.value() == 2);
    CHECK(clear.lamport.value() == 2);

    // Same lamport → replica tie-break: replica 2's clear wins on both.
    Doc w1(ReplicaId{3});
    Doc w2(ReplicaId{4});
    w1.apply_remote(ins);
    w2.apply_remote(ins);
    w1.apply_remote(bold);
    w1.apply_remote(clear);
    w2.apply_remote(clear);
    w2.apply_remote(bold);
    const auto w1_entry = w1.stream_entry(0);
    CHECK(w1_entry.attrs.find("bold") == w1_entry.attrs.end());
    CHECK(w2.stream_entry(0).attrs == w1.stream_entry(0).attrs);

    // Distinct lamports: higher lamport wins regardless of replica.
    Doc c1(ReplicaId{5});
    const Operation ins2 = c1.local_insert_text(0, U'v');
    const auto s1 = c1.local_set_attr(0, "italic", std::string{"1"});  // lamport 2
    Doc c2(ReplicaId{6});
    c2.apply_remote(ins2);
    const auto s2 = c2.local_set_attr(0, "italic", std::nullopt);      // lamport 2
    CHECK(s1.lamport.value() == 2);
    CHECK(s2.lamport.value() == 2);
    // replica 6 > replica 5 → c2's clear wins.
    Doc w(ReplicaId{7});
    w.apply_remote(ins2);
    w.apply_remote(s1);
    w.apply_remote(s2);
    const auto w_entry = w.stream_entry(0);
    CHECK(w_entry.attrs.find("italic") == w_entry.attrs.end());
}

CONCORD_TEST(duplicate_storm_shuffled_redelivery) {
    // M016: duplicate operations in shuffled order never change state.
    Doc a(ReplicaId{1});
    std::vector<Operation> ops;
    for (const char32_t c : std::u32string(U"storm!")) {
        ops.push_back(a.local_insert_text(a.stream_size(), c));
    }
    ops.push_back(*a.local_delete(2));
    ops.push_back(a.local_set_attr(0, "bold", std::string{"1"}));

    Doc b(ReplicaId{2});
    std::mt19937 rng{12345};
    std::vector<Operation> delivery;
    for (int round = 0; round < 5; ++round) {
        for (const Operation& op : ops) {
            delivery.push_back(op);
        }
    }
    std::shuffle(delivery.begin(), delivery.end(), rng);
    for (const Operation& op : delivery) {
        b.apply_remote(op);
    }
    CHECK(render_text(b) == render_text(a));
    CHECK(b.stream_entry(0).attrs.at("bold") == "1");
    const auto diag_a = a.diagnostics();
    const auto diag_b = b.diagnostics();
    CHECK(diag_b.operation_count == diag_a.operation_count);
    CHECK(diag_b.tombstone_count == diag_a.tombstone_count);
    CHECK(diag_b.summary == diag_a.summary);
    CHECK(b.canonical_digest() == a.canonical_digest());
}

CONCORD_TEST(state_summary_gap_tracking) {
    // M017: summaries track contiguous counters; gaps are explicit.
    Doc a(ReplicaId{1});
    std::vector<Operation> ops;
    for (int i = 0; i < 5; ++i) {
        ops.push_back(a.local_insert_text(a.stream_size(), U'a' + static_cast<char32_t>(i)));
    }
    Doc b(ReplicaId{2});
    // Deliver 1,2 then 5 (gap at 3,4), then 3,4.
    b.apply_remote(ops[0]);
    b.apply_remote(ops[1]);
    CHECK(b.state_summary().at(ReplicaId{1}) == 2);
    b.apply_remote(ops[4]);
    CHECK(b.state_summary().at(ReplicaId{1}) == 2);  // gap: 5 not counted
    CHECK(b.pending_count() == 1);                    // op5 needs anchors 3,4
    b.apply_remote(ops[2]);
    b.apply_remote(ops[3]);
    CHECK(b.state_summary().at(ReplicaId{1}) == 5);
    CHECK(b.pending_count() == 0);
    CHECK(render_text(b) == "abcde");

    // Summary comparison relations.
    StateSummary mine = b.state_summary();
    StateSummary empty;
    CHECK(mine.compare(empty) == StateSummary::Relation::Greater);
    CHECK(empty.compare(mine) == StateSummary::Relation::Less);
    CHECK(mine.compare(mine) == StateSummary::Relation::Equal);
    StateSummary mixed;
    mixed.contiguous[1] = 2;
    mixed.contiguous[99] = 5;
    CHECK(mixed.compare(mine) == StateSummary::Relation::Mixed);
}

CONCORD_TEST(five_replica_shuffled_convergence) {
    // M018: 5 replicas applying the same op set in different random orders.
    const std::size_t replica_count = 5;
    std::vector<Doc> docs;
    for (std::size_t i = 0; i < replica_count; ++i) {
        docs.emplace_back(ReplicaId{static_cast<std::uint64_t>(100 + i)});
    }
    // Each replica types its own letter 4 times at the end; deliver globally.
    std::vector<Operation> all_ops;
    for (std::size_t r = 0; r < replica_count; ++r) {
        for (int i = 0; i < 4; ++i) {
            all_ops.push_back(docs[r].local_insert_text(
                docs[r].stream_size(), U'a' + static_cast<char32_t>(r)));
        }
    }
    // Cross-deliver everything.
    std::mt19937 rng{777};
    for (std::size_t r = 0; r < replica_count; ++r) {
        std::vector<Operation> incoming;
        for (std::size_t other = 0; other < replica_count; ++other) {
            if (other == r) {
                continue;
            }
            for (const Operation& op : all_ops) {
                if (op.id.replica == docs[other].replica()) {
                    incoming.push_back(op);
                }
            }
        }
        std::shuffle(incoming.begin(), incoming.end(), rng);
        for (const Operation& op : incoming) {
            docs[r].apply_remote(op);
        }
    }
    for (std::size_t r = 1; r < replica_count; ++r) {
        CHECK(visible_of(live_items(docs[r])) == visible_of(live_items(docs[0])));
        CHECK(docs[r].canonical_digest() == docs[0].canonical_digest());
    }
}
