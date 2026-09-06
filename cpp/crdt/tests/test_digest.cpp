// P2-M021: canonical state hashing and diagnostics.
#include "test_harness.hpp"

#include <string>

#include "concord/crdt/digest.hpp"
#include "concord/crdt/doc.hpp"

using namespace concord::crdt;

CONCORD_TEST(sha256_known_vectors) {
    // Official NIST FIPS 180-4 test vectors.
    const auto empty = concord::crypto::sha256("");
    CHECK(concord::crypto::to_hex(empty) ==
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    const auto abc = concord::crypto::sha256("abc");
    CHECK(concord::crypto::to_hex(abc) ==
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    const auto long_input = concord::crypto::sha256(
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
    CHECK(concord::crypto::to_hex(long_input) ==
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

CONCORD_TEST(digest_format_and_stability) {
    Doc doc(ReplicaId{1});
(void)    doc.local_insert_text(0, U'h');
(void)    doc.local_insert_text(1, U'i');

    const std::string digest = doc.canonical_digest();
    CHECK(digest.rfind("sha256:", 0) == 0);
    CHECK(digest.size() == 7 + 64);
    // Same state → same digest.
    CHECK(doc.canonical_digest() == doc.canonical_digest());
}

CONCORD_TEST(equivalent_states_same_digest_different_states_differ) {
    Doc a(ReplicaId{1});
    Doc b(ReplicaId{2});
    for (const char32_t c : std::u32string(U"same")) {
        const Operation op = a.local_insert_text(a.stream_size(), c);
        b.apply_remote(op);
    }
    CHECK(a.canonical_digest() == b.canonical_digest());

    // A divergent edit changes the digest.
    (void)b.local_insert_text(b.stream_size(), U'!');
    CHECK(a.canonical_digest() != b.canonical_digest());

    // Mark difference changes the digest even with identical visible text.
    Doc c(ReplicaId{3});
    Doc d(ReplicaId{4});
    const Operation op = c.local_insert_text(0, U'x');
    d.apply_remote(op);
    CHECK(c.canonical_digest() == d.canonical_digest());
    (void)c.local_set_attr(0, "bold", std::string{"1"});
    CHECK(c.canonical_digest() != d.canonical_digest());
}

CONCORD_TEST(diagnostics_shape) {
    Doc doc(ReplicaId{77});
    for (const char32_t c : std::u32string(U"abcd")) {
(void)        doc.local_insert_text(doc.stream_size(), c);
    }
(void)    doc.local_delete(3);
(void)    doc.local_insert_delimiter(doc.stream_size(), "heading-3");

    const DocDiagnostics diag = doc.diagnostics();
    CHECK(diag.replica_id == 77);
    CHECK(diag.operation_count == 6);  // 4 inserts + 1 delete + 1 delimiter
    CHECK(diag.visible_char_count == 3);
    CHECK(diag.visible_block_count == 1);
    CHECK(diag.tombstone_count == 1);
    CHECK(diag.pending_count == 0);
    CHECK(diag.summary.at(ReplicaId{77}) == 6);
    CHECK(diag.canonical_digest == doc.canonical_digest());
}
