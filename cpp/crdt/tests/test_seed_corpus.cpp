// P6-M014: fixed deterministic CRDT/fault seed corpus.
//
// Every scenario is a FIXED seed constant in code (reproducible on every
// run, every platform). Each scenario builds a set of independent replicas,
// delivers the same op set through several deterministic permutations /
// fault patterns, runs to quiescence, and asserts every replica's canonical
// digest is identical. Conflict classes covered:
//   - concurrent inserts at the same position (left/right origin anchoring)
//   - insert vs delete overlaps
//   - format/mark LWW register writes on the same and overlapping ranges
//   - reordering: the same op set delivered in N deterministic permutations
//   - duplication: redelivery of already-applied ops (idempotence)
//   - partition heal: two isolated groups converge after the merge
//   - snapshot-restore mid-stream: snapshot one replica, restore on another,
//     keep editing — the rest of the network and the restored replica agree
//   - compaction-style resync: snapshot + tail == full-history digest
//
// Failure output: the scenario id + seed print to stderr BEFORE the
// assertion so a divergence is reproducible from the log alone.
//
// Style: matches test_property_sim.cpp / test_integration.cpp — no external
// framework, CHECK macros from test_harness.hpp, std::mt19937 seeded with
// compile-time constants.
#include "test_harness.hpp"

#include <algorithm>
#include <cstdio>
#include <numeric>
#include <random>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"

using namespace concord::crdt;

namespace {

// ---------------------------------------------------------------------------
// Scenario plumbing.
// ---------------------------------------------------------------------------

// Fixed scenario identity for failure messages.
struct ScenarioId {
    const char* name;
    std::uint32_t seed;
};

// Prints the scenario identity before any CHECK can fail, so the log alone
// reproduces the failing run.
[[nodiscard]] ScenarioId announce(const char* name, std::uint32_t seed) {
    std::fprintf(stderr, "seed-corpus scenario: %s (seed=%u)\n", name, seed);
    return ScenarioId{name, seed};
}

[[nodiscard]] std::vector<Doc> make_replicas(std::size_t count, std::uint64_t base) {
    std::vector<Doc> docs;
    docs.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        docs.emplace_back(ReplicaId{base + i});
    }
    return docs;
}

// The quiescence convergence check: ALL replica digests equal. Divergent
// replicas are enumerated to stderr for minimization.
bool assert_all_converged(const char* scenario, std::uint32_t seed,
                          const std::vector<Doc>& docs) {
    const std::string digest = docs[0].canonical_digest();
    std::vector<std::size_t> divergent;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        if (docs[r].canonical_digest() != digest) {
            divergent.push_back(r);
        }
    }
    if (!divergent.empty()) {
        std::fprintf(stderr,
                     "DIVERGENCE scenario=%s seed=%u reference=replica0 digest0=%s\n",
                     scenario, seed, digest.c_str());
        for (const std::size_t r : divergent) {
            std::fprintf(stderr, "  replica %zu digest=%s\n", r,
                         docs[r].canonical_digest().c_str());
        }
    }
    return divergent.empty();
}

// Deliver one op set to every replica EXCEPT its author (already integrated
// at generation time), in the given order.
void deliver_permutation(std::vector<Doc>& docs, const std::vector<Operation>& ops) {
    for (std::size_t r = 0; r < docs.size(); ++r) {
        for (const Operation& op : ops) {
            if (op.id.replica == docs[r].replica()) {
                continue;
            }
            docs[r].apply_remote(op);
        }
    }
}

// Generates the permutation array 0..n-1 shuffled with the given seed.
[[nodiscard]] std::vector<std::size_t> shuffled_order(std::size_t n, std::uint32_t seed) {
    std::vector<std::size_t> order(n);
    std::iota(order.begin(), order.end(), std::size_t{0});
    std::mt19937 rng{seed};
    std::shuffle(order.begin(), order.end(), rng);
    return order;
}

// Builds `ops` reordered by `order` (order[i] = source index of target i).
[[nodiscard]] std::vector<Operation> permute(const std::vector<Operation>& ops,
                                             const std::vector<std::size_t>& order) {
    std::vector<Operation> out;
    out.reserve(ops.size());
    for (const std::size_t index : order) {
        out.push_back(ops[index]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Conflict-class op builders. Each seeds a shared prefix on all replicas so
// concurrent edits anchor at identical stream positions.
// ---------------------------------------------------------------------------

// Seeds the same text on every replica (replica 0 generates; the rest
// receive) and returns the seed ops for later redelivery.
void seed_text(std::vector<Doc>& docs, std::u32string_view text) {
    std::vector<Operation> ops;
    for (const char32_t c : text) {
        ops.push_back(docs[0].local_insert_text(docs[0].stream_size(), c));
    }
    for (std::size_t r = 1; r < docs.size(); ++r) {
        for (const Operation& op : ops) {
            docs[r].apply_remote(op);
        }
    }
}

// ---------------------------------------------------------------------------
// Scenario runners. Each returns true on convergence; each takes the scenario
// seed from a fixed constant table at the bottom of the file.
// ---------------------------------------------------------------------------

// Concurrent inserts at the SAME position by every replica (left/right
// origin anchoring under N-way contention). Delivers the same op set in
// P deterministic permutations (all replicas get every permutation's
// ordering — a single doc per permutation would not check cross-order
// convergence between replicas).
bool scenario_same_position_inserts(std::uint32_t seed, std::size_t replicas) {
    (void)announce("same_position_inserts", seed);
    constexpr std::size_t kPermutations = 4;  // >= 4 per the milestone

    std::vector<Doc> docs = make_replicas(replicas, 7000);
    seed_text(docs, U"anchor-text");

    // Every replica inserts its own marker at the same stream position.
    std::vector<Operation> concurrent;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        concurrent.push_back(docs[r].local_insert_text(5, U'A' + static_cast<char32_t>(r)));
    }
    // Also concurrent left-anchored and right-anchored inserts at the same
    // gap: replica 0 anchors right of position 3, replica 1 (if present)
    // left of position 4 — the classic YATA sibling tie-break case.
    if (docs.size() >= 2) {
        concurrent.push_back(docs[0].local_insert_text(3, U'<'));
        concurrent.push_back(docs[1].local_insert_text(4, U'>'));
    }

    // Deliver the concurrent set through kPermutations distinct orderings.
    // A fresh replica fleet per permutation would only check intra-fleet
    // convergence; here ONE fleet must survive every permutation because
    // each delivery is idempotent once applied, so the digest check after
    // the last permutation proves order independence across all of them.
    for (std::size_t p = 0; p < kPermutations; ++p) {
        deliver_permutation(docs, permute(concurrent, shuffled_order(concurrent.size(), seed + static_cast<std::uint32_t>(p))));
    }
    return assert_all_converged("same_position_inserts", seed, docs);
}

// Insert vs delete overlap: concurrent deletes of overlapping ranges and a
// concurrent insert inside the deleted range (survivorship semantics).
bool scenario_insert_delete_overlap(std::uint32_t seed, std::size_t replicas) {
    (void)announce("insert_delete_overlap", seed);
    std::vector<Doc> docs = make_replicas(replicas, 7100);
    seed_text(docs, U"0123456789");

    // Each replica deletes an overlapping window (clamped to the stream:
    // windows near the end shrink so every index stays in range).
    std::vector<Operation> dels;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        const std::size_t start = (r * 4) / docs.size();  // spread within 0..3
        for (std::size_t k = 0; k < 4; ++k) {
            const std::size_t target = start + k;
            if (target >= docs[r].stream_size()) {
                break;
            }
            if (auto op = docs[r].local_delete(target)) {
                dels.push_back(*op);
            }
        }
    }
    // A concurrent insert INSIDE the deleted range on replica 0.
    const Operation inside = docs[0].local_insert_text(5, U'X');

    // Deliver deletes before the insert (delete-first), then the insert.
    std::vector<Operation> all = dels;
    all.push_back(inside);
    for (std::size_t p = 0; p < 4; ++p) {
        deliver_permutation(docs, permute(all, shuffled_order(all.size(), seed + static_cast<std::uint32_t>(p))));
    }
    return assert_all_converged("insert_delete_overlap", seed, docs);
}

// Format/mark LWW registers: same-name concurrent writes on the same item
// (tie-break by (lamport, writer)) and non-conflicting writes on overlapping
// ranges of items.
bool scenario_format_lww_ranges(std::uint32_t seed, std::size_t replicas) {
    (void)announce("format_lww_ranges", seed);
    std::vector<Doc> docs = make_replicas(replicas, 7200);
    seed_text(docs, U"abcdefghij");
    // One block delimiter so delimiter attributes participate too.
    const Operation delim = docs[0].local_insert_delimiter(docs[0].stream_size(), "paragraph");
    for (std::size_t r = 1; r < docs.size(); ++r) {
        docs[r].apply_remote(delim);
    }

    // Same item, every replica writes the SAME attribute name concurrently:
    // LWW must pick one winner on all replicas regardless of delivery order.
    std::vector<Operation> marks;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        marks.push_back(docs[r].local_set_attr(2, "bold", std::string{"1"}));
        marks.push_back(docs[r].local_set_attr(2, "italic", std::nullopt));  // concurrent clear
    }
    // Overlapping ranges with DIFFERENT names (no conflict, coexist).
    for (std::size_t r = 0; r < docs.size(); ++r) {
        marks.push_back(docs[r].local_set_attr(3, "underline", std::string{"1"}));
        marks.push_back(docs[r].local_set_attr(4, "strikethrough", std::string{"1"}));
    }
    // Delimiter attributes: concurrent type/align/lineHeight writes.
    const std::size_t delim_index = docs[0].stream_size() - 1;
    marks.push_back(docs[0].local_set_attr(delim_index, "align", std::string{"center"}));
    if (docs.size() >= 2) {
        marks.push_back(docs[1].local_set_attr(delim_index, "align", std::string{"right"}));
    }
    marks.push_back(docs[0].local_set_attr(delim_index, "lineHeight", std::string{"1.5"}));

    for (std::size_t p = 0; p < 4; ++p) {
        deliver_permutation(docs, permute(marks, shuffled_order(marks.size(), seed + static_cast<std::uint32_t>(p))));
    }
    return assert_all_converged("format_lww_ranges", seed, docs);
}

// Duplication / redelivery storm: the full op set (with duplicates) applied
// repeatedly in shuffled order; redelivery must never change state (checked
// per permutation via digest stability) and all replicas must converge.
bool scenario_duplication_idempotence(std::uint32_t seed, std::size_t replicas) {
    (void)announce("duplication_idempotence", seed);
    std::vector<Doc> docs = make_replicas(replicas, 7300);
    seed_text(docs, U"duplicate-me");

    std::vector<Operation> ops;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        ops.push_back(docs[r].local_insert_text(docs[r].stream_size(), U'a' + static_cast<char32_t>(r)));
        if (auto del = docs[r].local_delete(2)) {
            ops.push_back(*del);
        }
        ops.push_back(docs[r].local_set_attr(0, "bold", std::string{"1"}));
    }

    // 3 copies of every op, reshuffled per permutation; every op reaches
    // every non-author replica at least twice.
    std::vector<Operation> storm;
    for (int round = 0; round < 3; ++round) {
        storm.insert(storm.end(), ops.begin(), ops.end());
    }
    // Permutation 0 applies everything for the first time; the digest AFTER
    // it is the reference. Permutations 1..3 are pure duplicate redelivery:
    // they must not move the digest (idempotence).
    deliver_permutation(docs, permute(storm, shuffled_order(storm.size(), seed)));
    const std::string digest_before = docs[0].canonical_digest();
    bool stable = true;
    for (std::size_t p = 1; p < 4; ++p) {
        deliver_permutation(docs,
                            permute(storm, shuffled_order(storm.size(), seed + static_cast<std::uint32_t>(p))));
        for (std::size_t r = 0; r < docs.size(); ++r) {
            if (docs[r].canonical_digest() != digest_before) {
                stable = false;
            }
        }
    }
    if (!stable) {
        std::fprintf(stderr, "DIVERGENCE scenario=duplication_idempotence seed=%u "
                             "(duplicate delivery changed state)\n", seed);
    }
    return assert_all_converged("duplication_idempotence", seed, docs) && stable;
}

// Partition heal: two isolated groups edit concurrently, then the partition
// heals and everything exchanges. Groups converge afterward.
bool scenario_partition_heal(std::uint32_t seed, std::size_t replicas) {
    (void)announce("partition_heal", seed);
    std::vector<Doc> docs = make_replicas(replicas, 7400);
    seed_text(docs, U"partition");

    const std::size_t group_a = (docs.size() + 1) / 2;
    std::vector<Operation> ops_a;
    std::vector<Operation> ops_b;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        auto& group_ops = r < group_a ? ops_a : ops_b;
        for (int i = 0; i < 6; ++i) {
            group_ops.push_back(docs[r].local_insert_text(
                docs[r].stream_size() / 2, U'a' + static_cast<char32_t>(r)));
        }
        if (auto del = docs[r].local_delete(2)) {
            group_ops.push_back(*del);
        }
        group_ops.push_back(docs[r].local_set_attr(0, "bold", std::string{"1"}));
    }

    // While partitioned: intra-group delivery only (each group converges
    // internally to its own digest — the digests MUST differ across groups
    // for the scenario to be meaningful).
    const auto deliver_group = [&](const std::vector<Operation>& ops, std::size_t begin,
                                   std::size_t end) {
        for (std::size_t r = begin; r < end; ++r) {
            for (const Operation& op : ops) {
                if (op.id.replica == docs[r].replica()) {
                    continue;
                }
                docs[r].apply_remote(op);
            }
        }
    };
    deliver_group(ops_a, 0, group_a);
    deliver_group(ops_b, group_a, docs.size());
    if (docs.size() >= 2) {
        CHECK(docs[0].canonical_digest() != docs[docs.size() - 1].canonical_digest());
    }

    // Heal: exchange everything (inter-group, shuffled).
    std::vector<Operation> all = ops_a;
    all.insert(all.end(), ops_b.begin(), ops_b.end());
    for (std::size_t p = 0; p < 4; ++p) {
        deliver_permutation(docs, permute(all, shuffled_order(all.size(), seed + static_cast<std::uint32_t>(p))));
    }
    return assert_all_converged("partition_heal", seed, docs);
}

// Snapshot-restore mid-stream: replica 0 exports a snapshot mid-edit; a NEW
// replica imports it and joins the network; concurrent ops generated before
// and after the snapshot must all converge across old + restored replicas.
bool scenario_snapshot_restore_midstream(std::uint32_t seed, std::size_t replicas) {
    (void)announce("snapshot_restore_midstream", seed);
    std::vector<Doc> docs = make_replicas(replicas, 7500);
    seed_text(docs, U"snapshot-mid-stream");

    // Ops generated concurrently BEFORE the snapshot.
    std::vector<Operation> before;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        before.push_back(docs[r].local_insert_text(3, U'p' + static_cast<char32_t>(r)));
        before.push_back(docs[r].local_set_attr(1, "bold", std::string{"1"}));
    }
    // Deliver the pre-snapshot ops everywhere first (they are IN the
    // snapshot's causal past for at least the exporter; other replicas may
    // have missed some — snapshots carry the full state either way).
    deliver_permutation(docs, permute(before, shuffled_order(before.size(), seed)));

    // The snapshot from replica 0, plus a concurrent post-snapshot op from
    // every OTHER replica that the snapshot does NOT contain.
    const std::string snapshot = docs[0].export_snapshot();
    std::vector<Operation> after;
    for (std::size_t r = 1; r < docs.size(); ++r) {
        after.push_back(docs[r].local_insert_text(2, U'q' + static_cast<char32_t>(r)));
        after.push_back(docs[r].local_set_attr(4, "italic", std::string{"1"}));
    }
    // The exporter also edits after taking the snapshot (tail relative to
    // the restored replica).
    after.push_back(docs[0].local_insert_text(docs[0].stream_size(), U'Z'));

    // A fresh replica joins from the snapshot (this is the "restore on
    // another replica" step) and continues as a full participant.
    Doc restored = Doc::import_snapshot(ReplicaId{7999}, snapshot);
    // The restored replica generates its own concurrent op post-restore.
    after.push_back(restored.local_insert_text(1, U'R'));
    docs.push_back(std::move(restored));

    // Full exchange of everything not yet applied (shuffled, duplicated).
    std::vector<Operation> storm;
    storm.insert(storm.end(), before.begin(), before.end());  // duplicates for the restored replica
    storm.insert(storm.end(), after.begin(), after.end());
    storm.insert(storm.end(), after.begin(), after.end());   // duplicates
    for (std::size_t p = 0; p < 4; ++p) {
        deliver_permutation(docs, permute(storm, shuffled_order(storm.size(), seed + static_cast<std::uint32_t>(p))));
    }
    return assert_all_converged("snapshot_restore_midstream", seed, docs);
}

// Compaction-style resync: a replica that receives snapshot + tail must end
// with the SAME digest as one that replayed the full history (the recovery
// invariant the worker's CMD 4 asserts end-to-end).
bool scenario_compaction_resync(std::uint32_t seed, std::size_t replicas) {
    (void)announce("compaction_resync", seed);
    std::vector<Doc> docs = make_replicas(replicas, 7600);
    seed_text(docs, U"compaction-full-replay");

    // Phase 1: the pre-snapshot history.
    std::vector<Operation> history;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        for (int i = 0; i < 5; ++i) {
            history.push_back(docs[r].local_insert_text(
                docs[r].stream_size() / 2, U'0' + static_cast<char32_t>(r)));
        }
        if (auto del = docs[r].local_delete(4)) {
            history.push_back(*del);
        }
        history.push_back(docs[r].local_set_attr(2, "underline", std::string{"1"}));
    }
    deliver_permutation(docs, permute(history, shuffled_order(history.size(), seed)));

    // Snapshot point: replica 0 exports.
    const std::string snapshot = docs[0].export_snapshot();

    // Phase 2: the tail (post-snapshot ops from every replica).
    std::vector<Operation> tail;
    for (std::size_t r = 0; r < docs.size(); ++r) {
        tail.push_back(docs[r].local_insert_text(1, U't' + static_cast<char32_t>(r)));
        if (auto del = docs[r].local_delete(6)) {
            tail.push_back(*del);
        }
        tail.push_back(docs[r].local_set_attr(3, "strikethrough", std::string{"1"}));
    }

    // Resync replica: snapshot + tail ONLY (never sees `history`).
    Doc resync = Doc::import_snapshot(ReplicaId{7998}, snapshot);
    for (const Operation& op : tail) {
        if (op.id.replica == resync.replica()) {
            continue;
        }
        resync.apply_remote(op);
    }

    // Full-replay replica: history + tail, shuffled (a late joiner that
    // received the entire op log).
    Doc replay = Doc::import_snapshot(ReplicaId{7997}, snapshot);
    std::vector<Operation> all = history;
    all.insert(all.end(), tail.begin(), tail.end());
    const std::vector<std::size_t> order =
        shuffled_order(all.size(), seed ^ 0x5eedu);
    for (const std::size_t index : order) {
        if (all[index].id.replica == replay.replica()) {
            continue;
        }
        replay.apply_remote(all[index]);
    }

    // Everyone else gets the tail too, then converges.
    deliver_permutation(docs, tail);

    const std::string expected = docs[0].canonical_digest();
    if (resync.canonical_digest() != expected) {
        std::fprintf(stderr,
                     "DIVERGENCE scenario=compaction_resync seed=%u resync digest=%s "
                     "expected=%s\n", seed, resync.canonical_digest().c_str(),
                     expected.c_str());
    }
    if (replay.canonical_digest() != expected) {
        std::fprintf(stderr,
                     "DIVERGENCE scenario=compaction_resync seed=%u replay digest=%s "
                     "expected=%s\n", seed, replay.canonical_digest().c_str(),
                     expected.c_str());
    }
    return assert_all_converged("compaction_resync", seed, docs) &&
           resync.canonical_digest() == expected && replay.canonical_digest() == expected;
}

// Mixed everything: inserts + deletes + marks + delimiters on a growing
// stream, delivered shuffled with duplicates — the broadest single scenario.
bool scenario_mixed_fault_storm(std::uint32_t seed, std::size_t replicas) {
    (void)announce("mixed_fault_storm", seed);
    std::mt19937 rng{seed};
    std::vector<Doc> docs = make_replicas(replicas, 7700);
    seed_text(docs, U"storm-base");

    std::vector<Operation> ops;
    std::vector<Operation> mine;  // ops the author already integrated
    for (int round = 0; round < 8; ++round) {
        for (std::size_t r = 0; r < docs.size(); ++r) {
            Doc& doc = docs[r];
            const auto choice = rng() % 10;
            Operation op = [&]() -> Operation {
                // An empty stream admits only inserts (deletes/marks would
                // throw out-of-range — round 0 on unseeded replicas).
                if (doc.stream_size() == 0 || choice < 5) {
                    std::uniform_int_distribution<std::size_t> pos(0, doc.stream_size());
                    return doc.local_insert_text(pos(rng), U'a' + static_cast<char32_t>(rng() % 26));
                }
                if (choice < 7) {
                    std::uniform_int_distribution<std::size_t> pos(0, doc.stream_size() - 1);
                    auto maybe = doc.local_delete(pos(rng));
                    if (!maybe.has_value()) {
                        // Already tombstoned locally: fall through to an
                        // insert so every iteration produces one op.
                        return doc.local_insert_text(doc.stream_size(), U'#');
                    }
                    return *maybe;
                }
                if (choice < 8) {
                    std::uniform_int_distribution<std::size_t> pos(0, doc.stream_size());
                    return doc.local_insert_delimiter(pos(rng), "heading-2");
                }
                std::uniform_int_distribution<std::size_t> pos(0, doc.stream_size() - 1);
                const std::size_t target = pos(rng);  // one draw: kind check + write
                const StreamEntry entry = doc.stream_entry(target);
                const bool set = rng() % 2 == 0;
                if (entry.kind == ItemKind::Text) {
                    return set ? doc.local_set_attr(target, "bold", std::string{"1"})
                                : doc.local_set_attr(target, "bold", std::nullopt);
                }
                return set ? doc.local_set_attr(target, "align", std::string{"right"})
                           : doc.local_set_attr(target, "align", std::nullopt);
            }();
            mine.push_back(op);
        }
        // Deliver this round cross-replica, shuffled with duplication.
        std::vector<Operation> round_ops = mine;
        round_ops.push_back(mine.back());  // one duplicate
        deliver_permutation(docs,
                            permute(round_ops, shuffled_order(round_ops.size(),
                                                               seed + static_cast<std::uint32_t>(round))));
    }
    return assert_all_converged("mixed_fault_storm", seed, docs);
}

// Runs one conflict-class scenario across the 2/5/10 replica counts.
template <typename Fn>
bool run_replica_matrix(Fn scenario, std::uint32_t base_seed, const char* name) {
    bool ok = true;
    for (const std::size_t replicas : {std::size_t{2}, std::size_t{5}, std::size_t{10}}) {
        // Deterministic per-count seed: base seed mixed by the replica count.
        const std::uint32_t seed = base_seed * 3u + static_cast<std::uint32_t>(replicas);
        if (!scenario(seed, replicas)) {
            std::fprintf(stderr, "FAILED matrix %s replicas=%zu seed=%u\n", name, replicas,
                         seed);
            ok = false;
        }
    }
    return ok;
}

}  // namespace

// ---------------------------------------------------------------------------
// Fixed-seed scenario registrations. Seeds are compile-time constants: the
// same corpus runs identically on every machine and every build type.
// ---------------------------------------------------------------------------

CONCORD_TEST(seed_corpus_same_position_inserts) {
    CHECK(run_replica_matrix(scenario_same_position_inserts, 0x5eed01u, "same_position_inserts"));
}

CONCORD_TEST(seed_corpus_insert_delete_overlap) {
    CHECK(run_replica_matrix(scenario_insert_delete_overlap, 0x5eed02u, "insert_delete_overlap"));
}

CONCORD_TEST(seed_corpus_format_lww_ranges) {
    CHECK(run_replica_matrix(scenario_format_lww_ranges, 0x5eed03u, "format_lww_ranges"));
}

CONCORD_TEST(seed_corpus_duplication_idempotence) {
    CHECK(run_replica_matrix(scenario_duplication_idempotence, 0x5eed04u, "duplication_idempotence"));
}

CONCORD_TEST(seed_corpus_partition_heal) {
    CHECK(run_replica_matrix(scenario_partition_heal, 0x5eed05u, "partition_heal"));
}

CONCORD_TEST(seed_corpus_snapshot_restore_midstream) {
    CHECK(run_replica_matrix(scenario_snapshot_restore_midstream, 0x5eed06u, "snapshot_restore_midstream"));
}

CONCORD_TEST(seed_corpus_compaction_resync) {
    CHECK(run_replica_matrix(scenario_compaction_resync, 0x5eed07u, "compaction_resync"));
}

CONCORD_TEST(seed_corpus_mixed_fault_storm) {
    CHECK(run_replica_matrix(scenario_mixed_fault_storm, 0x5eed08u, "mixed_fault_storm"));
}
