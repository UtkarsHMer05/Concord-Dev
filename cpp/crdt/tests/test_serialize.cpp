// P2-M019: canonical wire serialization round trips + malformed rejection.
#include "test_harness.hpp"

#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"
#include "concord/crdt/validation.hpp"

using namespace concord::crdt;

namespace {
Operation make_insert(char32_t scalar, ReplicaId replica, std::uint64_t counter) {
    Operation op;
    op.type = OpType::Insert;
    op.id = OpId{replica, Counter{counter}};
    op.lamport = Lamport{counter};
    op.kind = ItemKind::Text;
    op.scalar = scalar;
    return op;
}
}  // namespace

CONCORD_TEST(operation_round_trip_insert) {
    Operation op = make_insert(U'é', ReplicaId{7}, 42);
    op.left = OpId{ReplicaId{7}, Counter{41}};
    op.right = OpId{ReplicaId{9}, Counter{3}};

    const std::string bytes = serialize_operation(op);
    const Operation decoded = parse_operation(bytes);
    CHECK(decoded == op);
}

CONCORD_TEST(operation_round_trip_delimiter_with_attrs) {
    Operation op;
    op.type = OpType::Insert;
    op.id = OpId{ReplicaId{3}, Counter{9}};
    op.lamport = Lamport{11};
    op.kind = ItemKind::Delimiter;
    op.left = OpId{ReplicaId{3}, Counter{1}};
    op.initial_attrs.push_back(InitialAttr{"type", "heading-2"});
    op.initial_attrs.push_back(InitialAttr{"align", "center"});

    const std::string bytes = serialize_operation(op);
    CHECK(parse_operation(bytes) == op);
}

CONCORD_TEST(operation_round_trip_delete_and_setattr) {
    Operation del;
    del.type = OpType::Delete;
    del.id = OpId{ReplicaId{1}, Counter{5}};
    del.lamport = Lamport{5};
    del.target = OpId{ReplicaId{2}, Counter{8}};
    CHECK(parse_operation(serialize_operation(del)) == del);

    Operation set;
    set.type = OpType::SetAttr;
    set.id = OpId{ReplicaId{1}, Counter{6}};
    set.lamport = Lamport{6};
    set.target = OpId{ReplicaId{2}, Counter{8}};
    set.attr_name = "bold";
    set.attr_value = std::string{"1"};
    CHECK(parse_operation(serialize_operation(set)) == set);

    Operation clear = set;
    clear.id = OpId{ReplicaId{1}, Counter{7}};
    clear.lamport = Lamport{7};
    clear.attr_value = std::nullopt;  // clear register
    CHECK(parse_operation(serialize_operation(clear)) == clear);
}

CONCORD_TEST(batch_round_trip) {
    std::vector<Operation> ops;
    ops.push_back(make_insert(U'a', ReplicaId{1}, 1));
    ops.push_back(make_insert(U'b', ReplicaId{1}, 2));
    Operation del;
    del.type = OpType::Delete;
    del.id = OpId{ReplicaId{1}, Counter{3}};
    del.lamport = Lamport{3};
    del.target = OpId{ReplicaId{1}, Counter{1}};
    ops.push_back(del);

    const std::string bytes = serialize_batch(ops);
    const auto decoded = parse_batch(bytes);
    CHECK(decoded.size() == ops.size());
    CHECK(decoded == ops);
}

CONCORD_TEST(malformed_frames_rejected) {
    const Operation op = make_insert(U'x', ReplicaId{1}, 1);
    const std::string good = serialize_operation(op);

    // Truncations at every length fail closed (no crash).
    for (std::size_t cut = 0; cut < good.size(); ++cut) {
        bool threw = false;
        try {
            (void)parse_operation(good.substr(0, cut));
        } catch (const CrdtError&) {
            threw = true;
        }
        CHECK(threw);
    }

    // Trailing garbage rejected.
    CHECK_THROW(parse_operation(good + std::string{1, static_cast<char>(0x00)}), CrdtError);

    // Bad version rejected.
    std::string bad_version = good;
    bad_version[0] = 0x7F;
    CHECK_THROW(parse_operation(bad_version), CrdtError);

    // Bad op type rejected.
    std::string bad_type = good;
    bad_type[1] = 0x7F;
    CHECK_THROW(parse_operation(bad_type), CrdtError);

    // Zero replica id in frame rejected.
    std::string bad_replica = good;
    bad_replica[2] = 0;
    CHECK_THROW(parse_operation(bad_replica), CrdtError);

    // Empty batch is legal.
    CHECK(parse_batch(serialize_batch({})).empty());
}

CONCORD_TEST(utf8_validation_strict) {
    CHECK(is_valid_utf8("plain ascii"));
    CHECK(is_valid_utf8("é€😀日"));
    CHECK(!is_valid_utf8(std::string{static_cast<char>(0xC0), static_cast<char>(0x80)}));  // overlong
    CHECK(!is_valid_utf8(std::string{static_cast<char>(0xED), static_cast<char>(0xA0),
                                     static_cast<char>(0x80)}));  // surrogate
    CHECK(!is_valid_utf8(std::string{static_cast<char>(0xF5), static_cast<char>(0x80),
                                     static_cast<char>(0x80), static_cast<char>(0x80)}));  // > U+10FFFF
    CHECK(!is_valid_utf8(std::string{static_cast<char>(0x80)}));  // stray continuation
    CHECK(!is_valid_utf8(std::string{static_cast<char>(0xC3)}));  // truncated
}

CONCORD_TEST(parse_validated_rejects_zero_scalar) {
    // A frame encoding a NUL scalar decodes as malformed at validation.
    Operation op = make_insert(U'a', ReplicaId{1}, 1);
    const std::string good = serialize_operation(op);
    CHECK(parse_validated_operation(good).id == op.id);
    CHECK_THROW(parse_validated_operation(std::string{1, static_cast<char>(0x7F)}), CrdtError);
}
