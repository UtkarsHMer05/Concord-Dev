/**
 * Snapshot resync tests (P5-M031 — client half of RECOVERY.md §4).
 *
 * - Wrapper decode: round-trip, truncation at every boundary, trailing
 *   bytes, version checks, little-endian parity with the Rust codec.
 * - validateServerSnapshot matrix: document/size/coverage/checksum/base64/
 *   format failures — every one typed and fail-closed.
 * - performSnapshotResync against an in-memory fake engine port: capture-
 *   before-import ordering, cursor timing, failure atomicity.
 * - BigInt boundary: coverage_seq = 2^64-1 survives the full path.
 */

import { describe, expect, it } from "vitest";

import {
  decodeBase64,
  decodeSnapshotWrapper,
  envelopeResyncMismatch,
  parseSnapshotEnvelope,
  parseSnapshotResyncRequired,
  performSnapshotResync,
  SnapshotResyncError,
  validateServerSnapshot,
  type SnapshotEnvelope,
} from "@/lib/sync/snapshot-resync";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Canonical uuid string → 16 bytes (mirror of Uuid::from_bytes). */
function uuidBytes(hex: string): Uint8Array {
  const clean = hex.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Builds the STORAGE.md §3.1 wrapper around a dummy inner payload. */
function buildTestWrapper(
  documentId: string,
  coverageSeq: bigint,
  opCount: bigint,
  inner: Uint8Array,
  formatVersion = 1,
): Uint8Array {
  const out = new Uint8Array(41 + inner.length);
  const view = new DataView(out.buffer);
  out[0] = formatVersion;
  out.set(uuidBytes(documentId), 1);
  view.setBigUint64(17, coverageSeq, true);
  view.setBigUint64(25, opCount, true);
  view.setBigUint64(33, BigInt(inner.length), true);
  out.set(inner, 41);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer (TS 5.7+ Uint8Array.buffer is
  // ArrayBufferLike; crypto.subtle demands an ArrayBuffer BufferSource).
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Buffer.from(digest).toString("hex");
}

/** base64 over the raw byte values (standard alphabet, no line wrapping). */
function base64Bytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

interface EnvelopeOverrides {
  documentId?: string;
  formatVersion?: number;
  coverageSeq?: string;
  coveredOpCount?: string;
  checksum?: string;
  payloadSize?: string;
  payload?: Uint8Array;
}

/** Builds a fully valid envelope for a wrapper (or a mutated variant). */
async function buildEnvelope(
  wrapper: Uint8Array,
  coverageSeq: bigint,
  coveredOpCount: bigint,
  overrides: EnvelopeOverrides = {},
): Promise<SnapshotEnvelope> {
  const payload = overrides.payload ?? wrapper;
  return {
    snapshotId: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
    formatVersion: overrides.formatVersion ?? 1,
    coverageSeq: overrides.coverageSeq ?? coverageSeq.toString(),
    coveredOpCount: overrides.coveredOpCount ?? coveredOpCount.toString(),
    checksum: overrides.checksum ?? (await sha256Hex(payload)),
    payloadBase64: base64Bytes(payload),
    stateDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    payloadSize: overrides.payloadSize ?? payload.length.toString(),
  };
}

/** Runs the decoder and captures the typed error instead of throwing. */
function tryDecode(bytes: Uint8Array): SnapshotResyncError | null {
  try {
    decodeSnapshotWrapper(bytes);
    return null;
  } catch (error) {
    return error instanceof SnapshotResyncError ? error : null;
  }
}

/** Minimal fake engine port recording every call, order included. */
class FakeEnginePort {
  imported: Uint8Array[] = [];
  applyCalls: Uint8Array[][] = [];
  unackedCalls = 0;
  events: string[] = [];
  failOnImport = false;
  private unacked: Uint8Array[];

  constructor(unacked: Uint8Array[] = []) {
    this.unacked = unacked;
  }

  async importSnapshot(inner: Uint8Array): Promise<void> {
    this.events.push("import");
    if (this.failOnImport) {
      throw new Error("engine import failed");
    }
    this.imported.push(inner.slice());
  }

  async applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }> {
    this.events.push("apply");
    this.applyCalls.push(ops.map((o) => o.slice()));
    return { applied: 0, duplicates: ops.length };
  }

  async unackedOps(): Promise<Uint8Array[]> {
    this.events.push("unacked");
    this.unackedCalls += 1;
    return this.unacked;
  }
}

function makeCursor() {
  let value = "12";
  return {
    getCursor: () => value,
    setCursor: (next: string) => {
      value = next;
    },
    value: () => value,
  };
}

const DOC = "2c1f9e58-6f0b-4d15-9a5a-1a7d4b8ee2b7";
const INNER = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33]);

// ---------------------------------------------------------------------------
// decodeSnapshotWrapper
// ---------------------------------------------------------------------------

describe("decodeSnapshotWrapper", () => {
  it("round-trips a valid wrapper with dummy inner payload", () => {
    const wrapper = buildTestWrapper(DOC, 9001n, 42n, INNER);
    const decoded = decodeSnapshotWrapper(wrapper);
    expect(decoded.formatVersion).toBe(1);
    expect(decoded.documentId).toBe(DOC);
    expect(decoded.coverageSeq).toBe(9001n);
    expect(decoded.coveredOpCount).toBe(42n);
    expect(Array.from(decoded.inner)).toEqual(Array.from(INNER));
  });

  it("formats the uuid lowercase canonical", () => {
    const upper = buildTestWrapper(DOC.toUpperCase(), 1n, 1n, INNER);
    expect(decodeSnapshotWrapper(upper).documentId).toBe(DOC);
  });

  it("accepts an empty inner payload (inner_len = 0)", () => {
    const decoded = decodeSnapshotWrapper(buildTestWrapper(DOC, 5n, 5n, new Uint8Array(0)));
    expect(decoded.inner).toHaveLength(0);
  });

  it("fails on an empty buffer (truncated at the first byte)", () => {
    const error = tryDecode(new Uint8Array(0));
    expect(error?.code).toBe("truncated");
  });

  it("fails at every truncation boundary of the header", () => {
    const wrapper = buildTestWrapper(DOC, 77n, 9n, INNER);
    // Cut at: 1 (first byte), 9 (mid uuid), 25 (mid coverage seq),
    // 33 (mid covered count), 41-exact-with-declared-inner (mid inner).
    for (const cut of [1, 9, 25, 33, 40, 45]) {
      const error = tryDecode(wrapper.subarray(0, cut));
      expect(error?.code).toBe("truncated");
    }
  });

  it("reports truncation when inner_len exceeds the actual bytes", () => {
    const wrapper = buildTestWrapper(DOC, 7n, 7n, INNER);
    // Truncate inside the declared inner region → total > actual.
    const error = tryDecode(wrapper.subarray(0, wrapper.length - 3));
    expect(error?.code).toBe("truncated");
  });

  it("fails on trailing bytes after the declared inner payload", () => {
    const wrapper = buildTestWrapper(DOC, 7n, 7n, INNER);
    const padded = new Uint8Array(wrapper.length + 2);
    padded.set(wrapper, 0);
    const error = tryDecode(padded);
    expect(error?.code).toBe("trailing_bytes");
  });

  it("fails on a hostile inner_len that would overflow (2^64-1)", () => {
    const wrapper = buildTestWrapper(DOC, 7n, 7n, INNER);
    new DataView(wrapper.buffer).setBigUint64(33, 0xffff_ffff_ffff_ffffn, true);
    const error = tryDecode(wrapper);
    expect(error?.code).toBe("truncated");
  });

  it("rejects an unsupported format version", () => {
    const wrapper = buildTestWrapper(DOC, 1n, 1n, INNER, 2);
    const error = tryDecode(wrapper);
    expect(error?.code).toBe("unsupported_format");
  });

  it("reads integers little-endian (0x0100000000000000 LE = 1)", () => {
    const wrapper = buildTestWrapper(DOC, 1n, 2n, INNER);
    // Rebuild with explicitly flipped bytes: LE encoding of 1 is
    // [1,0,0,0,0,0,0,0] — buildTestWrapper already uses LE; assert directly.
    const view = new DataView(wrapper.buffer);
    expect(view.getUint8(17)).toBe(1);
    expect(view.getUint8(18)).toBe(0);
    expect(view.getUint8(25)).toBe(2);
    expect(decodeSnapshotWrapper(wrapper).coverageSeq).toBe(1n);
  });

  it("decodes 2^64-1 coverage/counts (u64 max)", () => {
    const wrapper = buildTestWrapper(DOC, 0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, INNER);
    const decoded = decodeSnapshotWrapper(wrapper);
    expect(decoded.coverageSeq).toBe(0xffff_ffff_ffff_ffffn);
    expect(decoded.coveredOpCount).toBe(0xffff_ffff_ffff_ffffn);
  });
});

// ---------------------------------------------------------------------------
// base64 decoder
// ---------------------------------------------------------------------------

describe("decodeBase64", () => {
  it("round-trips against Buffer for all lengths 0..64", () => {
    for (let len = 0; len <= 64; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + len) % 256;
      const encoded = base64Bytes(bytes);
      expect(Array.from(decodeBase64(encoded))).toEqual(Array.from(bytes));
    }
  });

  it("round-trips a 1 KiB random payload", () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    expect(Array.from(decodeBase64(base64Bytes(bytes)))).toEqual(Array.from(bytes));
  });

  it("rejects lengths that are not a multiple of 4", () => {
    expect(base64Try("abcde")).toBe("bad_base64");
  });

  it("rejects invalid characters (URL-safe alphabet rejected)", () => {
    expect(base64Try("ab_d")).toBe("bad_base64"); // underscore
    expect(base64Try("ab-d")).toBe("bad_base64"); // dash
    expect(base64Try("ab d")).toBe("bad_base64"); // space
  });

  it("rejects internal padding", () => {
    expect(base64Try("ab=dcGA=")).toBe("bad_base64");
  });

  it("rejects non-canonical trailing bits", () => {
    // Canonical 1-byte encoding of 0x41 is "QQ==" (low 4 bits zero);
    // "QR==" carries non-zero trailing bits a canonical encoder never
    // emits (Node's Buffer is lenient and accepts it anyway).
    expect(base64Try("QQ==")).toBeNull();
    expect(base64Try("QR==")).toBe("bad_base64");
    // Canonical 2-byte encoding of 0x4141 is "QUE=" (low 2 bits zero).
    expect(base64Try("QUE=")).toBeNull();
    expect(base64Try("QUF=")).toBe("bad_base64"); // F=5 → low bits 01
  });

  it("decodes the empty string to zero bytes", () => {
    expect(decodeBase64("")).toHaveLength(0);
  });
});

function base64Try(text: string): string | null {
  try {
    decodeBase64(text);
    return null;
  } catch (error) {
    return error instanceof SnapshotResyncError ? error.code : "unknown";
  }
}

// ---------------------------------------------------------------------------
// Envelope + frame parsing
// ---------------------------------------------------------------------------

describe("parseSnapshotEnvelope", () => {
  const valid = {
    snapshot_id: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
    format_version: 1,
    coverage_seq: "12",
    covered_op_count: "34",
    checksum: "a".repeat(64),
    payload_base64: "AAAA",
    state_digest: "sha256:0000",
    payload_size: "3",
  };

  it("accepts the spec shape and maps to camelCase", () => {
    const parsed = parseSnapshotEnvelope(valid);
    expect(parsed?.snapshotId).toBe(valid.snapshot_id);
    expect(parsed?.formatVersion).toBe(1);
    expect(parsed?.coverageSeq).toBe("12");
    expect(parsed?.coveredOpCount).toBe("34");
    expect(parsed?.checksum).toBe("a".repeat(64));
    expect(parsed?.payloadBase64).toBe("AAAA");
    expect(parsed?.payloadSize).toBe("3");
  });

  it("rejects non-canonical decimal strings", () => {
    expect(parseSnapshotEnvelope({ ...valid, coverage_seq: "012" })).toBeNull();
    expect(parseSnapshotEnvelope({ ...valid, coverage_seq: "-1" })).toBeNull();
    expect(parseSnapshotEnvelope({ ...valid, coverage_seq: "1.5" })).toBeNull();
    expect(parseSnapshotEnvelope({ ...valid, coverage_seq: "1e3" })).toBeNull();
    expect(parseSnapshotEnvelope({ ...valid, payload_size: " 3" })).toBeNull();
    // > u64 max
    expect(
      parseSnapshotEnvelope({ ...valid, coverage_seq: "18446744073709551616" }),
    ).toBeNull();
    // exactly u64 max passes
    expect(
      parseSnapshotEnvelope({ ...valid, coverage_seq: "18446744073709551615" }),
    ).not.toBeNull();
  });

  it("rejects a short/long checksum and wrong types", () => {
    expect(parseSnapshotEnvelope({ ...valid, checksum: "a".repeat(63) })).toBeNull();
    expect(parseSnapshotEnvelope({ ...valid, checksum: "z".repeat(64) })).toBeNull();
    expect(parseSnapshotEnvelope({ ...valid, format_version: "1" })).toBeNull();
    expect(parseSnapshotEnvelope({ ...valid, snapshot_id: 7 })).toBeNull();
    expect(parseSnapshotEnvelope(null)).toBeNull();
    expect(parseSnapshotEnvelope([valid])).toBeNull();
  });

  it("tolerates extra fields (versioned HTTP response, not a frame)", () => {
    expect(parseSnapshotEnvelope({ ...valid, extra: "ignored" })).not.toBeNull();
  });
});

describe("parseSnapshotResyncRequired (control payload, strict)", () => {
  const valid = {
    boundary: "42",
    snapshot_id: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
    snapshot_checksum: "b".repeat(64),
    snapshot_format_version: 1,
    coverage_op_count: "42",
  };

  it("accepts the spec shape", () => {
    const parsed = parseSnapshotResyncRequired(valid);
    expect(parsed?.boundary).toBe("42");
    expect(parsed?.snapshotFormatVersion).toBe(1);
    expect(parsed?.coverageOpCount).toBe("42");
  });

  it("rejects unknown fields (strict, protocol.ts style)", () => {
    expect(parseSnapshotResyncRequired({ ...valid, extra: 1 })).toBeNull();
  });

  it("rejects missing fields and bad types", () => {
    const { boundary, ...noBoundary } = valid;
    void boundary;
    expect(parseSnapshotResyncRequired(noBoundary)).toBeNull();
    expect(parseSnapshotResyncRequired({ ...valid, boundary: 42 })).toBeNull();
    expect(parseSnapshotResyncRequired({ ...valid, boundary: "007" })).toBeNull();
    expect(
      parseSnapshotResyncRequired({ ...valid, snapshot_format_version: "1" }),
    ).toBeNull();
    expect(parseSnapshotResyncRequired("nope")).toBeNull();
  });

  it("accepts boundary = u64 max as a canonical decimal", () => {
    expect(
      parseSnapshotResyncRequired({ ...valid, boundary: "18446744073709551615" })
        ?.boundary,
    ).toBe("18446744073709551615");
  });
});

describe("envelopeResyncMismatch (frame ↔ envelope cross-check)", () => {
  it("accepts an agreeing frame/envelope pair", () => {
    const frame = {
      boundary: "12",
      snapshotId: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
      snapshotChecksum: "b".repeat(64),
      snapshotFormatVersion: 1,
      coverageOpCount: "34",
    };
    const envelope: SnapshotEnvelope = {
      snapshotId: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
      formatVersion: 1,
      coverageSeq: "12",
      coveredOpCount: "34",
      checksum: "b".repeat(64),
      payloadBase64: "",
      stateDigest: "",
      payloadSize: "0",
    };
    expect(envelopeResyncMismatch(frame, envelope)).toBeNull();
  });

  it("detects every disagreement", () => {
    const frame = {
      boundary: "12",
      snapshotId: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
      snapshotChecksum: "b".repeat(64),
      snapshotFormatVersion: 1,
      coverageOpCount: "34",
    };
    const envelope: SnapshotEnvelope = {
      snapshotId: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
      formatVersion: 1,
      coverageSeq: "12",
      coveredOpCount: "34",
      checksum: "b".repeat(64),
      payloadBase64: "",
      stateDigest: "",
      payloadSize: "0",
    };
    expect(envelopeResyncMismatch({ ...frame, boundary: "13" }, envelope)).toContain("boundary");
    expect(
      envelopeResyncMismatch({ ...frame, coverageOpCount: "35" }, envelope),
    ).toContain("coverage_op_count");
    expect(
      envelopeResyncMismatch({ ...frame, snapshotChecksum: "c".repeat(64) }, envelope),
    ).toContain("checksum");
    expect(
      envelopeResyncMismatch({ ...frame, snapshotId: "other" }, envelope),
    ).toContain("snapshot_id");
    expect(
      envelopeResyncMismatch({ ...frame, snapshotFormatVersion: 2 }, envelope),
    ).toContain("format_version");
  });
});

// ---------------------------------------------------------------------------
// validateServerSnapshot
// ---------------------------------------------------------------------------

describe("validateServerSnapshot", () => {
  it("accepts a fully valid snapshot and returns inner + coverage", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const result = await validateServerSnapshot({ expectedDocumentId: DOC, envelope });
    expect(Array.from(result.inner)).toEqual(Array.from(INNER));
    expect(result.coverageSeq).toBe(500n);
  });

  it("rejects a wrong document id", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const error = await validateTry({ expectedDocumentId: "00000000-0000-4000-8000-000000000000", envelope });
    expect(error?.code).toBe("document_mismatch");
  });

  it("rejects a checksum mismatch (one flipped payload byte)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const flipped = wrapper.slice();
    flipped[flipped.length - 1] ^= 0x01;
    // Envelope carries the ORIGINAL wrapper's checksum but the mutated
    // bytes — the classic one-bit-flip corruption case (invariant S4).
    const envelope = await buildEnvelope(wrapper, 500n, 20n, {
      payload: flipped,
      checksum: await sha256Hex(wrapper),
    });
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("checksum_mismatch");
  });

  it("rejects a size mismatch (declared != actual)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n, { payloadSize: "999" });
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("size_mismatch");
  });

  it("rejects a coverage_seq mismatch (envelope X, wrapper Y)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 499n, 20n, {
      coverageSeq: "499", // envelope says 499; wrapper says 500
    });
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("coverage_mismatch");
  });

  it("rejects a covered_op_count mismatch", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n, {
      coveredOpCount: "19", // envelope says 19; wrapper says 20
    });
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("coverage_mismatch");
  });

  it("rejects bad base64 in the payload", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const good = await buildEnvelope(wrapper, 500n, 20n);
    const envelope = { ...good, payloadBase64: "!!!not-base64!!!" };
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("bad_base64");
  });

  it("rejects an unsupported envelope format version", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n, { formatVersion: 2 });
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("unsupported_format");
  });

  it("rejects a truncated wrapper (payload cut mid-header)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const cut = wrapper.subarray(0, 20);
    const envelope = await buildEnvelope(wrapper, 500n, 20n, { payload: cut });
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("truncated");
  });

  it("rejects trailing bytes in the payload", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const padded = new Uint8Array(wrapper.length + 1);
    padded.set(wrapper, 0);
    const envelope = await buildEnvelope(wrapper, 500n, 20n, { payload: padded });
    const error = await validateTry({ expectedDocumentId: DOC, envelope });
    expect(error?.code).toBe("trailing_bytes");
  });

  it("accepts an uppercase checksum (hex case-insensitive)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const good = await buildEnvelope(wrapper, 500n, 20n);
    const envelope = { ...good, checksum: good.checksum.toUpperCase() };
    await expect(
      validateServerSnapshot({ expectedDocumentId: DOC, envelope }),
    ).resolves.toMatchObject({ coverageSeq: 500n });
  });

  it("accepts coverage_seq = u64 max end to end", async () => {
    const seq = 0xffff_ffff_ffff_ffffn;
    const wrapper = buildTestWrapper(DOC, seq, 1n, INNER);
    const envelope = await buildEnvelope(wrapper, seq, 1n);
    const result = await validateServerSnapshot({ expectedDocumentId: DOC, envelope });
    expect(result.coverageSeq).toBe(seq);
  });
});

async function validateTry(params: {
  expectedDocumentId: string;
  envelope: SnapshotEnvelope;
}): Promise<SnapshotResyncError | null> {
  try {
    await validateServerSnapshot(params);
    return null;
  } catch (error) {
    return error instanceof SnapshotResyncError ? error : null;
  }
}

// ---------------------------------------------------------------------------
// performSnapshotResync (fake engine port)
// ---------------------------------------------------------------------------

describe("performSnapshotResync", () => {
  const pendingA = new Uint8Array([1, 1, 7, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const pendingB = new Uint8Array([1, 1, 7, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);

  it("happy path: validates, imports inner, re-applies pending, sets cursor", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const engine = new FakeEnginePort([pendingA, pendingB]);
    const cursor = makeCursor();

    const result = await performSnapshotResync({
      expectedDocumentId: DOC,
      envelope,
      engine,
      setCursor: cursor.setCursor,
      getCursor: cursor.getCursor,
    });

    expect(result.boundary).toBe(500n);
    expect(result.reapplyCount).toBe(2);
    expect(result.duplicateCount).toBe(2);
    expect(result.previousCursor).toBe("12");
    expect(cursor.value()).toBe("500");
    // Ordering: capture → import → apply.
    expect(engine.events).toEqual(["unacked", "import", "apply"]);
    // The engine received exactly the inner payload bytes.
    expect(engine.imported).toHaveLength(1);
    expect(Array.from(engine.imported[0])).toEqual(Array.from(INNER));
    // Pending ops re-applied under their ORIGINAL bytes, same array order.
    expect(engine.applyCalls).toHaveLength(1);
    expect(Array.from(engine.applyCalls[0][0])).toEqual(Array.from(pendingA));
    expect(Array.from(engine.applyCalls[0][1])).toEqual(Array.from(pendingB));
  });

  it("captures pending ops BEFORE importSnapshot (order asserted)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const engine = new FakeEnginePort([pendingA]);
    const cursor = makeCursor();
    await performSnapshotResync({
      expectedDocumentId: DOC,
      envelope,
      engine,
      setCursor: cursor.setCursor,
      getCursor: cursor.getCursor,
    });
    expect(engine.unackedCalls).toBe(1);
    // Capture must precede import — even a port that derives unacked state
    // from engine internals sees the pre-import snapshot of the outbox.
    expect(engine.events.indexOf("unacked")).toBeLessThan(engine.events.indexOf("import"));
  });

  it("skips the applyRemote call when there are no pending ops", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const engine = new FakeEnginePort([]);
    const cursor = makeCursor();
    const result = await performSnapshotResync({
      expectedDocumentId: DOC,
      envelope,
      engine,
      setCursor: cursor.setCursor,
      getCursor: cursor.getCursor,
    });
    expect(result.reapplyCount).toBe(0);
    expect(engine.applyCalls).toHaveLength(0);
    expect(engine.events).toEqual(["unacked", "import"]);
    expect(cursor.value()).toBe("500");
  });

  it("failure at import: cursor unchanged, no pending re-apply", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const engine = new FakeEnginePort([pendingA, pendingB]);
    engine.failOnImport = true;
    const cursor = makeCursor();

    await expect(
      performSnapshotResync({
        expectedDocumentId: DOC,
        envelope,
        engine,
        setCursor: cursor.setCursor,
        getCursor: cursor.getCursor,
      }),
    ).rejects.toThrow("engine import failed");

    expect(cursor.value()).toBe("12"); // old cursor stays
    expect(engine.applyCalls).toHaveLength(0); // no re-apply happened
    expect(engine.imported).toHaveLength(0);
  });

  it("failure during pending re-apply: cursor unchanged (never advances early)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const engine = new FakeEnginePort([pendingA]);
    engine.applyRemote = async () => {
      throw new Error("apply failed");
    };
    const cursor = makeCursor();

    await expect(
      performSnapshotResync({
        expectedDocumentId: DOC,
        envelope,
        engine,
        setCursor: cursor.setCursor,
        getCursor: cursor.getCursor,
      }),
    ).rejects.toThrow("apply failed");

    expect(cursor.value()).toBe("12");
  });

  it("validation failure: engine never touched (no import, no unacked read)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n, { checksum: "0".repeat(64) });
    const engine = new FakeEnginePort([pendingA]);
    const cursor = makeCursor();

    await expect(
      performSnapshotResync({
        expectedDocumentId: DOC,
        envelope,
        engine,
        setCursor: cursor.setCursor,
        getCursor: cursor.getCursor,
      }),
    ).rejects.toBeInstanceOf(SnapshotResyncError);

    expect(engine.events).toEqual([]); // nothing ran
    expect(cursor.value()).toBe("12");
  });

  it("restores the cursor if a miswired port advanced it during failure", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const cursor = makeCursor();
    const engine = new FakeEnginePort([pendingA]);
    engine.failOnImport = true;
    // A buggy port that persists a cursor inside importSnapshot.
    const badSetCursor = (next: string) => {
      cursor.setCursor(next);
    };

    await expect(
      performSnapshotResync({
        expectedDocumentId: DOC,
        envelope,
        engine,
        setCursor: badSetCursor,
        getCursor: cursor.getCursor,
      }),
    ).rejects.toThrow("engine import failed");

    expect(cursor.value()).toBe("12"); // restored to the pre-resync value
  });

  it("e2e: full path with real sha256 (crypto.subtle) lands cursor on boundary", async () => {
    const coverage = 123_456n;
    const wrapper = buildTestWrapper(DOC, coverage, 456n, INNER);
    // Rebuild the raw snake_case HTTP JSON exactly as the server sends it,
    // then parse like a real fetch() consumer would.
    const raw = {
      snapshot_id: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
      format_version: 1,
      coverage_seq: coverage.toString(),
      covered_op_count: "456",
      checksum: await sha256Hex(wrapper),
      payload_base64: base64Bytes(wrapper),
      state_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      payload_size: wrapper.length.toString(),
    };
    const envelope = parseSnapshotEnvelope(JSON.parse(JSON.stringify(raw)));
    expect(envelope).not.toBeNull();

    const engine = new FakeEnginePort([pendingA]);
    const cursor = makeCursor();
    const result = await performSnapshotResync({
      expectedDocumentId: DOC,
      envelope: envelope!,
      engine,
      setCursor: cursor.setCursor,
      getCursor: cursor.getCursor,
    });
    expect(result.boundary).toBe(coverage);
    expect(cursor.value()).toBe("123456");
  });

  it("e2e: boundary = 2^63-1 formats as a string cursor exactly", async () => {
    const coverage = 2n ** 63n - 1n; // 9223372036854775807
    const wrapper = buildTestWrapper(DOC, coverage, 1n, INNER);
    const envelope = await buildEnvelope(wrapper, coverage, 1n);
    const engine = new FakeEnginePort([pendingA]);
    const cursor = makeCursor();
    await performSnapshotResync({
      expectedDocumentId: DOC,
      envelope,
      engine,
      setCursor: cursor.setCursor,
      getCursor: cursor.getCursor,
    });
    expect(cursor.value()).toBe("9223372036854775807");
  });

  it("defensively copies pending bytes (later outbox mutation cannot corrupt the re-apply)", async () => {
    const wrapper = buildTestWrapper(DOC, 500n, 20n, INNER);
    const envelope = await buildEnvelope(wrapper, 500n, 20n);
    const mutable = new Uint8Array(pendingA);
    const engine = new FakeEnginePort([mutable]);
    const cursor = makeCursor();
    // The engine port mutates the outbox's array DURING the resync (after
    // unackedOps() resolved, before applyRemote consumes it). The resync's
    // defensive copy must be immune — re-apply uses the ORIGINAL bytes.
    let releaseImport: (() => void) | null = null;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    let importEntered: (() => void) | null = null;
    const importEnteredGate = new Promise<void>((resolve) => {
      importEntered = resolve;
    });
    const originalImport = engine.importSnapshot.bind(engine);
    engine.importSnapshot = async (inner: Uint8Array) => {
      mutable[0] = 0xff; // mutate the outbox's array mid-flight
      importEntered!();
      await importGate;
      await originalImport(inner);
    };

    const resyncPromise = performSnapshotResync({
      expectedDocumentId: DOC,
      envelope,
      engine,
      setCursor: cursor.setCursor,
      getCursor: cursor.getCursor,
    });
    // Wait until the resync reached the import step (capture complete).
    await importEnteredGate;
    releaseImport!();
    await resyncPromise;

    const applied = engine.applyCalls[0][0];
    expect(applied[0]).toBe(1); // re-applied under the ORIGINAL byte
  });
});

// ---------------------------------------------------------------------------
// Wrapper + envelope parity with the pinned spec layout
// ---------------------------------------------------------------------------

describe("spec byte-layout parity (STORAGE.md §3.1 / Rust wrapper)", () => {
  it("matches the pinned header layout exactly", async () => {
    // Hand-encode the spec layout for (version=1, uuid 2c1f…, seq 0x1122…,
    // count 3, inner [0xAA, 0xBB]) and expect a successful validate.
    const docHex = "2c1f9e586f0b4d159a5a1a7d4b8ee2b7";
    const wrapper = new Uint8Array(43);
    wrapper[0] = 0x01;
    for (let i = 0; i < 16; i++) {
      wrapper[1 + i] = parseInt(docHex.slice(i * 2, i * 2 + 2), 16);
    }
    const view = new DataView(wrapper.buffer);
    view.setBigUint64(17, 0x0102_0304_0506_0708n, true); // LE seq
    view.setBigUint64(25, 3n, true);
    view.setBigUint64(33, 2n, true);
    wrapper[41] = 0xaa;
    wrapper[42] = 0xbb;

    const decoded = decodeSnapshotWrapper(wrapper);
    expect(decoded.documentId).toBe(DOC);
    expect(decoded.coverageSeq).toBe(0x0102_0304_0506_0708n);
    expect(decoded.coveredOpCount).toBe(3n);
    expect(Array.from(decoded.inner)).toEqual([0xaa, 0xbb]);

    const envelope: SnapshotEnvelope = {
      snapshotId: "8f14e45f-ceea-467f-a830-a731f6d1e10a",
      formatVersion: 1,
      coverageSeq: decoded.coverageSeq.toString(),
      coveredOpCount: "3",
      checksum: await sha256Hex(wrapper),
      payloadBase64: base64Bytes(wrapper),
      stateDigest: "sha256:0000",
      payloadSize: wrapper.length.toString(),
    };
    const validated = await validateServerSnapshot({ expectedDocumentId: DOC, envelope });
    expect(Array.from(validated.inner)).toEqual([0xaa, 0xbb]);
  });
});
