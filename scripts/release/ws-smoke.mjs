// P7-M019 — Recovery-order drill: WS smoke (join + catch-up returns history).
//
// Manual DR-verification script: after a catastrophic restart, one client
// joins a seeded document and MUST receive the full durable history via
// normal catch-up (the DB floor is the source). Mirrors the catch-up
// client in scripts/release/drain-test.mjs (same protocol flows as
// tests/realtime/e2e.test.ts).
//
// Prerequisites: gateway running (host binary or container), compose db up,
// e2e JWKS+key present. Seeds nothing — reads the seeded document by title
// 'dr-recovery' and asserts the ops replay.
//
// Usage: node scripts/release/ws-smoke.mjs [port]

import { readFileSync } from "node:fs";
import { createPrivateKey, createSign } from "node:crypto";
import { Client } from "pg";

const PORT = Number(process.argv[2] ?? 8791);
const DB_URL = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";
const ISSUER = "https://e2e.clerk.accounts.dev";
const REPO = decodeURIComponent(new URL("../..", import.meta.url).pathname);
const KEY_DER = `${REPO}.agent/scratch/phase-3/e2e-key.der`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signToken(sub) {
  const der = readFileSync(KEY_DER);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "e2e-key-1" }));
  const payload = b64u(JSON.stringify({ sub, iss: ISSUER, iat: now, exp: now + 600 }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function main() {
  const sql = new Client({ connectionString: DB_URL });
  await sql.connect();

  const doc = await sql.query("SELECT d.id, d.title FROM documents d WHERE d.title = 'dr-recovery'");
  if (doc.rows.length === 0) {
    console.error("FAIL: seeded document 'dr-recovery' not found");
    process.exit(1);
  }
  const documentId = doc.rows[0].id;
  const ops = await sql.query("SELECT count(*)::int AS n FROM crdt_operations WHERE document_id = $1", [
    documentId,
  ]);
  const expectedOps = ops.rows[0].n;
  const owner = await sql.query("SELECT clerk_user_id FROM users WHERE id = (SELECT owner_user_id FROM documents WHERE id = $1)", [
    documentId,
  ]);
  const clerkId = owner.rows[0].clerk_user_id;
  console.log(`document ${documentId}: ${expectedOps} durable ops (owner ${clerkId})`);

  const state = { ready: false, replayed: 0 };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/sync`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const frame = JSON.parse(ev.data);
      if (frame.type === "hello_ack") {
        ws.send(JSON.stringify({ v: 1, type: "authenticate", payload: { token: signToken(clerkId) } }));
      } else if (frame.type === "authenticated") {
        ws.send(
          JSON.stringify({ v: 1, type: "join_document", payload: { documentId, stateSummary: [] } }),
        );
      } else if (frame.type === "join_accepted") {
        ws.send(JSON.stringify({ v: 1, type: "sync_request", payload: { cursor: "0" } }));
      } else if (frame.type === "sync_done") {
        state.ready = true;
      }
    } else {
      // [u64 nextCursor][u8 hasMore][u16 count] — 13-byte header (kind 0x21).
      const buf = Buffer.from(ev.data);
      if (buf.length >= 13 && buf[0] === 1 && buf[1] === 0x21) {
        state.replayed += buf.readUInt16BE(11);
      }
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`ws: ${e.message}`));
  });
  ws.send(JSON.stringify({ v: 1, type: "hello", payload: { clientProtocolVersion: 1 } }));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (state.ready && state.replayed >= expectedOps) break;
    await sleep(100);
  }
  ws.close();
  await sql.end();

  console.log(`catch-up: sync_done=${state.ready}, ops replayed=${state.replayed}/${expectedOps}`);
  const pass = state.ready && state.replayed >= expectedOps;
  console.log(pass ? "WS SMOKE: PASS" : "WS SMOKE: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("ws smoke error:", e);
  process.exit(1);
});
