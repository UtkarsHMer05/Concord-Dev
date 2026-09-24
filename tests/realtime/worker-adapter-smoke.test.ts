/**
 * REAL-WORKER ADAPTER SMOKE (D16 — Phase 7 product wiring).
 *
 * The one missing link between the Phase 3/5 E2E suites (fake engine port)
 * and the product: SyncSession driven through the REAL adapter the
 * document page now uses — WorkerEnginePort over a real CrdtWorkerCore
 * (the exact engine code the browser worker runs, WASM included) — against
 * the REAL Rust gateway over real WebSockets.
 *
 * What is real here: the WASM CRDT engine, the worker core request
 * handlers (replicaInfo/localOpsSince/applyRemote/localInsertText), the
 * WorkerEnginePort, SyncSession, the outbox flow, the Rust gateway, its
 * PostgreSQL persistence, ACKs and fanout.
 *
 * What is a Node test stand-in (documented honestly):
 * - The postMessage transport is replaced by direct CrdtWorkerCore.handle
 *   calls (the browser bundle's worker-message layer is exercised by the
 *   vitest worker/bridge suites; the REQUEST semantics are identical).
 * - IndexedDB-backed persistence → the in-memory adapter (same contract;
 *   the IDB adapter is covered by tests/crdt).
 * - IndexedDB PendingOpStore → in-memory store with the identical state
 *   contract (the established realtime-suite convention).
 * - The Clerk JWT → the local test JWKS signer (the gateway's Verifier
 *   path is identical; only the key source differs, as in every realtime
 *   suite).
 *
 * Flow under test (the product path end-to-end):
 *   connect → authenticate → join(REAL replicaInfo summary) → catch-up
 *   → local op via the engine → outbox → client_ops → durable_ack
 *   → second client fanout → applyRemote → convergent engine digests.
 */

import { spawn } from "node:child_process";
import * as net from "node:net";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { identityFromOpBytes } from "@/lib/sync/identities";
import { SyncSession } from "@/lib/sync/sync-session";
import type { PendingOpStore, PendingOpRecord } from "@/lib/sync/pending-store";
import { WorkerEnginePort } from "@/lib/sync/worker-engine-port";
import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { PersistenceAdapter, LocalState } from "@/lib/crdt/worker/idb";
import type { CrdtClient } from "@/lib/crdt/worker/client";

const REPO_ROOT = join(__dirname, "..", "..");
const GATEWAY_BIN = join(REPO_ROOT, "rust", "target", "release", "sync-gateway");
const JWKS_FILE = join(REPO_ROOT, ".agent", "scratch", "phase-3", "e2e-jwks.json");
const KEY_DER = join(REPO_ROOT, ".agent", "scratch", "phase-3", "e2e-key.der");
const WASM_DIR = join(REPO_ROOT, "wasm", "dist");
const DB_URL = process.env.DATABASE_TEST_URL ?? "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER = "https://e2e.clerk.accounts.dev";

const databaseAvailable: Promise<boolean> = (async () => {
  try {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
})();

const binaryAvailable = (async () => {
  try {
    readFileSync(GATEWAY_BIN);
    return true;
  } catch {
    return false;
  }
})();

/** Loads the REAL WASM engine factory (identical to tests/crdt/worker.test.ts). */
async function loadFactory() {
  const source = await readFile(join(WASM_DIR, "concord-crdt.js"), "utf8");
  const binary = await readFile(join(WASM_DIR, "concord-crdt.wasm"));
  const load = new Function(`${source}; return loadConcordCrdt;`)();
  return (await load({
    instantiateWasm(
      info: WebAssembly.Imports,
      receiveInstance: (instance: WebAssembly.Instance) => void,
    ) {
      WebAssembly.instantiate(binary, info).then((r) => receiveInstance(r.instance));
      return {};
    },
  })) as never;
}

async function signToken(sub: string): Promise<string> {
  const { createSign, createPrivateKey } = await import("node:crypto");
  const der = readFileSync(KEY_DER);
  const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "e2e-key-1" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ sub, iss: ISSUER, iat: now, exp: now + 600 }));
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(key)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// ---------------------------------------------------------------------------
// Node stand-ins with byte-identical contracts
// ---------------------------------------------------------------------------

class MemoryPersistence implements PersistenceAdapter {
  snapshots = new Map<string, Uint8Array>();
  logs = new Map<string, { seq: number; op: Uint8Array }[]>();
  cursors = new Map<string, string>();
  async loadLocalState(documentId: string): Promise<LocalState> {
    return {
      snapshot: this.snapshots.get(documentId) ?? null,
      ops: (this.logs.get(documentId) ?? []).map((e) => e.op),
    };
  }
  async appendOps(
    documentId: string,
    ops: Uint8Array[],
    sync?: { cursor: string; coveredOpIds: string[] },
  ): Promise<void> {
    const log = this.logs.get(documentId) ?? [];
    for (const op of ops) log.push({ seq: log.length, op });
    this.logs.set(documentId, log);
    if (sync !== undefined) {
      const current = this.cursors.get(documentId) ?? "0";
      this.cursors.set(documentId, BigInt(sync.cursor) > BigInt(current) ? sync.cursor : current);
    }
  }
  async loadSyncCursor(documentId: string): Promise<string> {
    return this.cursors.get(documentId) ?? "0";
  }
  async saveSyncCursor(documentId: string, cursor: string): Promise<void> {
    const current = this.cursors.get(documentId) ?? "0";
    this.cursors.set(documentId, BigInt(cursor) > BigInt(current) ? cursor : current);
  }
  async saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void> {
    this.snapshots.set(documentId, snapshot);
  }
  async clearDocument(documentId: string): Promise<void> {
    this.logs.delete(documentId);
    this.snapshots.delete(documentId);
    this.cursors.delete(documentId);
  }
}

/** In-memory PendingOpStore (the established realtime-suite seam stand-in). */
class MemPendingStore {
  private rows = new Map<string, { id: string; op: Uint8Array; state: string; seq: number }>();
  constructor(private readonly documentId: string) {}
  async addPending(id: string, op: Uint8Array) {
    this.rows.set(`${this.documentId}:${id}`, {
      id: `${this.documentId}:${id}`,
      op,
      state: "pending",
      seq: this.rows.size,
    });
  }
  async unackedOps(): Promise<PendingOpRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.state !== "durably_acked")
      .map((r) => ({ ...r, state: r.state as PendingOpRecord["state"], savedAt: 0 }));
  }
  async markSent(ids: string[]) {
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r && r.state !== "durably_acked") r.state = "sent";
    }
  }
  async markDurablyAcked(ids: string[]) {
    for (const id of ids) {
      const r = this.rows.get(`${this.documentId}:${id}`);
      if (r) r.state = "durably_acked";
    }
  }
  async clearAcked() {
    return 0;
  }
  close() {}
}

/**
 * CrdtClient-shaped adapter delegating to a real CrdtWorkerCore, including
 * the D16 sync-seam methods. The worker postMessage layer is the only
 * browser-only piece (see file header); the core request handlers are the
 * same code the worker runs. Local ops push to onLocalOps subscribers
 * exactly like the worker's localOps notification.
 */
class RealWorkerClient {
  private nextId = 1;
  private listeners = new Set<(ops: Uint8Array[]) => void>();

  constructor(
    private readonly core: CrdtWorkerCore,
    private readonly documentId: string,
    private readonly replicaId: bigint,
  ) {}

  private notifyLocal(ops: Uint8Array[]): void {
    if (ops.length === 0) return;
    for (const l of this.listeners) l(ops);
  }

  async init(): Promise<void> {
    await this.core.handle({
      id: this.nextId++,
      kind: "init",
      documentId: this.documentId,
      replicaId: this.replicaId.toString(),
    });
  }

  async localInsertText(streamIndex: number, codepoint: number): Promise<Uint8Array[]> {
    const r = await this.core.handle({
      id: this.nextId++,
      kind: "localInsertText",
      streamIndex,
      codepoint,
    });
    const ops = (r as { ops: Uint8Array[] }).ops;
    this.notifyLocal(ops);
    return ops;
  }

  applyRemote(ops: Uint8Array[], cursor?: string): Promise<{ applied: number; duplicates: number }> {
    return this.core.handle({ id: this.nextId++, kind: "applyRemote", ops, cursor }) as Promise<{
      applied: number;
      duplicates: number;
    }>;
  }

  async syncCursor(): Promise<string> {
    const result = await this.core.handle({ id: this.nextId++, kind: "getSyncCursor" });
    return (result as { cursor: string }).cursor;
  }

  async persistSyncCursor(cursor: string): Promise<void> {
    await this.core.handle({ id: this.nextId++, kind: "persistSyncCursor", cursor });
  }

  async localOpsSince(counter: string): Promise<{ ops: Uint8Array[]; nextCounter: string }> {
    const result = await this.core.handle({ id: this.nextId++, kind: "localOpsSince", counter });
    return result as { ops: Uint8Array[]; nextCounter: string };
  }

  async replicaInfo(): Promise<{ replicaId: string; sequence: string }> {
    const r = await this.core.handle({ id: this.nextId++, kind: "replicaInfo" });
    return r as { replicaId: string; sequence: string };
  }

  async visibleJson(): Promise<string> {
    const r = await this.core.handle({ id: this.nextId++, kind: "visibleJson" });
    return (r as { json: string }).json;
  }

  async digest(): Promise<string> {
    const r = await this.core.handle({ id: this.nextId++, kind: "digest" });
    return (r as { digest: string }).digest;
  }

  onLocalOps(handler: (ops: Uint8Array[]) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  gateway: ReturnType<typeof spawn>;
  port: number;
  sql: Client;
  ownerClerk: string;
  documentId: string;
}

let harness: Harness | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  everyMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

beforeAll(async () => {
  if (!(await databaseAvailable) || !(await binaryAvailable)) {
    console.warn("SKIP: concord_test DB, gateway binary, or wasm build unavailable");
    return;
  }
  const sql = new Client({ connectionString: DB_URL });
  await sql.connect();
  const ownerClerk = `user_d16_owner_${Date.now()}`;
  const ownerId = (
    await sql.query("INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id", [ownerClerk])
  ).rows[0].id as string;
  const documentId = (
    await sql.query(
      "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'd16-adapter', '') RETURNING id",
      [ownerId],
    )
  ).rows[0].id as string;

  const port = await freePort();
  const gateway = spawn(GATEWAY_BIN, [], {
    env: {
      ...process.env,
      GATEWAY_DATABASE_URL: DB_URL,
      GATEWAY_CLERK_ISSUER: ISSUER,
      GATEWAY_BIND_PORT: String(port),
      GATEWAY_JWKS_FILE: JWKS_FILE,
      GATEWAY_HEARTBEAT_INTERVAL_SECS: "5",
      GATEWAY_IDLE_TIMEOUT_SECS: "120",
      RUST_LOG: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stderr?.on("data", (d: Buffer) => process.env.E2E_DEBUG && console.error(String(d)));
  gateway.stdout?.on("data", (d: Buffer) => process.env.E2E_DEBUG && console.log(String(d)));
  const ready = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
      return res.ok;
    } catch {
      return false;
    }
  }, 20_000);
  if (!ready) {
    gateway.kill("SIGKILL");
    await sql.end();
    throw new Error("gateway did not become ready");
  }
  harness = { gateway, port, sql, ownerClerk, documentId };
}, 120_000);

afterAll(async () => {
  if (harness) {
    harness.gateway.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    harness.gateway.kill("SIGKILL");
    await harness.sql.query("DELETE FROM crdt_operations WHERE document_id = $1", [
      harness.documentId,
    ]);
    await harness.sql.query("DELETE FROM documents WHERE id = $1", [harness.documentId]);
    await harness.sql.end();
    harness = null;
  }
});

/** A real worker engine + port + session for one "browser tab". */
interface RealTab {
  session: SyncSession;
  client: RealWorkerClient;
  store: MemPendingStore;
  statuses: string[];
  /** Live counter (mutated by the port hook — held by reference). */
  remoteRenders: { count: number };
}

let replicaCounter = 30_000n;

async function makeTab(port: number, clerkId: string, documentId: string): Promise<RealTab> {
  const replicaId = ++replicaCounter;
  const persistence = new MemoryPersistence();
  const core = new CrdtWorkerCore({
    documentId,
    replicaId,
    loadFactory,
    persistence,
  });
  const client = new RealWorkerClient(core, documentId, replicaId);
  await client.init();
  const store = new MemPendingStore(documentId);
  const statuses: string[] = [];
  const remoteRenders = { count: 0 };
  const engine = new WorkerEnginePort({
    client: client as unknown as CrdtClient,
    store: store as unknown as PendingOpStore,
    onRemoteApplied: () => {
      remoteRenders.count += 1;
    },
  });
  let cursor = "0";
  const session = new SyncSession({
    documentId,
    gatewayUrl: `ws://127.0.0.1:${port}/api/v1/sync`,
    getToken: () => signToken(clerkId),
    engine,
    getCursor: () => cursor,
    setCursor: (c) => {
      cursor = c;
    },
    store: store as unknown as PendingOpStore,
    onStatus: (s) => void statuses.push(s),
  });
  return { session, client, store, statuses, remoteRenders };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("real worker-backed adapter through the real gateway (D16)", () => {
  it("connect → join(real summary) → local op → durable ack → peer fanout → converge", async () => {
    if (!harness) return;
    const h = harness;
    const a = await makeTab(h.port, h.ownerClerk, h.documentId);
    const b = await makeTab(h.port, h.ownerClerk, h.documentId);
    // Debug: is the raw WS reachable?

    // Full handshake with the REAL join summary from replicaInfo.
    await a.session.start();
    await b.session.start();
    const bothReady = await waitFor(
      async () => a.session.status === "ready" && b.session.status === "ready",
      20_000,
    );
    expect(bothReady).toBe(true);
    expect(a.statuses).toContain("syncing");
    expect(a.statuses).toContain("ready");

    // ONE local keystroke through the REAL engine (worker localInsertText,
    // durable in the local log; the port subscription feeds the outbox).
    const ops = await a.client.localInsertText(0, 0x61); // 'a'
    expect(ops).toHaveLength(1);
    const identity = identityFromOpBytes(ops[0])!;
    expect(identity.replica).toBeGreaterThan(30_000n);

    // The session flushed it: durable ack transitions the outbox record.
    const acked = await waitFor(
      async () => (await a.store.unackedOps()).length === 0,
      15_000,
    );
    expect(acked).toBe(true);

    // The durable row exists in PostgreSQL (gateway persisted it).
    const rows = await h.sql.query(
      "SELECT operation_id FROM crdt_operations WHERE document_id = $1",
      [h.documentId],
    );
    expect(rows.rows).toHaveLength(1);

    // Peer tab B received the op via fanout, applied it in its REAL engine,
    // and the port fired the remote-render hook (editor re-render signal).
    const converged = await waitFor(async () => b.remoteRenders.count >= 1, 15_000);
    expect(converged).toBe(true);
    const bVisible = JSON.parse(await b.client.visibleJson()) as {
      blocks: { runs: { t: string }[] }[];
    };
    expect(bVisible.blocks[0]?.runs[0]?.t).toBe("a");

    // Both engines hold the same converged state (CRDT digest equality).
    const digestA = await a.client.digest();
    const digestB = await b.client.digest();
    expect(digestA).toBe(digestB);

    // The own-replica summary advanced on A (join-summary contract).
    const info = await a.client.replicaInfo();
    expect(info.sequence).toBe("1");

    await a.session.stop();
    await b.session.stop();
  }, 60_000);

  it("second wave: B types; A applies through fanout; one row per identity", async () => {
    if (!harness) return;
    const h = harness;
    const a = await makeTab(h.port, h.ownerClerk, h.documentId);
    const b = await makeTab(h.port, h.ownerClerk, h.documentId);
    await a.session.start();
    await b.session.start();
    await waitFor(async () => a.session.status === "ready" && b.session.status === "ready", 20_000);

    // B types two characters; A must converge on both.
    await b.client.localInsertText(0, 0x62); // 'b'
    await b.client.localInsertText(1, 0x63); // 'c'
    const acked = await waitFor(
      async () => (await b.store.unackedOps()).length === 0,
      15_000,
    );
    expect(acked).toBe(true);

    const aCaughtUp = await waitFor(async () => a.remoteRenders.count >= 1, 15_000);
    expect(aCaughtUp).toBe(true);
    const digestA = await a.client.digest();
    const digestB = await b.client.digest();
    expect(digestA).toBe(digestB);

    // Exactly 2 durable rows for this wave (document ops total 3 with the
    // previous test's op — beforeEach equivalent: this file's tests share
    // the document sequentially; assert per-identity uniqueness instead).
    const rows = await h.sql.query(
      "SELECT operation_id FROM crdt_operations WHERE document_id = $1",
      [h.documentId],
    );
    const ids = rows.rows.map((r) => r.operation_id);
    expect(new Set(ids).size).toBe(ids.length);

    await a.session.stop();
    await b.session.stop();
  }, 60_000);

  /**
   * P7-M024 staging regression: RAPID MULTI-BURST typing (the browser
   * pattern — real keystrokes produce several back-to-back batches, not
   * the single-op waves above). Observed live on staging: the receiving
   * session's editor rendered the FIRST fanout batch then stalled until a
   * reconnect, even though its worker converges (catch-up on rejoin always
   * renders). This test drives the exact engine/session/transport layers
   * with bursts; if it converges here, the stall is browser-render
   * specific (TipTap), not a sync-layer defect.
   */
  it("rapid multi-burst typing: receiver converges on every batch", async () => {
    if (!harness) return;
    const h = harness;
    const a = await makeTab(h.port, h.ownerClerk, h.documentId);
    const b = await makeTab(h.port, h.ownerClerk, h.documentId);
    await a.session.start();
    await b.session.start();
    await waitFor(async () => a.session.status === "ready" && b.session.status === "ready", 20_000);

    // Burst typing: 4 bursts of multiple insert ops issued back-to-back,
    // no fanout waits between them (real keystroke cadence through the
    // bridge; the outbox batches and flushes asynchronously).
    const bursts = ["burst-one-", "burst-two-", "burst-three-", "burst-four-"];
    let streamIndex = 0;
    for (const burst of bursts) {
      for (const ch of burst) {
        await a.client.localInsertText(streamIndex, ch.charCodeAt(0));
        streamIndex += 1;
      }
    }
    const acked = await waitFor(async () => (await a.store.unackedOps()).length === 0, 20_000);
    expect(acked).toBe(true);

    // Receiver's ENGINE converges on the FULL burst text (digest equality).
    const digestsMatch = await waitFor(async () => {
      const da = await a.client.digest();
      const db = await b.client.digest();
      return da === db;
    }, 20_000);
    expect(digestsMatch).toBe(true);

    // Receiver's visible text contains EVERY burst (not just the first
    // batch — the staging symptom was first-batch-only rendering).
    const visible = JSON.parse(await b.client.visibleJson()) as {
      blocks: { runs: { t: string }[] }[];
    };
    const text = visible.blocks.map((bl) => bl.runs.map((r) => r.t).join("")).join("");
    for (const burst of bursts) {
      expect(text).toContain(burst);
    }

    // And the render hook fired for more than the first batch.
    expect(b.remoteRenders.count).toBeGreaterThanOrEqual(2);

    await a.session.stop();
    await b.session.stop();
  }, 90_000);
});
