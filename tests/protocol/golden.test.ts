/**
 * Cross-language golden fixture parity (P3-M012).
 *
 * The committed fixtures (fixtures/protocol/v1/golden.json) are generated
 * by the RUST codec (cargo test regenerate_golden -- --ignored). This suite
 * proves the TypeScript mirror is byte-exact against them:
 *   1. every text fixture round-trips through encode(decode(x)) === x,
 *   2. the TS encoder produces the identical wire text from the decoded
 *      payload,
 *   3. binary fixtures decode to the same ops/identities and re-encode to
 *      the identical hex,
 *   4. error codes and fatal flags match.
 *
 * A failure here means Rust and TypeScript have drifted — never edit only
 * one side. Intentional changes: bump the wire protocol version and
 * regenerate fixtures in the same commit (see golden.rs module docs).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decodeControlFrame,
  decodeDataFrame,
  encodeClientOps,
  encodeControlFrame,
  FATAL_ERROR_CODES,
  ProtocolDecodeError,
  type ControlFrameType,
} from "@/lib/sync/protocol";

interface TextFixture {
  name: string;
  wire: string;
}

interface BinaryFixture {
  name: string;
  hex: string;
  identities: string[];
}

interface ErrorFixture {
  name: string;
  code: string;
  fatal: boolean;
}

interface EnvelopeFixture {
  name: string;
  op_hex: string;
  identity: string;
}

interface FixtureFile {
  wire_version: number;
  text_frames: TextFixture[];
  binary_frames: BinaryFixture[];
  error_codes: ErrorFixture[];
  op_envelopes: EnvelopeFixture[];
}

const fixtures: FixtureFile = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/protocol/v1/golden.json"), "utf-8"),
);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("golden fixture parity (Rust ⇄ TypeScript)", () => {
  it("fixture file matches the implemented wire version", () => {
    expect(fixtures.wire_version).toBe(1);
    expect(fixtures.text_frames.length).toBe(13);
    expect(fixtures.binary_frames.length).toBe(2);
    expect(fixtures.error_codes.length).toBe(11);
    expect(fixtures.op_envelopes.length).toBe(3);
  });

  for (const fixture of fixtures.text_frames) {
    it(`text frame '${fixture.name}' decodes and re-encodes byte-exactly`, () => {
      const decoded = decodeControlFrame(fixture.wire);
      const reEncoded = encodeControlFrame({
        id: decoded.id,
        type: decoded.type,
        payload: decoded.payload,
      });
      expect(reEncoded).toBe(fixture.wire);
      // Payload shape checks are already enforced by strict decode; prove
      // key order too by exact string equality above.
      expect(decoded.type).toBe(fixture.name as ControlFrameType);
    });
  }

  it("all 13 control frame types are covered by fixtures", () => {
    const names = fixtures.text_frames.map((f) => f.name).sort();
    const expected = [
      "authenticated",
      "authenticate",
      "durable_ack",
      "error",
      "hello",
      "hello_ack",
      "join_accepted",
      "join_document",
      "ping",
      "pong",
      "server_draining",
      "sync_done",
      "sync_request",
    ].sort();
    expect(names).toEqual(expected);
  });

  it("client_ops binary fixture decodes to the identical ops and re-encodes to the identical hex", () => {
    const fixture = fixtures.binary_frames.find((f) => f.name === "client_ops");
    expect(fixture).toBeDefined();
    const decoded = decodeDataFrame(hexToBytes(fixture!.hex));
    expect(decoded.kind).toBe("client_ops");
    const frame = decoded.frame as { batchId: number; ops: Uint8Array[] };
    expect(frame.batchId).toBe(42);
    expect(frame.ops.length).toBe(3);
    const reEncoded = encodeClientOps({
      batchId: frame.batchId,
      ops: frame.ops.map((o) => new Uint8Array(o)),
    });
    expect(bytesToHex(reEncoded)).toBe(fixture!.hex);
  });

  it("sync_batch binary fixture decodes with the documented header fields", () => {
    const fixture = fixtures.binary_frames.find((f) => f.name === "sync_batch");
    expect(fixture).toBeDefined();
    const decoded = decodeDataFrame(hexToBytes(fixture!.hex));
    expect(decoded.kind).toBe("sync_batch");
    const frame = decoded.frame as { nextCursor: number; hasMore: boolean; ops: Uint8Array[] };
    expect(frame.nextCursor).toBe(99);
    expect(frame.hasMore).toBe(true);
    expect(frame.ops.length).toBe(3);
  });

  it("client_ops identities fixture matches the documented op envelopes", () => {
    const clientOps = fixtures.binary_frames.find((f) => f.name === "client_ops")!;
    const decoded = decodeDataFrame(hexToBytes(clientOps.hex));
    const frame = decoded.frame as { ops: Uint8Array[] };
    // The identity strings in the fixture come from the Rust envelope
    // validator; TS must at minimum preserve the exact op bytes so the
    // gateway can extract the same identities.
    for (let i = 0; i < frame.ops.length; i++) {
      const envelope = fixtures.op_envelopes[i];
      expect(bytesToHex(frame.ops[i])).toBe(envelope.op_hex);
    }
    expect(clientOps.identities).toEqual(["212:17", "212:18", "226:5"]);
  });

  it("error codes and fatal flags match the Rust mirror", () => {
    for (const code of fixtures.error_codes) {
      expect(FATAL_ERROR_CODES.has(code.code as never)).toBe(code.fatal);
    }
  });

  it("TS decode rejects the same hostile inputs Rust rejects", () => {
    expect(() => decodeControlFrame("not json")).toThrow(ProtocolDecodeError);
    expect(() => decodeControlFrame('{"type":"hello","payload":{}}')).toThrow(ProtocolDecodeError);
    expect(() => decodeControlFrame('{"v":2,"type":"hello","payload":{"clientProtocolVersion":1}}')).toThrow(
      /unsupported/i,
    );
    expect(() => decodeControlFrame('{"v":1,"type":"h4x0r","payload":{}}')).toThrow(/unknown frame type/);
    expect(() =>
      decodeControlFrame('{"v":1,"type":"hello","payload":{"clientProtocolVersion":1,"x":2}}'),
    ).toThrow(/unexpected field/);
    expect(() =>
      decodeControlFrame('{"v":1,"type":"hello","payload":{"clientProtocolVersion":1},"extra":1}'),
    ).toThrow(/extra envelope/);
    // Truncated binary frames.
    expect(() => decodeDataFrame(new Uint8Array([1]))).toThrow(ProtocolDecodeError);
    expect(() => decodeDataFrame(new Uint8Array([9, 0x20]))).toThrow(/unsupported/i);
    expect(() => decodeDataFrame(new Uint8Array([1, 0x7f]))).toThrow(/unknown binary kind/);
  });
});
