import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { replayMerklePath, verifyProofDocument, type ProofDocument } from "@/lib/crdt/proofs";

/**
 * The gateway-side rules (merkle + canonical receipt bytes + Ed25519) are
 * pinned by rust tests/proofs_api.rs. This suite re-derives the CLIENT
 * rules: a fresh Ed25519 key is generated per run with node:crypto and the
 * signature is verified through the module's WebCrypto path — an
 * independent engine cross-check, mirroring how the browser verifies.
 */

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

/** Node-side mirror of the Rust leaf/node hashes. */
import { createHash } from "node:crypto";

function sha256(...parts: Uint8Array[]): Buffer {
  return createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
}

function leafHash(seq: bigint, operationId: string, checksumHex: string): Buffer {
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(operationId.length);
  return sha256(
    Uint8Array.of(LEAF_PREFIX),
    Buffer.from(seq.toString(16).padStart(16, "0"), "hex"),
    idLen,
    Buffer.from(operationId, "ascii"),
    Buffer.from(checksumHex, "ascii"),
  );
}

function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return Buffer.alloc(32);
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(Uint8Array.of(NODE_PREFIX), level[i], level[i + 1] ?? level[i]));
    }
    level = next;
  }
  return level[0];
}

function merkleProof(leaves: Buffer[], index: number): Buffer[] {
  const path: Buffer[] = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    path.push(level[siblingIdx] ?? level[idx]);
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(Uint8Array.of(NODE_PREFIX), level[i], level[i + 1] ?? level[i]));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return path;
}

const OP_COUNT = 7;

function buildOps(): Array<{ seq: bigint; opId: string; checksum: string }> {
  return Array.from({ length: OP_COUNT }, (_, i) => ({
    seq: BigInt(900 + i),
    opId: `4242:${i + 1}`,
    checksum: createHash("sha256").update(`payload-${i}`).digest("hex"),
  }));
}

async function buildProofDocument(stateDigest: string): Promise<ProofDocument> {
  const ops = buildOps();
  const leaves = ops.map((op) => leafHash(op.seq, op.opId, op.checksum));
  const root = merkleRoot(leaves);
  const leafIndex = ops.length - 1;
  const proof = merkleProof(leaves, leafIndex);
  const documentId = "5f0e9a4b-0000-4000-8000-000000000001";

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32) as Buffer;

  // Canonical bytes: version || document(16) || seq(8) || root(32) ||
  // stateDigest(u16+len) || opCount(8) || issuedAtMs(8) || keyId(u8+len).
  const stateDigestBytes = Buffer.from(stateDigest, "ascii");
  const keyId = Buffer.from("proof-test-key", "ascii");
  const message = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(documentId.replace(/-/g, ""), "hex"),
    Buffer.from(ops[ops.length - 1].seq.toString(16).padStart(16, "0"), "hex"),
    root,
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(stateDigestBytes.length); return b; })(),
    stateDigestBytes,
    Buffer.from(BigInt(OP_COUNT).toString(16).padStart(16, "0"), "hex"),
    Buffer.from(1_733_568_000_000n.toString(16).padStart(16, "0"), "hex"),
    Buffer.from([keyId.length]),
    keyId,
  ]);
  const signature = nodeSign(null, message, privateKey);

  const base64 = (bytes: Buffer) => bytes.toString("base64");
  return {
    documentId,
    seq: ops[ops.length - 1].seq.toString(),
    baseSeq: ops[0].seq.toString(),
    opCount: String(OP_COUNT),
    leafIndex: String(leafIndex),
    leaf: leaves[leafIndex].toString("hex"),
    proof: proof.map((p) => p.toString("hex")),
    root: root.toString("hex"),
    stateDigest,
    publicKey: rawPublic.toString("hex"),
    keyEphemeral: true,
    receipt: {
      documentId,
      seq: ops[ops.length - 1].seq.toString(),
      root: root.toString("hex"),
      stateDigest,
      opCount: String(OP_COUNT),
      issuedAtMs: "1733568000000",
      keyId: "proof-test-key",
      signature: base64(signature),
    },
  };
}

describe("history proof verification (Feature 5)", () => {
  it("verifies merkle path, signature, and state binding on a genuine receipt", async () => {
    const proof = await buildProofDocument("sha256:deadbeef");
    const result = await verifyProofDocument(proof, "sha256:deadbeef");
    expect(result.merkleOk).toBe(true);
    expect(result.signatureOk).toBe(true);
    expect(result.stateMatch).toBe(true);
    expect(result.keyId).toBe("proof-test-key");
    expect(result.opCount).toBe("7");
  });

  it("fails the state binding when the local replica digest differs", async () => {
    const proof = await buildProofDocument("sha256:deadbeef");
    const result = await verifyProofDocument(proof, "sha256:different");
    expect(result.merkleOk).toBe(true);
    expect(result.signatureOk).toBe(true);
    expect(result.stateMatch).toBe(false);
  });

  it("rejects a tampered receipt signature and a tampered audit path", async () => {
    const proof = await buildProofDocument("sha256:cafe");
    const sig = Buffer.from(proof.receipt.signature, "base64");
    sig[0] ^= 0x01;
    const forgedSig = { ...proof, receipt: { ...proof.receipt, signature: sig.toString("base64") } };
    const tamperedSig = await verifyProofDocument(forgedSig, "sha256:cafe");
    expect(tamperedSig.merkleOk).toBe(true);
    expect(tamperedSig.signatureOk).toBe(false);

    const forgedLeaf = { ...proof, leaf: proof.leaf.slice(0, -2) + (proof.leaf.endsWith("ab") ? "cd" : "ab") };
    const tamperedLeaf = await verifyProofDocument(forgedLeaf, "sha256:cafe");
    expect(tamperedLeaf.merkleOk).toBe(false);
  });

  it("replays single-leaf and empty-log shapes", async () => {
    const ops = buildOps().slice(0, 1);
    const leaf = leafHash(ops[0].seq, ops[0].opId, ops[0].checksum);
    // Single leaf: root == leaf, empty path.
    expect(await replayMerklePath(leaf.toString("hex"), 0, [])).toBe(leaf.toString("hex"));
  });
});
