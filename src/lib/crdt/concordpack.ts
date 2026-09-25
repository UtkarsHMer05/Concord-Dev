// Portable, integrity-checked Concord document bundles. Checksums detect
// corruption; without a server signature they do not attest who exported it.
import { ConcordEngine } from "./runtime";
import type { LoadConcordCrdtFactory } from "./wasm-types";

const MAGIC = new Uint8Array([0x43, 0x4e, 0x43, 0x50]); // "CNCP"
const VERSION = 1;
const HEADER_BYTES = 9;
const MAX_MANIFEST_BYTES = 4096;
export const MAX_CONCORDPACK_BYTES = 64 * 1024 * 1024;
const MAX_OP_BYTES = 8 * 1024 * 1024;
const MAX_OP_COUNT = 1_000_000;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface ConcordPackState {
  snapshot: Uint8Array;
  /** Complete locally retained operation log; duplicates in the snapshot are expected. */
  ops: Uint8Array[];
  stateDigest: string;
}

export interface ConcordPackClient {
  exportSnapshot(): Promise<Uint8Array>;
  exportOps(): Promise<Uint8Array[]>;
  digest(): Promise<string>;
}

export class ConcordPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcordPackError";
  }
}

function fail(message: string): never {
  throw new ConcordPackError(message);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) fail("Web Crypto SHA-256 is unavailable");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = new Uint8Array(await subtle.digest("SHA-256", buffer));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validateState(state: ConcordPackState): void {
  if (!(state.snapshot instanceof Uint8Array) || state.snapshot.length === 0) {
    fail("bundle snapshot is missing");
  }
  if (!Array.isArray(state.ops) || state.ops.length > MAX_OP_COUNT) {
    fail("bundle operation count is invalid");
  }
  if (!DIGEST_RE.test(state.stateDigest)) fail("bundle state digest is invalid");
  let opsBytes = 0;
  for (const op of state.ops) {
    if (!(op instanceof Uint8Array) || op.length === 0 || op.length > MAX_OP_BYTES) {
      fail("bundle contains an invalid operation");
    }
    opsBytes += op.length;
  }
  const payloadBytes = 4 + state.snapshot.length + 4 + state.ops.length * 4 + opsBytes;
  if (payloadBytes + HEADER_BYTES + MAX_MANIFEST_BYTES > MAX_CONCORDPACK_BYTES) {
    fail("bundle exceeds the 64 MiB size limit");
  }
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** Encode a bounded v1 bundle. Call verifyConcordPackState before exporting user data. */
export async function encodeConcordPack(state: ConcordPackState): Promise<Uint8Array> {
  validateState(state);
  const opsBytes = state.ops.reduce((sum, op) => sum + op.length, 0);
  const payload = new Uint8Array(4 + state.snapshot.length + 4 + state.ops.length * 4 + opsBytes);
  const view = new DataView(payload.buffer);
  let offset = 0;
  writeU32(view, offset, state.snapshot.length);
  offset += 4;
  payload.set(state.snapshot, offset);
  offset += state.snapshot.length;
  writeU32(view, offset, state.ops.length);
  offset += 4;
  for (const op of state.ops) {
    writeU32(view, offset, op.length);
    offset += 4;
    payload.set(op, offset);
    offset += op.length;
  }

  const manifest = new TextEncoder().encode(JSON.stringify({
    format: "concordpack",
    version: VERSION,
    snapshotBytes: state.snapshot.length,
    opCount: state.ops.length,
    opsBytes,
    stateDigest: state.stateDigest,
    payloadDigest: await sha256(payload),
  }));
  if (manifest.length > MAX_MANIFEST_BYTES) fail("bundle manifest is too large");
  const pack = new Uint8Array(HEADER_BYTES + manifest.length + payload.length);
  pack.set(MAGIC);
  pack[4] = VERSION;
  const packView = new DataView(pack.buffer);
  writeU32(packView, 5, manifest.length);
  pack.set(manifest, HEADER_BYTES);
  pack.set(payload, HEADER_BYTES + manifest.length);
  if (pack.length > MAX_CONCORDPACK_BYTES) fail("bundle exceeds the 64 MiB size limit");
  return pack;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and checksum-check a pack. Unknown fields, truncation, and trailing bytes fail closed. */
export async function decodeConcordPack(input: Uint8Array): Promise<ConcordPackState> {
  if (!(input instanceof Uint8Array) || input.length < HEADER_BYTES || input.length > MAX_CONCORDPACK_BYTES) {
    fail("bundle size is invalid");
  }
  if (!MAGIC.every((byte, index) => input[index] === byte)) fail("bundle magic is invalid");
  if (input[4] !== VERSION) fail("unsupported bundle version");
  const manifestLength = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(5, true);
  if (manifestLength === 0 || manifestLength > MAX_MANIFEST_BYTES || HEADER_BYTES + manifestLength >= input.length) {
    fail("bundle manifest length is invalid");
  }

  let manifest: unknown;
  let manifestText = "";
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(HEADER_BYTES, HEADER_BYTES + manifestLength));
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    fail("bundle manifest is malformed");
  }
  if (!isRecord(manifest)) fail("bundle manifest is malformed");
  const expectedKeys = ["format", "version", "snapshotBytes", "opCount", "opsBytes", "stateDigest", "payloadDigest"];
  if (Object.keys(manifest).length !== expectedKeys.length || expectedKeys.some((key) => !(key in manifest))) {
    fail("bundle manifest fields are invalid");
  }
  const { format, version, snapshotBytes, opCount, opsBytes, stateDigest, payloadDigest } = manifest;
  if (format !== "concordpack" || version !== VERSION) fail("unsupported bundle format");
  if (!Number.isSafeInteger(snapshotBytes) || (snapshotBytes as number) <= 0 ||
      !Number.isSafeInteger(opCount) || (opCount as number) < 0 || (opCount as number) > MAX_OP_COUNT ||
      !Number.isSafeInteger(opsBytes) || (opsBytes as number) < 0 ||
      typeof stateDigest !== "string" || !DIGEST_RE.test(stateDigest) ||
      typeof payloadDigest !== "string" || !DIGEST_RE.test(payloadDigest)) {
    fail("bundle manifest values are invalid");
  }
  if (manifestText !== JSON.stringify({ format, version, snapshotBytes, opCount, opsBytes, stateDigest, payloadDigest })) {
    fail("bundle manifest is not canonical");
  }

  const payloadOffset = HEADER_BYTES + manifestLength;
  const payload = input.subarray(payloadOffset);
  if (await sha256(payload) !== payloadDigest) fail("bundle payload checksum mismatch");
  if (payload.length < 8) fail("bundle payload is truncated");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const encodedSnapshotBytes = view.getUint32(offset, true);
  offset += 4;
  if (encodedSnapshotBytes !== snapshotBytes || offset + encodedSnapshotBytes + 4 > payload.length) {
    fail("bundle snapshot length is incomplete");
  }
  const snapshot = payload.slice(offset, offset + encodedSnapshotBytes);
  offset += encodedSnapshotBytes;
  const encodedOpCount = view.getUint32(offset, true);
  offset += 4;
  if (encodedOpCount !== opCount) fail("bundle operation count is incomplete");

  const ops: Uint8Array[] = [];
  let actualOpsBytes = 0;
  for (let index = 0; index < encodedOpCount; index++) {
    if (offset + 4 > payload.length) fail("bundle operation list is truncated");
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length === 0 || length > MAX_OP_BYTES || offset + length > payload.length) {
      fail("bundle operation is truncated or too large");
    }
    ops.push(payload.slice(offset, offset + length));
    actualOpsBytes += length;
    offset += length;
  }
  if (offset !== payload.length || actualOpsBytes !== opsBytes) fail("bundle payload lengths do not match the manifest");
  return { snapshot, ops, stateDigest };
}

/** Reconstruct a temporary engine first, so bad semantic digests never touch the target. */
export async function verifyConcordPackState(
  state: ConcordPackState,
  loadFactory: LoadConcordCrdtFactory,
): Promise<void> {
  await reconstructVerifiedState(state, loadFactory);
}

async function reconstructVerifiedState(
  state: ConcordPackState,
  loadFactory: LoadConcordCrdtFactory,
): Promise<string> {
  validateState(state);
  let engine: ConcordEngine | null = null;
  try {
    engine = await ConcordEngine.importFromSnapshot(1n, state.snapshot, loadFactory);
    for (const op of state.ops) engine.applyRemote(op);
    if (engine.digest() !== state.stateDigest) fail("bundle CRDT state digest mismatch");
    return engine.visibleJson();
  } finally {
    engine?.free();
  }
}

/** Check a file's framing, checksum, operation stream, and state digest, then expose its read-only visible preview. */
export async function previewConcordPack(
  input: Uint8Array,
  loadFactory: LoadConcordCrdtFactory,
): Promise<{ state: ConcordPackState; visibleJson: string }> {
  const state = await decodeConcordPack(input);
  const visibleJson = await reconstructVerifiedState(state, loadFactory);
  return { state, visibleJson };
}

/** Capture, verify, then serialize the worker's snapshot and durable op log. */
export async function exportConcordPack(
  client: Pick<ConcordPackClient, "exportSnapshot" | "exportOps" | "digest">,
  loadFactory: LoadConcordCrdtFactory,
): Promise<Uint8Array> {
  const state = {
    snapshot: await client.exportSnapshot(),
    ops: await client.exportOps(),
    stateDigest: await client.digest(),
  };
  await verifyConcordPackState(state, loadFactory);
  return encodeConcordPack(state);
}
