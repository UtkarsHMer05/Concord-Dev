// CNCP v2: independently trusted, signed retained history. CNCP v1 remains a
// local content bundle; only v2 can restore a document's retained identities.
import { z } from "zod";
import { ConcordEngine } from "./runtime";
import type { LoadConcordCrdtFactory } from "./wasm-types";
import { MAX_CONCORDPACK_BYTES } from "./concordpack";
import { bytesToHex, concatBytes, hexToBytes, operationLeaf, operationRoot, sha256Bytes } from "./proofs";

const seq = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine((s) => BigInt(s) <= 9223372036854775807n);
const timestamp = seq.refine((s) => BigInt(s) <= 253402300799999n);
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const nullableUuid = uuid.nullable();
const size = z.number().int().min(1).max(MAX_CONCORDPACK_BYTES);
export const trustRecordSchema = z.strictObject({ publicKey: hex, documentId: uuid, seq, baseSnapshotSeq: seq, revisionId: nullableUuid.default(null) });
const manifestSchema = z.strictObject({
  content: z.strictObject({
    format: z.literal("concordpack"), version: z.literal(2), documentId: uuid,
    title: z.string().refine((s) => !!s.trim() && [...s].length <= 200), seq, floorSeq: seq, baseSnapshotSeq: seq,
    stateDigest: digest, root: hex, exportedAtMs: timestamp,
    snapshots: z.array(z.strictObject({ snapshotId: uuid, seq, opCount: seq, stateDigest: digest, bytes: size })).max(500),
    operations: z.array(z.strictObject({ seq, operationId: z.string().max(41), checksum: hex, bytes: size })).max(1_000_000),
    revisions: z.array(z.strictObject({ revisionId: uuid, seq, kind: z.enum(["named", "auto_checkpoint", "restore_event"]),
      label: z.string().nullable(), createdBy: nullableUuid, createdAtMs: timestamp, snapshotId: nullableUuid,
      restoreSourceRevision: nullableUuid, stateDigest: digest.nullable(), })).max(200),
    provenance: z.unknown().nullable(), payloadDigest: hex,
  }),
  publicKey: hex, keyId: z.string().regex(/^[0-9a-f]{16}$/), signature: z.string().regex(/^[0-9a-f]{128}$/),
});
export type TrustRecord = z.infer<typeof trustRecordSchema>;
export type SignedManifest = z.infer<typeof manifestSchema>;
export interface VerifiedSignedPack {
  manifest: SignedManifest;
  trust: TrustRecord;
  archiveChecksum: string;
  visibleContent: unknown;
}
function fail(message: string): never { throw new Error(message); }

function framedManifest(bytes: Uint8Array): { manifest: SignedManifest; offset: number } {
  if (bytes.length < 10 || bytes.length > MAX_CONCORDPACK_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== "CNCP\x02") {
    fail("Choose a signed history archive (Concordpack v2). Local v1 bundles cannot restore history.");
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5, true);
  if (!length || length > 16 * 1024 * 1024 || 9 + length >= bytes.length) fail("Invalid archive manifest length.");
  const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(9, 9 + length));
  const raw: unknown = JSON.parse(json);
  if (JSON.stringify(raw) !== json) fail("Archive manifest is not canonical JSON.");
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) fail("Archive metadata is invalid or unsupported.");
  // Preserve the signed serialization order; validation must not rewrite it.
  return { manifest: raw as SignedManifest, offset: 9 + length };
}
export function readSignedManifest(bytes: Uint8Array): SignedManifest { return framedManifest(bytes).manifest; }
export function parseTrustRecord(json: string): TrustRecord {
  if (new TextEncoder().encode(json).length > 4096) fail("Trusted verification details are too large.");
  const parsed = trustRecordSchema.safeParse(JSON.parse(json));
  if (!parsed.success) fail("Trusted verification details need the full public key, document ID, sequence, snapshot boundary, and optional revision ID.");
  return parsed.data;
}
export function archiveTrust(manifest: SignedManifest): TrustRecord {
  return { publicKey: manifest.publicKey, documentId: manifest.content.documentId, seq: manifest.content.seq,
    baseSnapshotSeq: manifest.content.baseSnapshotSeq, revisionId: null };
}

/** No gateway request: WebCrypto checks trust and WASM reconstructs each state. */
export async function verifySignedConcordPack(bytes: Uint8Array, trust: TrustRecord, loadFactory: LoadConcordCrdtFactory): Promise<VerifiedSignedPack> {
  trust = trustRecordSchema.parse(trust);
  const { manifest, offset } = framedManifest(bytes);
  const c = manifest.content;
  if (manifest.publicKey !== trust.publicKey || c.documentId !== trust.documentId || c.seq !== trust.seq || c.baseSnapshotSeq !== trust.baseSnapshotSeq) {
    fail("The archive does not match the trusted key, document, or expected sequence and snapshot boundary.");
  }
  if (trust.revisionId && !c.revisions.some((r) => r.revisionId === trust.revisionId && r.stateDigest)) fail("The expected revision is not retained in this archive.");
  const publicBytes = hexToBytes(trust.publicKey);
  if (bytesToHex(await sha256Bytes(publicBytes)).slice(0, 16) !== manifest.keyId) fail("Signing key ID is invalid.");
  const key = await crypto.subtle.importKey("raw", publicBytes.slice().buffer as ArrayBuffer, "Ed25519", false, ["verify"]);
  const message = concatBytes(new TextEncoder().encode("Concordpack signed history v2\0"), await sha256Bytes(new TextEncoder().encode(JSON.stringify(c))));
  if (!await crypto.subtle.verify("Ed25519", key, hexToBytes(manifest.signature).slice().buffer as ArrayBuffer, message.slice().buffer as ArrayBuffer)) fail("The trusted signing key did not sign this archive.");
  if (bytesToHex(await sha256Bytes(bytes.subarray(offset))) !== c.payloadDigest) fail("Archive payload checksum failed. The file was altered or damaged.");
  let cursor = offset;
  const take = (length: number) => {
    if (cursor + length > bytes.length) fail("Archive payload length is invalid.");
    const part = bytes.slice(cursor, cursor + length); cursor += length; return part;
  };
  const snapshots = c.snapshots.map((s) => take(s.bytes));
  const operations = c.operations.map((o) => take(o.bytes));
  if (cursor !== bytes.length) fail("Archive has trailing payload bytes.");
  const floor = BigInt(c.floorSeq); const end = BigInt(c.seq);
  if (floor > end || c.baseSnapshotSeq !== c.floorSeq || (floor > 0n && !c.snapshots.some((s) => s.seq === c.floorSeq))) fail("Archive snapshot boundary is invalid.");
  let previous = 0n; const opIds = new Set<string>(); const leaves: Uint8Array[] = [];
  for (let i = 0; i < operations.length; i++) {
    const op = c.operations[i]; const payload = operations[i]; const boundary = BigInt(op.seq);
    if (payload.length < 18 || payload[0] !== 1) fail("Archive contains an invalid operation.");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const replica = view.getBigUint64(2, true); const counter = view.getBigUint64(10, true);
    if (!replica || !counter || counter > 9223372036854775807n || `${replica}:${counter}` !== op.operationId || opIds.has(op.operationId) ||
      boundary <= previous || boundary <= floor || boundary > end || bytesToHex(await sha256Bytes(payload)) !== op.checksum) fail("Archive operation log does not match its signed identities and checksums.");
    opIds.add(op.operationId); previous = boundary;
    leaves.push(await operationLeaf(op.seq, op.operationId, op.checksum));
  }
  if (end !== (previous > floor ? previous : floor) || await operationRoot(leaves) !== c.root) fail("Archive operation boundary or Merkle root is invalid.");
  if (new Set(c.snapshots.map((s) => s.snapshotId)).size !== snapshots.length || new Set(c.revisions.map((r) => r.revisionId)).size !== c.revisions.length) fail("Archive contains duplicate history identities.");
  let lastSnapshot = -1n;
  for (const s of c.snapshots) {
    if (BigInt(s.seq) < lastSnapshot || BigInt(s.seq) > end) fail("Snapshot sequence is invalid.");
    lastSnapshot = BigInt(s.seq);
  }
  for (const r of c.revisions) {
    if (BigInt(r.seq) > end || (r.kind === "named" && (!r.label?.trim() || [...r.label].length > 200))) fail("Revision metadata is invalid.");
  }
  const inputs = (boundary: string) => {
    if (boundary === "0") return { snapshot: null, ops: [] };
    const belowFloor = BigInt(boundary) < floor;
    let index = -1;
    for (let i = 0; i < c.snapshots.length; i++) if (c.snapshots[i].seq === (belowFloor ? boundary : c.floorSeq) && (belowFloor || floor > 0n)) index = i;
    if (belowFloor && index < 0) return null;
    const start = index < 0 ? 0n : BigInt(c.snapshots[index].seq);
    return { snapshot: index < 0 ? null : snapshots[index], ops: operations.filter((_, i) => BigInt(c.operations[i].seq) > start && BigInt(c.operations[i].seq) <= BigInt(boundary)) };
  };
  const states = new Map<string, { digest: string; visible: unknown }>();
  const state = async (boundary: string) => {
    const cached = states.get(boundary); if (cached) return cached;
    const source = inputs(boundary); if (!source) fail("This revision's state has been pruned.");
    const engine = source.snapshot ? await ConcordEngine.importFromSnapshot(1n, source.snapshot, loadFactory) : await ConcordEngine.create(1n, loadFactory);
    try {
      for (const op of source.ops) engine.applyRemote(op);
      const result = { digest: engine.digest(), visible: JSON.parse(engine.visibleJson()) as unknown };
      states.set(boundary, result); return result;
    } finally { engine.free(); }
  };
  for (let i = 0; i < snapshots.length; i++) {
    const meta = c.snapshots[i]; const engine = await ConcordEngine.importFromSnapshot(1n, snapshots[i], loadFactory);
    try { if (engine.digest() !== meta.stateDigest) fail("Snapshot CRDT digest failed."); } finally { engine.free(); }
    if ((BigInt(meta.seq) >= floor || meta.seq === "0") && (await state(meta.seq)).digest !== meta.stateDigest) fail("Snapshot does not match retained history.");
  }
  for (const r of c.revisions) {
    if (r.stateDigest === null) { if (inputs(r.seq)) fail("Revision is incorrectly marked as pruned."); }
    else if ((await state(r.seq)).digest !== r.stateDigest) fail("Retained revision CRDT digest failed.");
  }
  const head = await state(c.seq);
  if (head.digest !== c.stateDigest) fail("Document CRDT digest failed.");
  return { manifest, trust, visibleContent: head.visible, archiveChecksum: bytesToHex(await sha256Bytes(bytes)) };
}
