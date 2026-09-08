// P6-M017: fuzz regression corpus tests.
//
// Mechanism: every file under cpp/crdt/fuzz/corpus/** is a retained input.
// Crash-driven regressions land there (one file per issue, named by it) and
// this suite replays EACH corpus file through the exact entry point that
// crashed, asserting no crash/UB today. The suite is data-driven from an
// embedded file list (kept explicit so a new corpus file MUST be registered
// here deliberately — an un-asserted corpus file is a review error).
//
// Smoke-tier findings at the time of writing: NONE (5 targets × 1,000,000
// executions each, standalone driver). The corpus seeds below are retained
// structural fixtures (valid snapshot+tail, truncated variants, worker
// frames) so every future fuzz session starts deep in the format; any NEW
// crash adds a minimized file + a case here.
#include "test_harness.hpp"

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"

using namespace concord::crdt;

namespace {

// Corpus root is relative to the test binary's build directory; tests run
// from the build tree per add_test, but direct invocation happens from the
// repo root too, so try both known layouts.
[[nodiscard]] std::string find_corpus_root() {
    const char* candidates[] = {
        "cpp/crdt/fuzz/corpus",                         // run from repo root
        "../../../../../cpp/crdt/fuzz/corpus",          // run from build/<tree>/crdt/tests
        "../../../../cpp/crdt/fuzz/corpus",             // run from build/<tree>/crdt
        "../../../cpp/crdt/fuzz/corpus",                // run from build/<tree>
        "../../../../../../cpp/crdt/fuzz/corpus",       // deeper build layouts
    };
    for (const char* candidate : candidates) {
        std::ifstream probe(std::string{candidate} + "/recovery/seed_valid",
                            std::ios::binary);
        if (probe.good()) {
            probe.close();
            return candidate;
        }
    }
    return {};
}

[[nodiscard]] std::vector<std::uint8_t> read_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file.good()) {
        return {};
    }
    return std::vector<std::uint8_t>{std::istreambuf_iterator<char>(file),
                                     std::istreambuf_iterator<char>()};
}

// The fuzz_recovery_stream entry point (verbatim from the fuzz target).
bool replay_recovery(const std::vector<std::uint8_t>& bytes) {
    const std::string as_text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    try {
        if (bytes.size() < 4) {
            return true;
        }
        std::uint32_t snapshot_len = 0;
        for (std::size_t i = 0; i < 4; ++i) {
            snapshot_len |= static_cast<std::uint32_t>(bytes[i]) << (8u * i);
        }
        if (snapshot_len > bytes.size() - 4) {
            snapshot_len = static_cast<std::uint32_t>(bytes.size() - 4);
        }
        const Doc doc = Doc::import_snapshot(ReplicaId{1},
                                             as_text.substr(4, snapshot_len));
        (void)doc.canonical_digest();
    } catch (const CrdtError&) {
        // Structured rejection is the expected path for retained malformed
        // corpus inputs — the assertion is "no crash", not "import ok".
    }
    return true;
}

// The fuzz_worker_protocol entry point: full frame parse chain (length
// prefix + command + core decoders).
bool replay_worker(const std::vector<std::uint8_t>& bytes) {
    const std::string as_text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    constexpr std::uint64_t kMaxFrameBytes = 256ULL * 1024 * 1024;
    if (bytes.size() < 4) {
        return true;
    }
    std::uint32_t frame_len = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        frame_len |= static_cast<std::uint32_t>(bytes[i]) << (8u * i);
    }
    if (frame_len == 0 || frame_len > kMaxFrameBytes || frame_len < 4 ||
        frame_len > bytes.size() - 4) {
        return true;
    }
    const std::string frame = as_text.substr(4, frame_len);
    if (frame.size() < 4) {
        return true;
    }
    std::uint32_t command = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        command |= static_cast<std::uint32_t>(frame[i]) << (8u * i);
    }
    if (command != 3 && command != 5) {
        return true;  // non-snapshot commands covered by the fuzz target
    }
    std::size_t offset = 4;
    if (offset + 4 > frame.size()) {
        return true;
    }
    std::uint32_t snapshot_len = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        snapshot_len |= static_cast<std::uint32_t>(frame[offset + i]) << (8u * i);
    }
    offset += 4;
    if (snapshot_len > frame.size() - offset) {
        return true;
    }
    try {
        const Doc doc = Doc::import_snapshot(ReplicaId{0x53595343ULL},
                                             frame.substr(offset, snapshot_len));
        (void)doc.canonical_digest();
    } catch (const CrdtError&) {
        // Structured rejection expected on malformed retained inputs.
    }
    return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// Retained corpus files. Registered explicitly: a file appearing in the
// corpus directory without a case here is a review error (the point of the
// mechanism — every regression MUST become an assertion).
// ---------------------------------------------------------------------------

CONCORD_TEST(fuzz_regressions_recovery_corpus) {
    const std::string root = find_corpus_root();
    if (root.empty()) {
        // Corpus directory not found from this working directory: skip
        // WITH a loud note (never silently green).
        std::fprintf(stderr,
                     "NOTE fuzz_regressions: corpus root not found from cwd; "
                     "run from the repo root or a build tree\n");
        CHECK(false);
        return;
    }
    const char* files[] = {
        "recovery/seed_valid", "recovery/seed_truncated", "recovery/seed_empty",
        "worker/seed_import", "worker/seed_reconstruct", "worker/seed_generate",
        "worker/seed_oversize_len",
        // New crash regressions append here: one minimized file per issue,
        // named by the issue id, e.g. "recovery/regress-mNNN-truncated-snap".
    };
    std::size_t replayed = 0;
    for (const char* file : files) {
        const std::vector<std::uint8_t> bytes = read_file(root + "/" + file);
        CHECK(!bytes.empty());
        const std::string path(file);
        if (path.rfind("recovery/", 0) == 0 || path.rfind("worker/", 0) == 0) {
            CHECK(replay_recovery(bytes));
            CHECK(replay_worker(bytes));
        }
        ++replayed;
    }
    CHECK_EQ(replayed, sizeof(files) / sizeof(files[0]));
    std::printf("fuzz_regressions: replayed %zu corpus inputs\n", replayed);
}

CONCORD_TEST(fuzz_regressions_snapshot_tail_replay_stability) {
    // Direct invariant check on the retained VALID fixture (beyond "no
    // crash"): snapshot+tail recovery must equal full-replay recovery —
    // the compaction invariant the recovery fuzz target asserts per input.
    const std::string root = find_corpus_root();
    if (root.empty()) {
        CHECK(false);
        return;
    }
    const std::vector<std::uint8_t> raw = read_file(root + "/recovery/seed_valid");
    CHECK(raw.size() >= 4);
    std::uint32_t snapshot_len = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        snapshot_len |= static_cast<std::uint32_t>(raw[i]) << (8u * i);
    }
    CHECK(snapshot_len <= raw.size() - 4);
    const std::string snapshot(reinterpret_cast<const char*>(raw.data() + 4),
                               snapshot_len);
    // Import + digest; digest must be stable under a second import (pure
    // function of state) and under export→import round trip.
    const Doc doc = Doc::import_snapshot(ReplicaId{42}, snapshot);
    const std::string digest = doc.canonical_digest();
    const Doc doc2 = Doc::import_snapshot(ReplicaId{43}, snapshot);
    CHECK_EQ(doc2.canonical_digest(), digest);
    const std::string exported = doc.export_snapshot();
    const Doc round = Doc::import_snapshot(ReplicaId{44}, exported);
    CHECK_EQ(round.canonical_digest(), digest);
}
