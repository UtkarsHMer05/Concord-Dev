// Deterministic multi-replica simulation harness (P2-M023/M024).
//
// One virtual network + N replicas. The scheduler controls delivery with
// seeded randomness: reordering, duplication, delay (in-flight buffers), and
// temporary partitions. Everything is reproducible from a seed; on failure a
// full trace (seed, schedule, op ids, final digests) is printed.
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <map>
#include <random>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"

namespace concord::sim {

struct ScheduleConfig {
    std::uint32_t seed = 1;
    std::size_t replica_count = 3;
    std::size_t steps = 200;              // generation steps
    double duplicate_probability = 0.15;  // per delivery
    double drop_probability = 0.0;        // permanent loss (0: eventual delivery)
    double partition_probability = 0.05;  // per step: toggle a partition
    double deliver_probability = 0.7;     // per step: flush one in-flight batch
};

struct SimTraceEntry {
    std::size_t step = 0;
    std::string event;
};

struct SimulationResult {
    bool converged = false;
    std::size_t deliveries = 0;
    std::size_t duplicates_ignored = 0;
    std::size_t partition_periods = 0;
    std::string digest;
    std::vector<SimTraceEntry> trace;
};

// A partition splits the replica set into two groups; while partitioned,
// deliveries only happen within groups. Partitions heal after `heal_after`
// steps; ops sent across the divide sit in in-flight queues and deliver on
// heal (eventual delivery guarantee).
class Simulation final {
public:
    explicit Simulation(const ScheduleConfig& config)
        : config_(config), rng_(config.seed) {
        for (std::size_t i = 0; i < config.replica_count; ++i) {
            docs_.emplace_back(
                concord::crdt::ReplicaId{static_cast<std::uint64_t>(1000 + i)});
            partition_of_.push_back(0);
        }
    }

    [[nodiscard]] const concord::crdt::Doc& doc(std::size_t index) const { return docs_[index]; }

    // Generates one local edit on replica `r` at a random visible position.
    void generate_local_edit(std::size_t r) {
        auto& doc = docs_[r];
        if (doc.stream_size() == 0 || dist_(rng_) < 0.5) {
            // Insert a random printable scalar.
            const char32_t scalar = U'a' + static_cast<char32_t>(dist_(rng_) * 26.0);
            enqueue(doc.local_insert_text(
                std::min(doc.stream_size(), static_cast<std::size_t>(dist_(rng_) * static_cast<double>(doc.stream_size() + 1))), scalar));
        } else {
            // Delete a random live item.
            const std::size_t target = static_cast<std::size_t>(dist_(rng_) * static_cast<double>(doc.stream_size()));
            if (auto op = doc.local_delete(target)) {
                enqueue(*op);
            }
        }
    }

    void generate_mark_toggle(std::size_t r) {
        auto& doc = docs_[r];
        if (doc.stream_size() == 0) {
            return;
        }
        const std::size_t target =
            static_cast<std::size_t>(dist_(rng_) * static_cast<double>(doc.stream_size()));
        const concord::crdt::StreamEntry entry = doc.stream_entry(target);
        const bool set = dist_(rng_) < 0.5;
        if (entry.kind == concord::crdt::ItemKind::Text) {
            // Text marks only on text items (PROTOCOL §5 registry).
            if (set) {
                enqueue(doc.local_set_attr(target, "bold", std::string{"1"}));
            } else {
                enqueue(doc.local_set_attr(target, "bold", std::nullopt));
            }
        } else {
            // Block attributes on delimiters.
            if (set) {
                enqueue(doc.local_set_attr(target, "align", std::string{"center"}));
            } else {
                enqueue(doc.local_set_attr(target, "align", std::nullopt));
            }
        }
    }

    void enqueue(concord::crdt::Operation op) {
        InFlight message;
        message.op = std::move(op);
        message.delivered.assign(docs_.size(), false);
        in_flight_.push_back(std::move(message));
    }

    // Run the full simulation: local edits + unreliable delivery + partitions,
    // then a healing phase with full delivery, then the convergence check.
    SimulationResult run() {
        SimulationResult result;
        const std::size_t partition_steps =
            static_cast<std::size_t>(static_cast<double>(config_.steps) * config_.partition_probability) + 1;
        bool partitioned = false;
        std::size_t partition_steps_remaining = 0;

        for (std::size_t step = 0; step < config_.steps; ++step) {
            // Local edits on random replicas.
            const std::size_t author = static_cast<std::size_t>(dist_(rng_) * static_cast<double>(docs_.size()));
            if (dist_(rng_) < 0.2) {
                generate_mark_toggle(author);
                trace_.push_back({step, "mark-toggle on replica " + std::to_string(author)});
            } else {
                generate_local_edit(author);
                trace_.push_back({step, "local edit on replica " + std::to_string(author)});
            }

            // Partition toggling.
            if (partition_steps_remaining == 0 && partitioned) {
                partitioned = false;
                result.partition_periods += 1;
                trace_.push_back({step, "partition heals"});
            }
            if (!partitioned && partition_steps_remaining == 0 &&
                std::uniform_real_distribution<>(0, 1)(rng_) < config_.partition_probability) {
                partitioned = true;
                partition_steps_remaining = partition_steps;
                const std::uint32_t pivot = 1 + static_cast<std::uint32_t>(
                                                   dist_(rng_) * static_cast<double>(docs_.size() - 1));
                for (std::size_t i = 0; i < partition_of_.size(); ++i) {
                    partition_of_[i] = i < pivot ? 0 : 1;
                }
                trace_.push_back({step, "partition begins (groups 0|1)"});
            }
            if (partition_steps_remaining > 0) {
                partition_steps_remaining -= 1;
            }

            // Deliver in-flight ops that cross no partition boundary.
            if (std::uniform_real_distribution<>(0, 1)(rng_) < config_.deliver_probability) {
                deliver_in_flight(partitioned, result);
            }
        }

        // Healing phase: no partitions; deliver everything until quiet.
        trace_.push_back({config_.steps, "healing phase: full delivery"});
        deliver_all(result);

        result.converged = check_convergence();
        result.digest = docs_[0].canonical_digest();
        result.trace = std::move(trace_);
        return result;
    }

private:
    // An in-flight message: one operation plus the set of replicas that have
    // already received it (at-least-once broadcast semantics; duplicates and
    // reordering are the norm, not the exception).
    struct InFlight {
        concord::crdt::Operation op;
        std::vector<bool> delivered;
    };

    [[nodiscard]] std::uint32_t partition_group_of(const InFlight& message) const {
        for (std::size_t r = 0; r < docs_.size(); ++r) {
            if (message.delivered[r] && partition_of_[r] == 1) {
                return 1;  // any already-delivered group-1 replica proves reach
            }
        }
        // Attribute by the generating replica's current group.
        for (std::size_t r = 0; r < docs_.size(); ++r) {
            if (docs_[r].replica().value() == message.op.id.replica.value()) {
                return partition_of_[r];
            }
        }
        return 0;
    }

    void deliver_in_flight(bool partitioned, SimulationResult& result) {
        if (in_flight_.empty()) {
            return;
        }
        // Work on a local copy: the queue mutates during delivery (erase /
        // duplication push), which would invalidate references into it.
        const std::size_t index =
            static_cast<std::size_t>(dist_(rng_) * static_cast<double>(in_flight_.size()));
        InFlight message = in_flight_[index];
        const std::uint32_t group = partition_group_of(message);

        // Eligible targets: same partition group while split, not yet delivered.
        std::vector<std::size_t> candidates;
        for (std::size_t r = 0; r < docs_.size(); ++r) {
            if (message.delivered[r]) {
                continue;
            }
            if (partitioned && partition_of_[r] != group) {
                continue;
            }
            candidates.push_back(r);
        }
        if (candidates.empty()) {
            // Everyone reachable has it; the entry retires (a heal
            // re-broadcasts anything still pending — entries are only fully
            // retired when every replica is covered).
            if (!partitioned) {
                in_flight_.erase(in_flight_.begin() + static_cast<std::ptrdiff_t>(index));
            }
            return;
        }
        const std::size_t target =
            candidates[static_cast<std::size_t>(dist_(rng_) * static_cast<double>(candidates.size()))];
        if (!docs_[target].apply_remote(message.op)) {
            result.duplicates_ignored += 1;
        }
        message.delivered[target] = true;
        result.deliveries += 1;

        // Duplication: schedule a redundant re-delivery pass.
        if (std::uniform_real_distribution<>(0, 1)(rng_) < config_.duplicate_probability) {
            in_flight_.push_back(message);
        }
        // Fully delivered entries retire.
        bool all = true;
        for (std::size_t r = 0; r < docs_.size(); ++r) {
            if (!message.delivered[r]) {
                all = false;
                break;
            }
        }
        if (all) {
            in_flight_.erase(in_flight_.begin() + static_cast<std::ptrdiff_t>(index));
        }
    }

    void deliver_all(SimulationResult& result) {
        // Healing: every remaining in-flight message reaches every replica.
        for (InFlight& message : in_flight_) {
            for (std::size_t r = 0; r < docs_.size(); ++r) {
                if (!message.delivered[r]) {
                    if (!docs_[r].apply_remote(message.op)) {
                        result.duplicates_ignored += 1;
                    }
                    message.delivered[r] = true;
                    result.deliveries += 1;
                }
            }
        }
        in_flight_.clear();
    }

    [[nodiscard]] bool check_convergence() const {
        const std::string digest = docs_[0].canonical_digest();
        for (const auto& doc : docs_) {
            if (doc.canonical_digest() != digest) {
                return false;
            }
        }
        return true;
    }

    ScheduleConfig config_;
    std::mt19937 rng_;
    std::uniform_real_distribution<> dist_{0.0, 1.0};
    std::vector<concord::crdt::Doc> docs_;
    std::vector<InFlight> in_flight_;
    std::vector<std::uint32_t> partition_of_;
    std::vector<SimTraceEntry> trace_;
};

// Prints a human-readable failure trace (seed + final state summaries).
inline void print_failure_trace(std::uint32_t seed, const SimulationResult& result) {
    std::fprintf(stderr, "SIMULATION FAILURE seed=%u converged=%d deliveries=%zu\n", seed,
                 result.converged ? 1 : 0, result.deliveries);
    for (std::size_t i = result.trace.size() > 40 ? result.trace.size() - 40 : 0;
         i < result.trace.size(); ++i) {
        std::fprintf(stderr, "  step %zu: %s\n", result.trace[i].step,
                     result.trace[i].event.c_str());
    }
}

}  // namespace concord::sim
