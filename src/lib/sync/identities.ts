/**
 * Stable operation identity helpers shared by the sync layer.
 *
 * Phase 2 operation identity is (ReplicaId, Counter) — u64s. On the wire
 * (and in the durable log + ACKs) it renders as the decimal string
 * "replica:counter" (u64-safe for JS, mirrors Rust `OpIdentity::to_wire`).
 */

export type OpIdentityString = string;

export interface ParsedIdentity {
  replica: bigint;
  counter: bigint;
}

/** Parses "replica:counter"; returns null on malformed input. */
export function parseOpIdentity(s: OpIdentityString): ParsedIdentity | null {
  const parts = s.split(":");
  if (parts.length !== 2) {
    return null;
  }
  try {
    const replica = BigInt(parts[0]);
    const counter = BigInt(parts[1]);
    if (replica <= 0n || counter <= 0n) {
      return null;
    }
    return { replica, counter };
  } catch {
    return null;
  }
}

/** Formats (replica, counter) as the wire identity string. */
export function formatOpIdentity(replica: bigint | number, counter: bigint | number): OpIdentityString {
  return `${replica.toString()}:${counter.toString()}`;
}

/**
 * Extracts the identity from canonical Phase 2 operation bytes:
 * header = [version u8][type u8][replica u64 LE][counter u64 LE]...
 * (mirror of the Rust envelope extractor; structural only — no CRDT
 * semantics here).
 */
export function identityFromOpBytes(op: Uint8Array): ParsedIdentity | null {
  if (op.length < 18) {
    return null;
  }
  if (op[0] !== 1) {
    return null; // unsupported op version
  }
  const view = new DataView(op.buffer, op.byteOffset, op.byteLength);
  const replica = view.getBigUint64(2, true);
  const counter = view.getBigUint64(10, true);
  if (replica <= 0n || counter <= 0n) {
    return null;
  }
  return { replica, counter };
}
