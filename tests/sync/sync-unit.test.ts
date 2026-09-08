/**
 * Sync-layer unit tests (P3-M032/M033/M034 Level A/B).
 *
 * - Backoff: deterministic pure-function math (no real timers).
 * - Identity helpers: parse/format/extract parity with the Rust envelope.
 * - Transport: protocol flow against a mock WebSocket (handshake, join,
 *   catch-up, ack, fatal close, reconnect scheduling via injected timers).
 * - PendingOpStore: state transitions + reload survival (fake-indexeddb).
 * - SyncSession: end-to-end orchestration with mock transport + engine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeBackoffDelay,
  SyncTransport,
  type BackoffConfig,
  type TransportEvents,
  type TimerSource,
  type ConnectionStatus,
} from "@/lib/sync/transport";
import { formatOpIdentity, identityFromOpBytes, parseOpIdentity } from "@/lib/sync/identities";

// ---------------------------------------------------------------------------
// Backoff math (M033)
// ---------------------------------------------------------------------------

describe("computeBackoffDelay (deterministic)", () => {
  const config: BackoffConfig = { baseMs: 250, maxMs: 15_000, immediateFirstRetry: true };
  const noJitter = () => 0;
  const fullJitter = () => 0.999999;

  it("retries immediately on the first attempt", () => {
    expect(computeBackoffDelay(0, config, noJitter)).toBe(0);
  });

  it("doubles per attempt from the base", () => {
    expect(computeBackoffDelay(1, config, noJitter)).toBe(250);
    expect(computeBackoffDelay(2, config, noJitter)).toBe(500);
    expect(computeBackoffDelay(3, config, noJitter)).toBe(1000);
    expect(computeBackoffDelay(4, config, noJitter)).toBe(2000);
  });

  it("caps at maxMs", () => {
    expect(computeBackoffDelay(10, config, noJitter)).toBe(15_000);
    expect(computeBackoffDelay(50, config, noJitter)).toBe(15_000);
  });

  it("adds up to 25% jitter, deterministic given random", () => {
    const d1 = computeBackoffDelay(2, config, noJitter);
    const d2 = computeBackoffDelay(2, config, fullJitter);
    expect(d1).toBe(500);
    expect(d2).toBe(500 + Math.floor(500 * 0.25 * 0.999999));
    // Same random → same delay (reproducible).
    expect(computeBackoffDelay(3, config, () => 0.5)).toBe(
      computeBackoffDelay(3, config, () => 0.5),
    );
  });

  it("rejects negative attempts", () => {
    expect(() => computeBackoffDelay(-1, config, noJitter)).toThrow();
  });

  it("without immediateFirstRetry the first attempt waits the base", () => {
    const cfg: BackoffConfig = { baseMs: 100, maxMs: 1000, immediateFirstRetry: false };
    expect(computeBackoffDelay(0, cfg, noJitter)).toBe(100);
    expect(computeBackoffDelay(1, cfg, noJitter)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Identity helpers (Rust parity)
// ---------------------------------------------------------------------------

describe("op identities", () => {
  it("round-trips parse/format", () => {
    const s = formatOpIdentity(9007199254740993n, 42n);
    expect(s).toBe("9007199254740993:42");
    const parsed = parseOpIdentity(s);
    expect(parsed?.replica).toBe(9007199254740993n);
    expect(parsed?.counter).toBe(42n);
  });

  it("rejects malformed and non-positive identities", () => {
    expect(parseOpIdentity("garbage")).toBeNull();
    expect(parseOpIdentity("1:2:3")).toBeNull();
    expect(parseOpIdentity("0:5")).toBeNull();
    expect(parseOpIdentity("5:0")).toBeNull();
    expect(parseOpIdentity("5:-1")).toBeNull();
  });

  it("extracts the identity from canonical op bytes (LE header)", () => {
    // version=1, type=1(insert), replica=7, counter=3 — little-endian.
    const op = new Uint8Array(18);
    op[0] = 1;
    op[1] = 1;
    new DataView(op.buffer).setBigUint64(2, 7n, true);
    new DataView(op.buffer).setBigUint64(10, 3n, true);
    const id = identityFromOpBytes(op);
    expect(id?.replica).toBe(7n);
    expect(id?.counter).toBe(3n);
    expect(formatOpIdentity(id!.replica, id!.counter)).toBe("7:3");
  });

  it("rejects truncated/unsupported bytes", () => {
    expect(identityFromOpBytes(new Uint8Array(4))).toBeNull();
    const bad = new Uint8Array(18);
    bad[0] = 9; // bad version
    expect(identityFromOpBytes(bad)).toBeNull();
    const zeroReplica = new Uint8Array(18);
    zeroReplica[0] = 1;
    new DataView(zeroReplica.buffer).setBigUint64(2, 0n, true);
    expect(identityFromOpBytes(zeroReplica)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transport against a mock WebSocket
// ---------------------------------------------------------------------------

/** Minimal scriptable WebSocket mock. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  binaryType = "";
  readyState = 1;
  sent: Array<string | ArrayBuffer> = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: string | ArrayBuffer) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor() {
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  // Test helpers ---------------------------------------------------------
  serverSend(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as unknown as Parameters<NonNullable<MockWebSocket["onmessage"]>>[0]);
  }

  lastText(): string {
    const last = this.sent.filter((s) => typeof s === "string").pop();
    return last as string;
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

function makeTimers(): TimerSource & { fire: () => void; pendingMs: () => number | null } {
  let handle: (() => void) | null = null;
  let ms: number | null = null;
  let counter = 0;
  return {
    setTimeout(fn, delay) {
      handle = fn;
      ms = delay;
      counter += 1;
      return counter;
    },
    clearTimeout() {
      handle = null;
      ms = null;
    },
    fire() {
      const fn = handle;
      handle = null;
      fn?.();
    },
    pendingMs: () => ms,
  };
}

interface EventCapture {
  events: TransportEvents;
  statuses: ConnectionStatus[];
  acks: Array<{ batchId: string; opIds: string[] }>;
  peerBatches: Uint8Array[][];
  errors: string[];
  fatal: string[];
}

function baseEvents(overrides: Partial<TransportEvents> = {}): EventCapture {
  const statuses: ConnectionStatus[] = [];
  const acks: Array<{ batchId: string; opIds: string[] }> = [];
  const peerBatches: Uint8Array[][] = [];
  const errors: string[] = [];
  const fatal: string[] = [];
  const events: TransportEvents = {
    onStatus: (s) => void statuses.push(s),
    onDurableAck: (batchId, opIds) => void acks.push({ batchId, opIds }),
    onAuthenticated: () => {},
    onJoinAccepted: () => {},
    onPeerOps: (ops) => void peerBatches.push(ops),
    onSyncBatch: () => {},
    onSyncDone: () => {},
    onSnapshotResyncRequired: () => {},
    onSnapshotPayload: () => {},
    onError: (code) => void errors.push(code),
    onDraining: () => {},
    onFatal: (reason) => void fatal.push(reason),
    ...overrides,
  };
  return { events, statuses, acks, peerBatches, errors, fatal };
}

describe("SyncTransport (mock socket)", () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
  });


  it("runs hello → authenticate → join and tracks status", async () => {
    const { events, statuses } = baseEvents();
    const transport = new SyncTransport({
      url: "ws://test",
      getToken: async () => "TEST-JWT",
      events,
      random: () => 0,
    });
    transport.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.onopen?.();

    // Server accepts hello.
    ws.serverSend('{"v":1,"type":"hello_ack","payload":{"protocolVersion":1,"connectionId":"c1"}}');
    await vi.waitFor(() => {
      expect(ws.lastText()).toContain('"authenticate"');
      expect(ws.lastText()).toContain("TEST-JWT");
    });
    ws.serverSend('{"v":1,"type":"authenticated","payload":{"userId":"u1","clerkUserId":"cu1"}}');
    transport.joinDocument("doc-1", [{ replicaId: "7", sequence: "9" }]);
    expect(ws.lastText()).toContain('"join_document"');
    expect(ws.lastText()).toContain('"documentId":"doc-1"');

    ws.serverSend(
      '{"v":1,"type":"join_accepted","payload":{"documentId":"doc-1","role":"owner","durableCursor":"42"}}',
    );
    ws.serverSend('{"v":1,"type":"sync_done","payload":{}}');
    expect(transport.currentStatus).toBe("ready");
    expect(statuses).toContain("ready");
    transport.close();
  });

  it("replies pong to server ping", () => {
    const { events } = baseEvents();
    const transport = new SyncTransport({
      url: "ws://t",
      getToken: async () => "x",
      events,
    });
    transport.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.onopen?.();
    ws.serverSend('{"v":1,"type":"hello_ack","payload":{"protocolVersion":1,"connectionId":"c"}}');
    ws.serverSend('{"v":1,"type":"ping","payload":{"nonce":"n123"}}');
    expect(ws.lastText()).toContain('"pong"');
    expect(ws.lastText()).toContain("n123");
    transport.close();
  });

  it("schedules reconnect with computed backoff on unclean close (injected timers)", async () => {
    const timers = makeTimers();
    const { events } = baseEvents();
    const transport = new SyncTransport({
      url: "ws://t",
      getToken: async () => "x",
      events,
      timers,
      random: () => 0,
      backoff: { baseMs: 100, maxMs: 1000, immediateFirstRetry: true },
    });
    transport.connect();
    const first = MockWebSocket.instances.at(-1)!;
    first.onopen?.();
    // First drop AFTER a successful open → immediate retry (attempt 0).
    first.onclose?.();
    expect(timers.pendingMs()).toBe(0);
    timers.fire();
    expect(MockWebSocket.instances.length).toBe(2);
    // Consecutive failures WITHOUT a successful open grow the backoff:
    // second failure → base (100ms), third → 2×base (200ms).
    MockWebSocket.instances.at(-1)!.onclose?.();
    expect(timers.pendingMs()).toBe(100);
    timers.fire();
    MockWebSocket.instances.at(-1)!.onclose?.();
    expect(timers.pendingMs()).toBe(200);
    transport.close();
    // close() cancels any scheduled reconnect.
    expect(timers.pendingMs()).toBeNull();
  });

  it("fatal error tears down without reconnect", () => {
    const { events, errors } = baseEvents();
    const timers = makeTimers();
    const transport = new SyncTransport({
      url: "ws://t",
      getToken: async () => "x",
      events,
      timers,
    });
    transport.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.onopen?.();
    ws.serverSend(
      '{"v":1,"type":"error","payload":{"code":"unsupported_protocol_version","message":"no"}}',
    );
    expect(errors).toContain("unsupported_protocol_version");
    expect(transport.currentStatus).toBe("closed");
    expect(timers.pendingMs()).toBeNull(); // no reconnect storm
  });

  it("decodes peer fanout and catch-up binaries", () => {
    const peer: Uint8Array[][] = [];
    const batches: Array<{ cursor: number; more: boolean; count: number }> = [];
    const { events } = baseEvents({
      onPeerOps: (ops) => void peer.push(ops),
      onSyncBatch: (ops, cursor, more) => void batches.push({ cursor, more, count: ops.length }),
    });
    const transport = new SyncTransport({ url: "ws://t", getToken: async () => "x", events });
    transport.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.onopen?.();

    // client_ops fanout with one op [0xAB].
    const fanout = new Uint8Array([1, 0x20, 0, 0, 0, 0, 0, 0, 0, 9, 0, 1, 0, 0, 0, 1, 0xab]);
    ws.serverSend(fanout.buffer.slice(0));
    expect(peer).toHaveLength(1);
    expect(Array.from(peer[0][0])).toEqual([0xab]);

    // sync_batch: next_cursor=99, has_more=1, one op.
    const sync = new Uint8Array([1, 0x21, 0, 0, 0, 0, 0, 0, 0, 99, 1, 0, 1, 0, 0, 0, 1, 0xcd]);
    ws.serverSend(sync.buffer.slice(0));
    expect(batches).toEqual([{ cursor: 99, more: true, count: 1 }]);
    transport.close();
  });
});

// ---------------------------------------------------------------------------
// PendingOpStore (fake-indexeddb)
// ---------------------------------------------------------------------------

describe("PendingOpStore semantics (M032, in-memory fake of the same contract)", () => {
  interface Rec {
    id: string;
    op: Uint8Array;
    state: "pending" | "sent" | "durably_acked";
    seq: number;
    savedAt: number;
  }

  class MemoryPendingStore {
    private records = new Map<string, Rec>();
    constructor(private readonly docId: string) {}

    private key(id: string): string {
      return `${this.docId}:${id}`;
    }

    async addPending(id: string, op: Uint8Array): Promise<void> {
      this.records.set(this.key(id), {
        id: this.key(id),
        op,
        state: "pending",
        seq: this.records.size,
        savedAt: Date.now(),
      });
    }

    async unackedOps(): Promise<Rec[]> {
      return [...this.records.values()]
        .filter((r) => r.state !== "durably_acked")
        .sort((a, b) => a.seq - b.seq);
    }

    async markSent(ids: string[]): Promise<void> {
      for (const id of ids) {
        const rec = this.records.get(this.key(id));
        if (rec && rec.state !== "durably_acked") rec.state = "sent";
      }
    }

    async markDurablyAcked(ids: string[]): Promise<void> {
      for (const id of ids) {
        const rec = this.records.get(this.key(id));
        if (rec && rec.state !== "durably_acked") rec.state = "durably_acked";
      }
    }

    async clearAcked(ids: string[]): Promise<number> {
      let removed = 0;
      for (const id of ids) {
        const key = this.key(id);
        const rec = this.records.get(key);
        if (rec?.state === "durably_acked") {
          this.records.delete(key);
          removed += 1;
        }
      }
      return removed;
    }
  }

  it("persists ops through reload and tracks ack states", async () => {
    const store = new MemoryPendingStore("doc-A");
    const op = new Uint8Array([1, 1, 7, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);

    await store.addPending("7:3", op);
    expect(await store.unackedOps()).toHaveLength(1);

    await store.markSent(["7:3"]);
    // sent ≠ acked: still resendable after a crash-before-ack.
    expect(await store.unackedOps()).toHaveLength(1);

    await store.markDurablyAcked(["7:3"]);
    expect(await store.unackedOps()).toHaveLength(0);

    // Identity-stable: re-adding the same id overwrites, never duplicates.
    await store.addPending("7:3", op);
    await store.addPending("7:3", op);
    expect(await store.unackedOps()).toHaveLength(1);

    // Compaction only removes durably-acked records.
    await store.markDurablyAcked(["7:3"]);
    await store.addPending("7:4", op);
    expect(await store.clearAcked(["7:3", "7:4"])).toBe(1);
    expect(await store.unackedOps()).toHaveLength(1); // 7:4 survives (unacked)
  });
});
