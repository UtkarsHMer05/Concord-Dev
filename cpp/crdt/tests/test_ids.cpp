// P2-M009: identity and clock type tests.
#include "test_harness.hpp"

#include <limits>
#include <unordered_set>

#include "concord/crdt/ids.hpp"

using namespace concord::crdt;

CONCORD_TEST(replica_id_validation) {
    CHECK(ReplicaId::is_valid(1));
    CHECK(ReplicaId::is_valid(std::numeric_limits<std::uint64_t>::max()));
    CHECK(!ReplicaId::is_valid(0));
}

CONCORD_TEST(counter_validation_and_overflow) {
    CHECK(Counter::is_valid(1));
    CHECK(Counter::is_valid(Counter::kMax));
    CHECK(!Counter::is_valid(0));
    CHECK(!Counter::is_valid(Counter::kMax + 1));

    const Counter first = Counter::first();
    CHECK(first.value() == 1);
    const auto next = first.next();
    CHECK(next.has_value());
    CHECK(next->value() == 2);

    Counter at_max{Counter::kMax};
    CHECK(!at_max.next().has_value());
}

CONCORD_TEST(lamport_validation) {
    CHECK(Lamport::is_valid(1));
    CHECK(Lamport::is_valid(Lamport::kMax));
    CHECK(!Lamport::is_valid(0));
    CHECK(!Lamport::is_valid(Lamport::kMax + 1));
}

CONCORD_TEST(op_id_total_order) {
    const OpId a{ReplicaId{1}, Counter{5}};
    const OpId b{ReplicaId{1}, Counter{7}};
    const OpId c{ReplicaId{2}, Counter{3}};

    CHECK(a < b);   // same replica: counter decides
    CHECK(a < c);   // replica decides
    CHECK(c > b);   // replica decides
    CHECK(!(a < a));
    CHECK(a == a);
}

CONCORD_TEST(op_id_null_sentinel) {
    const OpId null_id = OpId::null();
    CHECK(null_id.is_null());
    CHECK(!null_id.is_valid());
    const OpId real{ReplicaId{42}, Counter{1}};
    CHECK(!real.is_null());
    CHECK(real.is_valid());
}

CONCORD_TEST(op_id_serialization_round_trip) {
    const OpId id{ReplicaId{0x0102030405060708ULL}, Counter{0xF1F2F3F4F5F6F7F8ULL}};
    std::string bytes;
    put_u64_le(bytes, id.replica.value());
    put_u64_le(bytes, id.counter.value());
    CHECK(bytes.size() == 16);

    std::size_t offset = 0;
    std::uint64_t replica = 0;
    std::uint64_t counter = 0;
    CHECK(get_u64_le(bytes, offset, replica));
    CHECK(get_u64_le(bytes, offset, counter));
    CHECK(offset == bytes.size());
    CHECK(ReplicaId{replica} == id.replica);
    CHECK(Counter{counter} == id.counter);
}

CONCORD_TEST(op_id_hash_consistency) {
    const OpId a{ReplicaId{7}, Counter{9}};
    const OpId b{ReplicaId{7}, Counter{9}};
    const OpId c{ReplicaId{7}, Counter{10}};
    OpIdHash hash;
    CHECK(hash(a) == hash(b));
    CHECK(hash(a) != hash(c));

    std::unordered_set<OpId, OpIdHash> set;
    set.insert(a);
    set.insert(b);
    set.insert(c);
    CHECK(set.size() == 2);
}

CONCORD_TEST(byte_helpers_little_endian) {
    // Explicit little-endian: least significant byte first, host-independent.
    std::string bytes;
    put_u64_le(bytes, 0x0102030405060708ULL);
    CHECK(static_cast<unsigned char>(bytes[0]) == 0x08);
    CHECK(static_cast<unsigned char>(bytes[7]) == 0x01);

    std::string small;
    put_u32_le(small, 0x04030201u);
    CHECK(static_cast<unsigned char>(small[0]) == 0x01);
    CHECK(static_cast<unsigned char>(small[3]) == 0x04);
}
