// P2-M023: seeded randomized/property-based convergence tests.
// P2-M024: deterministic multi-replica network simulator scenarios.
//
// Every scenario is reproducible from its seed; failures print a trace.
#include "test_harness.hpp"

#include <cstdio>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "simulator.hpp"

using namespace concord::crdt;
using namespace concord::sim;

namespace {

// Property harness: N replicas generate ops locally; delivery is shuffled
// and duplicated; every replica must converge and redelivery must be inert.
bool run_property_seed(std::uint32_t seed, std::size_t replicas, std::size_t ops_per_replica) {
    std::mt19937 rng{seed};
    std::vector<Doc> docs;
    for (std::size_t i = 0; i < replicas; ++i) {
        docs.emplace_back(ReplicaId{static_cast<std::uint64_t>(500 + i)});
    }
    std::vector<Operation> all_ops;
    for (std::size_t r = 0; r < replicas; ++r) {
        for (std::size_t i = 0; i < ops_per_replica; ++i) {
            const std::uint32_t choice = static_cast<std::uint32_t>(rng()) % 10;
            if (docs[r].stream_size() == 0 || choice < 6) {
                // Insert at a random position.
                std::uniform_int_distribution<std::size_t> pos(0, docs[r].stream_size());
                const char32_t scalar =
                    U'a' + static_cast<char32_t>(rng() % 26);
                all_ops.push_back(docs[r].local_insert_text(pos(rng), scalar));
            } else if (choice < 8) {
                // Delete a random live item.
                std::uniform_int_distribution<std::size_t> pos(0, docs[r].stream_size() - 1);
                if (auto op = docs[r].local_delete(pos(rng))) {
                    all_ops.push_back(*op);
                }
            } else if (choice < 9) {
                // Toggle a mark/attribute on a random item, kind-aware.
                std::uniform_int_distribution<std::size_t> pos(0, docs[r].stream_size() - 1);
                const std::size_t target = pos(rng);
                const concord::crdt::StreamEntry entry = docs[r].stream_entry(target);
                const bool set = rng() % 2 == 0;
                if (entry.kind == concord::crdt::ItemKind::Text) {
                    all_ops.push_back(
                        set ? docs[r].local_set_attr(target, "bold", std::string{"1"})
                            : docs[r].local_set_attr(target, "bold", std::nullopt));
                } else {
                    all_ops.push_back(
                        set ? docs[r].local_set_attr(target, "align", std::string{"center"})
                            : docs[r].local_set_attr(target, "align", std::nullopt));
                }
            } else {
                // Split/merge: insert or delete a delimiter.
                if (choice == 9 || docs[r].stream_size() > 0) {
                    std::uniform_int_distribution<std::size_t> pos(0, docs[r].stream_size());
                    all_ops.push_back(docs[r].local_insert_delimiter(pos(rng), "paragraph"));
                }
            }
        }
    }

    // Deliver each op twice, shuffled (duplicates + reorder).
    std::vector<Operation> delivery = all_ops;
    for (const Operation& op : all_ops) {
        delivery.push_back(op);
    }
    std::shuffle(delivery.begin(), delivery.end(), rng);
    for (std::size_t r = 0; r < replicas; ++r) {
        for (const Operation& op : delivery) {
            if (op.id.replica == docs[r].replica()) {
                continue;  // own ops are already integrated
            }
            docs[r].apply_remote(op);
        }
    }

    // Assert: convergence + idempotency under full redelivery.
    const std::string digest = docs[0].canonical_digest();
    bool ok = true;
    for (std::size_t r = 0; r < replicas; ++r) {
        if (docs[r].canonical_digest() != digest) {
            ok = false;
        }
    }
    for (std::size_t r = 0; r < replicas; ++r) {
        for (const Operation& op : delivery) {
            if (docs[r].apply_remote(op)) {
                ok = false;  // a duplicate CHANGED state — invariant violation
            }
        }
    }
    if (!ok) {
        std::fprintf(stderr,
                     "PROPERTY FAILURE seed=%u replicas=%zu ops=%zu\n", seed, replicas,
                     all_ops.size());
    }
    return ok;
}

}  // namespace

CONCORD_TEST(property_fixed_seed_corpus) {
    // Fixed deterministic seed corpus for PR CI: must always pass.
    std::uint32_t seed = 1;
    for (std::size_t replicas : {std::size_t{2}, std::size_t{3}, std::size_t{5}}) {
        for (std::size_t ops : {std::size_t{10}, std::size_t{40}}) {
            CHECK(run_property_seed(seed, replicas, ops));
            seed = seed * 1664525u + 1013904223u;  // deterministic LCG advance
        }
    }
}

CONCORD_TEST(simulator_partition_heal_duplicate_reorder) {
    ScheduleConfig config;
    config.seed = 20260906;
    config.replica_count = 4;
    config.steps = 150;
    config.duplicate_probability = 0.2;
    config.partition_probability = 0.08;
    config.deliver_probability = 0.6;

    Simulation sim(config);
    const SimulationResult result = sim.run();
    if (!result.converged) {
        print_failure_trace(config.seed, result);
    }
    CHECK(result.converged);
    CHECK(result.deliveries > 0);
    // All replicas identical digests after heal + full delivery.
    CHECK(sim.doc(0).canonical_digest() == sim.doc(1).canonical_digest());
    CHECK(sim.doc(0).canonical_digest() == sim.doc(2).canonical_digest());
    CHECK(sim.doc(0).canonical_digest() == sim.doc(3).canonical_digest());
}

CONCORD_TEST(simulator_fixed_seed_corpus) {
    // Multiple deterministic schedules: partition + duplicate + reorder.
    std::uint32_t seed = 7;
    for (int run = 0; run < 10; ++run) {
        ScheduleConfig config;
        config.seed = seed;
        config.replica_count = 3 + static_cast<std::size_t>(run % 3);
        config.steps = 100 + static_cast<std::size_t>(run) * 10;
        config.duplicate_probability = 0.05 + static_cast<double>(run % 4) * 0.05;
        config.partition_probability = run % 2 == 0 ? 0.05 : 0.0;
        config.deliver_probability = 0.5;

        Simulation sim(config);
        const SimulationResult result = sim.run();
        if (!result.converged) {
            print_failure_trace(seed, result);
        }
        CHECK(result.converged);
        seed = seed * 1103515245u + 12345u;
    }
}
