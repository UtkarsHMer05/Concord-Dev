/**
 * Client-verifiable history proofs (Feature 5) — TS mirror of
 * `rust/sync-gateway/src/maintenance/proofs.rs`, byte-for-byte.
 *
 * What a verified receipt proves, honestly:
 *  1. merkle: the audit path binds the advertised leaf to the advertised
 *     root (SHA-256, domain-separated, duplicate-last for odd levels);
 *  2. signature: an Ed25519 key signs the canonical bytes
 *     `version || document || seq || root || stateDigest || opCount ||
 *     issuedAtMs || keyId` — length-prefixed framing, not JSON;
 *  3. state: the caller compares `receipt.stateDigest` with its OWN replica
 *     digest — equality means "the gateway durably committed exactly the
 *     content this replica converged to, at exactly this sequence".
 *
 * Trust note: the verifying public key rides the same response. Verifying
 * against it detects gateway-side tampering/replay, but third-party
 * verifiability requires obtaining the key out of band (or pinning `keyId`).
 * `keyEphemeral: true` means the gateway had no pinned signing key — the
 * receipt still verifies but cannot outlive the process.
 */

import type { CrdtClient } from "@/lib/crdt/worker/client";

export interface ProofDocument {
  documentId: string;
  seq: string;
  baseSeq: string;
  opCount: string;
  leafIndex: string;
  leaf: string;
  proof: string[];
  root: string;
  stateDigest: string;
  publicKey: string;
  keyEphemeral: boolean;
  receipt: {
    documentId: string;
    seq: string;
    root: string;
    stateDigest: string;
    opCount: string;
    issuedAtMs: string;
    keyId: string;
    signature: string;
  };
}

export interface ProofVerification {
  merkleOk: boolean;
  signatureOk: boolean;
  stateMatch: boolean;
  keyId: string;
  keyEphemeral: boolean;
  seq: string;
  opCount: string;
}

const NODE_PREFIX = 0x01;
const RECEIPT_VERSION = 1;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16be(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function u64be(value: string | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("invalid hex encoding");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64StdDecode(input: string): Uint8Array {
  const normalized = input.replace(/=+$/, "");
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = new Uint8Array(Math.floor((normalized.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let length = 0;
  for (const char of normalized) {
    const value = table.indexOf(char);
    if (value < 0) throw new Error("invalid base64 encoding");
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (acc >> bits) & 0xff;
    }
  }
  return out.slice(0, length);
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = hexToBytes(hex);
  if (bytes.length !== 16) throw new Error("invalid document id");
  return bytes;
}

/** One internal-node step (mirror of Rust `node_hash`). */
async function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(Uint8Array.of(NODE_PREFIX), left, right));
}

/** Replays an audit path from a leaf to the root (mirror of `replay_path`). */
export async function replayMerklePath(
  leafHex: string,
  index: number,
  proofHex: string[],
): Promise<string> {
  let current = hexToBytes(leafHex);
  let idx = index;
  for (const siblingHex of proofHex) {
    const sibling = hexToBytes(siblingHex);
    current = idx % 2 === 0 ? await nodeHash(current, sibling) : await nodeHash(sibling, current);
    idx = Math.floor(idx / 2);
  }
  return bytesToHex(current);
}

/** Canonical signed bytes (mirror of Rust `receipt_message`). */
function receiptMessage(receipt: ProofDocument["receipt"]): Uint8Array {
  const document = uuidToBytes(receipt.documentId);
  const root = hexToBytes(receipt.root);
  const stateDigest = new TextEncoder().encode(receipt.stateDigest);
  const keyId = new TextEncoder().encode(receipt.keyId);
  if (keyId.length > 255) throw new Error("key id too long");
  return concat(
    Uint8Array.of(RECEIPT_VERSION),
    document,
    u64be(receipt.seq),
    root,
    u16be(stateDigest.length),
    stateDigest,
    u64be(receipt.opCount),
    u64be(receipt.issuedAtMs),
    Uint8Array.of(keyId.length),
    keyId,
  );
}

/**
 * Verifies a gateway proof document end to end. `localDigest` is the
 * caller's own replica digest (same canonical form as `stateDigest`) — the
 * content-binding check. Throws on malformed input, returns structured
 * pass/fail otherwise.
 */
export async function verifyProofDocument(
  proof: ProofDocument,
  localDigest: string,
): Promise<ProofVerification> {
  const { receipt } = proof;

  // 1. Merkle: audit path reaches BOTH the body root and the receipt root.
  const leafIndex = Number(proof.leafIndex);
  if (!Number.isInteger(leafIndex) || leafIndex < 0) {
    throw new Error("invalid leaf index");
  }
  const replayed = await replayMerklePath(proof.leaf, leafIndex, proof.proof);
  const merkleOk =
    replayed === proof.root.toLowerCase() &&
    replayed === receipt.root.toLowerCase() &&
    (proof.opCount === "0" ? proof.root === "0".repeat(64) : proof.leaf.length === 64);

  // 2. Signature: Ed25519 over the canonical bytes. WebCrypto Ed25519 is
  // baseline in current browsers/Node; an unsupported engine reports
  // signatureOk=false (the UI shows the honest failure, not a fake pass).
  const message = receiptMessage(receipt);
  const signature = base64StdDecode(receipt.signature);
  const publicKey = hexToBytes(proof.publicKey);
  let signatureOk = false;
  if (signature.length === 64 && publicKey.length === 32) {
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        publicKey.slice().buffer as ArrayBuffer,
        "Ed25519",
        true,
        ["verify"],
      );
      signatureOk = await crypto.subtle.verify(
        "Ed25519",
        key,
        signature.slice().buffer as ArrayBuffer,
        message.buffer as ArrayBuffer,
      );
    } catch {
      signatureOk = false;
    }
  }

  // 3. State binding: the caller's own replica digest.
  const stateMatch = localDigest === receipt.stateDigest;

  return {
    merkleOk,
    signatureOk,
    stateMatch,
    keyId: receipt.keyId,
    keyEphemeral: proof.keyEphemeral,
    seq: receipt.seq,
    opCount: receipt.opCount,
  };
}

/**
 * Convenience flow for the Concordpack panel: fold the caller's durable log
 * to its digest, fetch the gateway proof, and verify. `fetchProof` handles
 * auth + transport (the panel's `gatewayRequest`).
 */
export async function verifyAgainstGateway(
  client: CrdtClient,
  fetchProof: () => Promise<ProofDocument>,
): Promise<ProofVerification> {
  const localDigest = await client.digest();
  const proof = await fetchProof();
  return verifyProofDocument(proof, localDigest);
}
