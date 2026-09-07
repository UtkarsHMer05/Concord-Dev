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
// Design constraints (production path):
//   - Deterministic: identical request bytes produce identical response
//     bytes (no timestamps, no addresses, no container-order leakage).
//   - Bounded: frames are capped (256 MiB), op counts are capped, and only
//     one frame plus one Doc is resident at a time.
//   - Content-silent errors: messages never echo op/snapshot bytes.
//   - Core CrdtError exceptions are caught and mapped to status codes; no
//     exception escapes a handled request.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "concord/crdt/doc.hpp"
#include "concord/crdt/errors.hpp"
#include "concord/crdt/ids.hpp"
#include "concord/crdt/serialize.hpp"

namespace {

namespace crdt = concord::crdt;

// ---------------------------------------------------------------------------
// Reserved maintenance replica id.
//
// Value: 0x53595343 ("SYSC" in ASCII, big-endian) = 1398362947.
//
// Collision analysis (why no client replica can ever hold this id):
//   - The only production client id allocator is `replicaIdForDocument`
//     (src/lib/crdt/editor-bridge.ts:45-71): 8 bytes from Web Crypto
//     getRandomValues (or Math.random fallback), then `bytes[0] |= 1`.
//     The result is a full-width u64. Its top byte (bits 56..63) is fully
//     random, so a client id lies in [2^56·k, ...] with k random — in
//     particular ids in the range of kMaintenanceReplica (< 2^31) occur
//     only with probability 2^-24 per allocation (top 33 bits all zero).
//     That is not a structural reservation, so the format adds one: see
//     below.
//   - Because a random 64-bit allocator cannot be *proven* disjoint from
//     any fixed constant, this worker additionally enforces the invariant
//     it actually needs: kMaintenanceReplica is never used to GENERATE
//     operations (reconstruction is apply-only, never local_* calls), and
//     incoming ops carrying kMaintenanceReplica as their writer id are
//     rejected with status 3 (op apply error) before touching Doc state.
//     Therefore no operation the worker produces (snapshots, digests) can
//     ever contain a maintenance-owned OpId, and a collision with some
//     hypothetical client id 1398362947 is harmless: such a client's ops
//     are rejected, never merged.
//   - All other replica-id issuers are deterministic test harnesses
//     (small integers) and the gateway, which stores but never allocates
//     replica ids (rust/sync-gateway envelope.rs — identity comes from
//     validated op bytes only).
constexpr std::uint64_t kMaintenanceReplicaValue = 0x53595343ULL;  // "SYSC"
constexpr crdt::ReplicaId kMaintenanceReplica{kMaintenanceReplicaValue};

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

// Reads the [u32 snapshot_len][snapshot bytes] section shared by CMD 3/4/5.
[[nodiscard]] ParseResult read_snapshot(const std::string& frame, std::size_t& offset,
                                        RequestBody& body, std::string& error) {
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
    body.snapshot = frame.substr(offset, snapshot_len);
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
            const ParseResult result = read_snapshot(frame, offset, body, error);
            if (result != ParseResult::Ok) {
                return result;
            }
            break;  // falls through to trailing check
        }
        case kCmdDigestAfter: {
            const ParseResult snap_result = read_snapshot(frame, offset, body, error);
            if (snap_result != ParseResult::Ok) {
                return snap_result;
            }
            const ParseResult ops_result = read_op_batches(frame, offset, body, error);
            if (ops_result != ParseResult::Ok) {
                return ops_result;
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

// ---------------------------------------------------------------------------
// Command execution. Exactly one Doc is resident per request.
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

struct CommandResult {
    std::uint32_t status = kStatusOk;
    std::string digest;
    std::string snapshot;
    bool has_snapshot = false;
    bool snapshot_only = false;  // CMD 2: emit [status][snapshot_len][snapshot]
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
        if (result.snapshot_only) {
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

}  // namespace

int main() {
    // Fatal diagnostics only on stderr; never payload content.
    try {
        return run_worker();
    } catch (const std::exception& e) {
        std::fprintf(stderr, "concord-worker: fatal: %s\n", e.what());
        return kExitInternal;
    } catch (...) {
        std::fprintf(stderr, "concord-worker: fatal: unknown exception\n");
        return kExitInternal;
    }
}
