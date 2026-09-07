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
#include "concord/crdt/validation.hpp"

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
constexpr std::uint32_t kCmdGenerateOps = 6;       // seed + shape -> ops + digest

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
        if (result.gen_batches) {
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
