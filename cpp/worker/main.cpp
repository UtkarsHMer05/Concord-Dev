// Concord native snapshot/recovery worker (P5-M014, SA-CPP5).
//
// Standalone executable wrapping the CRDT core for server-side
// reconstruction and verification. A request-driven binary protocol runs on
// stdin/stdout; each request is one length-prefixed frame and produces one
// length-prefixed response frame. The worker never owns document identity
// (the calling wrapper does) and never allocates client-visible replica
// ids: all Docs it constructs use the reserved maintenance replica id
// `kMaintenanceReplica`, which no client replica can collide with (see
// the collision analysis in the header comment below).
//
// It also deterministically GENERATES collaborative op streams (command 6,
// P5-M014b) so the Rust differential verifier and benchmarks never
// re-implement CRDT op encoding: same seed + parameters ⇒ byte-identical
// ops. The C++ core stays the semantic authority (DEC-035/DEC-038) —
// generation constructs ops through the core's own builder-path shapes
// and validates them with the core's registry before serializing.
//
// Command 7 (P5-M036, DEC-039) computes the RESTORE DIFF: the forward-op
// batch that converges a current state's visible content to a target
// (restore-boundary) state. Its generated ops carry a SECOND reserved
// replica band, kRestoreReplica ("REST") — distinct from
// kMaintenanceReplica ("SYSC") because restore ops must be ingestible by
// this same worker (which rejects SYSC-authored ops) to flow back through
// the normal durable pipeline (see the analysis at kRestoreReplicaValue).
//
// Design constraints (production path):
//   - Deterministic: identical request bytes produce identical response
//     bytes (no timestamps, no addresses, no container-order leakage).
//   - Bounded: frames are capped (256 MiB), op counts are capped, and only
//     one frame plus at most two Docs (command 7's two-state diff) is
//     resident at a time.
//   - Content-silent errors: messages never echo op/snapshot bytes.
//   - Core CrdtError exceptions are caught and mapped to status codes; no
//     exception escapes a handled request.
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"
#include "concord/crdt/ids.hpp"
#include "concord/crdt/serialize.hpp"
#include "concord/crdt/validation.hpp"

namespace {

namespace crdt = concord::crdt;

// ---------------------------------------------------------------------------
// Reserved maintenance replica id.
//
// Value: 0x53595343 ("SYSC" in ASCII, big-endian) = 1398362947.
//
// Collision analysis (why client identities are structurally separate):
//   - The production browser allocator sets the MSB of its u64 identity
//     (`src/lib/crdt/editor-bridge.ts`), placing new client IDs above the
//     low maintenance namespace. Existing ordinary stored IDs remain
//     backwards-compatible.
//   - The gateway's validated client-ingress decoder rejects both reserved
//     origins before persistence; this worker also rejects its SYSC writer
//     identity before touching document state. The worker never authors
//     client input operations with that identity.
//   - Other replica-id issuers are deterministic test harnesses and the
//     gateway, which stores but never allocates identities from op bytes.
constexpr std::uint64_t kMaintenanceReplicaValue = 0x53595343ULL;  // "SYSC"
constexpr crdt::ReplicaId kMaintenanceReplica{kMaintenanceReplicaValue};

// ---------------------------------------------------------------------------
// Reserved restore replica id (P5-M036, DEC-039).
//
// Value: 0x52455354 ("REST" in ASCII, big-endian) = 1380275028. Distinct from
// the maintenance replica (0x53595343) on purpose: restore-diff INSERT ops
// generated here must survive this worker's own reserved-namespace rejection
// (read_op_batches / apply_batches reject kMaintenanceReplica only), because
// the forward-restore batch flows back through the normal reconstruct/
// digest-after path when the restored document is rebuilt from A's ops plus
// the diff. The same value is pre-staged in the Rust gateway
// (rust/sync-gateway/src/maintenance/history.rs MAINTENANCE_RESTORE_REPLICA),
// whose tests pin its distinctness from SYSC.
//
// The browser allocator's MSB reservation keeps new client IDs above this
// low maintenance namespace, while the gateway independently rejects
// client operations authored with either reserved origin. Restore uses this
// identity only for worker-generated forward diff batches.
constexpr std::uint64_t kRestoreReplicaValue = 0x52455354ULL;  // "REST"
constexpr crdt::ReplicaId kRestoreReplica{kRestoreReplicaValue};

// ---------------------------------------------------------------------------
// Protocol constants. All integers little-endian (matching the core's
// canonical encodings, ids.hpp put_u32_le family).
// ---------------------------------------------------------------------------

// Command ids.
constexpr std::uint32_t kCmdReconstruct = 1;      // ops -> digest + snapshot
constexpr std::uint32_t kCmdExportSnapshot = 2;    // ops -> snapshot only
constexpr std::uint32_t kCmdImportVerify = 3;      // snapshot -> digest
constexpr std::uint32_t kCmdDigestAfter = 4;       // snapshot + tail ops -> digest
constexpr std::uint32_t kCmdVerifySnapshot = 5;    // snapshot -> digest (alias)
constexpr std::uint32_t kCmdGenerateOps = 6;       // seed + shape -> ops + digest
constexpr std::uint32_t kCmdRestoreDiff = 7;       // two snapshots -> forward-restore ops (P5-M036)

// Status codes.
constexpr std::uint32_t kStatusOk = 0;
constexpr std::uint32_t kStatusMalformed = 1;
constexpr std::uint32_t kStatusVersionUnsupported = 2;
constexpr std::uint32_t kStatusOpApplyError = 3;
constexpr std::uint32_t kStatusSizeExceeded = 4;
constexpr std::uint32_t kStatusInternal = 5;

// Bounds.
constexpr std::uint64_t kMaxFrameBytes = 256ULL * 1024 * 1024;  // 256 MiB
constexpr std::uint64_t kMaxOpCount = 10'000'000;
constexpr std::size_t kMaxErrorMessageBytes = 4096;

// Generation bounds (command 6): each emitted batch mirrors protocol
// batching at 512 ops, and per-replica stream growth is capped so the
// generator's generated-index vector stays bounded (deleted items are
// recycled as fresh anchor candidates — churn, not accumulation).
constexpr std::uint32_t kMaxGenReplicas = 8;
constexpr std::uint32_t kGenBatchOps = 512;
constexpr std::uint32_t kMaxLiveGeneratedItems = 8192;

// Restore-diff bounds (command 7): the emitted forward-op batch is capped at
// kMaxRestoreDiffOps (status 4 past it); input snapshots stay within the
// 256 MiB frame rule. One serialize_batch frame can hold 1,000,000 ops
// (the core's kMaxBatchSize), so the batch always fits a single frame.
constexpr std::uint64_t kMaxRestoreDiffOps = 1'000'000;

// Exit codes: 0 = request handled (status may still be an error status),
// 1 = framing failure (unframeable stdin), 2 = internal crash path.
constexpr int kExitHandled = 0;
constexpr int kExitFraming = 1;
constexpr int kExitInternal = 2;

// ---------------------------------------------------------------------------
// Byte-level framing helpers over std::string (host-endianness independent).
// ---------------------------------------------------------------------------

void put_u32le(std::string& out, std::uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) {
        out.push_back(static_cast<char>((value >> shift) & 0xffu));
    }
}

// Reads exactly `count` bytes; false on EOF/truncation.
bool read_exact(char* buffer, std::size_t count) {
    return std::fread(buffer, 1, count, stdin) == count;
}

// Writes raw bytes to stdout; false on write failure.
bool write_all(const char* data, std::size_t count) {
    if (count == 0) {
        return true;
    }
    return std::fwrite(data, 1, count, stdout) == count;
}

[[nodiscard]] std::uint32_t load_u32le(const std::string& bytes, std::size_t offset) {
    std::uint32_t value = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        value |= static_cast<std::uint32_t>(static_cast<unsigned char>(bytes[offset + i])) << (8u * i);
    }
    return value;
}

// ---------------------------------------------------------------------------
// Frame-level request parsing. One request frame is resident at a time.
// ---------------------------------------------------------------------------

struct RequestBody {
    std::uint32_t command = 0;
    std::vector<std::string> op_batches;  // each entry: one serialize_batch-encoded payload (ops appended for CMD 1/2/4)
    std::string snapshot;                // CMD 3/4/5

    // CMD 7 (restore_diff): the current state's snapshot (A) and the target
    // (restore-boundary) state's snapshot (B).
    std::string snapshot_a;
    std::string snapshot_b;

    // CMD 6 (generate_ops) parameters.
    std::uint64_t gen_seed = 0;
    std::uint32_t gen_op_count = 0;
    std::uint32_t gen_replica_count = 1;
    std::uint32_t gen_shape = 0;
};

enum class ParseResult { Ok, Malformed, VersionUnsupported, OpApplyError, SizeExceeded, Internal };

// Maps a core ErrorCode to a protocol status.
[[nodiscard]] std::uint32_t status_for(const crdt::ErrorCode code) {
    switch (code) {
        case crdt::ErrorCode::UnsupportedVersion:
        case crdt::ErrorCode::SnapshotVersionUnsupported:
            return kStatusVersionUnsupported;
        case crdt::ErrorCode::OpTooLarge:
        case crdt::ErrorCode::PendingLimitExceeded:
            return kStatusSizeExceeded;
        case crdt::ErrorCode::MalformedFrame:
        case crdt::ErrorCode::InvalidReplicaId:
        case crdt::ErrorCode::InvalidCounter:
        case crdt::ErrorCode::InvalidLamport:
        case crdt::ErrorCode::InvalidUnicodeScalar:
        case crdt::ErrorCode::InvalidString:
        case crdt::ErrorCode::UnknownAttributeName:
        case crdt::ErrorCode::InvalidAttributeValue:
        case crdt::ErrorCode::InvalidArgument:
            // Structurally unframeable / semantically invalid input.
            return kStatusMalformed;
        default:
            // Op-merge failures that imply bad content beyond structure.
            return kStatusOpApplyError;
    }
}

// Extracts a short, content-free message from an exception: code name plus
// the core's message (core messages are already field/position oriented and
// never embed payload bytes). Truncates to the 4 KiB cap.
[[nodiscard]] std::string sanitize_message(const std::string& message) {
    std::string out = message;
    if (out.size() > kMaxErrorMessageBytes) {
        out.resize(kMaxErrorMessageBytes);
        out.append("...(truncated)");
    }
    // Strip control characters that could confuse consuming terminals/logs.
    for (char& c : out) {
        const auto uc = static_cast<unsigned char>(c);
        if (uc < 0x20 && c != '\n') {
            c = ' ';
        }
    }
    return out;
}

// Reads the [u32 batch_count] + batches section shared by CMD 1/2/4.
// Enforces the op-count bound across all batches and the maintenance-replica
// exclusion on every op.
[[nodiscard]] ParseResult read_op_batches(const std::string& frame, std::size_t& offset,
                                          RequestBody& body, std::string& error) {
    const std::uint32_t batch_count = load_u32le(frame, offset);
    offset += 4;
    if (batch_count > kMaxOpCount) {
        error = "batch count exceeds limit";
        return ParseResult::SizeExceeded;
    }
    body.op_batches.reserve(batch_count);
    std::uint64_t total_ops = 0;
    for (std::uint32_t i = 0; i < batch_count; ++i) {
        if (offset + 4 > frame.size()) {
            error = "truncated batch length";
            return ParseResult::Malformed;
        }
        const std::uint32_t batch_len = load_u32le(frame, offset);
        offset += 4;
        if (batch_len > frame.size() - offset) {
            error = "batch exceeds frame";
            return ParseResult::Malformed;
        }
        std::string batch = frame.substr(offset, batch_len);
        offset += batch_len;
        try {
            // Validate the batch: decode every op, count it against the
            // global cap, and reject any op written under the maintenance
            // replica id (that namespace is reserved for this worker and
            // must never appear in client ops).
            const std::vector<crdt::Operation> ops = crdt::parse_batch(batch);
            total_ops += ops.size();
            if (total_ops > kMaxOpCount) {
                error = "operation count exceeds limit";
                return ParseResult::SizeExceeded;
            }
            for (const crdt::Operation& op : ops) {
                if (op.id.replica.value() == kMaintenanceReplicaValue) {
                    error = "operation uses reserved replica id";
                    return ParseResult::OpApplyError;
                }
            }
            // The entry is stored verbatim: it is already a complete,
            // strictly-parsed serialize_batch frame (count + ops), identical
            // in shape to what the durable log stores per row.
            body.op_batches.push_back(std::move(batch));
        } catch (const crdt::CrdtError& e) {
            error = sanitize_message(e.what());
            // Batch decode failures map like their execute-time twins:
            // version → 2, size → 4, structure/semantics → 1, else 3.
            if (e.code() == crdt::ErrorCode::UnsupportedVersion ||
                e.code() == crdt::ErrorCode::SnapshotVersionUnsupported) {
                return ParseResult::VersionUnsupported;
            }
            if (e.code() == crdt::ErrorCode::OpTooLarge ||
                e.code() == crdt::ErrorCode::PendingLimitExceeded) {
                return ParseResult::SizeExceeded;
            }
            if (e.code() == crdt::ErrorCode::MalformedFrame ||
                e.code() == crdt::ErrorCode::InvalidReplicaId ||
                e.code() == crdt::ErrorCode::InvalidCounter ||
                e.code() == crdt::ErrorCode::InvalidLamport ||
                e.code() == crdt::ErrorCode::InvalidUnicodeScalar ||
                e.code() == crdt::ErrorCode::InvalidString ||
                e.code() == crdt::ErrorCode::UnknownAttributeName ||
                e.code() == crdt::ErrorCode::InvalidAttributeValue ||
                e.code() == crdt::ErrorCode::InvalidArgument) {
                return ParseResult::Malformed;
            }
            return ParseResult::OpApplyError;
        }
    }
    return ParseResult::Ok;
}

// Reads the [u32 snapshot_len][snapshot bytes] section shared by CMD 3/4/5/7
// into an arbitrary slot (CMD 3/4/5 use body.snapshot; CMD 7 reads it twice
// for snapshots A and B).
[[nodiscard]] ParseResult read_snapshot_into(const std::string& frame, std::size_t& offset,
                                             std::string& out, std::string& error) {
    if (offset + 4 > frame.size()) {
        error = "truncated snapshot length";
        return ParseResult::Malformed;
    }
    const std::uint32_t snapshot_len = load_u32le(frame, offset);
    offset += 4;
    if (snapshot_len > kMaxFrameBytes || snapshot_len > frame.size() - offset) {
        error = "snapshot exceeds frame";
        return ParseResult::SizeExceeded;
    }
    out = frame.substr(offset, snapshot_len);
    offset += snapshot_len;
    return ParseResult::Ok;
}

// Reads one full request frame (already size-validated) into `body`.
// Returns a ParseResult and fills `error` on failure.
[[nodiscard]] ParseResult parse_request(const std::string& frame, RequestBody& body,
                                         std::string& error) {
    if (frame.size() < 4) {
        error = "frame too short for command header";
        return ParseResult::Malformed;
    }
    std::size_t offset = 0;
    body.command = load_u32le(frame, offset);
    offset += 4;

    switch (body.command) {
        case kCmdReconstruct:
        case kCmdExportSnapshot:
            return read_op_batches(frame, offset, body, error);
        case kCmdImportVerify:
        case kCmdVerifySnapshot: {
            const ParseResult result = read_snapshot_into(frame, offset, body.snapshot, error);
            if (result != ParseResult::Ok) {
                return result;
            }
            break;  // falls through to trailing check
        }
        case kCmdDigestAfter: {
            const ParseResult snap_result = read_snapshot_into(frame, offset, body.snapshot, error);
            if (snap_result != ParseResult::Ok) {
                return snap_result;
            }
            const ParseResult ops_result = read_op_batches(frame, offset, body, error);
            if (ops_result != ParseResult::Ok) {
                return ops_result;
            }
            break;
        }
        case kCmdGenerateOps: {
            // [u64 seed][u32 op_count][u32 replica_count][u32 shape].
            if (offset + 20 > frame.size()) {
                error = "truncated generate body";
                return ParseResult::Malformed;
            }
            std::uint64_t seed = 0;
            for (std::size_t i = 0; i < 8; ++i) {
                seed |= static_cast<std::uint64_t>(static_cast<unsigned char>(frame[offset + i])) << (8u * i);
            }
            offset += 8;
            body.gen_seed = seed;
            body.gen_op_count = load_u32le(frame, offset);
            offset += 4;
            body.gen_replica_count = load_u32le(frame, offset);
            offset += 4;
            body.gen_shape = load_u32le(frame, offset);
            offset += 4;
            if (body.gen_op_count > kMaxOpCount) {
                error = "operation count exceeds limit";
                return ParseResult::SizeExceeded;
            }
            if (body.gen_replica_count < 1 || body.gen_replica_count > kMaxGenReplicas) {
                error = "replica count out of range";
                return ParseResult::Malformed;
            }
            if (body.gen_shape > 3) {
                error = "unknown shape";
                return ParseResult::Malformed;
            }
            break;
        }
        case kCmdRestoreDiff: {
            // [u32 current_snapshot_len][current snapshot bytes]
            // [u32 target_snapshot_len][target snapshot bytes]
            const ParseResult current_result =
                read_snapshot_into(frame, offset, body.snapshot_a, error);
            if (current_result != ParseResult::Ok) {
                return current_result;
            }
            const ParseResult target_result =
                read_snapshot_into(frame, offset, body.snapshot_b, error);
            if (target_result != ParseResult::Ok) {
                return target_result;
            }
            break;
        }
        default:
            error = "unknown command";
            return ParseResult::Malformed;
    }
    if (offset != frame.size()) {
        error = "trailing bytes after request body";
        return ParseResult::Malformed;
    }
    return ParseResult::Ok;
}

// ---------------------------------------------------------------------------
// Response emission. Never buffers more than the frame being written.
// ---------------------------------------------------------------------------

void emit_status(std::uint32_t status) {
    std::string out;
    out.reserve(4);
    put_u32le(out, status);
    (void)write_all(out.data(), out.size());
}

void emit_error_response(std::uint32_t status, const std::string& message) {
    std::string out;
    out.reserve(8 + message.size());
    put_u32le(out, status);
    const std::string clean = sanitize_message(message);
    put_u32le(out, static_cast<std::uint32_t>(clean.size()));
    out.append(clean);
    (void)write_all(out.data(), out.size());
}

void emit_ok_response(const std::string& digest, const std::string* snapshot) {
    std::string out;
    out.reserve(12 + digest.size() + (snapshot != nullptr ? 4 + snapshot->size() : 0));
    put_u32le(out, kStatusOk);
    put_u32le(out, static_cast<std::uint32_t>(digest.size()));
    out.append(digest);
    if (snapshot != nullptr) {
        put_u32le(out, static_cast<std::uint32_t>(snapshot->size()));
        out.append(*snapshot);
    }
    (void)write_all(out.data(), out.size());
}

void emit_ok_snapshot_only(const std::string& snapshot) {
    std::string out;
    out.reserve(8 + snapshot.size());
    put_u32le(out, kStatusOk);
    put_u32le(out, static_cast<std::uint32_t>(snapshot.size()));
    out.append(snapshot);
    (void)write_all(out.data(), out.size());
}

// CMD 6 OK response: [u32 0][u32 digest_len][digest][u32 batch_count]
// + batches × ([u32 len][serialize_batch bytes]). Streamed incrementally so
// large generations never hold a second full copy in memory.
void emit_ok_generated(const std::string& digest, const std::vector<std::string>& batches) {
    std::string out;
    out.reserve(16 + digest.size());
    put_u32le(out, kStatusOk);
    put_u32le(out, static_cast<std::uint32_t>(digest.size()));
    out.append(digest);
    put_u32le(out, static_cast<std::uint32_t>(batches.size()));
    (void)write_all(out.data(), out.size());
    for (const std::string& batch : batches) {
        std::string head;
        head.reserve(4);
        put_u32le(head, static_cast<std::uint32_t>(batch.size()));
        (void)write_all(head.data(), head.size());
        (void)write_all(batch.data(), batch.size());
    }
}

// CMD 7 OK response: [u32 0][u32 digest_len][target digest][u32 batch_len]
// [batch bytes]. The batch is ONE serialize_batch frame holding every
// emitted op (≤1,000,000 ops fits the core's per-batch cap, so a single
// frame always suffices and the Rust adapter wraps it as one entry).
void emit_ok_restore_diff(const std::string& target_digest, const std::string& batch) {
    std::string out;
    out.reserve(16 + target_digest.size() + batch.size());
    put_u32le(out, kStatusOk);
    put_u32le(out, static_cast<std::uint32_t>(target_digest.size()));
    out.append(target_digest);
    put_u32le(out, static_cast<std::uint32_t>(batch.size()));
    out.append(batch);
    (void)write_all(out.data(), out.size());
}

// ---------------------------------------------------------------------------
// Command execution. Exactly one Doc is resident per request (commands 1-6);
// the restore diff (command 7) holds exactly two: the current and target
// states.
// ---------------------------------------------------------------------------

// Applies every batch into `doc` in order. Throws CrdtError from the core on
// invalid ops (mapped by the caller); returns false if any op reserved the
// maintenance replica (already rejected at parse time — belt and braces).
[[nodiscard]] bool apply_batches(crdt::Doc& doc, const RequestBody& body) {
    for (const std::string& batch : body.op_batches) {
        const std::vector<crdt::Operation> ops = crdt::parse_batch(batch);
        for (const crdt::Operation& op : ops) {
            if (op.id.replica.value() == kMaintenanceReplicaValue) {
                return false;
            }
            (void)doc.apply_remote(op);
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Command 7: restore diff (P5-M036, DEC-039).
//
// Input: snapshot A (the current converged state) + snapshot B (the target
// restore-boundary state). Output: the forward-op batch that converges A's
// VISIBLE CONTENT to B's, plus B's canonical digest.
//
// ITEM ENUMERATION (access path): Doc keeps `items_` private with no public
// item iterator; the public surface exposing the full item stream is
// `canonical_state_bytes()` (digest.cpp) — a stable, versioned, append-only
// core encoding of exactly: [u32 item count] then per item
// [u64 replica][u64 counter][left opt id][right opt id][u8 kind][u8 tombstone]
// [scalar (Text only): u8 len + UTF-8][u32 attr count] then per attr
// [u64 name_len][name][u8 has_value][u64 value_len][value][u64 lamport]
// [u64 writer] — followed by the applied-id and summary sections (ignored
// here). The worker parses these bytes rather than the SNAPSHOT bytes: the
// snapshot format additionally embeds serialized pending ops and register
// internals whose re-interpretation would duplicate integration semantics;
// canonical_state_bytes is the core's DOCUMENTED canonical item encoding
// (it is the digest input), so consuming it keeps the core the single
// format owner (DEC-038) — the worker and core are the same semantic domain.
// The full apply-through-restore (below) additionally validates every emitted
// op against the real Doc, so a format drift cannot silently corrupt output.
//
// DIFF ALGORITHM (documented order + origin-remap rules):
//
// 1. DELETE ops FIRST, then INSERT ops, then ATTR-sync ops; within each
//    class, the emitting state's stream order (deletes: A-stream; inserts
//    and attr syncs: B-stream) — the canonical stream order is the fixed
//    deterministic iteration order.
//    - Deletes: for every item visible in A but tombstoned-or-absent in B:
//      Delete{replica=REST, sequential fresh counter, lamport=base+1..,
//      target=item's A OpId}. A->B items ABSENT in A can't exist; only A
//      items visible and B-tombstoned-or-absent occur, so every delete
//      target already lives in A.
// 2. INSERT (re-insertion): un-delete is impossible (DEC-023 tombstones), so
//    items visible in B but tombstoned-or-absent in A are re-created under
//    fresh identities in the reserved REST band (counters sequential, each
//    batch starting ABOVE every REST counter already applied in either
//    snapshot — the m036 convergence fix: a colliding id would be a dedup
//    no-op in Doc::apply_remote and silently drop its op's effect).
//    Lamports are base+i
//    where base = max(A,B) register lamports: strictly greater than BOTH
//    snapshots' clocks, so re-inserted attr registers win any LWW merge.
// 3. ORDERING / ANCHORING. A literal origin remap (rewriting B's left/right
//    origins) cannot always preserve B's visible order: B may hold two
//    VISIBLE items with the same left origin (the first is a delete-crossing
//    gap anchor — after A deleted the intervening item, remapping both to
//    the same origin leaves them as concurrent siblings, and Doc's
//    tie-break orders equal-replica siblings REVERSED). Instead each
//    re-insert is anchored between its nearest NEIGHBORS in B's visible
//    order: left = the next earlier B-visible item that exists alive in A or
//    was re-inserted earlier in this batch; right = symmetric next later.
//    Both endpoints always exist at apply time (left neighbors are applied
//    earlier — B-stream scan order; right neighbors, when not in A, are
//    later batch ops, when not in the batch they are A items; null at the
//    sequence boundary), so every anchor is legal by construction — the
//    op never rides the pending buffer on the restore path. In-order,
//    non-conflicting inserts integrate exactly at their anchor boundary,
//    which reproduces B's visible order by induction (independent
//    preserves of order compose). This IS the core's own proven shape:
//    Doc::local_insert_text/stream walk anchors exactly this way.
//    (Deviation from the task's literal origin-remap sketch — rationale
//    documented here and in the report; the literal variant fails the
//    spec's own core property, digest(diff(A,B)) == digest(B), on
//    delete-crossing sibling runs.)
// 4. ATTRIBUTES: (a) each re-insert carries B's item registers verbatim as
//    initial_attrs (value or cleared), by lexicographic name — the AttrMap
//    iteration order of the canonical encoding; the fresh higher lamports
//    make them take effect on merge. (b) KEPT items (alive in both) may hold
//    DIVERGED registers: A's snapshot carries a (lamport, writer) write for
//    a name B's snapshot never saw (the write happened after B's boundary
//    and never reached B — B's register is ABSENT, not merely cleared). Each
//    differing register gets ONE SetAttr carrying B's value (or a clear
//    when B holds none), under the fresh high lamport, so B's visible
//    semantics win the LWW merge. Emitted in B-stream order after the
//    inserts.
// 5. The batch is validated by FOLDING it into a copy of A's state (the
//    restore path: A's ops arrive as one frame in the same execute call —
//    deterministic, content-free on failure): any op the core refuses, or
//    any pending op that fails to drain, or a visible-content mismatch, is
//    status 3 with a content-free message (never a silent partial restore).
// 6. Cap: emitted ops (deletes + inserts) <= 1,000,000, else status 4.
//    Determinism: fixed iteration order everywhere, no container-order
//    leakage, fresh-but-sequential identities — same inputs ⇒ byte-identical
//    output.
// ---------------------------------------------------------------------------

// A full item parsed out of Doc::canonical_state_bytes() — every field the
// diff needs (up to the worker's own needs; digests and summaries stay in
// the core).
struct DiffItem {
    crdt::OpId id{};
    std::optional<crdt::OpId> left;    // origins (informational: neighbor
    std::optional<crdt::OpId> right;   // anchoring replaces literal remap)
    crdt::ItemKind kind = crdt::ItemKind::Text;
    char32_t scalar = 0;
    bool tombstoned = false;
    std::map<std::string, std::optional<std::string>> attrs;  // name → value/cleared
};

// The parsed item stream of one canonical_state_bytes encoding.
struct DiffState {
    std::vector<DiffItem> items;  // stream order
    std::uint64_t max_lamport = 0;  // highest attr-register lamport (0 = none)
};

// Parses one canonical_state_bytes payload. The bytes were produced by the
// core from an imported snapshot, so malformed input is impossible by
// construction; the parser is still total — a short/overshooting read fails
// closed through the boolean result and maps to a structured status.
[[nodiscard]] bool parse_canonical_items(const std::string& bytes, DiffState& out,
                                         std::string& error) {
    out.items.clear();
    out.max_lamport = 0;

    std::size_t offset = 0;

    // Borrow the core's own little-endian readers (ids.hpp) — single format
    // owner, no re-implementation.
    auto read_u32 = [&](std::uint32_t& value) {
        return crdt::get_u32_le(bytes, offset, value);
    };
    auto read_u64 = [&](std::uint64_t& value) {
        return crdt::get_u64_le(bytes, offset, value);
    };
    auto read_u8 = [&](std::uint8_t& value) {
        return crdt::get_u8(bytes, offset, value);
    };
    auto read_opt_id = [&](std::optional<crdt::OpId>& id) -> bool {
        std::uint8_t flag = 0;
        if (!read_u8(flag)) {
            return false;
        }
        if (flag == 0) {
            id = std::nullopt;
            return true;
        }
        if (flag != 1) {
            return false;
        }
        std::uint64_t replica = 0;
        std::uint64_t counter = 0;
        if (!read_u64(replica) || !read_u64(counter) ||
            !crdt::OpId::is_valid_counter_pair(replica, counter)) {
            return false;
        }
        id = crdt::OpId{crdt::ReplicaId{replica}, crdt::Counter{counter}};
        return true;
    };
    auto read_string = [&](std::string& value) -> bool {
        std::uint64_t length = 0;
        if (!read_u64(length) || length > 4096 || bytes.size() < offset + length) {
            return false;
        }
        value.assign(bytes, offset, static_cast<std::size_t>(length));
        offset += static_cast<std::size_t>(length);
        return true;
    };

    std::uint32_t count = 0;
    if (!read_u32(count)) {
        error = "truncated item count";
        return false;
    }
    out.items.reserve(count);
    for (std::uint32_t i = 0; i < count; ++i) {
        DiffItem item;
        std::uint64_t replica = 0;
        std::uint64_t counter = 0;
        std::uint8_t kind = 0;
        std::uint8_t tombstone = 0;
        if (!read_u64(replica) || !read_u64(counter) || !read_opt_id(item.left) ||
            !read_opt_id(item.right) || !read_u8(kind) || !read_u8(tombstone) ||
            !crdt::OpId::is_valid_counter_pair(replica, counter) ||
            (kind != static_cast<std::uint8_t>(crdt::ItemKind::Text) &&
             kind != static_cast<std::uint8_t>(crdt::ItemKind::Delimiter)) ||
            tombstone > 1) {
            error = "bad item record";
            return false;
        }
        item.id = crdt::OpId{crdt::ReplicaId{replica}, crdt::Counter{counter}};
        item.kind = static_cast<crdt::ItemKind>(kind);
        item.tombstoned = tombstone == 1;
        if (item.kind == crdt::ItemKind::Text) {
            std::uint8_t scalar_length = 0;
            if (!read_u8(scalar_length) || scalar_length < 1 || scalar_length > 4 ||
                bytes.size() < offset + scalar_length) {
                error = "bad item scalar";
                return false;
            }
            std::size_t decoded_offset = 0;
            bool ok = false;
            item.scalar = crdt::decode_utf8(std::string(bytes, offset, scalar_length),
                                            decoded_offset, ok);
            if (!ok || decoded_offset != scalar_length || item.scalar == 0 ||
                (item.scalar >= 0xD800 && item.scalar <= 0xDFFF) ||
                item.scalar > 0x10FFFF) {
                error = "bad item scalar";
                return false;
            }
            offset += scalar_length;
        }
        std::uint32_t attr_count = 0;
        if (!read_u32(attr_count)) {
            error = "bad attribute count";
            return false;
        }
        for (std::uint32_t a = 0; a < attr_count; ++a) {
            std::string name;
            std::uint8_t has_value = 0;
            std::string value;
            std::uint64_t lamport = 0;
            std::uint64_t writer = 0;
            if (!read_string(name) || !read_u8(has_value) ||
                (has_value == 1 && !read_string(value)) || !read_u64(lamport) ||
                !read_u64(writer) || has_value > 1 || !crdt::Lamport::is_valid(lamport)) {
                error = "bad attribute record";
                return false;
            }
            out.max_lamport = std::max(out.max_lamport, lamport);
            item.attrs.emplace(std::move(name),
                               has_value == 1 ? std::optional<std::string>{value}
                                             : std::nullopt);
        }
        out.items.push_back(std::move(item));
    }
    return true;
}

// The result of computing the restore diff.
struct RestoreDiffResult {
    std::uint32_t status = kStatusOk;
    std::string message;      // on error (content-free)
    std::string digest_b;     // the TARGET state's canonical digest
    std::string batch;        // ONE serialize_batch frame with all emitted ops
};

// Computes the visible-content diff A -> B and emits the forward-op batch.
// Every failure is a structured status with a content-free message.
[[nodiscard]] RestoreDiffResult compute_restore_diff(const std::string& snapshot_a,
                                                     const std::string& snapshot_b) {
    RestoreDiffResult result;

    // Fold both snapshots into Docs (the core is the semantic authority for
    // snapshot validity and for the canonical item encodings below).
    const crdt::Doc doc_a = crdt::Doc::import_snapshot(kMaintenanceReplica, snapshot_a);
    const crdt::Doc doc_b = crdt::Doc::import_snapshot(kMaintenanceReplica, snapshot_b);
    result.digest_b = doc_b.canonical_digest();

    // Item streams (through the core's documented canonical encoding).
    DiffState state_a;
    DiffState state_b;
    std::string parse_error;
    if (!parse_canonical_items(doc_a.canonical_state_bytes(), state_a, parse_error) ||
        !parse_canonical_items(doc_b.canonical_state_bytes(), state_b, parse_error)) {
        // Impossible by construction (the core produced the bytes); fail
        // closed rather than proceeding on a misparsed stream.
        result.status = kStatusInternal;
        result.message = "canonical state parse failed";
        return result;
    }

    // Visibility membership: id -> tombstoned flag, per state. An id absent
    // from the map is treated as tombstoned-or-absent (the delete rule).
    const auto build_vis_index = [](const DiffState& state) {
        std::unordered_map<crdt::OpId, bool, crdt::OpIdHash> index;
        index.reserve(state.items.size());
        for (const DiffItem& item : state.items) {
            index.emplace(item.id, !item.tombstoned);
        }
        return index;
    };
    const std::unordered_map<crdt::OpId, bool, crdt::OpIdHash> visible_a =
        build_vis_index(state_a);
    const std::unordered_map<crdt::OpId, bool, crdt::OpIdHash> visible_b =
        build_vis_index(state_b);

    // A-stream position by id (register comparison on kept items).
    const auto build_pos_index = [](const DiffState& state) {
        std::unordered_map<crdt::OpId, std::size_t, crdt::OpIdHash> index;
        index.reserve(state.items.size());
        for (std::size_t i = 0; i < state.items.size(); ++i) {
            index.emplace(state.items[i].id, i);
        }
        return index;
    };
    const std::unordered_map<crdt::OpId, std::size_t, crdt::OpIdHash> a_index =
        build_pos_index(state_a);

    // Fresh REST identity + clock basis: lamports strictly greater than both
    // snapshots' register lamports so re-inserted attrs win every LWW merge.
    //
    // Identity basis is HISTORY-AWARE (m036 convergence fix): the emitted ops
    // must never collide with an op id the CURRENT state (or the target) has
    // already applied. A restore pipeline can legitimately feed a previous
    // diff's batch back into the history (A was rebuilt as ops_A + diff_old,
    // then new concurrent ops arrived); the core dedups ops by identity
    // (Doc::apply_remote returns false on an applied id and integrates
    // nothing), so a colliding delete would silently skip its tombstone and
    // the fold check would fail with status 3. The counter therefore starts
    // ABOVE every REST-band counter already applied in either snapshot. The
    // state summary (version vector) exposes exactly that bound: it is the
    // highest CONTIGUOUS counter per replica, and the REST band only ever
    // grows through sequentially-numbered batches (1..N per call, each later
    // batch continuing above the previous), so applied REST counters are
    // always a contiguous prefix — `state_summary().at(REST)` is the max.
    // Belt and braces: an applied id above the contiguous bound (impossible
    // for this band, but a snapshot could be crafted) is still caught by the
    // fold check below, which rejects any non-convergence (status 3, never
    // silent). Determinism is preserved: the basis is a pure function of the
    // two input snapshots (no wall clock, no randomness).
    const std::uint64_t applied_restore_high =
        std::max(doc_a.state_summary().at(kRestoreReplica),
                 doc_b.state_summary().at(kRestoreReplica));
    std::uint64_t restore_counter = applied_restore_high;  // next = high + 1..
    std::uint64_t lamport_clock = std::max(state_a.max_lamport, state_b.max_lamport);
    const auto next_identity = [&]() {
        restore_counter += 1;
        if (restore_counter > crdt::Counter::kMax) {
            throw crdt::CrdtError(crdt::ErrorCode::CounterOverflow,
                                  "restore identity counter exhausted");
        }
        return crdt::OpId{kRestoreReplica, crdt::Counter{restore_counter}};
    };
    const auto next_lamport = [&]() {
        if (lamport_clock >= crdt::Lamport::kMax) {
            throw crdt::CrdtError(crdt::ErrorCode::InvalidLamport,
                                  "lamport clock exhausted for restore diff");
        }
        lamport_clock += 1;
        return crdt::Lamport{lamport_clock};
    };

    std::vector<crdt::Operation> ops;  // DELETEs first, then INSERTs (spec order)
    ops.reserve(state_a.items.size() + state_b.items.size());

    // ---- Pass 1: DELETE ops, in A-stream order ----
    // An A item that exists alive and B-visible stays; an A item visible in
    // A but tombstoned-or-absent in B is deleted. (Absent-in-B means A saw
    // an op B never did; the item is in A, so the delete is well-formed.)
    for (const DiffItem& item : state_a.items) {
        if (item.tombstoned) {
            continue;  // already tombstoned in A: nothing to delete
        }
        const auto in_b = visible_b.find(item.id);
        if (in_b != visible_b.end() && in_b->second) {
            continue;  // same item alive in both: no op
        }
        crdt::Operation op;
        op.type = crdt::OpType::Delete;
        op.id = next_identity();
        op.lamport = next_lamport();
        op.target = item.id;
        ops.push_back(std::move(op));
        if (ops.size() > kMaxRestoreDiffOps) {
            result.status = kStatusSizeExceeded;
            result.message = "restore diff exceeds operation limit";
            return result;
        }
    }

    // ---- Pass 2: INSERT (re-insert) ops, in B-stream order ----
    // Re-insertion: un-delete is impossible (DEC-023 tombstones). Every op
    // is anchored between its nearest stable NEIGHBORS in B's visible order
    // (see the anchoring rationale in the command header): left = nearest
    // EARLIER B-visible item that is alive in A or re-inserted earlier in
    // this batch; right = symmetric nearest LATER item. Because the batch
    // runs in B-stream order, every left neighbor is already applied, and
    // right neighbors are either A-live items (present before the batch) or
    // later batch ops (present when their turn comes) — so anchors always
    // resolve and no op rides the pending buffer on the restore path.
    //
    // `new_ids`: B id -> batch-assigned REST identity (for remapping anchors
    // that point at earlier batch items). `b_pos`: B id -> position among
    // B's VISIBLE items (stream order — the neighbor space).
    std::unordered_map<crdt::OpId, crdt::OpId, crdt::OpIdHash> new_ids;
    std::vector<crdt::OpId> b_visible;  // B's visible ids, stream order
    std::unordered_map<crdt::OpId, std::size_t, crdt::OpIdHash> b_pos;
    b_visible.reserve(state_b.items.size());
    for (const DiffItem& item : state_b.items) {
        if (!item.tombstoned) {
            b_pos.emplace(item.id, b_visible.size());
            b_visible.push_back(item.id);
        }
    }

    // An anchor candidate is resolvable at THIS op's apply time iff it is
    // alive in A (present before the batch) or was re-inserted EARLIER in
    // the batch (batch order = B-stream order, so earlier = lower b_pos).
    const auto is_anchor = [&](const crdt::OpId& id) {
        const auto a = visible_a.find(id);
        if (a != visible_a.end() && a->second) {
            return true;  // alive in A
        }
        return new_ids.find(id) != new_ids.end();  // earlier batch insert
    };
    // Remap a B-space anchor into the batch's identity space: earlier batch
    // items are referenced by their fresh REST ids; A-live items keep A's ids.
    const auto remap = [&](const std::optional<crdt::OpId>& anchor) {
        if (!anchor.has_value()) {
            return std::optional<crdt::OpId>{};
        }
        const auto mapped = new_ids.find(*anchor);
        if (mapped != new_ids.end()) {
            return std::optional<crdt::OpId>{mapped->second};
        }
        return anchor;  // alive in A: A's own id
    };

    std::vector<crdt::Operation> inserts;
    inserts.reserve(state_b.items.size());
    for (const DiffItem& item : state_b.items) {
        if (item.tombstoned) {
            continue;  // B tombstone: re-insertion is out of scope (that
                       // item is invisible in B, so A must not show it either)
        }
        const auto in_a = visible_a.find(item.id);
        if (in_a != visible_a.end() && in_a->second) {
            continue;  // alive in both: keep A's item (attr registers are
                       // already LWW-merged on both sides; the final fold's
                       // visible-document check re-verifies convergence)
        }
        if (new_ids.size() + 1 > kMaxRestoreDiffOps) {
            result.status = kStatusSizeExceeded;
            result.message = "restore diff exceeds operation limit";
            return result;
        }

        // Neighbors in B's visible order.
        const std::size_t pos = b_pos.at(item.id);
        std::optional<crdt::OpId> left;
        for (std::size_t i = pos; i > 0; --i) {
            const crdt::OpId& candidate = b_visible[i - 1];
            if (is_anchor(candidate)) {
                left = candidate;
                break;
            }
        }
        std::optional<crdt::OpId> right;
        for (std::size_t i = pos + 1; i < b_visible.size(); ++i) {
            if (is_anchor(b_visible[i])) {
                right = b_visible[i];
                break;
            }
        }

        crdt::Operation op;
        op.type = crdt::OpType::Insert;
        op.id = next_identity();
        op.lamport = next_lamport();
        op.left = remap(left);
        op.right = remap(right);
        op.kind = item.kind;
        op.scalar = item.scalar;
        for (const auto& [name, value] : item.attrs) {
            // B's registers verbatim (cleared registers carried as nullopt).
            // The registry check happened at B's snapshot import; the final
            // fold below re-validates everything the core integrates.
            op.initial_attrs.push_back(crdt::InitialAttr{name, value});
        }
        new_ids.emplace(item.id, op.id);
        inserts.push_back(std::move(op));
    }

    // ---- Pass 3: ATTR sync ops on KEPT items, in B-stream order ----
    // An item alive in both may hold DIVERGED registers: A's snapshot carries
    // a (lamport, writer) write for a name that B's snapshot never saw (the
    // op happened after B's boundary and never reached B — B's register is
    // ABSENT, not merely cleared; both raw states are visible in the
    // canonical encoding's value-flag). B's visible semantics must WIN, so
    // the divergence is repaired with one SetAttr per differing register:
    // set B's value (or clear it when B's register is absent-or-cleared),
    // under a fresh high lamport (beats A's diverging write in LWW).
    // Registers where B's value EQUALS A's (or both hold no value) need no
    // op — the states already agree.
    std::vector<crdt::Operation> attr_syncs;
    attr_syncs.reserve(state_b.items.size());
    for (const DiffItem& b_item : state_b.items) {
        if (b_item.tombstoned) {
            continue;  // kept items only (alive in both)
        }
        const auto in_a = visible_a.find(b_item.id);
        if (in_a == visible_a.end() || !in_a->second) {
            continue;  // not alive in A: either re-inserted (initial_attrs
                      // already carry B's registers) or deleted — not kept
        }
        // A's registers for this item (id -> stream position in state_a).
        const auto a_it = a_index.find(b_item.id);
        if (a_it == a_index.end()) {
            continue;  // cannot happen (alive in A implies present)
        }
        const DiffItem& a_item = state_a.items[a_it->second];
        // Divergent register names: union of A's and B's register keys.
        std::vector<std::string> names;
        for (const auto& [name, value] : a_item.attrs) {
            names.push_back(name);
        }
        for (const auto& [name, value] : b_item.attrs) {
            if (a_item.attrs.find(name) == a_item.attrs.end()) {
                names.push_back(name);
            }
        }
        std::sort(names.begin(), names.end());
        for (const std::string& name : names) {
            const auto b_reg = b_item.attrs.find(name);
            const auto a_reg = a_item.attrs.find(name);
            const std::optional<std::string> b_value =
                b_reg != b_item.attrs.end() ? b_reg->second : std::nullopt;
            const std::optional<std::string> a_value =
                a_reg != a_item.attrs.end() ? a_reg->second : std::nullopt;
            if (b_value == a_value) {
                continue;  // both unset, or equal values (cleared == cleared)
            }
            crdt::Operation op;
            op.type = crdt::OpType::SetAttr;
            op.id = next_identity();
            op.lamport = next_lamport();
            op.target = b_item.id;
            op.attr_name = name;
            op.attr_value = b_value;  // B's winning value; nullopt clears A's
            attr_syncs.push_back(std::move(op));
            if (ops.size() + inserts.size() + attr_syncs.size() > kMaxRestoreDiffOps) {
                result.status = kStatusSizeExceeded;
                result.message = "restore diff exceeds operation limit";
                return result;
            }
        }
    }

    // ---- Assemble (deletes first, then inserts, then attr syncs —
    // documented order). ----
    const std::size_t total_ops = ops.size() + inserts.size() + attr_syncs.size();
    if (total_ops > kMaxRestoreDiffOps) {
        result.status = kStatusSizeExceeded;
        result.message = "restore diff exceeds operation limit";
        return result;
    }
    ops.insert(ops.end(), inserts.begin(), inserts.end());
    ops.insert(ops.end(), attr_syncs.begin(), attr_syncs.end());

    // ---- Restore-path validation: fold A + batch; the result must hold ----
    // exactly B's visible content. A fresh maintenance Doc receives A's
    // items via snapshot import, then the batch; every anchor resolves
    // (left neighbors precede, right/batch items exist), so no op may
    // remain pending — a leftover means the anchors were wrong: status 3,
    // content-free, never a silent partial restore.
    crdt::Doc folded = crdt::Doc::import_snapshot(kMaintenanceReplica, snapshot_a);
    // A's own snapshot may legitimately carry causally-early pendings
    // from its history (ops whose anchors never arrived). The batch
    // must add NO NEW pendings — baseline, not absolute zero.
    const std::size_t pending_baseline = folded.pending_count();
    for (const crdt::Operation& op : ops) {
        try {
            (void)folded.apply_remote(op);
        } catch (const crdt::CrdtError& e) {
            result.status = kStatusOpApplyError;
            result.message = sanitize_message(std::string{"restore batch rejected: "} + e.what());
            return result;
        }
    }
    if (folded.pending_count() > pending_baseline) {
        result.status = kStatusOpApplyError;
        result.message = "restore batch left new undrained pending operations";
        return result;
    }
    // Visible-content equality (not digest equality: A keeps its tombstone
    // history and its own live-item identities — the visible document is the
    // restore contract, HISTORY.md §5 step 2).
    if (folded.visible_document() != doc_b.visible_document()) {
        result.status = kStatusOpApplyError;
        result.message = "restore batch does not converge to target content";
        return result;
    }

    // Serialize as ONE batch frame (the 1M cap fits the core's kMaxBatchSize).
    try {
        result.batch = crdt::serialize_batch(ops);
    } catch (const crdt::CrdtError& e) {
        result.status = status_for(e.code());
        result.message = sanitize_message(e.what());
        return result;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Command 6: deterministic op-stream generation (P5-M014b).
//
// PRNG: splitmix64 (64-bit state, one add + two xorshift-multiply mixes per
// draw) — self-contained in this translation unit, no <random>, no rand(),
// fully specified across platforms (uint64 wrapping arithmetic is the only
// ingredient). Same seed + parameters ⇒ identical draws ⇒ byte-identical
// response.
//
// Replica ids: splitmix64-mixed, band-forced with bit 62 SET (giving
// 46 usable random low bits per id, plus fixed top bits 0x4000...). This
// band is disjoint from the maintenance replica constant (0x53595343 <
// 2^31, bit 62 clear) and from every realistic id shape elsewhere in the
// system (TS harnesses use small integers; the client allocator is random
// full-width but only <2^31 ids could collide, and none of them can lie
// in the 2^62 band). The maintenance value is additionally filtered out
// explicitly, belt and braces, and the checker rejects any op claiming it.
//
// Semantics: every generated op is validated against the core's own
// registries (crdt::validate_operation + AllowedAttrs value sets are the
// authority, DEC-035/DEC-038); anchors only ever reference item ids that
// were already generated earlier in the stream (or nullopt = sequence
// boundary, the only other legal anchor per Doc::integrate_insert's
// resolve_anchor). Lamport discipline: replica r's op number n gets
// lamport = n + 1 (per-replica monotonic — plausible, and legal because
// LWW only requires a strict total order on writes that observe each
// other, which (lamport, writer) provides here).
// ---------------------------------------------------------------------------

struct SplitMix64 {
    std::uint64_t state = 0;

    [[nodiscard]] std::uint64_t next() noexcept {
        std::uint64_t z = (state += 0x9E3779B97F4A7C15ULL);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
};

// Deterministic count-table pick from `count` options; count > 0.
[[nodiscard]] std::uint32_t pick(std::uint64_t raw, std::uint32_t count) noexcept {
    return static_cast<std::uint32_t>(raw % count);
}

// Generator bookkeeping per replica.
struct GenReplica {
    std::uint64_t id = 0;
    std::uint64_t next_counter = 0;  // last-used counter; incremented before each op
    std::uint64_t lamport = 0;        // value for the NEXT op (op number + 1)
    bool opened = false;              // initial delimiter+text emitted yet?
};

// The generated stream, in delivery order.
struct GeneratedStream {
    std::vector<crdt::Operation> ops;
    std::string digest;  // digest after applying all ops in delivery order
};

// Command 6 success payload: the generated op stream in protocol batches.
// Owning the operations separately from the serialized frames lets the
// executor chunk + emit without retaining two full copies (the op vector
// is freed before any batch emission).
struct GenerateResult {
    std::uint32_t status = kStatusOk;
    std::string message;         // on error
    GeneratedStream stream;      // on success
};

// Serializes the whole op stream into ≤ kGenBatchOps serialize_batch frames.
// Deterministic chunking (pure size cut, no rng draws).
[[nodiscard]] std::vector<std::string> batch_generated(const std::vector<crdt::Operation>& ops) {
    std::vector<std::string> batches;
    const std::size_t total = ops.size();
    batches.reserve(total == 0 ? 0 : (total + kGenBatchOps - 1) / kGenBatchOps);
    std::vector<crdt::Operation> chunk;
    chunk.reserve(kGenBatchOps);
    for (std::size_t i = 0; i < total; ++i) {
        chunk.push_back(ops[i]);
        if (chunk.size() == kGenBatchOps) {
            batches.push_back(crdt::serialize_batch(chunk));
            chunk.clear();
        }
    }
    if (!chunk.empty()) {
        batches.push_back(crdt::serialize_batch(chunk));
    }
    return batches;
}

constexpr std::uint64_t kGenReplicaBandBit = 1ULL << 62;  // band selector

[[nodiscard]] GenerateResult generate_ops(std::uint64_t seed, std::uint32_t op_count,
                                          std::uint32_t replica_count, std::uint32_t shape) {
    GenerateResult result;

    // ---- Per-replica independent generators (ids + sequencing) ----
    SplitMix64 id_rng{seed};
    GenReplica replicas[kMaxGenReplicas];
    for (std::uint32_t r = 0; r < replica_count; ++r) {
        GenReplica rep;
        std::uint64_t id = 0;
        do {
            id = (id_rng.next() | kGenReplicaBandBit) & 0x7FFF'FFFF'FFFF'FFFFULL;
        } while (id == kMaintenanceReplicaValue);  // cannot hit the band, but check anyway
        rep.id = id;
        replicas[r] = rep;
    }
    for (std::uint32_t r = 0; r < replica_count; ++r) {
        for (std::uint32_t s = r + 1; s < replica_count; ++s) {
            if (replicas[r].id == replicas[s].id) {
                // 46-bit draws within ≤8 ids: collision probability ≤ 28/2^46 —
                // reject deterministically rather than silently aliasing.
                result.status = kStatusInternal;
                result.message = "replica id collision in generation";
                return result;
            }
        }
    }

    // The stream generator. The seed is mixed with a fixed constant so
    // generation is decorrelated from other splitmix users of the seed.
    SplitMix64 rng{seed ^ 0x6F7067656E657261ULL};  // "opgenera"

    // ---- Static content tables (all values core-legal) ----
    // Text scalars: printable ASCII + a few non-ASCII code points (multi-byte
    // UTF-8 paths). All nonzero, non-surrogate, <= U+10FFFF.
    static constexpr char32_t kScalars[] = {
        U'a', U'b', U'c', U'd', U'e', U'f', U'g', U'h', U'k', U'm', U'n',
        U'p', U'q', U'r', U's', U't', U'u', U'v', U'w', U'x', U'y', U'z',
        U'0', U'1', U'2', U'3', U'4', U'5', U'6', U'7', U'8', U'9', U' ',
        U'.', U',', U'!', U'?', U'-', U'_', U'=', U'+', U'(', U')', U'é',
        U'ü', U'ñ', U'α', U'Ω', U'日', U'本', U'→', U'∑', U'😀',
    };
    static constexpr std::uint32_t kScalarCount =
        static_cast<std::uint32_t>(sizeof(kScalars) / sizeof(kScalars[0]));
    // Block types (AllowedAttrs on Delimiter/"type").
    static constexpr const char* kBlockTypes[] = {
        "paragraph", "heading-1", "heading-2", "heading-3",
        "heading-4", "heading-5", "heading-6",
    };
    static constexpr std::uint32_t kBlockTypeCount =
        static_cast<std::uint32_t>(sizeof(kBlockTypes) / sizeof(kBlockTypes[0]));
    // Alignment values.
    static constexpr const char* kAligns[] = {"left", "center", "right", "justify"};
    static constexpr std::uint32_t kAlignCount =
        static_cast<std::uint32_t>(sizeof(kAligns) / sizeof(kAligns[0]));
    // Line-height values (toolbar's fixed set).
    static constexpr const char* kLineHeights[] = {"normal", "1", "1.15", "1.5", "2"};
    static constexpr std::uint32_t kLineHeightCount =
        static_cast<std::uint32_t>(sizeof(kLineHeights) / sizeof(kLineHeights[0]));

    // Weighted op choice per shape. Roll bands are over 10; inserts inherit
    // the remainder (insert_weight), so only delete/attr weights are named.
    const std::uint32_t delete_weight = [&] {
        switch (shape) {
            case 1:
                return 1;
            case 2:
                return 6;
            case 3:
                return 1;
            default:
                return 2;
        }
    }();
    const std::uint32_t attr_weight = [&] {
        switch (shape) {
            case 1:
                return 1;  // a sprinkle: every shape exercises all op types
            case 2:
                return 1;
            case 3:
                return 7;
            default:
                return 2;
        }
    }();

    // ---- Stream state ----
    std::vector<crdt::Operation>& ops = result.stream.ops;
    ops.reserve(op_count);

    // Live item pools (bounded by kMaxLiveGeneratedItems; freed slots are
    // recycled so large op counts churn instead of accumulating).
    std::vector<crdt::OpId> live;             // any-kind ids: anchors
    std::vector<crdt::OpId> live_del_pool;    // tombstone candidates (every item)
    std::vector<crdt::OpId> live_text_pool;   // text attrs
    std::vector<crdt::OpId> live_delim_pool;  // delimiter attrs
    live.reserve(kMaxLiveGeneratedItems);

    const auto push_live = [&](const crdt::OpId& id, bool is_text) {
        auto pooled = [&](std::vector<crdt::OpId>& pool) {
            if (pool.size() < kMaxLiveGeneratedItems) {
                pool.push_back(id);
            } else {
                pool[pick(rng.next(), static_cast<std::uint32_t>(pool.size()))] = id;
            }
        };
        pooled(live);
        pooled(live_del_pool);  // every item is a tombstone candidate
        if (is_text) {
            pooled(live_text_pool);
        } else {
            pooled(live_delim_pool);
        }
    };
    const auto pop_live = [&](const crdt::OpId& id) {
        // Remove from every pool it may occupy (id may sit in up to two).
        const auto erase_from = [&](std::vector<crdt::OpId>& pool) {
            for (std::size_t i = 0; i < pool.size(); ++i) {
                if (pool[i] == id) {
                    pool.erase(pool.begin() + static_cast<std::ptrdiff_t>(i));
                    return;
                }
            }
        };
        erase_from(live);
        erase_from(live_del_pool);
        erase_from(live_text_pool);
        erase_from(live_delim_pool);
    };
    const auto sample_live = [&](crdt::OpId& out) {
        out = live[pick(rng.next(), static_cast<std::uint32_t>(live.size()))];
    };
    const auto random_scalar = [&] {
        return kScalars[pick(rng.next(), kScalarCount)];
    };

    // Builds and validates one op; returns false on a structurally surprising
    // failure (never expected — the grammar only produces core-legal ops).
    const auto make_op = [&](crdt::OpType type, std::uint32_t r, auto fill) -> bool {
        GenReplica& rep = replicas[r];
        crdt::Operation op;
        op.type = type;
        rep.next_counter += 1;
        rep.lamport += 1;  // per-replica monotonic (lamport = op number + 1)
        op.id = crdt::OpId{crdt::ReplicaId{rep.id}, crdt::Counter{rep.next_counter}};
        op.lamport = crdt::Lamport{rep.lamport};
        fill(op);
        try {
            crdt::validate_operation(op);
        } catch (const crdt::CrdtError&) {
            return false;
        }
        ops.push_back(std::move(op));
        return true;
    };

    // ---- Op grammar ----
    // Insert anchors: an existing live item id (left or right side, the
    // other nullopt) or sequence boundary (both nullopt) — exactly the shapes
    // Doc::integrate_insert resolves (tombstoned anchor items are legal: the
    // YATA scan is tombstone-inclusive by design, same as the adapter's
    // position space).
    const auto anchor_pair = [&](std::optional<crdt::OpId>& left,
                                 std::optional<crdt::OpId>& right) {
        if (!live.empty() && (rng.next() & 0xFF) < 208) {  // ~81% anchored
            crdt::OpId anchor{};
            sample_live(anchor);
            left = anchor;
            if ((rng.next() & 1) != 0) {  // half the time anchor is the right side
                right = left;
                left = std::nullopt;
            }
        }  // else both null: append/prepend at the sequence boundary
    };

    const auto gen_insert_text = [&](std::uint32_t r) -> bool {
        std::optional<crdt::OpId> left;
        std::optional<crdt::OpId> right;
        anchor_pair(left, right);
        const crdt::OpId created = crdt::OpId{crdt::ReplicaId{replicas[r].id},
                                             crdt::Counter{replicas[r].next_counter + 1}};
        if (!make_op(crdt::OpType::Insert, r, [&](crdt::Operation& op) {
                op.left = left;
                op.right = right;
                op.kind = crdt::ItemKind::Text;
                op.scalar = random_scalar();
            })) {
            return false;
        }
        push_live(created, true);
        return true;
    };

    const auto gen_insert_delimiter = [&](std::uint32_t r) -> bool {
        std::optional<crdt::OpId> left;
        std::optional<crdt::OpId> right;
        anchor_pair(left, right);
        const crdt::OpId created = crdt::OpId{crdt::ReplicaId{replicas[r].id},
                                             crdt::Counter{replicas[r].next_counter + 1}};
        const char* block_type = kBlockTypes[pick(rng.next(), kBlockTypeCount)];
        const bool with_align = (rng.next() & 0xFF) < 128;
        const char* align = kAligns[pick(rng.next(), kAlignCount)];
        if (!make_op(crdt::OpType::Insert, r, [&](crdt::Operation& op) {
                op.left = left;
                op.right = right;
                op.kind = crdt::ItemKind::Delimiter;
                op.initial_attrs.push_back(crdt::InitialAttr{"type", std::string{block_type}});
                if (with_align) {
                    op.initial_attrs.push_back(crdt::InitialAttr{"align", std::string{align}});
                }
            })) {
            return false;
        }
        push_live(created, false);
        return true;
    };

    const auto gen_delete = [&](std::uint32_t r) -> bool {
        if (live_del_pool.empty()) {
            return gen_insert_text(r);  // nothing to delete yet
        }
        const crdt::OpId target =
            live_del_pool[pick(rng.next(), static_cast<std::uint32_t>(live_del_pool.size()))];
        if (!make_op(crdt::OpType::Delete, r, [&](crdt::Operation& op) {
                op.target = target;
            })) {
            return false;
        }
        pop_live(target);  // a tombstoned item no longer needs new attention
        return true;
    };

    const auto gen_attr = [&](std::uint32_t r) -> bool {
        // Text marks: bold/italic/underline/strikethrough; value is always
        // "1" or a cleared register. Falls through to delimiter attributes
        // (type/align/lineHeight, value sets from the registry) when no
        // text item is live.
        if (!live_text_pool.empty()) {
            const crdt::OpId target = live_text_pool[
                pick(rng.next(), static_cast<std::uint32_t>(live_text_pool.size()))];
            static constexpr const char* kTextAttrs[] = {"bold", "italic", "underline",
                                                         "strikethrough"};
            const char* name = kTextAttrs[pick(rng.next(), 4)];
            const bool clear = (rng.next() & 0xFF) < 32;  // ~12% clears
            return make_op(crdt::OpType::SetAttr, r, [&](crdt::Operation& op) {
                op.target = target;
                op.attr_name = name;
                if (!clear) {
                    op.attr_value = std::string{"1"};
                }  // nullopt value = clear register
            });
        }
        if (!live_delim_pool.empty()) {
            const crdt::OpId target = live_delim_pool[
                pick(rng.next(), static_cast<std::uint32_t>(live_delim_pool.size()))];
            const std::uint32_t which = pick(rng.next(), 3);
            const char* name = which == 0 ? "type" : (which == 1 ? "align" : "lineHeight");
            const char* value = which == 0
                ? kBlockTypes[pick(rng.next(), kBlockTypeCount)]
                : (which == 1 ? kAligns[pick(rng.next(), kAlignCount)]
                              : kLineHeights[pick(rng.next(), kLineHeightCount)]);
            return make_op(crdt::OpType::SetAttr, r, [&](crdt::Operation& op) {
                op.target = target;
                op.attr_name = name;
                op.attr_value = std::string{value};
            });
        }
        return gen_insert_text(r);  // no attr target available yet
    };

    // ---- Stream construction ----
    // Validation doc: apply every op in delivery order; the digest is that
    // doc's canonical digest (self-consistency by construction).
    crdt::Doc doc(kMaintenanceReplica);

    // The open of a replica's first contribution: one delimiter + one text
    // item, both null-anchored (legal on an empty region — and on any region,
    // since null anchors address the sequence boundary).
    const auto open_replica = [&](std::uint32_t r) -> bool {
        if (!gen_insert_delimiter(r)) {
            return false;
        }
        return gen_insert_text(r);
    };

    std::uint32_t opened_count = 0;
    std::uint32_t emitted = 0;
    std::uint32_t round_robin = 0;  // next replica in rotation
    while (emitted < op_count) {
        std::uint32_t r = 0;
        if (opened_count < replica_count) {
            // Open replicas first (round-robin), interleaved from the start.
            r = round_robin;
            round_robin = (round_robin + 1) % replica_count;
            ++opened_count;
            if (!open_replica(r)) {
                break;
            }
            emitted += 2;
            continue;
        }
        // Rotation with occasional 1-2 position skips (a different author
        // takes the turn — still safe: every anchor/target is an
        // already-generated id).
        std::uint32_t skip = 0;
        if ((rng.next() & 0xFF) < 64 && replica_count > 1) {  // ~25% skips
            skip = 1 + (rng.next() & 1);
        }
        r = (round_robin + skip) % replica_count;
        round_robin = (round_robin + 1) % replica_count;

        // Weighted op type choice by shape (out-of-10 bands; insert inherits
        // the remainder).
        const std::uint32_t roll = pick(rng.next(), 10);
        bool ok = false;
        if (roll < delete_weight) {
            ok = gen_delete(r);
        } else if (roll < delete_weight + attr_weight) {
            ok = gen_attr(r);
        } else {
            // Insert: ~15% of inserts are delimiters (block churn), the
            // rest text.
            if ((rng.next() & 0xFF) < 38) {
                ok = gen_insert_delimiter(r);
            } else {
                ok = gen_insert_text(r);
            }
        }
        if (!ok) {
            break;
        }
        ++emitted;
    }

    if (emitted != op_count) {
        // A grammar failure means the generator produced something the core
        // refused: impossible by construction (validated builder + null /
        // known-id anchors); surfaced as internal, never silently truncated.
        result.status = kStatusInternal;
        result.message = "op generation failed validation";
        return result;
    }

    // Digest: apply in delivery order and canonicalize. (Apply-only: the
    // maintenance replica never generates.)
    for (const crdt::Operation& op : ops) {
        if (op.id.replica.value() == kMaintenanceReplicaValue) {
            result.status = kStatusInternal;
            result.message = "generator emitted reserved replica id";
            return result;
        }
        try {
            (void)doc.apply_remote(op);
        } catch (const crdt::CrdtError& e) {
            result.status = status_for(e.code());
            result.message = sanitize_message(e.what());
            return result;
        }
    }
    result.stream.digest = doc.canonical_digest();
    return result;
}

struct CommandResult {
    std::uint32_t status = kStatusOk;
    std::string digest;
    std::string snapshot;
    bool has_snapshot = false;
    bool snapshot_only = false;  // CMD 2: emit [status][snapshot_len][snapshot]
    bool gen_batches = false;    // CMD 6: emit [digest_len][digest][batch_count][batches]
    std::vector<std::string> batches;  // CMD 6: serialize_batch frames, ≤512 ops each
    bool restore_diff = false;  // CMD 7: emit [digest_len][target digest][batch_len][batch]
    std::string diff_batch;     // CMD 7: ONE serialize_batch frame with all ops
};

[[nodiscard]] CommandResult execute(const RequestBody& body) {
    CommandResult result;
    try {
        switch (body.command) {
            case kCmdReconstruct:
            case kCmdExportSnapshot: {
                crdt::Doc doc(kMaintenanceReplica);
                if (!apply_batches(doc, body)) {
                    result.status = kStatusOpApplyError;
                    result.digest = "operation uses reserved replica id";
                    return result;
                }
                result.snapshot = doc.export_snapshot();
                result.has_snapshot = true;
                result.snapshot_only = body.command == kCmdExportSnapshot;
                result.digest = doc.canonical_digest();
                return result;
            }
            case kCmdImportVerify:
            case kCmdVerifySnapshot: {
                const crdt::Doc doc = crdt::Doc::import_snapshot(kMaintenanceReplica, body.snapshot);
                result.digest = doc.canonical_digest();
                return result;
            }
            case kCmdDigestAfter: {
                crdt::Doc doc = crdt::Doc::import_snapshot(kMaintenanceReplica, body.snapshot);
                if (!apply_batches(doc, body)) {
                    result.status = kStatusOpApplyError;
                    result.digest = "operation uses reserved replica id";
                    return result;
                }
                result.digest = doc.canonical_digest();
                return result;
            }
            case kCmdGenerateOps: {
                const GenerateResult generated =
                    generate_ops(body.gen_seed, body.gen_op_count, body.gen_replica_count,
                                 body.gen_shape);
                if (generated.status != kStatusOk) {
                    result.status = generated.status;
                    result.digest = generated.message;
                    return result;
                }
                result.digest = generated.stream.digest;
                result.gen_batches = true;
                // Serialize in size-capped chunks; the op vector is released
                // with the GenerateResult before any batch is written out.
                result.batches = batch_generated(generated.stream.ops);
                return result;
            }
            case kCmdRestoreDiff: {
                // The restore-diff machinery throws only through the core's
                // own guards (snapshot validation, identity exhaustion), so
                // the shared catch maps those exactly like the other
                // commands; internal diff failures return structured results.
                const RestoreDiffResult diff =
                    compute_restore_diff(body.snapshot_a, body.snapshot_b);
                if (diff.status != kStatusOk) {
                    result.status = diff.status;
                    result.digest = diff.message;
                    return result;
                }
                result.digest = diff.digest_b;
                result.restore_diff = true;
                result.diff_batch = diff.batch;
                return result;
            }
            default:
                result.status = kStatusMalformed;
                result.digest = "unknown command";
                return result;
        }
    } catch (const crdt::CrdtError& e) {
        result.status = status_for(e.code());
        result.digest = sanitize_message(e.what());
        return result;
    }
}

// ---------------------------------------------------------------------------
// Process loop: read one frame, handle it, emit one response, exit.
// The worker is process-per-request (the wrapper spawns per call), so the
// loop body runs at most once in production; it stays a loop so an
// interactive driver can feed multiple frames in one session.
// ---------------------------------------------------------------------------

int run_worker() {
    // Frame: [u32 LE payload_len][payload]. 4 header bytes.
    std::string header(4, '\0');
    if (!read_exact(header.data(), 4)) {
        return kExitFraming;  // no/short header: framing failure
    }
    const std::uint64_t frame_len = load_u32le(header, 0);
    if (frame_len == 0 || frame_len > kMaxFrameBytes) {
        // Oversize (or empty) frame: structured size-error response
        // (status 4), then exit handled — the frame was still frameable.
        emit_error_response(kStatusSizeExceeded, "frame exceeds 256 MiB limit");
        (void)std::fflush(stdout);
        return kExitHandled;
    }
    if (frame_len < 4) {
        // A payload must at least carry the command word.
        emit_error_response(kStatusMalformed, "frame too short for command header");
        (void)std::fflush(stdout);
        return kExitHandled;
    }

    std::string frame(static_cast<std::size_t>(frame_len), '\0');
    if (!read_exact(frame.data(), frame.size())) {
        return kExitFraming;  // truncated frame: unframeable
    }

    RequestBody body;
    std::string parse_error;
    const ParseResult parsed = parse_request(frame, body, parse_error);
    if (parsed != ParseResult::Ok) {
        std::uint32_t status = kStatusMalformed;
        switch (parsed) {
            case ParseResult::Ok:
                break;  // unreachable (checked above); keeps -Wswitch happy
            case ParseResult::Malformed:
                status = kStatusMalformed;
                break;
            case ParseResult::VersionUnsupported:
                status = kStatusVersionUnsupported;
                break;
            case ParseResult::OpApplyError:
                status = kStatusOpApplyError;
                break;
            case ParseResult::SizeExceeded:
                status = kStatusSizeExceeded;
                break;
            case ParseResult::Internal:
                status = kStatusInternal;
                break;
        }
        emit_error_response(status, parse_error);
        (void)std::fflush(stdout);
        return kExitHandled;
    }

    const CommandResult result = execute(body);
    if (result.status == kStatusOk) {
        if (result.restore_diff) {
            emit_ok_restore_diff(result.digest, result.diff_batch);
        } else if (result.gen_batches) {
            emit_ok_generated(result.digest, result.batches);
        } else if (result.snapshot_only) {
            emit_ok_snapshot_only(result.snapshot);
        } else if (result.has_snapshot) {
            emit_ok_response(result.digest, &result.snapshot);
        } else {
            emit_ok_response(result.digest, nullptr);
        }
    } else {
        emit_error_response(result.status, result.digest);
    }
    (void)std::fflush(stdout);
    return kExitHandled;
}

// ---------------------------------------------------------------------------
// --version: report the release identity and exit BEFORE any stdin reading.
// Zero impact on frame semantics (the process-per-request wrapper and the
// interactive driver both start at the frame loop; argv is ignored there).
//
// Output contract (pinned by tests/worker_test.cpp):
//   "concord-worker 1.0.1 (<short-sha>)\n"  when a NON-EMPTY CONCORD_GIT_SHA
//                                           is wired (git checkout builds)
//   "concord-worker 1.0.1\n"                 plain form otherwise —
//   including source-archive/gitless builds, which must NEVER emit a
//   malformed "1.0.1 ()" (SA-NATV1: the worker CMakeLists only defines
//   CONCORD_GIT_SHA when it is non-empty).
// The version comes from the build (CONCORD_VERSION compile definition,
// set from the CMake project VERSION == package.json version). The
// build-definition fallback keeps a bare compile from failing.
// ---------------------------------------------------------------------------
#ifndef CONCORD_VERSION
#define CONCORD_VERSION "unknown"
#endif

bool print_version() {
#if defined(CONCORD_GIT_SHA)
    std::printf("concord-worker %s (%s)\n", CONCORD_VERSION, CONCORD_GIT_SHA);
#else
    std::printf("concord-worker %s\n", CONCORD_VERSION);
#endif
    (void)std::fflush(stdout);
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    // Fatal diagnostics only on stderr; never payload content.
    try {
        // --version short-circuits before any frame I/O begins.
        if (argc > 1 && argv[1] == std::string_view("--version")) {
            (void)print_version();
            return 0;
        }
        return run_worker();
    } catch (const std::exception& e) {
        std::fprintf(stderr, "concord-worker: fatal: %s\n", e.what());
        return kExitInternal;
    } catch (...) {
        std::fprintf(stderr, "concord-worker: fatal: unknown exception\n");
        return kExitInternal;
    }
}
