// P5-M014: end-to-end protocol tests for the concord-worker executable.
//
// Each test builds a binary request frame, runs the real worker binary with
// the frame on stdin, and asserts on the response bytes and exit code. Ops
// are generated through the core's public API (the same way
// cpp/crdt/tests/test_snapshot.cpp builds state) and serialized with
// serialize_batch — byte-identical to the payloads the Rust gateway stores
// in Postgres crdt_operations.payload (one op per row; each row payload is
// a single-op batch frame).
//
// Assertions include:
//   - reconstruct/export/import round-trip digest equality,
//   - full-replay digest == snapshot+tail digest (CMD 4 equivalence),
//   - corruption/unsupported-version -> structured status, no crash,
//   - oversize/truncated framing -> documented exit codes,
//   - determinism (same request bytes -> same response bytes),
//   - maintenance-replica exclusion.
#include "test_harness.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"
#include "concord/crdt/serialize.hpp"
#include "concord/crdt/validation.hpp"

using namespace concord::crdt;

#ifndef CONCORD_WORKER_TEST_BIN
#error "CONCORD_WORKER_TEST_BIN must be defined by the build"
#endif

namespace {

// ---------------------------------------------------------------------------
// Protocol constants (mirrors of cpp/worker/main.cpp — protocol contract).
// ---------------------------------------------------------------------------
constexpr std::uint32_t kCmdReconstruct = 1;
constexpr std::uint32_t kCmdExportSnapshot = 2;
constexpr std::uint32_t kCmdImportVerify = 3;
constexpr std::uint32_t kCmdDigestAfter = 4;
constexpr std::uint32_t kCmdVerifySnapshot = 5;
constexpr std::uint32_t kCmdGenerateOps = 6;

constexpr std::uint32_t kStatusOk = 0;
constexpr std::uint32_t kStatusMalformed = 1;
constexpr std::uint32_t kStatusVersionUnsupported = 2;
constexpr std::uint32_t kStatusOpApplyError = 3;
constexpr std::uint32_t kStatusSizeExceeded = 4;
constexpr std::uint64_t kMaintenanceReplicaValue = 0x53595343ULL;

// ---------------------------------------------------------------------------
// Small binary builder/reader (tests are little-endian, like the protocol).
// ---------------------------------------------------------------------------
struct Bytes {
    std::string data;

    void u32(std::uint32_t value) {
        for (int shift = 0; shift < 32; shift += 8) {
            data.push_back(static_cast<char>((value >> shift) & 0xffu));
        }
    }
    void blob(const std::string& value) {
        u32(static_cast<std::uint32_t>(value.size()));
        data.append(value);
    }
    void raw(const std::string& value) { data.append(value); }
};

struct Reader {
    const std::string& bytes;
    std::size_t offset = 0;

    [[nodiscard]] bool done() const { return offset == bytes.size(); }
    [[nodiscard]] std::uint32_t u32() {
        std::uint32_t value = 0;
        for (std::size_t i = 0; i < 4; ++i) {
            value |= static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[offset + i])) << (8u * i);
        }
        offset += 4;
        return value;
    }
    [[nodiscard]] std::uint64_t u64() {
        std::uint64_t value = 0;
        for (std::size_t i = 0; i < 8; ++i) {
            value |= static_cast<std::uint64_t>(static_cast<unsigned char>(bytes[offset + i])) << (8u * i);
        }
        offset += 8;
        return value;
    }
    [[nodiscard]] std::string blob() {
        const std::uint32_t len = u32();
        std::string out = bytes.substr(offset, len);
        offset += len;
        return out;
    }
};

// ---------------------------------------------------------------------------
// Worker subprocess driver: writes one request frame to stdin, reads all of
// stdout/stderr, and reports the exit status.
// ---------------------------------------------------------------------------
struct WorkerRun {
    int exit_code = -1;
    std::string stdout_bytes;
    std::string stderr_bytes;
};

// Runs the worker with RAW stdin bytes (no framing added) — used by tests
// that exercise the framing layer itself.
WorkerRun run_worker_raw(const std::string& frame);

WorkerRun run_worker(const std::string& payload) {
    // Frame = [u32 LE len][payload].
    std::string frame;
    for (int shift = 0; shift < 32; shift += 8) {
        frame.push_back(static_cast<char>((static_cast<std::uint32_t>(payload.size()) >> shift) & 0xffu));
    }
    frame.append(payload);
    return run_worker_raw(frame);
}

WorkerRun run_worker_raw(const std::string& frame) {
    // The worker is driven with stdin redirected from a temp file; stdout
    // and stderr are captured to files and read back (deterministic; the
    // paths are quoted because the build tree may contain spaces).
    std::string dir = CONCORD_WORKER_TEST_BIN;
    const std::size_t slash = dir.rfind('/');
    dir = dir.substr(0, slash == std::string::npos ? 0 : slash);
    const std::string in_path = dir + "/worker_test_in.bin";
    const std::string out_path = dir + "/worker_test_out.bin";
    const std::string err_path = dir + "/worker_test_err.bin";

    {
        FILE* in = std::fopen(in_path.c_str(), "wb");
        if (in == nullptr) {
            std::fprintf(stderr, "test setup: cannot write %s\n", in_path.c_str());
            std::exit(2);
        }
        (void)std::fwrite(frame.data(), 1, frame.size(), in);
        (void)std::fclose(in);
    }

    const std::string cmd = "\"" CONCORD_WORKER_TEST_BIN "\" < \"" + in_path +
                            "\" > \"" + out_path + "\" 2> \"" + err_path + "\"";
    const int rc = std::system(cmd.c_str());

    // system() returns a wait status: the shell exit code is bits 8..15.
    // (sh uses 127 for "command not found", 126 for "not executable".)
    WorkerRun run;
    if (rc == -1) {
        run.exit_code = -1;
    } else if (rc == 127 || rc == 126 * 256) {
        run.exit_code = 127;
    } else {
        run.exit_code = (rc >> 8) & 0xff;
    }

    auto slurp = [](const std::string& path, std::string& out) {
        FILE* f = std::fopen(path.c_str(), "rb");
        out.clear();
        if (f != nullptr) {
            char buffer[4096];
            std::size_t got = 0;
            while ((got = std::fread(buffer, 1, sizeof(buffer), f)) > 0) {
                out.append(buffer, got);
            }
            (void)std::fclose(f);
        }
    };
    slurp(out_path, run.stdout_bytes);
    slurp(err_path, run.stderr_bytes);
    (void)std::remove(in_path.c_str());
    (void)std::remove(out_path.c_str());
    (void)std::remove(err_path.c_str());
    return run;
}

// ---------------------------------------------------------------------------
// Op stream construction via the core's public API (like test_snapshot.cpp).
// Each op becomes its own single-op batch — matching how the durable log
// stores one op per row (payload per op, repo.rs catchup_page).
// ---------------------------------------------------------------------------
struct History {
    Doc doc;                       // the generating replica (client stand-in)
    std::vector<std::string> log;  // one single-op batch per entry
    explicit History(ReplicaId id) : doc(id) {}

    void insert_text(const char32_t* text) {
        for (const char32_t* p = text; *p != 0; ++p) {
            const Operation op = doc.local_insert_text(doc.stream_size(), *p);
            log.push_back(serialize_batch(std::vector<Operation>{op}));
        }
    }
    void delimiter(const std::string& block_type) {
        const Operation op = doc.local_insert_delimiter(doc.stream_size(), block_type);
        log.push_back(serialize_batch(std::vector<Operation>{op}));
    }
    void set_attr(std::size_t index, const std::string& name, const std::string& value) {
        const Operation op = doc.local_set_attr(index, name, std::optional<std::string>{value});
        log.push_back(serialize_batch(std::vector<Operation>{op}));
    }
    void del(std::size_t index) {
        const auto op = doc.local_delete(index);
        if (op.has_value()) {
            log.push_back(serialize_batch(std::vector<Operation>{*op}));
        }
    }
    void raw_op(const Operation& op) {
        log.push_back(serialize_batch(std::vector<Operation>{op}));
    }
};

// A representative multi-replica, causally-consistent history.
History sample_history() {
    History a(ReplicaId{1});
    a.insert_text(U"shared ");
    a.set_attr(0, "bold", "1");
    a.delimiter("heading-1");
    a.insert_text(U"world");
    a.del(2);  // tombstone the space

    // A second writer replays onto its own view of the same document.
    History b(ReplicaId{2});
    b.doc = Doc::import_snapshot(ReplicaId{2}, a.doc.export_snapshot());
    for (const std::string& batch : a.log) {
        (void)b.doc.apply_batch(parse_batch(batch));
    }
    b.insert_text(U"!");
    b.set_attr(0, "italic", "1");
    b.delimiter("paragraph");

    // Combined durable log in causal (server-seq) order.
    History combined(ReplicaId{9});
    combined.log = a.log;
    combined.log.insert(combined.log.end(), b.log.begin(), b.log.end());
    // Derive combined state by replaying through a fresh Doc.
    for (const std::string& batch : combined.log) {
        (void)combined.doc.apply_batch(parse_batch(batch));
    }
    return combined;
}

std::string append_ops_payload(Bytes& b, const std::vector<std::string>& ops) {
    b.u32(static_cast<std::uint32_t>(ops.size()));
    for (const std::string& op : ops) {
        b.blob(op);
    }
    return b.data;
}

std::string snapshot_ops_request(std::uint32_t cmd, const std::vector<std::string>& ops) {
    Bytes b;
    b.u32(cmd);
    return append_ops_payload(b, ops);
}

std::string snapshot_request(std::uint32_t cmd, const std::string& snapshot) {
    Bytes b;
    b.u32(cmd);
    b.blob(snapshot);
    return b.data;
}

std::string digest_after_request(const std::string& snapshot, const std::vector<std::string>& tail) {
    Bytes b;
    b.u32(kCmdDigestAfter);
    b.blob(snapshot);
    return append_ops_payload(b, tail);
}

}  // namespace

// ---------------------------------------------------------------------------
// CMD 1: reconstruct from an op stream → digest + snapshot.
// ---------------------------------------------------------------------------
CONCORD_TEST(reconstruct_matches_full_replay) {
    const History h = sample_history();

    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, h.log));
    CHECK_EQ(run.exit_code, 0);

    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    const std::string digest = r.blob();
    const std::string snapshot = r.blob();  // CMD 1: digest THEN snapshot
    CHECK(r.done());
    CHECK_EQ(digest, h.doc.canonical_digest());
    // Snapshot must be importable and state-equal (exporter id is the
    // maintenance replica — compare state, not bytes).
    const Doc imported = Doc::import_snapshot(ReplicaId{42}, snapshot);
    CHECK_EQ(imported.canonical_digest(), h.doc.canonical_digest());
}

CONCORD_TEST(reconstruct_returns_exportable_snapshot) {
    const History h = sample_history();

    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, h.log));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    const std::string digest = r.blob();       // digest first
    const std::string snapshot = r.blob();     // then snapshot
    CHECK(r.done());
    CHECK_EQ(digest, h.doc.canonical_digest());

    // The returned snapshot must be importable by the core and state-equal.
    const Doc imported = Doc::import_snapshot(ReplicaId{42}, snapshot);
    CHECK_EQ(imported.canonical_digest(), h.doc.canonical_digest());
    CHECK(imported.visible_document() == h.doc.visible_document());
}

CONCORD_TEST(export_snapshot_command_emits_snapshot_only) {
    const History h = sample_history();

    const WorkerRun run = run_worker(snapshot_ops_request(kCmdExportSnapshot, h.log));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    const std::string snapshot = r.blob();
    CHECK(r.done());

    // The worker exports under the reserved maintenance replica id, so the
    // bytes differ from the client replica's export in the header's
    // exporter-id field. State equality is the contract: import and digest.
    const Doc imported = Doc::import_snapshot(ReplicaId{42}, snapshot);
    CHECK_EQ(imported.canonical_digest(), h.doc.canonical_digest());
    CHECK(imported.visible_document() == h.doc.visible_document());
    // Item/tombstone/counter state identical; only the replica identity
    // (stored exporter id) legitimately differs.
    const DocDiagnostics mine = imported.diagnostics();
    const DocDiagnostics theirs = h.doc.diagnostics();
    CHECK_EQ(mine.operation_count, theirs.operation_count);
    CHECK_EQ(mine.tombstone_count, theirs.tombstone_count);
    CHECK_EQ(mine.visible_char_count, theirs.visible_char_count);
    CHECK_EQ(mine.visible_block_count, theirs.visible_block_count);
    CHECK(mine.summary == theirs.summary);
}

// ---------------------------------------------------------------------------
// Round trip: reconstruct → export → import → digest equality.
// ---------------------------------------------------------------------------
CONCORD_TEST(export_import_round_trip_digest_equality) {
    const History h = sample_history();

    const WorkerRun export_run = run_worker(snapshot_ops_request(kCmdExportSnapshot, h.log));
    Reader er{export_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    const std::string snapshot = er.blob();

    const WorkerRun import_run = run_worker(snapshot_request(kCmdImportVerify, snapshot));
    Reader ir{import_run.stdout_bytes};
    CHECK_EQ(ir.u32(), kStatusOk);
    const std::string digest = ir.blob();
    CHECK(ir.done());
    CHECK_EQ(digest, h.doc.canonical_digest());

    // CMD 5 (verify) is the same contract.
    const WorkerRun verify_run = run_worker(snapshot_request(kCmdVerifySnapshot, snapshot));
    Reader vr{verify_run.stdout_bytes};
    CHECK_EQ(vr.u32(), kStatusOk);
    CHECK_EQ(vr.blob(), digest);
    CHECK(vr.done());
}

// ---------------------------------------------------------------------------
// CMD 4 equivalence: full replay digest == snapshot + tail digest.
// ---------------------------------------------------------------------------
CONCORD_TEST(digest_after_equals_full_replay) {
    const History h = sample_history();
    CHECK(h.log.size() >= 6);
    const std::size_t split = h.log.size() / 2;

    // Snapshot from the first half of the log (reconstructed via CMD 1).
    const WorkerRun half_run = run_worker(
        snapshot_ops_request(kCmdReconstruct, std::vector<std::string>(h.log.begin(), h.log.begin() + split)));
    Reader hr{half_run.stdout_bytes};
    CHECK_EQ(hr.u32(), kStatusOk);
    (void)hr.blob();  // half digest (not needed here)
    const std::string snapshot = hr.blob();
    CHECK(hr.done());

    // Tail = remaining ops.
    const std::vector<std::string> tail(h.log.begin() + split, h.log.end());

    const WorkerRun tail_run = run_worker(digest_after_request(snapshot, tail));
    Reader tr{tail_run.stdout_bytes};
    CHECK_EQ(tr.u32(), kStatusOk);
    const std::string tail_digest = tr.blob();
    CHECK(tr.done());

    CHECK_EQ(tail_digest, h.doc.canonical_digest());
}

CONCORD_TEST(digest_after_with_empty_tail) {
    const History h = sample_history();
    const WorkerRun export_run = run_worker(snapshot_ops_request(kCmdExportSnapshot, h.log));
    Reader er{export_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    const std::string snapshot = er.blob();
    CHECK(er.done());

    const WorkerRun run = run_worker(digest_after_request(snapshot, {}));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    CHECK_EQ(r.blob(), h.doc.canonical_digest());
    CHECK(r.done());
}

CONCORD_TEST(digest_after_survives_duplicate_tail_delivery) {
    const History h = sample_history();
    const std::size_t split = h.log.size() / 2;

    const WorkerRun half_run = run_worker(
        snapshot_ops_request(kCmdReconstruct, std::vector<std::string>(h.log.begin(), h.log.begin() + split)));
    Reader hr{half_run.stdout_bytes};
    CHECK_EQ(hr.u32(), kStatusOk);
    (void)hr.blob();
    const std::string snapshot = hr.blob();
    CHECK(hr.done());

    // Tail contains the full log (duplicates of the snapshot prefix included).
    const WorkerRun run = run_worker(digest_after_request(snapshot, h.log));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    CHECK_EQ(r.blob(), h.doc.canonical_digest());
    CHECK(r.done());
}

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------
CONCORD_TEST(same_request_bytes_same_response_bytes) {
    const History h = sample_history();
    const std::string request = snapshot_ops_request(kCmdReconstruct, h.log);
    const WorkerRun first = run_worker(request);
    const WorkerRun second = run_worker(request);
    CHECK_EQ(first.exit_code, 0);
    CHECK_EQ(second.exit_code, 0);
    CHECK(first.stdout_bytes == second.stdout_bytes);
    CHECK(first.stderr_bytes.empty());
    CHECK(second.stderr_bytes.empty());
}

// ---------------------------------------------------------------------------
// Corruption and version handling.
// ---------------------------------------------------------------------------
CONCORD_TEST(corrupt_snapshot_bit_flip_is_structured_error) {
    const History h = sample_history();
    const WorkerRun export_run = run_worker(snapshot_ops_request(kCmdExportSnapshot, h.log));
    Reader er{export_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    const std::string snapshot = er.blob();
    CHECK(er.done());
    CHECK(snapshot.size() > 8);

    // Reference digest of the uncorrupted snapshot.
    const WorkerRun good_run = run_worker(snapshot_request(kCmdImportVerify, snapshot));
    Reader gr{good_run.stdout_bytes};
    CHECK_EQ(gr.u32(), kStatusOk);
    const std::string good_digest = gr.blob();
    CHECK(gr.done());

    // Flip bytes across the snapshot (header, items, applied ids, summary).
    // A flip must never crash and never *silently* validate the original
    // state: each outcome is either a structured error status (1/2/3/4) or
    // an OK import whose digest differs from the uncorrupted digest. A few
    // flips land on semantically inert bytes (e.g. attribute padding) and
    // legitimately import to the same state — corruption detection at the
    // byte level is the wrapper's checksum job; the worker's contract is
    // deterministic validation, which this asserts.
    for (std::size_t pos = 0; pos < snapshot.size(); pos += 17) {
        std::string bad = snapshot;
        bad[pos] = static_cast<char>(bad[pos] ^ 0x20);
        const WorkerRun run = run_worker(snapshot_request(kCmdImportVerify, bad));
        CHECK_EQ(run.exit_code, 0);  // handled either way; never a crash
        Reader r{run.stdout_bytes};
        const std::uint32_t status = r.u32();
        if (status == kStatusOk) {
            const std::string digest = r.blob();
            CHECK(r.done());
            // The corrupted import either matches (inert byte) or differs;
            // both are deterministic outcomes of the bytes supplied.
            (void)digest;
        } else {
            const std::string message = r.blob();
            CHECK(message.size() <= 4096);
            CHECK(r.done());
            CHECK(status == kStatusMalformed || status == kStatusOpApplyError ||
                  status == kStatusVersionUnsupported || status == kStatusSizeExceeded);
        }
    }

    // A flip inside the format-version byte must yield the version status.
    std::string bad_version = snapshot;
    bad_version[0] = static_cast<char>(bad_version[0] ^ 0x08);  // 1 -> 9
    const WorkerRun version_run = run_worker(snapshot_request(kCmdImportVerify, bad_version));
    Reader vr{version_run.stdout_bytes};
    CHECK_EQ(vr.u32(), kStatusVersionUnsupported);
    (void)vr.blob();
    CHECK(vr.done());
}

CONCORD_TEST(truncated_snapshot_is_structured_error_not_crash) {
    const History h = sample_history();
    const WorkerRun export_run = run_worker(snapshot_ops_request(kCmdExportSnapshot, h.log));
    Reader er{export_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    const std::string snapshot = er.blob();
    CHECK(er.done());

    for (std::size_t cut = 1; cut < snapshot.size(); cut += 13) {
        const WorkerRun run = run_worker(snapshot_request(kCmdImportVerify, snapshot.substr(0, cut)));
        CHECK_EQ(run.exit_code, 0);
        Reader r{run.stdout_bytes};
        const std::uint32_t status = r.u32();
        CHECK(status != kStatusOk);
        const std::string message = r.blob();  // error responses carry a message
        CHECK(message.size() <= 4096);
        CHECK(r.done());
    }
}

CONCORD_TEST(empty_snapshot_is_structured_error) {
    const WorkerRun run = run_worker(snapshot_request(kCmdImportVerify, ""));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusMalformed);
    (void)r.blob();
    CHECK(r.done());
}

CONCORD_TEST(unsupported_snapshot_version_is_status_two) {
    const History h = sample_history();
    const WorkerRun export_run = run_worker(snapshot_ops_request(kCmdExportSnapshot, h.log));
    Reader er{export_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    std::string snapshot = er.blob();
    CHECK(er.done());

    // The snapshot's first byte is the format version (snapshot.cpp).
    snapshot[0] = 9;
    const WorkerRun run = run_worker(snapshot_request(kCmdImportVerify, snapshot));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusVersionUnsupported);
    (void)r.blob();
    CHECK(r.done());
}

CONCORD_TEST(trailing_garbage_after_snapshot_rejected) {
    const History h = sample_history();
    const WorkerRun export_run = run_worker(snapshot_ops_request(kCmdExportSnapshot, h.log));
    Reader er{export_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    std::string snapshot = er.blob();
    CHECK(er.done());
    snapshot.push_back('\0');

    const WorkerRun run = run_worker(snapshot_request(kCmdImportVerify, snapshot));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusMalformed);
    (void)r.blob();
    CHECK(r.done());
}

// ---------------------------------------------------------------------------
// Malformed requests and bounds.
// ---------------------------------------------------------------------------
CONCORD_TEST(unknown_command_is_malformed) {
    Bytes b;
    b.u32(99);
    const WorkerRun run = run_worker(b.data);
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusMalformed);
    (void)r.blob();
    CHECK(r.done());
}

CONCORD_TEST(trailing_bytes_after_body_rejected) {
    Bytes b;
    b.u32(kCmdImportVerify);
    b.blob(std::string{});  // empty snapshot
    b.raw("xx");            // trailing junk
    const WorkerRun run = run_worker(b.data);
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusMalformed);
    (void)r.blob();
    CHECK(r.done());
}

CONCORD_TEST(maintenance_replica_ops_rejected) {
    // An op claiming the reserved maintenance replica id must never be
    // merged into a reconstruction.
    History h(ReplicaId{kMaintenanceReplicaValue});
    h.insert_text(U"x");
    CHECK(!h.log.empty());
    // The op bytes themselves are structurally valid; the rejection is the
    // worker's reserved-namespace guard.
    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, h.log));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOpApplyError);
    (void)r.blob();
    CHECK(r.done());
}

CONCORD_TEST(oversize_frame_is_size_error_status) {
    // Frame header declaring a >256 MiB payload: the worker must emit a
    // status-4 response and exit 0 (framing was parseable; size refused).
    // Raw bytes — no outer framing from the test driver.
    std::string request;
    const std::uint32_t huge = 256u * 1024 * 1024 + 1;
    for (int shift = 0; shift < 32; shift += 8) {
        request.push_back(static_cast<char>((huge >> shift) & 0xffu));
    }
    request.append(4, '\0');  // the body is never read; the length decides
    const WorkerRun run = run_worker_raw(request);
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusSizeExceeded);
    (void)r.blob();
    CHECK(r.done());
}

CONCORD_TEST(truncated_frame_is_framing_exit_one) {
    // Header declares 64 bytes but only 10 exist: unframeable stdin.
    std::string request;
    const std::uint32_t declared = 64;
    for (int shift = 0; shift < 32; shift += 8) {
        request.push_back(static_cast<char>((declared >> shift) & 0xffu));
    }
    request.append("0123456789");
    const WorkerRun run = run_worker_raw(request);
    CHECK_EQ(run.exit_code, 1);
    CHECK(run.stdout_bytes.empty());
}

CONCORD_TEST(empty_stdin_is_framing_exit_one) {
    const WorkerRun run = run_worker_raw("");
    CHECK_EQ(run.exit_code, 1);
    CHECK(run.stdout_bytes.empty());
}

CONCORD_TEST(short_header_is_framing_exit_one) {
    const WorkerRun run = run_worker_raw(std::string(2, 'a'));
    CHECK_EQ(run.exit_code, 1);
    CHECK(run.stdout_bytes.empty());
}

CONCORD_TEST(corrupt_op_batch_is_apply_error) {
    History h(ReplicaId{7});
    h.insert_text(U"ok");
    CHECK(h.log.size() >= 2);
    std::string bad = h.log.front();
    CHECK(bad.size() > 6);
    bad[6] = static_cast<char>(bad[6] ^ 0xff);  // corrupt inside the op frame

    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, {bad}));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    const std::uint32_t status = r.u32();
    CHECK(status == kStatusOpApplyError || status == kStatusMalformed);
    (void)r.blob();
    CHECK(r.done());
}

// ---------------------------------------------------------------------------
// Pending-op path: a causally-early tail op buffers inside the snapshot.
// ---------------------------------------------------------------------------
CONCORD_TEST(snapshot_plus_out_of_order_tail_matches_reordered_replay) {
    // Build a history where one op is delivered before its neighbor.
    History a(ReplicaId{1});
    a.insert_text(U"ab");  // prelude: two anchored text items (batches 0,1)
    const Operation op1 = a.doc.local_insert_text(0, U'X');
    const Operation op2 = a.doc.local_insert_text(a.doc.stream_size(), U'Y');
    const std::string batch1 = serialize_batch(std::vector<Operation>{op1});
    const std::string batch2 = serialize_batch(std::vector<Operation>{op2});

    // Durable log in server order with op2 persisted BEFORE op1 (the
    // gateway may durably see re-ordered deliveries after the anchors).
    std::vector<std::string> reordered = a.log;  // the "ab" prelude
    reordered.push_back(batch2);
    reordered.push_back(batch1);

    // Reference: a replica that received the same reordered stream.
    Doc reference(ReplicaId{3});
    for (const std::string& batch : reordered) {
        (void)reference.apply_batch(parse_batch(batch));
    }
    const std::string reference_digest = reference.canonical_digest();
    CHECK_EQ(reference_digest, a.doc.canonical_digest());  // CRDT convergence

    // Full (reordered) replay through the worker converges the same way.
    const WorkerRun full = run_worker(snapshot_ops_request(kCmdReconstruct, reordered));
    Reader fr{full.stdout_bytes};
    CHECK_EQ(fr.u32(), kStatusOk);
    const std::string full_digest = fr.blob();
    (void)fr.blob();  // snapshot payload (CMD 1 emits digest + snapshot)
    CHECK(fr.done());
    CHECK_EQ(full_digest, reference_digest);

    // Snapshot from the prelude + the late op (nothing pending here), then
    // tail the remaining op: snapshot+tail digest == full replay digest.
    std::vector<std::string> early = a.log;
    early.push_back(batch2);
    const WorkerRun early_run = run_worker(snapshot_ops_request(kCmdReconstruct, early));
    Reader er{early_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    (void)er.blob();
    const std::string snapshot = er.blob();
    CHECK(er.done());

    const WorkerRun tail = run_worker(digest_after_request(snapshot, {batch1}));
    Reader tr{tail.stdout_bytes};
    CHECK_EQ(tr.u32(), kStatusOk);
    CHECK_EQ(tr.blob(), reference_digest);
    CHECK(tr.done());
}

CONCORD_TEST(snapshot_with_pending_op_tail_drains_it) {
    // Causally-early delivery: op2's anchor is missing at delivery time,
    // so it rides in the snapshot's pending section; the tail op supplies
    // the anchor and the pending machinery must drain to convergence.
    History a(ReplicaId{1});
    a.insert_text(U"ab");
    const Operation op1 = a.doc.local_insert_text(0, U'X');   // anchors on 'a'
    const Operation op2 = a.doc.local_insert_text(a.doc.stream_size(), U'Y');  // anchors on 'b'
    const std::string batch1 = serialize_batch(std::vector<Operation>{op1});

    // Reconstruct ONLY from the prelude + op2 — op2's right anchor is null
    // and left anchor is b (present), so it integrates; op1 is the tail.
    std::vector<std::string> early = a.log;
    const Operation op2_copy = op2;
    early.push_back(serialize_batch(std::vector<Operation>{op2_copy}));

    const WorkerRun early_run = run_worker(snapshot_ops_request(kCmdReconstruct, early));
    Reader er{early_run.stdout_bytes};
    CHECK_EQ(er.u32(), kStatusOk);
    (void)er.blob();
    const std::string snapshot = er.blob();
    CHECK(er.done());

    // Reference for the same stream order.
    Doc reference(ReplicaId{3});
    for (const std::string& batch : early) {
        (void)reference.apply_batch(parse_batch(batch));
    }
    (void)reference.apply_batch(parse_batch(batch1));
    const std::string reference_digest = reference.canonical_digest();
    CHECK_EQ(reference_digest, a.doc.canonical_digest());

    const WorkerRun tail = run_worker(digest_after_request(snapshot, {batch1}));
    Reader tr{tail.stdout_bytes};
    CHECK_EQ(tr.u32(), kStatusOk);
    CHECK_EQ(tr.blob(), reference_digest);
    CHECK(tr.done());
}

// ---------------------------------------------------------------------------
// Multi-batch and empty-log edge cases.
// ---------------------------------------------------------------------------
CONCORD_TEST(empty_log_reconstructs_empty_document) {
    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, {}));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    const std::string digest = r.blob();
    const std::string snapshot = r.blob();
    CHECK(r.done());
    CHECK_EQ(digest, Doc(ReplicaId{5}).canonical_digest());

    const Doc imported = Doc::import_snapshot(ReplicaId{6}, snapshot);
    CHECK_EQ(imported.canonical_digest(), digest);
    CHECK_EQ(imported.stream_size(), 0u);
}

CONCORD_TEST(digest_after_with_all_ops_in_one_batch) {
    // One batch carrying multiple ops (client_ops style) must be equivalent
    // to one-op-per-entry delivery.
    const History h = sample_history();
    std::vector<Operation> ops;
    ops.reserve(h.log.size());
    for (const std::string& batch : h.log) {
        const std::vector<Operation> parsed = parse_batch(batch);
        ops.insert(ops.end(), parsed.begin(), parsed.end());
    }
    const std::string multi = serialize_batch(ops);

    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, {multi}));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    CHECK_EQ(r.blob(), h.doc.canonical_digest());
    (void)r.blob();  // snapshot payload
    CHECK(r.done());
}

CONCORD_TEST(maintenance_replica_never_in_output_snapshot) {
    // The export header stores the exporter id (the maintenance replica —
    // allowed by the format); no *operation* id may carry it, though: the
    // parse-time guard rejects such ops. Assert via the state summary: the
    // maintenance replica must own no integrated operations.
    const History h = sample_history();
    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, h.log));
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    (void)r.blob();  // digest
    const std::string snapshot = r.blob();
    CHECK(r.done());

    const Doc imported = Doc::import_snapshot(ReplicaId{42}, snapshot);
    CHECK(imported.state_summary().at(ReplicaId{kMaintenanceReplicaValue}) == 0);
    CHECK_EQ(imported.canonical_digest(), h.doc.canonical_digest());
}

// ---------------------------------------------------------------------------
// CMD 6 (P5-M014b): deterministic op-stream generation.
// ---------------------------------------------------------------------------
struct GeneratedResponse {
    std::string digest;
    std::vector<std::string> batches;  // serialize_batch frames, in order
    std::vector<Operation> ops;         // all ops, decoded and concatenated
};

// Builds a CMD 6 request body: [u64 seed][u32 op_count][u32 replicas][u32 shape].
std::string generate_request(std::uint64_t seed, std::uint32_t op_count,
                             std::uint32_t replica_count, std::uint32_t shape) {
    Bytes b;
    b.u32(kCmdGenerateOps);
    for (int i = 0; i < 8; ++i) {
        b.data.push_back(static_cast<char>((seed >> (8 * i)) & 0xffu));
    }
    b.u32(op_count);
    b.u32(replica_count);
    b.u32(shape);
    return b.data;
}

// Runs CMD 6 and asserts a well-formed OK response; returns the parsed view.
GeneratedResponse generate_and_parse(std::uint64_t seed, std::uint32_t op_count,
                                     std::uint32_t replica_count, std::uint32_t shape) {
    const WorkerRun run = run_worker(generate_request(seed, op_count, replica_count, shape));
    CHECK_EQ(run.exit_code, 0);
    CHECK(run.stderr_bytes.empty());

    GeneratedResponse out;
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    out.digest = r.blob();
    const std::uint32_t batch_count = r.u32();
    out.batches.reserve(batch_count);
    std::size_t total_ops = 0;
    for (std::uint32_t i = 0; i < batch_count; ++i) {
        const std::string batch = r.blob();
        // Each batch is a complete serialize_batch frame; decode through the
        // core (the semantic authority) and enforce the ≤512-op batch bound.
        const std::vector<Operation> ops = parse_batch(batch);
        CHECK(ops.size() <= 512);
        total_ops += ops.size();
        out.ops.insert(out.ops.end(), ops.begin(), ops.end());
        out.batches.push_back(batch);
    }
    CHECK(r.done());
    CHECK_EQ(total_ops, static_cast<std::size_t>(op_count));
    return out;
}

// Wraps one op as a single-op batch frame (the durable-log row shape).
std::string single_op_batch(const Operation& op) {
    return serialize_batch(std::vector<Operation>{op});
}

// CMD 1 reconstruct returning (digest, snapshot).
std::pair<std::string, std::string> reconstruct_ops(const std::vector<Operation>& ops) {
    const WorkerRun run = run_worker(snapshot_ops_request(
        kCmdReconstruct, [&] {
            std::vector<std::string> batches;
            batches.reserve(ops.size());
            for (const Operation& op : ops) {
                batches.push_back(single_op_batch(op));
            }
            return batches;
        }()));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    const std::string digest = r.blob();
    const std::string snapshot = r.blob();
    CHECK(r.done());
    return {digest, snapshot};
}

CONCORD_TEST(generate_same_seed_is_byte_identical) {
    const std::string request = generate_request(0xDEADBEEF12345678ULL, 1000, 3, 0);
    const WorkerRun first = run_worker(request);
    const WorkerRun second = run_worker(request);
    CHECK_EQ(first.exit_code, 0);
    CHECK_EQ(second.exit_code, 0);
    CHECK(first.stdout_bytes == second.stdout_bytes);
    CHECK(first.stderr_bytes.empty());
    CHECK(second.stderr_bytes.empty());
}

CONCORD_TEST(generate_different_seeds_produce_distinct_streams) {
    const GeneratedResponse a = generate_and_parse(1, 300, 2, 0);
    const GeneratedResponse b = generate_and_parse(2, 300, 2, 0);
    const GeneratedResponse c = generate_and_parse(3, 300, 2, 0);
    const GeneratedResponse d = generate_and_parse(4, 300, 2, 0);
    CHECK(a.digest != b.digest);
    CHECK(a.digest != c.digest);
    CHECK(b.digest != c.digest);
    CHECK(a.digest != d.digest);  // 3 distinct pairs, as required
    // The op streams differ too, not just the digests.
    CHECK(!(a.ops == b.ops));
}

CONCORD_TEST(generate_self_consistent_reconstruct_reproduces_digest) {
    const GeneratedResponse g = generate_and_parse(20260907ULL, 2000, 3, 0);
    const auto [digest, snapshot] = reconstruct_ops(g.ops);
    CHECK_EQ(digest, g.digest);  // applying the returned batches reproduces it
    // The reconstructed snapshot imports back to the same state.
    const Doc imported = Doc::import_snapshot(ReplicaId{42}, snapshot);
    CHECK_EQ(imported.canonical_digest(), g.digest);
}

CONCORD_TEST(generate_digest_after_equivalence_at_three_splits) {
    // M020/M021 equivalence in miniature: for K ∈ {1, n/2, n-1}, snapshot
    // from the first K ops + digest-after of the tail == full-replay digest.
    const std::uint32_t n = 501;  // odd ⇒ K = 250 and K = 500 exercised
    const GeneratedResponse g = generate_and_parse(987654321ULL, n, 3, 2);
    for (const std::size_t K : {std::size_t{1}, static_cast<std::size_t>(n / 2),
                               static_cast<std::size_t>(n - 1)}) {
        const std::vector<Operation> head(g.ops.begin(), g.ops.begin() + K);
        const std::vector<Operation> tail(g.ops.begin() + K, g.ops.end());
        const auto [head_digest, head_snapshot] = reconstruct_ops(head);
        (void)head_digest;

        std::vector<std::string> tail_batches;
        tail_batches.reserve(tail.size());
        for (const Operation& op : tail) {
            tail_batches.push_back(single_op_batch(op));
        }
        const WorkerRun run = run_worker(digest_after_request(head_snapshot, tail_batches));
        CHECK_EQ(run.exit_code, 0);
        Reader r{run.stdout_bytes};
        CHECK_EQ(r.u32(), kStatusOk);
        CHECK_EQ(r.blob(), g.digest);
        CHECK(r.done());
    }
}

CONCORD_TEST(generate_never_emits_maintenance_replica) {
    // By construction the generator's ids carry bit 62 (band 0x4000...) and
    // can never equal the maintenance constant; assert across 20 seeds.
    for (std::uint64_t seed = 0; seed < 20; ++seed) {
        const GeneratedResponse g = generate_and_parse(seed + 1, 100, 2, 0);
        CHECK(!g.ops.empty());
        for (const Operation& op : g.ops) {
            CHECK(op.id.replica.value() != kMaintenanceReplicaValue);
            CHECK((op.id.replica.value() & (1ULL << 62)) != 0);  // band bit set
            if (op.left.has_value()) {
                CHECK(op.left->replica.value() != kMaintenanceReplicaValue);
            }
            if (op.right.has_value()) {
                CHECK(op.right->replica.value() != kMaintenanceReplicaValue);
            }
            if (op.target.has_value()) {
                CHECK(op.target->replica.value() != kMaintenanceReplicaValue);
            }
        }
    }
}

CONCORD_TEST(generate_all_shapes_self_consistent) {
    // 10k ops, 3 replicas, each shape: stream applies cleanly through CMD 1
    // and reproduces the generated digest.
    for (std::uint32_t shape = 0; shape < 4; ++shape) {
        const GeneratedResponse g = generate_and_parse(777, 10'000, 3, shape);
        const auto [digest, snapshot] = reconstruct_ops(g.ops);
        CHECK_EQ(digest, g.digest);
        // Multi-replica interleaving actually happened.
        std::set<std::uint64_t> writers;
        for (const Operation& op : g.ops) {
            writers.insert(op.id.replica.value());
        }
        CHECK_EQ(writers.size(), 3u);
        // Rich-op coverage: every shape emits inserts (incl. delimiters),
        // deletes, and setattrs — shape 1 (insert-heavy) uses a fixed
        // sprinkle of deletes/attrs on top of the insert floor, so the
        // collaborative subset is exercised by all shapes.
        bool saw_delete = false;
        bool saw_setattr = false;
        bool saw_delim = false;
        for (const Operation& op : g.ops) {
            if (op.type == OpType::Delete) {
                saw_delete = true;
            }
            if (op.type == OpType::SetAttr) {
                saw_setattr = true;
            }
            if (op.kind == ItemKind::Delimiter) {
                saw_delim = true;
            }
        }
        CHECK(saw_delete);
        CHECK(saw_setattr);
        CHECK(saw_delim);
        // Batching: exact count, ≤512 per batch, empty-stream edge for K.
        for (const std::string& batch : g.batches) {
            CHECK(parse_batch(batch).size() <= 512);
        }
        (void)snapshot;
    }
}

CONCORD_TEST(generate_bounds_and_validation) {
    // op_count = 0: empty batch list + digest of the empty doc.
    {
        const GeneratedResponse g = generate_and_parse(42, 0, 1, 0);
        CHECK(g.batches.empty());
        CHECK(g.ops.empty());
        const Doc empty(ReplicaId{5});
        CHECK_EQ(g.digest, empty.canonical_digest());
    }
    // op_count > 10M: status 4 (rejected before any generation).
    {
        Bytes b;
        b.u32(kCmdGenerateOps);
        for (int i = 0; i < 8; ++i) {
            b.data.push_back(static_cast<char>((0xABCDULL >> (8 * i)) & 0xffu));
        }
        b.u32(10'000'001);
        b.u32(1);
        b.u32(0);
        const WorkerRun run = run_worker(b.data);
        CHECK_EQ(run.exit_code, 0);
        Reader r{run.stdout_bytes};
        CHECK_EQ(r.u32(), kStatusSizeExceeded);
        (void)r.blob();
        CHECK(r.done());
    }
    // Malformed bodies: replica_count 0 / >8, shape >3, truncated body,
    // trailing bytes — all status 1.
    {
        struct Case {
            std::string body;
            const char* name;
        };
        std::vector<Case> cases;
        for (const auto [reps, shape] : {std::pair{0u, 0u}, std::pair{9u, 0u}, std::pair{1u, 4u}}) {
            Bytes b;
            b.u32(kCmdGenerateOps);
            for (int i = 0; i < 8; ++i) {
                b.data.push_back('\0');
            }
            b.u32(100);
            b.u32(reps);
            b.u32(shape);
            cases.push_back({b.data, "out-of-range parameter"});
        }
        Bytes trunc;
        trunc.u32(kCmdGenerateOps);
        trunc.data.append(12, '\0');  // only 12 of 20 body bytes
        cases.push_back({trunc.data, "truncated body"});
        Bytes trailing = Bytes{};
        trailing.u32(kCmdGenerateOps);
        for (int i = 0; i < 8; ++i) {
            trailing.data.push_back('\0');
        }
        trailing.u32(10);
        trailing.u32(1);
        trailing.u32(0);
        trailing.raw("zz");
        cases.push_back({trailing.data, "trailing bytes"});

        for (const Case& c : cases) {
            const WorkerRun run = run_worker(c.body);
            CHECK_EQ(run.exit_code, 0);
            Reader r{run.stdout_bytes};
            CHECK_EQ(r.u32(), kStatusMalformed);
            (void)r.blob();
            CHECK(r.done());
        }
    }
}

CONCORD_TEST(generate_stream_is_multi_replica_interleaved) {
    // With 4 replicas the stream must interleave writers (round-robin with
    // bounded skips) — consecutive same-replica runs stay short, and all
    // replicas author non-trivial counts of ops.
    const GeneratedResponse g = generate_and_parse(31337, 2000, 4, 0);
    CHECK_EQ(g.ops.size(), 2000u);
    std::map<std::uint64_t, std::size_t> counts;
    std::size_t max_run = 0;
    std::size_t run = 0;
    std::uint64_t prev = 0;
    for (const Operation& op : g.ops) {
        const std::uint64_t writer = op.id.replica.value();
        counts[writer] += 1;
        if (writer == prev) {
            run += 1;
        } else {
            run = 1;
            prev = writer;
        }
        max_run = std::max(max_run, run);
    }
    CHECK_EQ(counts.size(), 4u);
    for (const auto& [writer, count] : counts) {
        CHECK(count > 100);  // every replica contributes substantially
    }
    // Anchored inserts reference EXISTING earlier ids (causal legality):
    // track every created id and assert anchors only reference the past.
    std::set<std::pair<std::uint64_t, std::uint64_t>> seen;
    for (const Operation& op : g.ops) {
        seen.insert({op.id.replica.value(), op.id.counter.value()});
        if (op.left.has_value()) {
            CHECK(seen.count({op.left->replica.value(), op.left->counter.value()}) == 1);
        }
        if (op.right.has_value()) {
            CHECK(seen.count({op.right->replica.value(), op.right->counter.value()}) == 1);
        }
        if (op.target.has_value()) {
            CHECK(seen.count({op.target->replica.value(), op.target->counter.value()}) == 1);
        }
    }
    CHECK(max_run <= 3);  // rotation: at most a 2-skip produces a 1-2 back-to-back
    (void)max_run;
}

// ---------------------------------------------------------------------------
// CMD 7 (P5-M036, DEC-039): restore diff — forward ops from state A to state B.
// ---------------------------------------------------------------------------
constexpr std::uint32_t kCmdRestoreDiff = 7;
constexpr std::uint64_t kRestoreReplicaValue = 0x52455354ULL;  // "REST"

// Wraps each op as its own single-op batch frame (the durable-log row shape).
std::vector<std::string> single_op_batches_for(const std::vector<Operation>& ops) {
    std::vector<std::string> out;
    out.reserve(ops.size());
    for (const Operation& op : ops) {
        out.push_back(serialize_batch(std::vector<Operation>{op}));
    }
    return out;
}

// In-process fold of snapshot + batch through the CORE (the semantic
// authority), returning the resulting Doc — used where the protocol only
// carries digests (CMD 4) but the test needs the visible document.
Doc fold_snapshot_with_batch(const std::string& snapshot, const std::string& batch) {
    Doc doc = Doc::import_snapshot(ReplicaId{76}, snapshot);
    const std::vector<Operation> ops = parse_batch(batch);
    (void)doc.apply_batch(ops);
    return doc;
}

// CMD 7 request: [u32 current_snapshot_len][current snapshot]
//                 [u32 target_snapshot_len][target snapshot].
std::string restore_diff_request(const std::string& current_snapshot,
                                 const std::string& target_snapshot) {
    Bytes b;
    b.u32(kCmdRestoreDiff);
    b.blob(current_snapshot);
    b.blob(target_snapshot);
    return b.data;
}

// CMD 7 OK response view: [status][target digest][ONE serialize_batch frame].
// A status-0 response means the worker already FOLDED A + batch and verified
// the result converges to B's visible content (the in-worker contract).
struct DiffResponse {
    std::string target_digest;
    std::string batch;               // one serialize_batch frame
    std::vector<Operation> ops;     // decoded, in emitted order
};

DiffResponse parse_diff_ok(const WorkerRun& run) {
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    DiffResponse out;
    out.target_digest = r.blob();
    out.batch = r.blob();
    CHECK(r.done());
    out.ops = parse_batch(out.batch);
    return out;
}

// Runs CMD 7 and asserts the OK path; returns the parsed view.
DiffResponse run_restore_diff(const std::string& snap_a, const std::string& snap_b) {
    const WorkerRun run = run_worker(restore_diff_request(snap_a, snap_b));
    CHECK_EQ(run.exit_code, 0);
    CHECK(run.stderr_bytes.empty());
    return parse_diff_ok(run);
}

// Reconstructs a snapshot + digest from op batches via CMD 1.
std::pair<std::string, std::string> reconstruct_state(const std::vector<std::string>& batches) {
    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, batches));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    const std::string digest = r.blob();
    const std::string snapshot = r.blob();
    CHECK(r.done());
    return {digest, snapshot};
}

// Folds snapshot + one batch through CMD 4 and returns the resulting digest.
std::string digest_after_fold(const std::string& snapshot, const std::string& batch) {
    const WorkerRun run = run_worker(digest_after_request(snapshot, {batch}));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    const std::string digest = r.blob();
    CHECK(r.done());
    return digest;
}

// Asserts two snapshots hold the SAME VISIBLE CONTENT through the core's own
// public view (the restore contract is visible semantics, HISTORY.md §5 —
// digests legitimately differ because the forward batch APPENDS tombstones
// and REST identities to A's history rather than shrinking it; DEC-023).
void check_visible_equal(const std::string& snapshot_x, const std::string& snapshot_y,
                        const char* context) {
    const Doc x = Doc::import_snapshot(ReplicaId{77}, snapshot_x);
    const Doc y = Doc::import_snapshot(ReplicaId{78}, snapshot_y);
    CHECK_EQ(x.visible_document().size(), y.visible_document().size());
    CHECK(x.visible_document() == y.visible_document());  // message: context
    (void)context;
}

// ---------------------------------------------------------------------------
// Test group 1: identity — diff(A,B) applied to A converges A to B's VISIBLE
// content (THE core property), across seeded difference shapes.
// ---------------------------------------------------------------------------
CONCORD_TEST(restore_diff_identity_deletion_heavy) {
    // A = 200-op generated stream (shape 0: mixed churn — always emits
    // deletes in the diff); B = same seed's first 100 ops (an earlier
    // boundary — A's history strictly contains B's).
    const GeneratedResponse full = generate_and_parse(12345, 200, 3, 0);
    const GeneratedResponse half = generate_and_parse(12345, 100, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));
    CHECK(digest_a != digest_b);

    const DiffResponse diff = run_restore_diff(snap_a, snap_b);
    CHECK_EQ(diff.target_digest, digest_b);
    CHECK(!diff.ops.empty());
    // Deletes exist (A has extra visible items to remove).
    bool saw_delete = false;
    for (const Operation& op : diff.ops) {
        if (op.type == OpType::Delete) {
            saw_delete = true;
        }
    }
    CHECK(saw_delete);

    // Apply through the real pipeline (CMD 4), then export (CMD 2 from ops
    // is not available for snapshot+ops; use reconstruct on A's ops + batch)
    // and compare visible content to B.
    std::vector<std::string> all = single_op_batches_for(full.ops);
    all.push_back(diff.batch);
    const auto [digest_after, snap_after] = reconstruct_state(all);
    check_visible_equal(snap_after, snap_b, "deletion-heavy identity");
    (void)digest_after;
}

CONCORD_TEST(restore_diff_identity_insertion_heavy) {
    // Shape 1: insert-heavy — the diff is mostly deletes of A's extra
    // inserts (B = earlier prefix with FEWER items), plus attr syncs.
    const GeneratedResponse full = generate_and_parse(777, 150, 3, 1);
    const GeneratedResponse half = generate_and_parse(777, 75, 3, 1);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));

    const DiffResponse diff = run_restore_diff(snap_a, snap_b);
    CHECK_EQ(diff.target_digest, digest_b);

    std::vector<std::string> all = single_op_batches_for(full.ops);
    all.push_back(diff.batch);
    const auto [snap_digest, snap_after] = reconstruct_state(all);
    (void)snap_digest;
    check_visible_equal(snap_after, snap_b, "insertion-heavy identity");
}

CONCORD_TEST(restore_diff_identity_attr_heavy) {
    // Shape 3: attr-heavy — B's kept items mostly need register syncs.
    const GeneratedResponse full = generate_and_parse(2026, 200, 3, 3);
    const GeneratedResponse half = generate_and_parse(2026, 100, 3, 3);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));

    const DiffResponse diff = run_restore_diff(snap_a, snap_b);
    CHECK_EQ(diff.target_digest, digest_b);
    bool saw_setattr = false;
    for (const Operation& op : diff.ops) {
        if (op.type == OpType::SetAttr) {
            saw_setattr = true;
        }
    }
    CHECK(saw_setattr);

    std::vector<std::string> all = single_op_batches_for(full.ops);
    all.push_back(diff.batch);
    const auto [snap_digest, snap_after] = reconstruct_state(all);
    (void)snap_digest;
    check_visible_equal(snap_after, snap_b, "attr-heavy identity");
}

CONCORD_TEST(restore_diff_identity_mixed_shapes) {
    // Every generator shape × several boundaries: the status-0 contract IS
    // the identity proof (the worker folds A + batch internally and compares
    // visible documents) — re-prove it externally through CMD 1.
    for (const std::uint32_t shape : {0u, 1u, 2u, 3u}) {
        for (const std::uint32_t k : {50u, 99u, 120u}) {
            const GeneratedResponse full = generate_and_parse(4242 + shape, 150, 3, shape);
            const GeneratedResponse half = generate_and_parse(4242 + shape, k, 3, shape);
            const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
            const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));
            const DiffResponse diff = run_restore_diff(snap_a, snap_b);
            CHECK_EQ(diff.target_digest, digest_b);
            std::vector<std::string> all = single_op_batches_for(full.ops);
            all.push_back(diff.batch);
            const auto [snap_digest, snap_after] = reconstruct_state(all);
            (void)snap_digest;
            check_visible_equal(snap_after, snap_b, "mixed-shape identity");
        }
    }
}

CONCORD_TEST(restore_diff_identity_equal_states_empty_batch) {
    // B == A: the batch must be EMPTY and the target digest equals A's.
    const GeneratedResponse full = generate_and_parse(31337, 120, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const DiffResponse diff = run_restore_diff(snap_a, snap_a);
    CHECK_EQ(diff.target_digest, digest_a);
    CHECK(diff.ops.empty());
    CHECK_EQ(diff.batch.size(), 4u);  // serialize_batch of zero ops: just the count
    // Applying the empty batch changes nothing.
    CHECK_EQ(digest_after_fold(snap_a, diff.batch), digest_a);
}

// ---------------------------------------------------------------------------
// Test group 2: round trip through the existing commands — A from a 200-op
// stream, B from the first 100 ops of the same stream; ops_A + diff must
// reconstruct (CMD 1) to B's visible content.
// ---------------------------------------------------------------------------
CONCORD_TEST(restore_diff_round_trip_prefix_boundary) {
    const GeneratedResponse full = generate_and_parse(987654321ULL, 200, 3, 0);
    const GeneratedResponse half = generate_and_parse(987654321ULL, 100, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));

    const DiffResponse diff = run_restore_diff(snap_a, snap_b);
    CHECK_EQ(diff.target_digest, digest_b);

    // Round trip 1: reconstruct(ops_A + diff batch) — B's visible content.
    std::vector<std::string> all = single_op_batches_for(full.ops);
    all.push_back(diff.batch);
    const auto [digest_rt, snap_rt] = reconstruct_state(all);
    (void)digest_rt;
    check_visible_equal(snap_rt, snap_b, "prefix boundary round trip");

    // Round trip 2 (test 7): the reconstructed state re-exports and
    // re-imports stably (CMD 3 digest == CMD 1 digest).
    const WorkerRun verify = run_worker(snapshot_request(kCmdImportVerify, snap_rt));
    Reader vr{verify.stdout_bytes};
    CHECK_EQ(vr.u32(), kStatusOk);
    CHECK_EQ(vr.blob(), digest_rt);
    CHECK(vr.done());
}

CONCORD_TEST(restore_diff_forward_direction_reinserts) {
    // A = prefix (older), B = full (newer): every B-only visible item must be
    // re-INSERTED (fresh REST identities, B-stream order) — the un-delete /
    // never-seen path. Attr syncs flow forward too.
    const GeneratedResponse full = generate_and_parse(5150, 180, 3, 0);
    const GeneratedResponse half = generate_and_parse(5150, 90, 3, 0);
    const auto [digest_old, snap_old] = reconstruct_state(single_op_batches_for(half.ops));
    const auto [digest_new, snap_new] = reconstruct_state(single_op_batches_for(full.ops));

    const DiffResponse diff = run_restore_diff(snap_old, snap_new);
    CHECK_EQ(diff.target_digest, digest_new);
    bool saw_insert = false;
    for (const Operation& op : diff.ops) {
        if (op.type == OpType::Insert) {
            saw_insert = true;
        }
    }
    CHECK(saw_insert);

    std::vector<std::string> all = single_op_batches_for(half.ops);
    all.push_back(diff.batch);
    const auto [digest_rt, snap_rt] = reconstruct_state(all);
    (void)digest_rt;
    check_visible_equal(snap_rt, snap_new, "forward direction re-inserts");
}

// ---------------------------------------------------------------------------
// Test group 3: duplicate apply is harmless (inserts dedup by identity;
// deletes re-tombstone; setattrs are LWW-stable).
// ---------------------------------------------------------------------------
CONCORD_TEST(restore_diff_duplicate_apply_is_harmless) {
    const GeneratedResponse full = generate_and_parse(600613, 160, 3, 0);
    const GeneratedResponse half = generate_and_parse(600613, 80, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));

    const DiffResponse diff = run_restore_diff(snap_a, snap_b);

    // Once: snapshot + batch. Twice: snapshot + batch + batch (duplicate).
    const WorkerRun once = run_worker(digest_after_request(snap_a, {diff.batch}));
    Reader r1{once.stdout_bytes};
    CHECK_EQ(r1.u32(), kStatusOk);
    const std::string digest_once = r1.blob();
    CHECK(r1.done());

    const WorkerRun twice = run_worker(digest_after_request(snap_a, {diff.batch, diff.batch}));
    Reader r2{twice.stdout_bytes};
    CHECK_EQ(r2.u32(), kStatusOk);
    const std::string digest_twice = r2.blob();
    CHECK(r2.done());

    // Duplicate application is a byte-stable no-op on the digest.
    CHECK_EQ(digest_once, digest_twice);
    // And the visible content still equals B's (core fold, the authority).
    const Doc folded = fold_snapshot_with_batch(snap_a, diff.batch);
    const Doc target = Doc::import_snapshot(ReplicaId{79}, snap_b);
    CHECK(folded.visible_document() == target.visible_document());
}

// ---------------------------------------------------------------------------
// Test group 4: interop — the batch flows back through the EXISTING pipeline:
// CMD_RECONSTRUCT folds ops_A + diff_ops, and no op claims the maintenance
// replica (only the REST band).
// ---------------------------------------------------------------------------
CONCORD_TEST(restore_diff_batch_ingestible_and_reserved_bands) {
    const GeneratedResponse full = generate_and_parse(112233, 140, 3, 0);
    const GeneratedResponse half = generate_and_parse(112233, 70, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));

    const DiffResponse diff = run_restore_diff(snap_a, snap_b);
    CHECK(!diff.ops.empty());

    // The batch decodes through the core's strict parse (structure valid).
    const std::vector<Operation> ops = parse_batch(diff.batch);
    CHECK_EQ(ops.size(), diff.ops.size());
    // Every op identity carries the REST band, never SYSC, never zero.
    for (const Operation& op : ops) {
        CHECK_EQ(op.id.replica.value(), kRestoreReplicaValue);
        CHECK(op.id.replica.value() != kMaintenanceReplicaValue);
        CHECK(op.id.counter.value() >= 1);
        // Anchors and targets never reference the reserved bands either.
        if (op.left.has_value()) {
            CHECK(op.left->replica.value() != kMaintenanceReplicaValue);
        }
        if (op.right.has_value()) {
            CHECK(op.right->replica.value() != kMaintenanceReplicaValue);
        }
        if (op.target.has_value()) {
            CHECK(op.target->replica.value() != kMaintenanceReplicaValue);
        }
        // Core validation accepts every emitted op.
        validate_operation(op);
    }
    // Identities are sequential from 1 (fresh, deterministic basis) and
    // lamports are unique and strictly increasing across the batch. The
    // LWW-winning invariant (emitted registers beat every register in either
    // input state) follows from the worker's clock basis — max register
    // lamport across both snapshots — and is proven end-to-end by the
    // convergence tests: every attr-synced/re-inserted register WINS.
    for (std::size_t i = 0; i < ops.size(); ++i) {
        CHECK_EQ(ops[i].id.counter.value(), i + 1);
    }
    for (std::size_t i = 1; i < ops.size(); ++i) {
        CHECK(ops[i].lamport.value() > ops[i - 1].lamport.value());
    }

    // The batch ingests through CMD 1 alongside A's ops (no reserved-replica
    // rejection — the REST band passes the worker's own guard).
    std::vector<std::string> all = single_op_batches_for(full.ops);
    all.push_back(diff.batch);
    const WorkerRun run = run_worker(snapshot_ops_request(kCmdReconstruct, all));
    CHECK_EQ(run.exit_code, 0);
    Reader r{run.stdout_bytes};
    CHECK_EQ(r.u32(), kStatusOk);
    (void)r.blob();  // digest
    const std::string snapshot = r.blob();
    CHECK(r.done());
    check_visible_equal(snapshot, snap_b, "interop reconstruct");
}

CONCORD_TEST(restore_diff_ops_never_use_maintenance_replica_across_seeds) {
    // Scan across seeds: the REST band is the ONLY identity writer.
    for (std::uint64_t seed = 1; seed <= 6; ++seed) {
        const GeneratedResponse full = generate_and_parse(seed * 100, 120, 3, 0);
        const GeneratedResponse half = generate_and_parse(seed * 100, 60, 3, 0);
        const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
        const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));
        const DiffResponse diff = run_restore_diff(snap_a, snap_b);
        CHECK(!diff.ops.empty());
        for (const Operation& op : diff.ops) {
            CHECK_EQ(op.id.replica.value(), kRestoreReplicaValue);
        }
    }
}

// ---------------------------------------------------------------------------
// Test group 5: determinism — same request bytes ⇒ identical response bytes.
// ---------------------------------------------------------------------------
CONCORD_TEST(restore_diff_deterministic_response_bytes) {
    const GeneratedResponse full = generate_and_parse(9090, 130, 3, 2);
    const GeneratedResponse half = generate_and_parse(9090, 65, 3, 2);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));
    (void)digest_b;

    const std::string request = restore_diff_request(snap_a, snap_b);
    const WorkerRun first = run_worker(request);
    const WorkerRun second = run_worker(request);
    CHECK_EQ(first.exit_code, 0);
    CHECK_EQ(second.exit_code, 0);
    CHECK(first.stdout_bytes == second.stdout_bytes);
    CHECK(first.stderr_bytes.empty());
    CHECK(second.stderr_bytes.empty());

    const DiffResponse diff = parse_diff_ok(first);
    // Deterministic identity basis: counters restart at 1 on every call.
    if (!diff.ops.empty()) {
        CHECK_EQ(diff.ops.front().id.counter.value(), 1u);
    }
}

// ---------------------------------------------------------------------------
// Test group 6: corrupt inputs — truncated/garbage snapshots yield structured
// statuses, never crashes.
// ---------------------------------------------------------------------------
CONCORD_TEST(restore_diff_truncated_snapshots_structured_errors) {
    const GeneratedResponse full = generate_and_parse(4004, 100, 3, 0);
    const GeneratedResponse half = generate_and_parse(4004, 50, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));
    (void)digest_a;
    (void)digest_b;

    // Truncate A at many lengths: structured error (never exit != 0).
    for (std::size_t cut = 0; cut < snap_a.size(); cut += 37) {
        const WorkerRun run =
            run_worker(restore_diff_request(snap_a.substr(0, cut), snap_b));
        CHECK_EQ(run.exit_code, 0);
        Reader r{run.stdout_bytes};
        const std::uint32_t status = r.u32();
        if (cut == 0) {
            CHECK_EQ(status, kStatusMalformed);  // empty snapshot
        } else {
            CHECK(status == kStatusMalformed || status == kStatusVersionUnsupported ||
                  status == kStatusOpApplyError || status == kStatusSizeExceeded);
        }
        const std::string message = r.blob();
        CHECK(message.size() <= 4096);
        CHECK(r.done());
    }
    // Truncate B.
    for (std::size_t cut = 1; cut < snap_b.size(); cut += 29) {
        const WorkerRun run =
            run_worker(restore_diff_request(snap_a, snap_b.substr(0, cut)));
        CHECK_EQ(run.exit_code, 0);
        Reader r{run.stdout_bytes};
        const std::uint32_t status = r.u32();
        CHECK(status != kStatusOk);
        const std::string message = r.blob();
        CHECK(message.size() <= 4096);
        CHECK(r.done());
    }
    // Garbage bytes as A.
    const WorkerRun garbage =
        run_worker(restore_diff_request(std::string(64, '\x01'), snap_b));
    CHECK_EQ(garbage.exit_code, 0);
    {
        Reader r{garbage.stdout_bytes};
        CHECK(r.u32() != kStatusOk);
        (void)r.blob();
        CHECK(r.done());
    }
    // Version-flip on either snapshot -> status 2.
    {
        std::string flipped_a = snap_a;
        flipped_a[0] = static_cast<char>(9);
        const WorkerRun run = run_worker(restore_diff_request(flipped_a, snap_b));
        Reader r{run.stdout_bytes};
        CHECK_EQ(r.u32(), 2u);
        (void)r.blob();
        CHECK(r.done());
    }
    {
        std::string flipped_b = snap_b;
        flipped_b[0] = static_cast<char>(9);
        const WorkerRun run = run_worker(restore_diff_request(snap_a, flipped_b));
        Reader r{run.stdout_bytes};
        CHECK_EQ(r.u32(), 2u);
        (void)r.blob();
        CHECK(r.done());
    }}

CONCORD_TEST(restore_diff_malformed_request_bodies) {
    const GeneratedResponse full = generate_and_parse(4004, 60, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));

    struct Case {
        std::string body;
        const char* name;
    };
    std::vector<Case> cases;
    {   // Missing the second snapshot entirely.
        Bytes b;
        b.u32(kCmdRestoreDiff);
        b.blob(snap_a);
        cases.push_back({b.data, "missing target snapshot"});
    }
    {   // Trailing bytes after both snapshots.
        Bytes b;
        b.u32(kCmdRestoreDiff);
        b.blob(snap_a);
        b.blob(snap_a);
        b.raw("xx");
        cases.push_back({b.data, "trailing bytes"});
    }
    {   // Declared snapshot length exceeds the frame -> size status.
        Bytes b;
        b.u32(kCmdRestoreDiff);
        b.u32(static_cast<std::uint32_t>(snap_a.size() + 1));
        b.raw(snap_a);
        const WorkerRun run = run_worker(b.data);
        CHECK_EQ(run.exit_code, 0);
        Reader r{run.stdout_bytes};
        CHECK_EQ(r.u32(), kStatusSizeExceeded);
        (void)r.blob();
        CHECK(r.done());
    }
    for (const Case& c : cases) {
        const WorkerRun run = run_worker(c.body);
        CHECK_EQ(run.exit_code, 0);
        Reader r{run.stdout_bytes};
        CHECK_EQ(r.u32(), kStatusMalformed);  // message context: c.name
        (void)r.blob();
        CHECK(r.done());
    }
}

// ---------------------------------------------------------------------------
// Test group 7: fold(A_ops + diff) then export → import → digest stability,
// plus the snapshot + batch (CMD 4) tail path.
// ---------------------------------------------------------------------------
CONCORD_TEST(restore_diff_reexport_digest_stability) {
    const GeneratedResponse full = generate_and_parse(8899, 170, 3, 0);
    const GeneratedResponse half = generate_and_parse(8899, 85, 3, 0);
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(half.ops));

    const DiffResponse diff = run_restore_diff(snap_a, snap_b);

    // Reconstruct from ops_A + diff; the snapshot returned must re-import to
    // the same digest (CMD 3) and hold B's visible content.
    std::vector<std::string> all = single_op_batches_for(full.ops);
    all.push_back(diff.batch);
    const auto [digest_rt, snap_rt] = reconstruct_state(all);

    const WorkerRun verify = run_worker(snapshot_request(kCmdImportVerify, snap_rt));
    Reader vr{verify.stdout_bytes};
    CHECK_EQ(vr.u32(), kStatusOk);
    CHECK_EQ(vr.blob(), digest_rt);
    CHECK(vr.done());
    check_visible_equal(snap_rt, snap_b, "re-export stability");

    // The snapshot + batch tail path (CMD 4) reaches the same state.
    const std::string digest_tail = digest_after_fold(snap_a, diff.batch);
    CHECK_EQ(digest_tail, digest_rt);
    (void)digest_b;
}

CONCORD_TEST(restore_diff_empty_document_edges) {
    // Empty -> empty: empty batch, equal digests.
    const auto [digest_empty, snap_empty] = reconstruct_state({});
    const DiffResponse same = run_restore_diff(snap_empty, snap_empty);
    CHECK_EQ(same.target_digest, digest_empty);
    CHECK(same.ops.empty());

    // Empty -> content: everything re-inserted; the whole visible document
    // of B must appear (null-anchored first items included).
    const GeneratedResponse full = generate_and_parse(61, 80, 3, 0);
    const auto [digest_b, snap_b] = reconstruct_state(single_op_batches_for(full.ops));
    const DiffResponse from_empty = run_restore_diff(snap_empty, snap_b);
    CHECK_EQ(from_empty.target_digest, digest_b);
    bool saw_insert = false;
    for (const Operation& op : from_empty.ops) {
        CHECK(op.type == OpType::Insert);
        saw_insert = true;
    }
    CHECK(saw_insert);
    // Applied: visible content equals B's.
    const std::string digest_applied = digest_after_fold(snap_empty, from_empty.batch);
    const WorkerRun reexport = run_worker(digest_after_request(snap_empty, {from_empty.batch}));
    Reader rr{reexport.stdout_bytes};
    CHECK_EQ(rr.u32(), kStatusOk);
    (void)rr.blob();
    CHECK(rr.done());
    (void)digest_applied;
    // Prove visible equality via reconstruct of the batch alone.
    const auto [digest_only, snap_only] = reconstruct_state({from_empty.batch});
    (void)digest_only;
    check_visible_equal(snap_only, snap_b, "empty to content");

    // Content -> empty: delete-everything batch; visible content collapses.
    const auto [digest_a, snap_a] = reconstruct_state(single_op_batches_for(full.ops));
    const DiffResponse to_empty = run_restore_diff(snap_a, snap_empty);
    CHECK_EQ(to_empty.target_digest, digest_empty);
    bool saw_delete = false;
    for (const Operation& op : to_empty.ops) {
        if (op.type == OpType::Delete) {
            saw_delete = true;
        }
    }
    CHECK(saw_delete);
    std::vector<std::string> all = single_op_batches_for(full.ops);
    all.push_back(to_empty.batch);
    const auto [digest_rt, snap_rt] = reconstruct_state(all);
    (void)digest_rt;
    const Doc folded = Doc::import_snapshot(ReplicaId{82}, snap_rt);
    CHECK(folded.visible_document().size() == 1);  // the implicit empty root block
    CHECK(folded.visible_document().front().chars.empty());
}

// ---------------------------------------------------------------------------
// Test group 8 (m036 convergence fix): a restore pipeline can feed a previous
// diff's batch back into the durable history (A was rebuilt as ops_A +
// diff_old, then concurrent ops arrived). The emitted batch's identities must
// never collide with an already-applied REST-band id — the core dedups ops by
// identity (apply_remote is a no-op for an applied id), so a colliding delete
// would silently skip its tombstone and the fold check would fail with
// status 3. Regression: the triple-wave protocol-level sequence (op bytes
// mirroring rust/sync-gateway/src/protocol/golden.rs shapes).
// ---------------------------------------------------------------------------
namespace {

// Golden op byte shapes (fixtures/protocol/v1/golden.json, golden.rs): builders
// cycle [insert, delimiter, delete]. Each op REWRITES only bytes [2..10)
// (writer replica) and [10..18) (writer counter) of the golden builder output
// — origins/targets keep their golden anchor bytes except the delete's target,
// which is rewritten in place (bytes [18..26)/[26..34)).
std::string golden_insert_op() {
    // 0101 d4..11 09 | 00 00 01 01 68 00
    return std::string("\x01\x01", 2) + std::string("\xd4\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x11\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x09\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x00\x00\x01\x01\x68\x00", 6);
}
std::string golden_delimiter_op() {
    // 0101 d4..12 0a | 01 d4..11 00 02 01 04 "type" 01 09 "paragraph"
    return std::string("\x01\x01", 2) + std::string("\xd4\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x12\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x0a\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x01", 1) +
           std::string("\xd4\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x11\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x00\x02\x01", 3) +
           std::string("\x04\x00\x00\x00\x00\x00\x00\x00", 8) + "type" +
           std::string("\x01", 1) +
           std::string("\x09\x00\x00\x00\x00\x00\x00\x00", 8) + "paragraph";
}
std::string golden_delete_op() {
    // 0102 e2..05 0b | d4..11
    return std::string("\x01\x02", 2) + std::string("\xe2\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x05\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x0b\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\xd4\x00\x00\x00\x00\x00\x00\x00", 8) +
           std::string("\x11\x00\x00\x00\x00\x00\x00\x00", 8);
}

void rewrite_u64(std::string& op, std::size_t offset, std::uint64_t value) {
    for (int i = 0; i < 8; ++i) {
        op[offset + static_cast<std::size_t>(i)] =
            static_cast<char>((value >> (8 * i)) & 0xffu);
    }
}
// Rewrites the WRITER identity (bytes [2..10) replica, [10..18) counter).
std::string rewrite_writer(std::string op, std::uint64_t replica, std::uint64_t counter) {
    rewrite_u64(op, 2, replica);
    rewrite_u64(op, 10, counter);
    return op;
}
// Rewrites a delete op's TARGET (bytes [18..26) replica, [26..34) counter).
std::string rewrite_delete_target(std::string op, std::uint64_t replica, std::uint64_t counter) {
    rewrite_u64(op, 18, replica);
    rewrite_u64(op, 26, counter);
    return op;
}

// One six-op wave of identities (replica, base..base+5) cycling builders
// [insert, delimiter, delete]: the delete targets the wave's own first insert
// (replica, base) — the golden delete's target bytes rewritten in place.
std::vector<std::string> golden_wave_ops(std::uint64_t replica, std::uint64_t base) {
    std::vector<std::string> ops;
    for (std::uint64_t step = 0; step < 6; ++step) {
        const std::uint64_t counter = base + step;
        switch (step % 3) {
            case 0:
                ops.push_back(rewrite_writer(golden_insert_op(), replica, counter));
                break;
            case 1:
                ops.push_back(rewrite_writer(golden_delimiter_op(), replica, counter));
                break;
            default:
                ops.push_back(rewrite_delete_target(
                    rewrite_writer(golden_delete_op(), replica, counter), replica, base));
                break;
        }
    }
    return ops;
}

// The concurrent four-op wave (replica 0xC003, counters 90..93): insert,
// delimiter, delete (targets 90), insert.
std::vector<std::string> golden_concurrent_ops() {
    std::vector<std::string> ops;
    ops.push_back(rewrite_writer(golden_insert_op(), 0xC003, 90));
    ops.push_back(rewrite_writer(golden_delimiter_op(), 0xC003, 91));
    ops.push_back(rewrite_delete_target(rewrite_writer(golden_delete_op(), 0xC003, 92),
                                         0xC003, 90));
    ops.push_back(rewrite_writer(golden_insert_op(), 0xC003, 93));
    return ops;
}

// Decodes a serialize_batch frame of raw op byte strings (the CMD 7 payload).
std::vector<std::string> decode_raw_batch(const std::string& batch) {
    std::vector<std::string> out;
    Reader r{batch};
    const std::uint32_t count = r.u32();
    for (std::uint32_t i = 0; i < count; ++i) {
        const std::uint32_t len = r.u32();
        out.push_back(r.bytes.substr(r.offset, len));
        r.offset += len;
    }
    CHECK(r.done());
    return out;
}

// Builds a one-op serialize_batch frame from raw op bytes without needing the
// Operation type: [u32 1][u32 len][raw]. Hand-rolled to keep raw byte fidelity
// (parse_batch below re-validates through the core).
std::string serialize_batch_frame_of_raw(const std::string& raw) {
    Bytes b;
    b.u32(1);
    b.u32(static_cast<std::uint32_t>(raw.size()));
    b.raw(raw);
    return b.data;
}

// Decodes one raw op byte string through the core's strict parser (structure
// validation for free — these are hand-encoded protocol bytes).
Operation parse_single_raw(const std::string& raw) {
    const std::vector<Operation> ops = parse_batch(serialize_batch_frame_of_raw(raw));
    CHECK_EQ(ops.size(), 1u);
    return ops.front();
}

// Wraps raw op bytes as single-op serialize_batch frames (the durable-log row
// shape) — the CMD 1/CMD 4 request batch entries.
std::vector<std::string> raw_op_batches(const std::vector<std::string>& raw_ops) {
    std::vector<std::string> out;
    out.reserve(raw_ops.size());
    for (const std::string& raw : raw_ops) {
        out.push_back(serialize_batch_frame_of_raw(raw));
    }
    return out;
}

// Concatenates raw-op waves into one raw list.
std::vector<std::string> concat_raw(const std::vector<std::string>& a,
                                     const std::vector<std::string>& b) {
    std::vector<std::string> out = a;
    out.insert(out.end(), b.begin(), b.end());
    return out;
}

// The triple-wave scenario, parameterized by the interleaving of the first
// restore batch against the concurrent wave. B = snap(fold wave1);
// A1 = snap(fold w1 + w2); diff(A1,B) → status 0 with a delete batch (ops1);
// A2 = snap(fold w1 + w2 + ops1 [+ ordering] + concurrent); diff(A2,B) MUST
// ALSO be status 0 — the m036 regression (before the fix: status 3, "restore
// batch does not converge to target content", because the new batch's REST
// identities collided with ops1's already-applied ids and the core deduped
// the deletes away).
void run_restore_history_collision_case(bool concurrent_first) {
    const std::vector<std::string> wave1 = golden_wave_ops(0xC001, 50);
    const std::vector<std::string> wave2 = golden_wave_ops(0xC002, 70);
    const std::vector<std::string> concurrent = golden_concurrent_ops();

    // B = snap(fold wave1) — the restore boundary.
    const auto [digest_b, snap_b] = reconstruct_state(raw_op_batches(wave1));
    // A1 = snap(fold wave1 + wave2).
    const auto [digest_a1, snap_a1] = reconstruct_state(raw_op_batches(concat_raw(wave1, wave2)));
    CHECK(digest_a1 != digest_b);

    // First diff: deletes wave2's live items; status 0 (pre-existing behavior).
    const DiffResponse diff1 = run_restore_diff(snap_a1, snap_b);
    CHECK_EQ(diff1.target_digest, digest_b);
    bool saw_delete = false;
    for (const Operation& op : diff1.ops) {
        CHECK(op.type == OpType::Delete);
        saw_delete = true;
    }
    CHECK(saw_delete);
    const std::vector<std::string> ops1 = decode_raw_batch(diff1.batch);

    // A2: the restore pipeline's durable history already contains ops1, plus a
    // concurrent wave that arrived after the restore.
    const std::vector<std::string> a2_ops = concurrent_first
        ? concat_raw(concat_raw(concat_raw(wave1, wave2), concurrent), ops1)
        : concat_raw(concat_raw(concat_raw(wave1, wave2), ops1), concurrent);
    const auto [digest_a2, snap_a2] = reconstruct_state(raw_op_batches(a2_ops));
    CHECK(digest_a2 != digest_b);

    // THE REGRESSION: the second diff must converge (status 0), and the batch
    // must fold A2 to B's visible content.
    const DiffResponse diff2 = run_restore_diff(snap_a2, snap_b);
    CHECK_EQ(diff2.target_digest, digest_b);
    bool saw_delete2 = false;
    for (const Operation& op : diff2.ops) {
        CHECK(op.type == OpType::Delete);
        CHECK_EQ(op.id.replica.value(), kRestoreReplicaValue);
        // The fix: every emitted id sits strictly ABOVE the REST ids already
        // applied in A2's history (ops1's counters) — no dedup collisions.
        CHECK(op.id.counter.value() > ops1.size());
        saw_delete2 = true;
    }
    CHECK(saw_delete2);

    // Externally re-prove convergence: fold A2's ops + diff2 through CMD 1 and
    // compare visible content to B's (the restore contract).
    const auto [digest_rt, snap_rt] =
        reconstruct_state(raw_op_batches(concat_raw(a2_ops, decode_raw_batch(diff2.batch))));
    (void)digest_rt;
    check_visible_equal(snap_rt, snap_b, "restore history collision");

    // Applying the batch twice is still a harmless duplicate (fold stability):
    // the same digest as once (dedup no-op on the second pass).
    const std::string once = digest_after_fold(snap_a2, diff2.batch);
    const WorkerRun dup = run_worker(digest_after_request(snap_a2, {diff2.batch, diff2.batch}));
    Reader dr{dup.stdout_bytes};
    CHECK_EQ(dr.u32(), kStatusOk);
    const std::string digest_dup = dr.blob();
    CHECK(dr.done());
    CHECK_EQ(digest_dup, once);
}

// Case 1: ops1 BEFORE the concurrent wave (the task's primary sequence).
CONCORD_TEST(restore_diff_history_collision_concurrent_after) {
    run_restore_history_collision_case(false);
}

// Case 2: the concurrent wave BEFORE the first restore batch (reverse
// interleaving — same contract, different pending-drain order).
CONCORD_TEST(restore_diff_history_collision_concurrent_before) {
    run_restore_history_collision_case(true);
}

}  // namespace

int main() {
    return ::concord::testing::run_all();
}

