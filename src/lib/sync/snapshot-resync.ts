/**
 * Snapshot resync — the stale-client half of the Phase 5 recovery path
 * (P5-M031; docs/RECOVERY.md §4, wrapper layout docs/STORAGE.md §3.1,
 * DEC-035).
 *
 * When a client's persisted cursor falls below a document's compaction
 * floor, the gateway answers sync_request with `snapshot_resync_required`
 * instead of delta pages. The client fetches the covering snapshot over
 * HTTP and rebuilds its local replica:
 *
 *   validate envelope + wrapper → capture unacked outbox ops → import the
 *   wrapper's INNER snapshot (replaces the engine base) → re-apply the
 *   pending op bytes → set cursor = boundary. The session then resumes
 *   delta catch-up (sync_request at the new cursor) and resends the outbox
 *   under ORIGINAL identities; the server dedups.
 *
 * Pure, dependency-light: no DOM/IndexedDB/network access — engine, outbox
 * and cursor persistence are injected ports (the sync-session.ts
 * CrdtEnginePort seam). The wrapper codec is byte-exact parity with the
 * Rust gateway module `rust/sync-gateway/src/db/snapshots.rs` (`wrapper`).
 */

// ---------------------------------------------------------------------------
// Constants + typed errors
// ---------------------------------------------------------------------------

/** The only snapshot wrapper/envelope format version this client accepts. */
export const SUPPORTED_CLIENT_FORMAT_VERSION = 1;

/**
 * Wrapper header: 1 (format version) + 16 (document uuid) + 8 (coverage
 * seq) + 8 (covered op count) + 8 (inner length). All integers LE.
 */
const WRAPPER_HEADER_LEN = 41;

/** u64 range — envelope decimal strings serialize server u64s. */
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export type SnapshotResyncErrorCode =
  | "unsupported_format" // wrapper/envelope format version ≠ supported
  | "document_mismatch" // wrapper uuid ≠ requested document
  | "size_mismatch" // declared payload_size ≠ actual byte length
  | "checksum_mismatch" // SHA-256(wrapper bytes) ≠ envelope checksum
  | "coverage_mismatch" // envelope ↔ wrapper coverage_seq/op-count split
  | "truncated" // wrapper shorter than its declared structure
  | "trailing_bytes" // bytes beyond header + inner_len (corruption signal)
  | "bad_base64" // payload_base64 is not canonical standard base64
  | "bad_envelope" // envelope field shape / decimal string invalid
  | "digest_unavailable"; // no Web Crypto — fail closed, never skip hashing

export class SnapshotResyncError extends Error {
  constructor(
    message: string,
    public readonly code: SnapshotResyncErrorCode,
  ) {
    super(message);
    this.name = "SnapshotResyncError";
  }
}

// ---------------------------------------------------------------------------
// Types (ports + wire shapes)
// ---------------------------------------------------------------------------

/**
 * The HTTP snapshot envelope (JSON). All u64 fields travel as CANONICAL
 * decimal strings ("0", "42" — never "007", "-1", "1.5"): u64s exceed
 * Number.MAX_SAFE_INTEGER, so every consumer parses with BigInt.
 */
export interface SnapshotEnvelope {
  snapshotId: string;
  formatVersion: number;
  coverageSeq: string;
  coveredOpCount: string;
  /** SHA-256 hex over ALL wrapper bytes (out of band — not in the binary). */
  checksum: string;
  /** base64 of the wrapper bytes (the same bytes stored server-side). */
  payloadBase64: string;
  /** Gateway-side state digest ("sha256:…") — informational, not verified here. */
  stateDigest: string;
  payloadSize: string;
}

/** The gateway control frame sent instead of delta pages (RECOVERY.md §4). */
export interface SnapshotResyncRequired {
  boundary: string;
  snapshotId: string;
  snapshotChecksum: string;
  snapshotFormatVersion: number;
  coverageOpCount: string;
}

/**
 * Engine + outbox port for one resync. Mirrors CrdtEnginePort from
 * sync-session.ts; `importSnapshot` MUST be atomic (build fresh, swap only
 * on success — the worker core's loadSnapshot already satisfies this).
 */
export interface ResyncEnginePort {
  /** Replaces the local engine base with the inner snapshot bytes. */
  importSnapshot(inner: Uint8Array): Promise<void>;
  /** Applies remote canonical op bytes (idempotent via the applied set). */
  applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }>;
  /** The UNSYNCED outbox set (pending + sent, never durably acked). */
  unackedOps(): Promise<Uint8Array[]>;
}

/** Decoded server snapshot wrapper (STORAGE.md §3.1). */
export interface DecodedSnapshotWrapper {
  formatVersion: number;
  /** Canonical lowercase uuid string. */
  documentId: string;
  coverageSeq: bigint;
  coveredOpCount: bigint;
  /** The Phase 2 inner snapshot bytes (view into the input). */
  inner: Uint8Array;
}

export interface ResyncResult {
  /** The snapshot boundary; the cursor is set to exactly this value. */
  boundary: bigint;
  /** Pending ops re-applied against the new base (all of them). */
  reapplyCount: number;
  /** Re-applied ops the engine deduped (already contained ≤ boundary). */
  duplicateCount: number;
  /** Cursor value before the resync (diagnostics; unchanged on failure). */
  previousCursor: string;
}

// ---------------------------------------------------------------------------
// Wrapper codec (Rust parity)
// ---------------------------------------------------------------------------

/**
 * Strictly decodes the server snapshot wrapper:
 * `[u8 format_version=1][16B uuid][u64 LE coverage_seq][u64 LE
 * covered_op_count][u64 LE inner_len][inner bytes]`.
 *
 * Fail-closed: the header must be complete, the version supported, and
 * inner_len must consume the remaining bytes EXACTLY — trailing bytes are
 * a corruption signal, not a tolerance (invariant S4 / DEC-035).
 */
export function decodeSnapshotWrapper(bytes: Uint8Array): DecodedSnapshotWrapper {
  if (bytes.length < WRAPPER_HEADER_LEN) {
    throw new SnapshotResyncError(
      `wrapper header truncated: ${bytes.length} of ${WRAPPER_HEADER_LEN} bytes`,
      "truncated",
    );
  }
  const formatVersion = bytes[0];
  if (formatVersion !== SUPPORTED_CLIENT_FORMAT_VERSION) {
    throw new SnapshotResyncError(
      `unsupported wrapper format version ${formatVersion}`,
      "unsupported_format",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const documentId = formatUuid(bytes, 1);
  const coverageSeq = view.getBigUint64(17, true);
  const coveredOpCount = view.getBigUint64(25, true);
  const innerLen = view.getBigUint64(33, true);
  // BigInt arithmetic cannot overflow — a hostile inner_len (e.g. 2^64-1)
  // simply yields a total far above the actual length, mirroring the Rust
  // checked_add path.
  const total = BigInt(WRAPPER_HEADER_LEN) + innerLen;
  const actual = BigInt(bytes.length);
  if (actual < total) {
    throw new SnapshotResyncError(
      `inner payload truncated: ${bytes.length - WRAPPER_HEADER_LEN} of ${innerLen} bytes`,
      "truncated",
    );
  }
  if (actual > total) {
    throw new SnapshotResyncError(
      `${actual - total} trailing bytes after inner payload`,
      "trailing_bytes",
    );
  }
  const inner =
    innerLen === 0n
      ? new Uint8Array(0)
      : bytes.subarray(WRAPPER_HEADER_LEN);
  return { formatVersion, documentId, coverageSeq, coveredOpCount, inner };
}

/** Formats 16 uuid bytes at `offset` as canonical lowercase uuid text. */
function formatUuid(bytes: Uint8Array, offset: number): string {
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes[offset + i].toString(16).padStart(2, "0");
    // Hyphens after the 4th, 6th, 8th and 10th byte (8-4-4-4-12).
    if (i === 3 || i === 5 || i === 7 || i === 9) {
      hex += "-";
    }
  }
  return hex;
}

// ---------------------------------------------------------------------------
// base64 + SHA-256 (self-contained, dependency-free)
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_INDEX: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Decodes standard base64 STRICTLY: length a multiple of 4, padding only as
 * final `=`/`==`, standard alphabet only (URL-safe chars rejected), and
 * canonical trailing bits (a re-encoder must produce the same text). An
 * empty string decodes to zero bytes — the wrapper layer then rejects.
 */
export function decodeBase64(text: string): Uint8Array {
  if (text.length === 0) {
    return new Uint8Array(0);
  }
  if (text.length % 4 !== 0) {
    throw new SnapshotResyncError(
      `base64 length ${text.length} is not a multiple of 4`,
      "bad_base64",
    );
  }
  const padCount = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const charCount = text.length - padCount;
  if (text.slice(0, charCount).includes("=")) {
    throw new SnapshotResyncError("base64 padding in a non-final position", "bad_base64");
  }
  const out = new Uint8Array(Math.floor((charCount * 3) / 4));
  let outIndex = 0;
  for (let i = 0; i < charCount; i += 4) {
    // Final chunk holds 2 or 3 real chars when padded; all others hold 4.
    const chunkLen = Math.min(4, charCount - i);
    let n = 0;
    for (let j = 0; j < chunkLen; j++) {
      const code = text.charCodeAt(i + j);
      const value = code < 128 ? BASE64_INDEX[code] : -1;
      if (value === -1) {
        throw new SnapshotResyncError(
          `invalid base64 character at index ${i + j}`,
          "bad_base64",
        );
      }
      n = (n << 6) | value;
    }
    if (chunkLen === 4) {
      out[outIndex++] = (n >> 16) & 0xff;
      out[outIndex++] = (n >> 8) & 0xff;
      out[outIndex++] = n & 0xff;
    } else if (chunkLen === 3) {
      // 18 bits → 2 bytes; the low 2 bits must be zero (canonical).
      if ((n & 0b11) !== 0) {
        throw new SnapshotResyncError("non-canonical base64 trailing bits", "bad_base64");
      }
      out[outIndex++] = (n >> 10) & 0xff;
      out[outIndex++] = (n >> 2) & 0xff;
    } else {
      // 12 bits → 1 byte; the low 4 bits must be zero (canonical).
      if ((n & 0b1111) !== 0) {
        throw new SnapshotResyncError("non-canonical base64 trailing bits", "bad_base64");
      }
      out[outIndex++] = (n >> 4) & 0xff;
    }
  }
  return out;
}

/** Lowercase SHA-256 hex. Web Crypto only — if unavailable we fail closed. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new SnapshotResyncError(
      "Web Crypto SHA-256 unavailable (non-secure context?); refusing to skip checksum validation",
      "digest_unavailable",
    );
  }
  // Copy into a plain ArrayBuffer: TS 5.7+ types Uint8Array.buffer as
  // ArrayBufferLike, but Web Crypto demands an ArrayBuffer BufferSource.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await subtle.digest("SHA-256", buffer);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Envelope / frame parsing (hand-rolled validators, protocol.ts style)
// ---------------------------------------------------------------------------

/** Canonical decimal u64: "0" or no leading zeros, ≤ 20 digits, ≤ u64 max. */
const CANONICAL_U64_RE = /^(?:0|[1-9][0-9]{0,19})$/;

function parseU64Decimal(value: string): bigint | null {
  if (!CANONICAL_U64_RE.test(value)) {
    return null;
  }
  const parsed = BigInt(value);
  return parsed > U64_MAX ? null : parsed;
}

/**
 * Parses the raw HTTP envelope JSON. Shape-only (types + canonical decimal
 * strings + 64-char hex checksum); semantics live in validateServerSnapshot.
 * Unknown extra fields are tolerated — this is a versioned HTTP API
 * response, not a wire frame (the control frame below is strict instead).
 * Returns null on malformed input (the parseOpIdentity convention).
 */
export function parseSnapshotEnvelope(raw: unknown): SnapshotEnvelope | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.snapshot_id !== "string") return null;
  if (typeof obj.format_version !== "number" || !Number.isInteger(obj.format_version)) {
    return null;
  }
  if (typeof obj.coverage_seq !== "string" || parseU64Decimal(obj.coverage_seq) === null) {
    return null;
  }
  if (typeof obj.covered_op_count !== "string" || parseU64Decimal(obj.covered_op_count) === null) {
    return null;
  }
  if (typeof obj.checksum !== "string" || !/^[0-9a-fA-F]{64}$/.test(obj.checksum)) return null;
  if (typeof obj.payload_base64 !== "string") return null;
  if (typeof obj.state_digest !== "string") return null;
  if (typeof obj.payload_size !== "string" || parseU64Decimal(obj.payload_size) === null) {
    return null;
  }
  return {
    snapshotId: obj.snapshot_id,
    formatVersion: obj.format_version,
    coverageSeq: obj.coverage_seq,
    coveredOpCount: obj.covered_op_count,
    checksum: obj.checksum,
    payloadBase64: obj.payload_base64,
    stateDigest: obj.state_digest,
    payloadSize: obj.payload_size,
  };
}

/**
 * Parses the `snapshot_resync_required` control payload STRICTLY (unknown
 * fields rejected, mirroring the protocol.ts payload validators). Returns
 * null on malformed input.
 */
export function parseSnapshotResyncRequired(payload: unknown): SnapshotResyncRequired | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  const keys = ["boundary", "snapshot_id", "snapshot_checksum", "snapshot_format_version", "coverage_op_count"];
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) return null;
  }
  for (const key of keys) {
    if (!(key in obj)) return null;
  }
  if (
    typeof obj.boundary !== "string" ||
    typeof obj.snapshot_id !== "string" ||
    typeof obj.snapshot_checksum !== "string" ||
    typeof obj.coverage_op_count !== "string"
  ) {
    return null;
  }
  if (
    typeof obj.snapshot_format_version !== "number" ||
    !Number.isInteger(obj.snapshot_format_version)
  ) {
    return null;
  }
  if (parseU64Decimal(obj.boundary) === null || parseU64Decimal(obj.coverage_op_count) === null) {
    return null;
  }
  return {
    boundary: obj.boundary,
    snapshotId: obj.snapshot_id,
    snapshotChecksum: obj.snapshot_checksum,
    snapshotFormatVersion: obj.snapshot_format_version,
    coverageOpCount: obj.coverage_op_count,
  };
}

/**
 * Cross-checks the resync frame against the fetched envelope — the frame
 * and envelope describe the SAME snapshot or something is wrong (stale
 * cache, wrong snapshot served). Returns a mismatch reason or null, the
 * protocol.ts check convention.
 */
export function envelopeResyncMismatch(
  frame: SnapshotResyncRequired,
  envelope: SnapshotEnvelope,
): string | null {
  if (frame.snapshotFormatVersion !== envelope.formatVersion) {
    return "snapshot_format_version disagrees with envelope format_version";
  }
  // Both sides are canonical decimal strings, so textual equality IS
  // numeric equality here.
  if (frame.boundary !== envelope.coverageSeq) {
    return "frame boundary disagrees with envelope coverage_seq";
  }
  if (frame.coverageOpCount !== envelope.coveredOpCount) {
    return "frame coverage_op_count disagrees with envelope covered_op_count";
  }
  if (frame.snapshotChecksum.toLowerCase() !== envelope.checksum.toLowerCase()) {
    return "frame snapshot_checksum disagrees with envelope checksum";
  }
  if (frame.snapshotId !== envelope.snapshotId) {
    return "frame snapshot_id disagrees with envelope snapshot_id";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot validation
// ---------------------------------------------------------------------------

/**
 * Fully validates the served snapshot against the pinned spec before any
 * engine state is touched:
 *
 *   envelope.format_version = 1 → base64 decodes → payload_size === actual
 *   bytes → wrapper decodes (version/bounds/exact length) → document uuid
 *   matches → coverage_seq + covered_op_count agree with the wrapper →
 *   SHA-256(wrapper bytes) === checksum (out of band, STORAGE.md §3.1).
 *
 * The checksum is verified LAST (most expensive) and over ALL wrapper
 * bytes, exactly as stored server-side. Every failure is a typed
 * SnapshotResyncError — fail-closed, never a best-effort import.
 */
export async function validateServerSnapshot(params: {
  expectedDocumentId: string;
  envelope: SnapshotEnvelope;
}): Promise<{ inner: Uint8Array; coverageSeq: bigint }> {
  const { expectedDocumentId, envelope } = params;
  if (envelope.formatVersion !== SUPPORTED_CLIENT_FORMAT_VERSION) {
    throw new SnapshotResyncError(
      `unsupported envelope format version ${envelope.formatVersion}`,
      "unsupported_format",
    );
  }
  const bytes = decodeBase64(envelope.payloadBase64);
  const declaredSize = parseU64Decimal(envelope.payloadSize);
  if (declaredSize === null) {
    throw new SnapshotResyncError("envelope payload_size is not a canonical u64 decimal", "bad_envelope");
  }
  if (declaredSize !== BigInt(bytes.length)) {
    throw new SnapshotResyncError(
      `declared payload size ${declaredSize} != actual ${bytes.length}`,
      "size_mismatch",
    );
  }
  const wrapper = decodeSnapshotWrapper(bytes);
  if (wrapper.documentId !== expectedDocumentId.toLowerCase()) {
    throw new SnapshotResyncError(
      `wrapper document ${wrapper.documentId} != requested ${expectedDocumentId}`,
      "document_mismatch",
    );
  }
  const declaredCoverage = parseU64Decimal(envelope.coverageSeq);
  if (declaredCoverage === null) {
    throw new SnapshotResyncError("envelope coverage_seq is not a canonical u64 decimal", "bad_envelope");
  }
  if (declaredCoverage !== wrapper.coverageSeq) {
    throw new SnapshotResyncError(
      `envelope coverage_seq ${declaredCoverage} != wrapper ${wrapper.coverageSeq}`,
      "coverage_mismatch",
    );
  }
  const declaredOpCount = parseU64Decimal(envelope.coveredOpCount);
  if (declaredOpCount === null) {
    throw new SnapshotResyncError("envelope covered_op_count is not a canonical u64 decimal", "bad_envelope");
  }
  if (declaredOpCount !== wrapper.coveredOpCount) {
    throw new SnapshotResyncError(
      `envelope covered_op_count ${declaredOpCount} != wrapper ${wrapper.coveredOpCount}`,
      "coverage_mismatch",
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(envelope.checksum)) {
    throw new SnapshotResyncError("envelope checksum is not 64 hex characters", "bad_envelope");
  }
  const computed = await sha256Hex(bytes);
  // Hex is case-insensitive on the wire; normalize before comparing.
  if (computed !== envelope.checksum.toLowerCase()) {
    throw new SnapshotResyncError(
      `payload checksum mismatch (computed ${computed}, envelope ${envelope.checksum})`,
      "checksum_mismatch",
    );
  }
  return { inner: wrapper.inner, coverageSeq: wrapper.coverageSeq };
}

// ---------------------------------------------------------------------------
// Resync orchestration (RECOVERY.md §4)
// ---------------------------------------------------------------------------

/**
 * Runs the full stale-client resync:
 *
 *   validate → capture pending → import inner snapshot → re-apply pending
 *   → set cursor = boundary.
 *
 * Pending-op preservation — the subtle correctness core (§4):
 *
 * The outbox (pending-store.ts) is the UNSYNCED set — ops the server may
 * never have seen. Importing the server snapshot REPLACES engine state, so
 * without re-application every un-acked local edit would vanish from the
 * local replica. Re-applying the pending op BYTES via applyRemote is
 * exactly what the server would have done on delivery, and it is safe on
 * a fresh import because the inner snapshot carries the applied-op-id
 * dedup set (the C++ snapshot restore path rebuilds `applied_`;
 * Doc::apply_remote no-ops any id already in it, and integrate_insert
 * records the id even when the item is already present — dedup holds even
 * for an id that somehow missed the applied set). So:
 *
 *   - a pending op the server DID receive (≤ boundary) re-applies as a
 *     duplicate no-op — the engine's applied set already contains it;
 *   - a pending op the server never saw integrates normally against the
 *     new base, exactly as it would have server-side.
 *
 * Ordering invariants:
 * 1. Pending ops are captured from the outbox BEFORE importSnapshot and
 *    defensively copied — the port bundles engine + outbox access, and a
 *    port implementation may derive unacked state from engine internals
 *    that the import replaces. Capture first, always.
 * 2. setCursor runs LAST, after every engine step succeeded: the cursor
 *    must never claim boundary coverage before the engine actually holds
 *    the snapshot base + re-applied pending ops. A crash mid-flow leaves
 *    the old (< boundary) cursor, so the next session resyncs again —
 *    the port's import must be atomic (fresh engine, swap on success),
 *    which makes the retry converge. There is deliberately no
 *    partial-rollback path; the only committed effect is the final cursor.
 * 3. Ops re-apply under their ORIGINAL bytes/identities; the subsequent
 *    outbox resend (the session's job, after this returns) hits the
 *    server's unique index + the snapshot's applied set — duplicates are
 *    harmless (§4 step 5).
 *
 * On failure the error propagates and the cursor is unchanged (plus a
 * belt-and-braces restore if a miswired port advanced it mid-failure).
 */
export async function performSnapshotResync(params: {
  expectedDocumentId: string;
  envelope: SnapshotEnvelope;
  engine: ResyncEnginePort;
  setCursor: (cursor: string) => void;
  getCursor: () => string;
}): Promise<ResyncResult> {
  const previousCursor = params.getCursor();

  // Validation touches no engine state — a bad snapshot never mutates the
  // local replica.
  const { inner, coverageSeq } = await validateServerSnapshot({
    expectedDocumentId: params.expectedDocumentId,
    envelope: params.envelope,
  });

  // Capture pending BEFORE the import (invariant 1) and detach the bytes
  // from any port-internal storage via copies.
  const pending = (await params.engine.unackedOps()).map((op) => op.slice());

  try {
    // Replaces the local base atomically (port contract).
    await params.engine.importSnapshot(inner);
    // Re-apply under original identities; the engine dedups ops the new
    // base already contains. An empty pending set skips the port call
    // entirely (some engines reject empty batches).
    let duplicates = 0;
    if (pending.length > 0) {
      const applied = await params.engine.applyRemote(pending);
      duplicates = applied.duplicates;
    }
    // The only committed effect — LAST, by invariant 2.
    params.setCursor(coverageSeq.toString());
    return {
      boundary: coverageSeq,
      reapplyCount: pending.length,
      duplicateCount: duplicates,
      previousCursor,
    };
  } catch (error) {
    // Fail-closed invariant: nothing above persisted a cursor, but if a
    // miswired port advanced it during the failed engine steps, put the
    // pre-resync value back so the next session retries from the truth.
    if (params.getCursor() !== previousCursor) {
      console.error("[snapshot-resync] cursor advanced during a failed resync; restoring");
      params.setCursor(previousCursor);
    }
    throw error;
  }
}
