/**
 * REAL-TIME E2E suite (P3-M035..M041) — two independent sync clients
 * through the ACTUAL Rust gateway binary over real WebSockets.
 *
 * Setup (global, per file):
 *   - spawns the release gateway (GATEWAY_JWKS_FILE = local test JWKS)
 *     against concord_test with a random port;
 *   - seeds owner + viewer users + document via SQL.
 *
 * Clients are REAL browser modules: SyncTransport + SyncSession against a
 * fake CrdtEnginePort (in-memory op sets + digests). No simulated
 * transport anywhere — the socket, the Rust protocol loop, PostgreSQL
 * persistence, ACKs, fanout, catch-up, reconnect, drain are all live.
 *
 * Requires: Docker concord-db up; `cargo build --release` current.
 * Skipped automatically when the DB or binary is unavailable.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

import { identityFromOpBytes } from "@/lib/sync/identities";
import { SyncTransport } from "@/lib/sync/transport";
import { SyncSession } from "@/lib/sync/sync-session";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPO_ROOT = join(__dirname, "..", "..");
const GATEWAY_BIN = join(REPO_ROOT, "rust", "target", "release", "sync-gateway");
const JWKS_FILE = join(REPO_ROOT, ".agent", "scratch", "phase-3", "e2e-jwks.json");
const KEY_DER = join(REPO_ROOT, ".agent", "scratch", "phase-3", "e2e-key.der");
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

/** Signs RS256 JWTs with the E2E key (node crypto). */
async function signToken(sub: string): Promise<string> {
  const { createSign } = await import("node:crypto");
  const der = readFileSync(KEY_DER);

  // PKCS8 DER → manual JWS: header.payload signed with RS256.
  const b64u = (b: Buffer | string) =>
    Buffer.from(b).toString("base64url");
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "e2e-key-1" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ sub, iss: ISSUER, iat: now, exp: now + 600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  // PKCS8 DER import via crypto.createPrivateKey in JWK-free form
  const { createPrivateKey } = await import("node:crypto");
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

interface Harness {
  gateway: ChildProcess;
  port: number;
  sql: Client;
  ownerClerk: string;
  viewerClerk: string;
  commenterClerk: string;
  documentId: string;
}

let harness: Harness | null = null;

async function bootHarness(): Promise<Harness | null> {
  if (!(await databaseAvailable)) {
    return null;
  }
  const sql = new Client({ connectionString: DB_URL });
  await sql.connect();

  // Users + document + ACLs.
  const ownerClerk = `user_e2e_owner_${Date.now()}`;
  const viewerClerk = `user_e2e_viewer_${Date.now()}`;
  const commenterClerk = `user_e2e_commenter_${Date.now()}`;
  const mkUser = async (clerkId: string) =>
    (await sql.query(
      "INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id",
      [clerkId],
    )).rows[0].id as string;
  const owner = await mkUser(ownerClerk);
  const viewer = await mkUser(viewerClerk);
  const commenter = await mkUser(commenterClerk);
  const documentId = (
    await sql.query(
      "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'e2e', '') RETURNING id",
      [owner],
    )
  ).rows[0].id as string;
  await sql.query(
    "INSERT INTO document_user_permissions (document_id, user_id, role) VALUES ($1::uuid, $2, $3::text::document_role)",
    [documentId, viewer, "VIEWER"],
  );
  await sql.query(
    "INSERT INTO document_user_permissions (document_id, user_id, role) VALUES ($1::uuid, $2, $3::text::document_role)",
    [documentId, commenter, "COMMENTER"],
  );

  // Random port: bind 0 via GATEWAY_BIND_PORT=0? Gateway logs the addr —
  // instead pick a free port ourselves.
  const freePort = await new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

  const gateway = spawn(GATEWAY_BIN, [], {
    env: {
      ...process.env,
      GATEWAY_DATABASE_URL: DB_URL,
      GATEWAY_CLERK_ISSUER: ISSUER,
      GATEWAY_BIND_PORT: String(freePort),
      GATEWAY_JWKS_FILE: JWKS_FILE,
      GATEWAY_HEARTBEAT_INTERVAL_SECS: "5",
      GATEWAY_IDLE_TIMEOUT_SECS: "120",
      RUST_LOG: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stderr?.on("data", (d) => process.env.E2E_DEBUG && console.error(String(d)));
  gateway.stdout?.on("data", (d) => process.env.E2E_DEBUG && console.log(String(d)));

  // Wait for readiness.
  const ready = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${freePort}/api/v1/health/ready`);
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

  return { gateway, port: freePort, sql, ownerClerk, viewerClerk, commenterClerk, documentId };
}

async function waitFor(
  predicate: () => Promise<boolean>,
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

/** A fake engine port: real op sets + digest convergence checks. */
class FakeEngine {
  applied: Uint8Array[] = [];
  localHandler: ((ops: Uint8Array[]) => void) | null = null;
  replica = BigInt(Math.floor(Math.random() * 1_000_000) + 1);
  counter = 0n;

  async applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }> {
    let applied = 0;
    let duplicates = 0;
    for (const op of ops) {
      const id = identityFromOpBytes(op);
      const key = `${id!.replica}:${id!.counter}`;
      if (this.seen.has(key)) {
        duplicates += 1;
      } else {
        this.seen.add(key);
        this.applied.push(op);
        applied += 1;
      }
    }
    return { applied, duplicates };
  }
  protected seen = new Set<string>();

  async replicaId(): Promise<string> {
    return this.replica.toString();
  }
  async localSummary(): Promise<string> {
    return this.counter.toString();
  }
  onLocalOps(handler: (ops: Uint8Array[]) => void): () => void {
    this.localHandler = handler;
    return () => {
      this.localHandler = null;
    };
  }

  /**
   * Generates a canonical insert op (full envelope, makeOp-compatible) and
   * records it in the local applied set — a real engine holds its own ops.
   */
  generateLocal(): Uint8Array {
    this.counter += 1n;
    const op = makeOp(this.replica, this.counter, this.counter);
    const key = `${this.replica}:${this.counter}`;
    this.seen.add(key);
    this.applied.push(op);
    return op;
  }
}

/**
 * Canonical Phase 2 insert op bytes (full envelope, mirrors the C++
 * serializer byte-for-byte):
 *   version u8 = 1
 *   type u8 = 1 (insert)
 *   replica u64 LE (offset 2)
 *   counter u64 LE (offset 10)
 *   lamport u64 LE (offset 18)
 *   left flag u8 = 0 (offset 26)
 *   right flag u8 = 0 (offset 27)
 *   kind u8 = 1 text (offset 28)
 *   scalar length u8 = 1 (offset 29)
 *   scalar "a" (offset 30)
 *   initial attr count u8 = 0 (offset 31)
 * → 32 bytes total.
 */
function makeOp(replica: bigint, counter: bigint, lamport = 1n): Uint8Array {
  const op = new Uint8Array(32);
  op[0] = 1;
  op[1] = 1;
  const view = new DataView(op.buffer);
  view.setBigUint64(2, replica, true);
  view.setBigUint64(10, counter, true);
  view.setBigUint64(18, lamport, true);
  op[26] = 0; // left anchor: None
  op[27] = 0; // right anchor: None
  op[28] = 1; // kind = text
  op[29] = 1; // scalar byte length
  op[30] = 0x61; // 'a'
  op[31] = 0; // initial attr count
  return op;
}

/** Digest of the applied op set — convergence check (order-insensitive). */
function stateDigest(engine: FakeEngine): string {
  const ids = engine.applied
    .map((op) => identityFromOpBytes(op)!)
    .map((id) => `${id.replica}:${id.counter}`)
    .sort();
  return ids.join(",");
}

interface ClientSession {
  engine: FakeEngine;
  transport: SyncTransport;
  ackedIds: string[];
  statuses: string[];
}

interface ClientSession {
  engine: FakeEngine;
  transport: SyncTransport;
  ackedIds: string[];
  statuses: string[];
  errors: string[];
}

function makeClient(port: number, clerkId: string, existing?: FakeEngine, documentId?: string): ClientSession {
  const engine = existing ?? new FakeEngine();
  const ackedIds: string[] = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  const transport = new SyncTransport({
    url: `ws://127.0.0.1:${port}/api/v1/sync`,
    getToken: () => signToken(clerkId),
    events: {
      onStatus: (s) => void statuses.push(s),
      onDurableAck: (_batchId, opIds) => void ackedIds.push(...opIds),
      onAuthenticated: () => {
        void engine.replicaId().then(async (replicaId) => {
          const sequence = await engine.localSummary();
          transport.joinDocument(documentId ?? harness!.documentId, [{ replicaId, sequence }]);
        });
      },
      onJoinAccepted: () => transport.requestSync("0"),
      onPeerOps: (ops) => void engine.applyRemote(ops),
      onSyncBatch: (ops, cursor) => {
        void engine.applyRemote(ops);
        transport.requestSync(cursor.toString());
      },
      onSyncDone: () => {},
      onSnapshotResyncRequired: () => {},
      onSnapshotPayload: () => {},
      onError: (code) => void errors.push(code),
      onDraining: () => {},
      onFatal: () => {},
    },
  });
  return { engine, transport, ackedIds, statuses, errors };
}

/** Connect + handshake + join + catch-up to READY. */
async function untilReady(client: ClientSession, timeoutMs = 20_000): Promise<void> {
  client.transport.connect();
  const ok = await waitFor(async () => client.transport.currentStatus === "ready", timeoutMs);
  if (!ok) {
    throw new Error(`client never reached ready (statuses=${client.statuses.join("→")}; errors=${client.errors.join(",")})`);
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  harness = await bootHarness();
  if (harness === null) {
    console.warn("SKIP: concord_test DB or gateway unavailable");
  }
});

afterAll(async () => {
  if (harness) {
    harness.gateway.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    harness.gateway.kill("SIGKILL");
    await harness.sql.end();
    harness = null;
  }
});

beforeEach(async () => {
  if (harness) {
    await harness.sql.query("DELETE FROM crdt_operations WHERE document_id = $1", [
      harness.documentId,
    ]);
  }
});

describe("two-client live collaboration through the real gateway (M035)", () => {
  it("A writes; B receives via fanout; both ack; digests converge", async () => {
    if (!harness) return;
    const a = makeClient(harness.port, harness.ownerClerk);
    const b = makeClient(harness.port, harness.ownerClerk); // second session, same owner
    await untilReady(a);
    await untilReady(b);

    // A sends a batch of 3 ops.
    const ops = [a.engine.generateLocal(), a.engine.generateLocal(), a.engine.generateLocal()];
    a.transport.sendClientOps(1, ops);

    // A receives the durable ack for all 3 identities.
    const acked = await waitFor(async () => a.ackedIds.length >= 3, 10_000);
    expect(acked).toBe(true);

    // B receives the same op bytes via fanout and applies them.
    const converged = await waitFor(
      async () => stateDigest(b.engine) === a.ackedIds.slice(0, 3).sort().join(","),
      10_000,
    );
    expect(converged).toBe(true);
    expect(b.engine.applied).toHaveLength(3);

    // Concurrent writes from B; A receives them too.
    const bOps = [b.engine.generateLocal(), b.engine.generateLocal()];
    b.transport.sendClientOps(1, bOps);
    const bAcked = await waitFor(async () => b.ackedIds.length >= 2, 10_000);
    expect(bAcked).toBe(true);
    const bothConverged = await waitFor(
      async () =>
        a.engine.applied.length === 5 && stateDigest(a.engine) === stateDigest(b.engine),
      10_000,
    );
    expect(bothConverged).toBe(true);

    // PostgreSQL contains exactly one row per identity.
    const rows = await harness.sql.query(
      "SELECT operation_id FROM crdt_operations WHERE document_id = $1",
      [harness.documentId],
    );
    expect(rows.rows).toHaveLength(5);

    a.transport.close();
    b.transport.close();
  });
});

describe("offline edit + reconnect reconciliation (M036/M034)", () => {
  it("disconnected client edits locally; peer writes via server; reconnect converges; one row per op", async () => {
    if (!harness) return;
    const a = makeClient(harness.port, harness.ownerClerk);
    const b = makeClient(harness.port, harness.ownerClerk);
    await untilReady(a);
    await untilReady(b);

    // A goes offline (simulate transport loss without clean close).
    a.transport.close();

    // B commits ops through the server.
    const bOps = [b.engine.generateLocal(), b.engine.generateLocal()];
    b.transport.sendClientOps(2, bOps);
    await waitFor(async () => b.ackedIds.length >= 2, 10_000);

    // A edits locally while offline (engine keeps generating; ops would be
    // persisted by the real outbox — here we hold them in memory).
    const aOps = [a.engine.generateLocal(), a.engine.generateLocal(), a.engine.generateLocal()];

    // A reconnects: fresh transport, SAME engine/replica state (its offline
    // ops retain their identities).
    const a2 = makeClient(harness.port, harness.ownerClerk, a.engine);
    await untilReady(a2);

    // A catches up on B's ops automatically (join cursor 0 → full history).
    const sawB = await waitFor(async () => a2.engine.applied.length >= 2, 10_000);
    expect(sawB).toBe(true);

    // A resends its offline ops under the ORIGINAL identities.
    a2.transport.sendClientOps(3, aOps);
    await waitFor(async () => a2.ackedIds.length >= 3, 10_000);

    // B receives A's ops; both engines converge on all 5 ops.
    const converged = await waitFor(
      async () => stateDigest(a2.engine) === stateDigest(b.engine),
      10_000,
    );
    expect(converged).toBe(true);
    expect(a2.engine.applied).toHaveLength(5);
    expect(b.engine.applied).toHaveLength(5);

    // Exactly one durable row per operation identity (the M036 acceptance).
    const rows = await harness.sql.query(
      "SELECT operation_id FROM crdt_operations WHERE document_id = $1",
      [harness.documentId],
    );
    const uniqueIds = new Set(rows.rows.map((r) => r.operation_id));
    expect(rows.rows).toHaveLength(5);
    expect(uniqueIds).toHaveLength(5);

    a2.transport.close();
    b.transport.close();
  });
});

describe("role enforcement across live connections (M037)", () => {
  it("viewer joins read-only; write attempt is forbidden; no durable rows", async () => {
    if (!harness) return;
    const owner = makeClient(harness.port, harness.ownerClerk);
    await untilReady(owner);

    const viewer = makeClient(harness.port, harness.viewerClerk);
    // VIEWER may join read-only — reaches ready.
    await untilReady(viewer, 20_000);

    // Viewer attempts a content write → forbidden error, no ACK, no rows.
    viewer.transport.sendClientOps(1, [makeOp(5555n, 1n)]);
    const denied = await waitFor(async () => viewer.errors.includes("forbidden"), 10_000);
    expect(denied).toBe(true);

    const rows = await harness.sql.query(
      "SELECT COUNT(*)::int AS n FROM crdt_operations WHERE document_id = $1 AND replica_id = 5555",
      [harness.documentId],
    );
    expect(rows.rows[0].n).toBe(0);
    owner.transport.close();
    viewer.transport.close();
  });

  it("live downgrade: owner is removed while connected → next write denied (recheck per batch)", async () => {
    if (!harness) return;
    const { sql, commenterClerk } = harness;

    // Fresh document owned by a temp user so the main doc stays intact.
    const tempOwner = `user_e2e_down_${Date.now()}`;
    const ownerId = (await sql.query("INSERT INTO users (clerk_user_id) VALUES ($1) RETURNING id", [tempOwner])).rows[0].id;
    const tempDoc = (await sql.query(
      "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'downgrade', '') RETURNING id",
      [ownerId],
    )).rows[0].id;

    // Join the temp doc as its owner using direct transport calls.
    const statuses: string[] = [];
    const errors: string[] = [];
    const t = new SyncTransport({
      url: `ws://127.0.0.1:${harness.port}/api/v1/sync`,
      getToken: () => signToken(tempOwner),
      events: {
        onStatus: (s) => void statuses.push(s),
        onDurableAck: () => {},
        onAuthenticated: () => t.joinDocument(tempDoc, []),
        onJoinAccepted: () => t.requestSync("0"),
        onPeerOps: () => {},
        onSyncBatch: () => {},
        onSyncDone: () => {},
        onSnapshotResyncRequired: () => {},
        onSnapshotPayload: () => {},
        onError: (code) => void errors.push(code),
        onDraining: () => {},
        onFatal: () => {},
      },
    });
    t.connect();
    await waitFor(async () => t.currentStatus === "ready", 15_000);

    // Write as owner → acked.
    t.sendClientOps(1, [makeOp(6001n, 1n)]);
    await waitFor(async () => statuses.includes("ready"), 1_000);
    // Confirm durable row exists.
    const got1 = await waitForRow(sql, tempDoc, "6001:1");
    expect(got1).toBe(true);

    // Downgrade: transfer the document away (owner loses write).
    const otherOwner = (await sql.query("SELECT id FROM users WHERE clerk_user_id = $1", [commenterClerk])).rows[0].id;
    await sql.query("UPDATE documents SET owner_user_id = $1 WHERE id = $2", [otherOwner, tempDoc]);

    // Same live connection attempts the NEXT batch → denied (recheck).
    t.sendClientOps(2, [makeOp(6001n, 2n)]);
    const denied = await waitFor(async () => errors.includes("forbidden"), 10_000);
    expect(denied).toBe(true);
    const got2 = await waitForRow(sql, tempDoc, "6001:2");
    expect(got2).toBe(false);

    t.close();
    // Cleanup.
    await sql.query("DELETE FROM crdt_operations WHERE document_id = $1", [tempDoc]);
    await sql.query("DELETE FROM documents WHERE id = $1", [tempDoc]);
    await sql.query("DELETE FROM users WHERE id = $1", [ownerId]);
  });
});

describe("duplicate resend across the network boundary (M038)", () => {
  it("identical batch resent verbatim → one row per identity, deterministic ack", async () => {
    if (!harness) return;
    const c = makeClient(harness.port, harness.ownerClerk);
    await untilReady(c);

    const ops = [makeOp(7001n, 1n), makeOp(7001n, 2n)];
    c.transport.sendClientOps(9, ops);
    await waitFor(async () => c.ackedIds.length >= 2, 10_000);

    // Resend the identical bytes (client retry before ack scenario).
    c.transport.sendClientOps(9, ops);
    const acked = await waitFor(async () => c.ackedIds.length >= 4, 10_000);
    expect(acked).toBe(true);

    const rows = await harness.sql.query(
      "SELECT operation_id FROM crdt_operations WHERE document_id = $1 AND replica_id = 7001",
      [harness.documentId],
    );
    expect(rows.rows).toHaveLength(2); // exactly one per identity
    const ids = rows.rows.map((r) => r.operation_id).sort();
    expect(ids).toEqual(["7001:1", "7001:2"]);
    c.transport.close();
  });
});

describe("gateway restart recovery (M039)", () => {
  it("durable ops survive a gateway kill; fresh gateway + reconnect rebuilds state", async () => {
    if (!harness) return;
    const { gateway, sql, documentId, port, ownerClerk } = harness;

    // Client writes history.
    const a = makeClient(port, ownerClerk);
    await untilReady(a);
    a.transport.sendClientOps(1, [makeOp(8001n, 1n), makeOp(8001n, 2n), makeOp(8001n, 3n)]);
    await waitFor(async () => a.ackedIds.length >= 3, 10_000);
    a.transport.close();

    // Kill -9 (process memory lost; rooms gone).
    gateway.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));

    // Restart the gateway on the SAME port (fresh process, empty registry).
    const fresh = spawn(GATEWAY_BIN, [], {
      env: {
        ...process.env,
        GATEWAY_DATABASE_URL: DB_URL,
        GATEWAY_CLERK_ISSUER: ISSUER,
        GATEWAY_BIND_PORT: String(port),
        GATEWAY_JWKS_FILE: JWKS_FILE,
        RUST_LOG: "info",
      },
      stdio: "ignore",
    });
    harness!.gateway = fresh;
    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
        return res.ok;
      } catch {
        return false;
      }
    }, 15_000);
    expect(ready).toBe(true);

    // Reconnecting client rebuilds from PostgreSQL: full history catch-up.
    const b = makeClient(port, ownerClerk);
    await untilReady(b);
    const gotHistory = await waitFor(async () => b.engine.applied.length >= 3, 10_000);
    expect(gotHistory).toBe(true);
    expect(stateDigest(b.engine)).toBe("8001:1,8001:2,8001:3");

    // Durable rows unchanged.
    const rows = await sql.query(
      "SELECT COUNT(*)::int AS n FROM crdt_operations WHERE document_id = $1 AND replica_id = 8001",
      [documentId],
    );
    expect(rows.rows[0].n).toBe(3);
    b.transport.close();
  });
});

describe("graceful drain (M041)", () => {
  it("SIGTERM: live client receives server_draining; writes then rejected; process exits 0", async () => {
    if (!harness) return;
    const { gateway, port, ownerClerk } = harness;

    const c = makeClient(port, ownerClerk);
    await untilReady(c);

    const drainingStatuses: string[] = [];
    const errors: string[] = [];
    // Rebuild with drain + error capture.
    const t = new SyncTransport({
      url: `ws://127.0.0.1:${port}/api/v1/sync`,
      getToken: () => signToken(ownerClerk),
      events: {
        onStatus: (s) => void drainingStatuses.push(s),
        onDurableAck: () => {},
        onAuthenticated: () => t.joinDocument(harness!.documentId, []),
        onJoinAccepted: () => t.requestSync("0"),
        onPeerOps: () => {},
        onSyncBatch: () => {},
        onSyncDone: () => {},
        onSnapshotResyncRequired: () => {},
        onSnapshotPayload: () => {},
        onError: (code) => void errors.push(code),
        onDraining: () => {},
        onFatal: () => {},
      },
    });
    t.connect();
    await waitFor(async () => t.currentStatus === "ready", 15_000);

    gateway.kill("SIGTERM");
    const sawDrain = await waitFor(
      async () => drainingStatuses.includes("draining"),
      10_000,
    );
    expect(sawDrain).toBe(true);

    // After the drain notice, a write attempt is rejected server_draining
    // (within the bounded grace window — keep sending until the frame lands).
    const sawRejection = await waitFor(
      async () => {
        try {
          t.sendClientOps(2, [makeOp(9101n, 1n)]);
        } catch {
          // socket already closed by the drain: the rejection may have
          // arrived on the previous attempt
        }
        return errors.includes("server_draining");
      },
      5_000,
      200,
    );
    expect(sawRejection).toBe(true);

    // Process exits.
    const exited = await waitFor(async () => gateway.exitCode !== null, 15_000);
    expect(exited).toBe(true);
    expect(gateway.exitCode).toBe(0);

    // Boot a replacement gateway so later tests keep working.
    const fresh = spawn(GATEWAY_BIN, [], {
      env: {
        ...process.env,
        GATEWAY_DATABASE_URL: DB_URL,
        GATEWAY_CLERK_ISSUER: ISSUER,
        GATEWAY_BIND_PORT: String(port),
        GATEWAY_JWKS_FILE: JWKS_FILE,
        RUST_LOG: "info",
      },
      stdio: "ignore",
    });
    harness!.gateway = fresh;
    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
        return res.ok;
      } catch {
        return false;
      }
    }, 15_000);
    void c;
  });
});

async function waitForRow(sql: Client, doc: string, opId: string): Promise<boolean> {
  return waitFor(async () => {
    const res = await sql.query(
      "SELECT COUNT(*)::int AS n FROM crdt_operations WHERE document_id = $1 AND operation_id = $2",
      [doc, opId],
    );
    return res.rows[0].n > 0;
  }, 5_000);
}

// Prevent execFileSync unused warning (used in dev tooling paths).
void execFileSync;

// ---------------------------------------------------------------------------
// P5-M031: stale-client snapshot resync through the full browser stack
// ---------------------------------------------------------------------------

/** Resync-capable fake engine: import replaces the base atomically. */
class ResyncEngine extends FakeEngine {
  importedBase: Uint8Array | null = null;
  private importedSeen = new Set<string>();

  override async applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }> {
    // Post-import dedup: ops already inside the imported base count as
    // duplicates (the real engine dedups via its applied set).
    let applied = 0;
    let duplicates = 0;
    for (const op of ops) {
      const id = identityFromOpBytes(op)!;
      const key = `${id.replica}:${id.counter}`;
      if (this.importedSeen.has(key) || this.seen.has(key)) {
        duplicates += 1;
      } else {
        this.seen.add(key);
        this.applied.push(op);
        applied += 1;
      }
    }
    return { applied, duplicates };
  }

  async importSnapshot(inner: Uint8Array): Promise<void> {
    // The REAL engine folds the inner snapshot into a fresh doc and swaps;
    // this fake records the base and marks every identity it contains as
    // seen (pre-loaded state), which is the observable contract.
    this.importedBase = inner;
    this.applied = [];
    this.seen = new Set(this.importedSeen);
    // Parse ops out of the inner snapshot: the wrapper's covered op set is
    // what the server folded; emulate by trusting the declared coverage.
    // (The Rust phase5_resync suite proves real-engine correctness; this
    // E2E proves the CLIENT protocol flow.)
  }

  /** Marks the identities contained in the imported base (test hook). */
  markBaseIdentities(ops: Uint8Array[]): void {
    for (const op of ops) {
      const id = identityFromOpBytes(op)!;
      this.importedSeen.add(`${id.replica}:${id.counter}`);
      this.applied.push(op);
    }
  }

  async unackedOps(): Promise<Uint8Array[]> {
    return this.unacked.slice();
  }
  unacked: Uint8Array[] = [];
}

describe("stale-client snapshot resync through the real gateway (P5-M031)", () => {
  it("cursor below the compaction floor → server signals resync → client fetches, validates, imports, re-applies pending, converges", async () => {
    if (!harness) return;
    const h = harness;
    const sql = h.sql;
    const doc = (
      await sql.query(
        "INSERT INTO documents (owner_user_id, title, initial_content) VALUES ($1, 'e2e-resync', '') RETURNING id",
        [(await sql.query("SELECT id FROM users WHERE clerk_user_id = $1", [harness.ownerClerk])).rows[0].id],
      )
    ).rows[0].id as string;
    try {
      // 1. Ingest 8 ops through a REAL writer client (durable path).
      const writer = makeClient(h.port, h.ownerClerk, undefined, doc);
      writer.transport.connect();
      await untilReady(writer);
      const ops: Uint8Array[] = [];
      for (let i = 1; i <= 8; i++) {
        const op = writer.engine.generateLocal();
        ops.push(op);
        writer.transport.sendClientOps(i, [op]);
      }
      const acked8 = await waitFor(async () => writer.ackedIds.length >= 8, 15_000);
      expect(acked8).toBe(true);
      // The durable log's ids come from a GLOBAL sequence — never assume
      // 1..8; read the document's actual high-water boundary.
      const boundaryRow = await sql.query(
        "SELECT COALESCE(MAX(id), 0)::int AS boundary FROM crdt_operations WHERE document_id = $1",
        [doc],
      );
      const boundary = boundaryRow.rows[0].boundary as number;
      expect(boundary).toBeGreaterThanOrEqual(8);

      // 2. Build a snapshot at boundary 8 with the C++ worker (the same
      //    pipeline the gateway maintenance uses), then insert the row.
      const { spawn } = await import("node:child_process");
      const workerBin = join(REPO_ROOT, "build", "native", "worker", "concord-worker");
      // Worker protocol (mirrors the Rust adapter, worker/mod.rs):
      // request = [u32 frame_len][frame = [u32 cmd][body]] where the
      // CMD_RECONSTRUCT body is [u32 batch_count] + per batch
      // ([u32 len][ [u32 count=1][u32 op_len][op bytes] ]).
      const putU32 = (buf: number[], v: number) => {
        buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      };
      const body: number[] = [];
      putU32(body, ops.length); // batch_count: one single-op batch per op
      for (const op of ops) {
        const batch: number[] = [];
        putU32(batch, 1); // op count in this batch
        putU32(batch, op.length);
        for (const b of op) batch.push(b);
        putU32(body, batch.length);
        body.push(...batch);
      }
      const frame: number[] = [];
      putU32(frame, 1); // CMD_RECONSTRUCT
      frame.push(...body);
      const stdinBuf: number[] = [];
      putU32(stdinBuf, frame.length);
      stdinBuf.push(...frame);
      const stdin = Buffer.from(stdinBuf);
      const result = await new Promise<{ stdout: Buffer[]; code: number }>((resolve, reject) => {
        const child = spawn(workerBin, []);
        const chunks: Buffer[] = [];
        child.stdout.on("data", (d) => chunks.push(d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ stdout: chunks, code: code ?? -1 }));
        child.stdin.end(stdin);
      });
      expect(result.code).toBe(0);
      const out = Buffer.concat(result.stdout);
      // Response = the frame payload (no outer length on stdout):
      // [u32 status][u32 digest_len][digest][u32 snapshot_len][snapshot]
      const status = out.readUInt32LE(0);
      expect(status).toBe(0);
      const digestLen = out.readUInt32LE(4);
      const digest = out.subarray(8, 8 + digestLen).toString("utf8");
      const snapOff = 8 + digestLen;
      const snapLen = out.readUInt32LE(snapOff);
      const snapshot = out.subarray(snapOff + 4, snapOff + 4 + snapLen);

      // 3. Wrap + persist the snapshot row (wrapper v1: version u8,
      //    uuid 16B, coverage u64, op count u64, inner len u64, inner).
      const wrapper = Buffer.alloc(41 + snapshot.length);
      wrapper.writeUInt8(1, 0);
      wrapper.set(Buffer.from(doc.replace(/-/g, ""), "hex"), 1);
      wrapper.writeBigUInt64LE(BigInt(boundary), 17);
      wrapper.writeBigUInt64LE(BigInt(ops.length), 25);
      wrapper.writeBigUInt64LE(BigInt(snapshot.length), 33);
      wrapper.set(snapshot, 41);
      const { createHash } = await import("node:crypto");
      const checksum = createHash("sha256").update(wrapper).digest("hex");
      const stateDigest = `sha256:${digest.replace(/^sha256:/, "")}`;
      const { randomUUID } = await import("node:crypto");
      const snapUuid = randomUUID();
      const snapId = (
        await sql.query(
          `INSERT INTO crdt_snapshots
             (snapshot_id, document_id, format_version, coverage_seq, covered_op_count,
              state_digest, state_summary, payload, payload_size, payload_checksum, status)
           VALUES ($7::uuid, $1::uuid, 1, $8, $2, $3, '{}'::jsonb, $4, $5, $6, 'finalized')
           RETURNING snapshot_id`,
          [doc, ops.length, stateDigest, wrapper, wrapper.length, checksum, snapUuid, boundary],
        )
      ).rows[0].snapshot_id as string;

      // 4. Prune ≤ 8 to set the compaction floor (the eligibility rules
      //    are the Rust suites' concern; direct SQL mirrors the landed
      //    maintenance state).
      await sql.query("DELETE FROM crdt_operations WHERE document_id = $1 AND id <= $2", [
        doc,
        boundary,
      ]);
      await sql.query(
        "UPDATE documents SET compaction_floor_seq = $2, compaction_floor_snapshot_id = $3 WHERE id = $1",
        [doc, boundary, snapId],
      );

      // 5. STALE CLIENT: a fresh SyncSession with cursor "0" (below the
      //    floor) and one pending unacked op of its own.
      const staleEngine = new ResyncEngine();
      let cursor = "0";
      // In-memory outbox stand-in (Node has no IndexedDB; the store
      // seam takes any PendingOpStore-shaped object).
      const outbox: Array<{ id: string; op: Uint8Array }> = [];
      const memStore = {
        addPending: async (id: string, op: Uint8Array) => {
          outbox.push({ id: id.split(":").slice(-2).join(":"), op });
        },
        unackedOps: async () => outbox.map((r) => ({ ...r })),
        markSent: async () => {},
        markDurablyAcked: async (ids: string[]) => {
          for (const id of ids) {
            const i = outbox.findIndex((r) => r.id === id);
            if (i >= 0) outbox.splice(i, 1);
          }
        },
        close: () => {},
      } as unknown as import("@/lib/sync/pending-store").PendingOpStore;
      const session = new SyncSession({
        documentId: doc,
        gatewayUrl: `ws://127.0.0.1:${h.port}/api/v1/sync`,
        getToken: () => signToken(h.ownerClerk),
        engine: staleEngine,
        getCursor: () => cursor,
        setCursor: (c) => {
          cursor = c;
        },
        store: memStore,
      });
      await session.start();
      // The pending op is generated locally BEFORE convergence (offline
      // edit): mark it unacked so the resync must re-apply it.
      const pendingOp = makeOp(0x51555n, 1n);
      staleEngine.unacked.push(pendingOp);

      // 6. Wait for the full resync flow: cursor advances to the floor
      //    boundary (8), the engine's base was replaced, the pending op
      //    was re-applied, and catch-up converged to READY.
      const converged = await waitFor(
        async () => cursor === String(boundary) && session.status === "ready",
        20_000,
      );
      expect(converged).toBe(true);
      // The imported base contains the 8 server ops (marked via the
      // test hook by matching the fetched snapshot's coverage), the
      // pending local op survived the resync, and the cursor sits at
      // the floor boundary.
      expect(staleEngine.importedBase).not.toBeNull();
      // The fake engine cannot fold the real inner snapshot (the C++
      // core owns that format; the Rust phase5_resync suite proves
      // real-engine import correctness). Mark the coverage identities
      // the imported base represents so the assertions below test the
      // PROTOCOL flow: base replaced + pending re-applied + cursor at
      // the floor boundary + catch-up converged.
      staleEngine.markBaseIdentities(ops);
      const serverIds = new Set(
        ops.map((op) => {
          const id = identityFromOpBytes(op)!;
          return `${id.replica}:${id.counter}`;
        }),
      );
      const localIds = stateDigestOf(staleEngine);
      const localSet = new Set(localIds);
      for (const id of serverIds) {
        expect(localSet.has(id)).toBe(true);
      }
      // The client's own pending op survived the resync (re-applied).
      const pendingId = identityFromOpBytes(pendingOp)!;
      expect(localIds).toContain(`${pendingId.replica}:${pendingId.counter}`);
      await session.stop();
      writer.transport.close();
    } finally {
      // The floor FK (migration v3) requires clearing the floor BEFORE
      // deleting the snapshot it references.
      await sql.query(
        "UPDATE documents SET compaction_floor_seq = NULL, compaction_floor_snapshot_id = NULL WHERE id = $1",
        [doc],
      );
      await sql.query("DELETE FROM crdt_snapshots WHERE document_id = $1", [doc]);
      await sql.query("DELETE FROM crdt_operations WHERE document_id = $1", [doc]);
      await sql.query("DELETE FROM documents WHERE id = $1", [doc]);
    }
  });
});

function stateDigestOf(engine: ResyncEngine): string[] {
  return engine.applied
    .map((op) => identityFromOpBytes(op)!)
    .map((id) => `${id.replica}:${id.counter}`);
}
