// P2-M020: snapshot export/import — restoration, replay safety, corruption.
#include "test_harness.hpp"

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"

using namespace concord::crdt;

namespace {
Doc build_sample(ReplicaId replica) {
    Doc doc(replica);
    for (const char32_t c : std::u32string(U"shared")) {
(void)        doc.local_insert_text(doc.stream_size(), c);
    }
(void)    doc.local_set_attr(0, "bold", std::string{"1"});
(void)    doc.local_insert_delimiter(doc.stream_size(), "heading-1");
(void)    doc.local_insert_text(doc.stream_size(), U'!');
(void)    doc.local_delete(2);  // tombstone 'a'
    return doc;
}
}  // namespace

CONCORD_TEST(snapshot_round_trip_preserves_state) {
    Doc doc = build_sample(ReplicaId{1});
    const std::string snapshot = doc.export_snapshot();

    Doc restored = Doc::import_snapshot(ReplicaId{2}, snapshot);
    CHECK(restored.visible_document() == doc.visible_document());
    CHECK(restored.canonical_digest() == doc.canonical_digest());
    // Shared-state diagnostics match; replica identity legitimately differs.
    const DocDiagnostics orig_diag = doc.diagnostics();
    const DocDiagnostics restored_diag = restored.diagnostics();
    CHECK(restored_diag.operation_count == orig_diag.operation_count);
    CHECK(restored_diag.tombstone_count == orig_diag.tombstone_count);
    CHECK(restored_diag.visible_char_count == orig_diag.visible_char_count);
    CHECK(restored_diag.visible_block_count == orig_diag.visible_block_count);
    CHECK(restored_diag.summary == orig_diag.summary);
    // The restoring replica keeps its own identity.
    CHECK(restored.replica() == ReplicaId{2});
    CHECK(doc.replica() == ReplicaId{1});
}

CONCORD_TEST(snapshot_survives_engine_destroy_and_replay) {
    // 1. build 2. export 3. "destroy" 4. import 5. replay duplicates 6. edit
    Doc a(ReplicaId{1});
    std::vector<Operation> ops;
    for (const char32_t c : std::u32string(U"alpha")) {
        ops.push_back(a.local_insert_text(a.stream_size(), c));
    }
    const auto del = a.local_delete(1);
    const std::string snapshot = a.export_snapshot();

    Doc b = Doc::import_snapshot(ReplicaId{2}, snapshot);
    // Replay the whole history: must be fully idempotent post-import.
    for (const Operation& op : ops) {
        CHECK(!b.apply_remote(op));  // duplicates ignored
    }
    b.apply_remote(*del);
    CHECK(b.visible_document() == a.visible_document());
    CHECK(b.canonical_digest() == a.canonical_digest());

    // Continue editing after import; still converges with the original.
    const Operation fresh_a = a.local_insert_text(a.stream_size(), U'X');
    const Operation fresh_b = b.local_insert_text(b.stream_size(), U'Y');
    a.apply_remote(fresh_b);
    b.apply_remote(fresh_a);
    CHECK(a.canonical_digest() == b.canonical_digest());
    CHECK(a.visible_document() == b.visible_document());
}

CONCORD_TEST(snapshot_of_replica_with_pending_ops) {
    // A snapshot taken while ops are pending restores the pending buffer.
    Doc a(ReplicaId{1});
    const Operation op1 = a.local_insert_text(0, U'1');
    const Operation op2 = a.local_insert_text(1, U'2');

    Doc b(ReplicaId{2});
    b.apply_remote(op2);           // pending (anchor missing)
    const std::string snapshot = b.export_snapshot();
    CHECK(b.pending_count() == 1);

    Doc c = Doc::import_snapshot(ReplicaId{3}, snapshot);
    CHECK(c.pending_count() == 1);
    c.apply_remote(op1);           // drain
    CHECK(c.pending_count() == 0);
    CHECK(c.visible_document() == a.visible_document());
    CHECK(c.canonical_digest() == a.canonical_digest());
}

CONCORD_TEST(snapshot_corruption_rejected) {
    Doc doc = build_sample(ReplicaId{1});
    const std::string good = doc.export_snapshot();

    for (std::size_t cut = 0; cut < good.size(); cut += 7) {
        bool threw = false;
        try {
            (void)Doc::import_snapshot(ReplicaId{2}, good.substr(0, cut));
        } catch (const CrdtError&) {
            threw = true;
        }
        CHECK(threw);
    }
    CHECK_THROW(Doc::import_snapshot(ReplicaId{2}, ""), CrdtError);

    std::string bad_version = good;
    bad_version[0] = 9;
    CHECK_THROW(Doc::import_snapshot(ReplicaId{2}, bad_version), CrdtError);

    std::string trailing = good;
    trailing.push_back('\0');
    CHECK_THROW(Doc::import_snapshot(ReplicaId{2}, trailing), CrdtError);
}

CONCORD_TEST(empty_document_snapshot) {
    Doc doc(ReplicaId{5});
    const std::string snapshot = doc.export_snapshot();
    Doc restored = Doc::import_snapshot(ReplicaId{6}, snapshot);
    CHECK(restored.visible_document().size() == 1);
    CHECK(restored.stream_size() == 0);
    CHECK(restored.canonical_digest() == doc.canonical_digest());
}
