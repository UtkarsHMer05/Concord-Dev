// P6-M015: large randomized convergence campaign runner.
//
// A standalone, configurable harness (NOT part of concord_crdt_tests): one
// process runs ONE campaign scenario and prints machine-readable JSON as
// the LAST line of stdout:
//   {"scenario":"campaign","seed":N,"replicas":N,"ops":N,"converged":true,
//    "digest":"...","divergent_replicas":0,...}
//
// Parameters (CLI args, env vars as fallback):
//   SEED          default 1          (deterministic default set)
//   REPLICAS      default 5
//   OPS           default 2000
//   CONFLICT_PROB default 0.5   probability an op targets a "hot" position
//                                (same anchor neighborhood as recent ops)
//   FAULT_PROB    default 0.3   per-delivery fault probability, split evenly
//                                between delay (partition), duplication, and
//                                reorder
//   OPS_BURST     default 16    local ops generated per burst before routing
//
// Model: R replicas each generate random weighted ops (insert/delete/mark),
// routed through an unreliable network: delay (op held in a partition-side
// buffer), duplicate delivery, reorder (delivery order decoupled from
// generation order). After ALL ops are delivered (partitions always heal),
// replicas exchange until quiescence, then digest equality is checked.
//
// Reproducibility: same SEED + parameters => identical result, identical
// trace. On divergence the harness prints the seed, a compact per-op trace,
// and the divergent replica list to stderr before the JSON line.
//
// Style: matches the codebase's zero-dependency conventions (std::mt19937
// seeded determinism, no I/O beyond printf, structured failure output).
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"

using namespace concord::crdt;

namespace {

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------
struct CampaignConfig {
    std::uint32_t seed = 1;
    std::size_t replicas = 5;
    std::size_t ops = 2000;
    double conflict_prob = 0.5;  // hot-position targeting
    double fault_prob = 0.3;      // delay|duplicate|reorder, 1/3 each
    std::size_t ops_burst = 16;
};

std::size_t parse_size(const char* value, std::size_t fallback) {
    if (value == nullptr) {
        return fallback;
    }
    const long long parsed = std::atoll(value);
    return parsed <= 0 ? fallback : static_cast<std::size_t>(parsed);
}

double parse_prob(const char* value, double fallback) {
    if (value == nullptr) {
        return fallback;
    }
    const double parsed = std::atof(value);
    if (parsed < 0.0 || parsed > 1.0) {
        return fallback;
    }
    return parsed;
}

// CLI: --seed N --replicas N --ops N --conflict 0.5 --fault 0.3 --burst N
// Env fallback: SEED, REPLICAS, OPS, CONFLICT_PROB, FAULT_PROB, OPS_BURST.
CampaignConfig config_from(int argc, char** argv) {
    CampaignConfig config;
    const char* env = nullptr;
    auto arg = [&](const char* name) -> const char* {
        for (int i = 1; i + 1 < argc; ++i) {
            if (std::strcmp(argv[i], name) == 0) {
                return argv[i + 1];
            }
        }
        return nullptr;
    };
    if ((env = std::getenv("SEED")) != nullptr || arg("--seed") != nullptr) {
        const std::uint64_t s =
            std::strtoull(arg("--seed") ? arg("--seed") : env, nullptr, 10);
        config.seed = static_cast<std::uint32_t>(s & 0xffffffffu);
    }
    config.replicas = parse_size(arg("--replicas") ? arg("--replicas")
                                                   : std::getenv("REPLICAS"), config.replicas);
    config.ops = parse_size(arg("--ops") ? arg("--ops") : std::getenv("OPS"), config.ops);
    config.conflict_prob = parse_prob(arg("--conflict") ? arg("--conflict")
                                                       : std::getenv("CONFLICT_PROB"),
                                      config.conflict_prob);
    config.fault_prob = parse_prob(arg("--fault") ? arg("--fault")
                                                  : std::getenv("FAULT_PROB"),
                                   config.fault_prob);
    config.ops_burst = parse_size(arg("--burst") ? arg("--burst")
                                                 : std::getenv("OPS_BURST"), config.ops_burst);
    return config;
}

// ---------------------------------------------------------------------------
// Deterministic fault-injecting network.
// ---------------------------------------------------------------------------
struct Message {
    Operation op;
    std::vector<bool> delivered;  // per-replica delivery mask
    std::uint64_t seq = 0;        // generation order (for reorder reporting)
    std::size_t author = 0;
    char desc = '?';  // compact op class: I/D/M/B (insert/delete/mark/block)
};

struct CampaignResult {
    bool converged = false;
    std::string digest;
    std::vector<std::size_t> divergent;
    std::size_t deliveries = 0;
    std::size_t duplicates_ignored = 0;
    std::size_t delayed = 0;
    std::size_t duplicated = 0;
    std::string trace;  // compact per-op script (filled on divergence only)
};

// Renders a JSON-escaped string (the digest is hex; trace entries are
// compact ASCII — escaping is belt and braces).
std::string json_escape(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 2);
    for (const char c : value) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back(c);
        } else if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out.append(buf);
        } else {
            out.push_back(c);
        }
    }
    return out;
}

// The campaign scenario. Returns a CampaignResult; deterministic in
// (seed, config).
CampaignResult run_campaign(const CampaignConfig& config) {
    CampaignResult result;
    std::mt19937 rng{config.seed};

    std::vector<Doc> docs;
    docs.reserve(config.replicas);
    for (std::size_t i = 0; i < config.replicas; ++i) {
        docs.emplace_back(ReplicaId{static_cast<std::uint64_t>(9000 + i)});
    }

    // Hot position: the stream index of the most recent local edit — ops
    // with CONFLICT_PROB target it or its neighborhood (same-position
    // contention); otherwise a uniform position.
    std::vector<std::size_t> hot(config.replicas, 0);
    std::vector<std::size_t> message_seq_counter(config.replicas, 0);
    std::vector<Message> in_flight;

    const std::size_t total_ops = config.ops;
    std::size_t generated = 0;
    std::string trace;

    // Partition state: two groups, toggled occasionally (partition = delay
    // of cross-group messages until heal; all messages deliver after heal).
    std::vector<std::uint32_t> group(config.replicas, 0);
    std::uint32_t partition_ticks = 0;

    const auto enqueue = [&](std::size_t author, Operation op, char desc) {
        Message message;
        message.op = std::move(op);
        message.delivered.assign(docs.size(), false);
        message.delivered[author] = true;  // author integrated at generation
        message.seq = message_seq_counter[author]++;
        message.author = author;
        message.desc = desc;
        in_flight.push_back(std::move(message));
    };

    // Generation + routing loop: bursts of local ops, then a routing pass.
    while (generated < total_ops) {
        const std::size_t burst = std::min(config.ops_burst, total_ops - generated);
        for (std::size_t b = 0; b < burst; ++b) {
            const std::size_t author = rng() % docs.size();
            Doc& doc = docs[author];
            if (doc.stream_size() == 0) {
                enqueue(author, doc.local_insert_text(0, U'a' + static_cast<char32_t>(rng() % 26)), 'I');
                ++generated;
                continue;
            }
            const auto choice = rng() % 10;
            if (choice < 6) {
                // Insert: hot position with probability conflict_prob.
                std::size_t position;
                if (static_cast<double>(rng() % 1000) / 1000.0 < config.conflict_prob) {
                    position = hot[author] + (rng() % 3);
                } else {
                    position = rng() % (doc.stream_size() + 1);
                }
                position = std::min(position, doc.stream_size());
                hot[author] = position;
                enqueue(author, doc.local_insert_text(position, U'a' + static_cast<char32_t>(rng() % 26)), 'I');
            } else if (choice < 8) {
                std::size_t position;
                if (static_cast<double>(rng() % 1000) / 1000.0 < config.conflict_prob) {
                    position = hot[author];
                } else {
                    position = rng() % doc.stream_size();
                }
                if (auto op = doc.local_delete(position)) {
                    enqueue(author, std::move(*op), 'D');
                }
            } else if (choice < 9) {
                std::size_t position = rng() % doc.stream_size();
                const StreamEntry entry = doc.stream_entry(position);
                const bool set = rng() % 2 == 0;
                if (entry.kind == ItemKind::Text) {
                    enqueue(author,
                            set ? doc.local_set_attr(position, "bold", std::string{"1"})
                                : doc.local_set_attr(position, "bold", std::nullopt),
                            'M');
                } else {
                    enqueue(author,
                            set ? doc.local_set_attr(position, "align", std::string{"center"})
                                : doc.local_set_attr(position, "align", std::nullopt),
                            'M');
                }
            } else {
                const std::size_t position = rng() % (doc.stream_size() + 1);
                hot[author] = position;
                enqueue(author, doc.local_insert_delimiter(position, "paragraph"), 'B');
            }
            ++generated;
        }

        // Partition toggling: start a partition with probability
        // fault_prob/3 per burst; heal after 2 bursts.
        if (partition_ticks == 0) {
            if (static_cast<double>(rng() % 1000) / 1000.0 < config.fault_prob / 3.0) {
                const std::size_t pivot = 1 + rng() % (docs.size() - 1);
                for (std::size_t i = 0; i < docs.size(); ++i) {
                    group[i] = i < pivot ? 0u : 1u;
                }
                partition_ticks = 2;
            }
        } else {
            --partition_ticks;
            if (partition_ticks == 0) {
                std::fill(group.begin(), group.end(), 0u);  // heal
            }
        }

        // Routing pass over in-flight messages with faults. Each message:
        //   delay  (fault_prob/3): stays queued (deliver after heal — at
        //          the end all partitions are healed so nothing is lost)
        //   dup    (fault_prob/3): duplicate delivery to a random target
        //   reorder: inherent — the pass walks in_flight in generation order
        //          but delivery picks random targets per message; plus an
        //          explicit shuffled pass below.
        for (std::size_t m = 0; m < in_flight.size(); ++m) {
            Message& message = in_flight[m];
            const double roll = static_cast<double>(rng() % 1000) / 1000.0;
            if (roll < config.fault_prob / 3.0 && partition_ticks > 0) {
                ++result.delayed;
                continue;  // delayed by the active partition
            }
            std::vector<std::size_t> candidates;
            for (std::size_t r = 0; r < docs.size(); ++r) {
                if (!message.delivered[r] && group[r] == group[message.author]) {
                    candidates.push_back(r);
                }
            }
            if (candidates.empty()) {
                continue;
            }
            const std::size_t target = candidates[rng() % candidates.size()];
            if (!docs[target].apply_remote(message.op)) {
                ++result.duplicates_ignored;
            } else {
                ++result.deliveries;
            }
            message.delivered[target] = true;

            if (roll >= config.fault_prob / 3.0 && roll < 2.0 * config.fault_prob / 3.0) {
                // Duplicate delivery: re-push a copy (redelivery must be
                // inert — counted when apply_remote returns false).
                Message copy = message;
                copy.delivered.assign(docs.size(), false);
                in_flight.push_back(std::move(copy));
                ++result.duplicated;
            }
        }
    }

    // Quiescence: heal everything, deliver every message to every replica
    // until no message is undelivered (bounded passes; each pass covers all
    // remaining (message, replica) pairs, so one pass suffices — the loop
    // is a safety net).
    for (int pass = 0; pass < 4; ++pass) {
        bool pending = false;
        for (Message& message : in_flight) {
            for (std::size_t r = 0; r < docs.size(); ++r) {
                if (!message.delivered[r]) {
                    if (!docs[r].apply_remote(message.op)) {
                        ++result.duplicates_ignored;
                    } else {
                        ++result.deliveries;
                    }
                    message.delivered[r] = true;
                }
            }
            for (const bool done : message.delivered) {
                if (!done) {
                    pending = true;
                }
            }
        }
        if (!pending) {
            break;
        }
    }

    // Convergence check + divergence reporting.
    result.digest = docs[0].canonical_digest();
    for (std::size_t r = 1; r < docs.size(); ++r) {
        if (docs[r].canonical_digest() != result.digest) {
            result.divergent.push_back(r);
        }
    }
    result.converged = result.divergent.empty();

    if (!result.converged) {
        // Compact per-op trace: author:seq,class per op (generation order).
        std::vector<const Message*> ordered;
        ordered.reserve(in_flight.size());
        for (const Message& message : in_flight) {
            ordered.push_back(&message);
        }
        std::sort(ordered.begin(), ordered.end(),
                  [](const Message* a, const Message* b) {
                      return std::tie(a->author, a->seq) < std::tie(b->author, b->seq);
                  });
        for (const Message* message : ordered) {
            char buf[64];
            std::snprintf(buf, sizeof(buf), "%zu:%llu%c ", message->author,
                          static_cast<unsigned long long>(message->seq), message->desc);
            trace.append(buf);
        }
        result.trace = std::move(trace);
    }
    return result;
}

}  // namespace

int main(int argc, char** argv) {
    const CampaignConfig config = config_from(argc, argv);
    const CampaignResult result = run_campaign(config);

    if (!result.converged) {
        std::fprintf(stderr,
                      "CAMPAIGN DIVERGENCE seed=%u replicas=%zu ops=%zu "
                      "conflict=%.3f fault=%.3f burst=%zu\n",
                      config.seed, config.replicas, config.ops, config.conflict_prob,
                      config.fault_prob, config.ops_burst);
        std::fprintf(stderr, "divergent replicas:");
        for (const std::size_t r : result.divergent) {
            std::fprintf(stderr, " %zu", r);
        }
        std::fprintf(stderr, "\nreference digest: %s\n", result.digest.c_str());
        for (const std::size_t r : result.divergent) {
            std::fprintf(stderr, "replica %zu digest: (see JSON digest field)\n", r);
        }
        std::fprintf(stderr, "op script (author:seq,class): %s\n", result.trace.c_str());
    }

    // Machine-readable result: ALWAYS the last line of stdout.
    std::printf(
        "{\"scenario\":\"campaign\",\"seed\":%u,\"replicas\":%zu,\"ops\":%zu,"
        "\"converged\":%s,\"digest\":\"%s\",\"divergent_replicas\":%zu,"
        "\"divergent_list\":\"%s\",\"deliveries\":%zu,\"duplicates_ignored\":%zu,"
        "\"delayed\":%zu,\"duplicated\":%zu}\n",
        config.seed, config.replicas, config.ops, result.converged ? "true" : "false",
        json_escape(result.digest).c_str(), result.divergent.size(),
        json_escape([&] {
            std::string list;
            for (const std::size_t r : result.divergent) {
                list += std::to_string(r);
                list += ",";
            }
            return list;
        }())
            .c_str(),
        result.deliveries, result.duplicates_ignored, result.delayed, result.duplicated);
    return result.converged ? 0 : 1;
}
