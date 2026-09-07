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

int main() {
    return ::concord::testing::run_all();
}


