// ---------------------------------------------------------------------------
// Browser E2E global setup: provision the full stack Playwright talks to.
//
//   1. concord_e2e database on the compose Postgres (dropped + recreated +
//      drizzle-migrated on every run — a clean, deterministic DB)
//   2. Rust sync-gateway release binary with the REAL Clerk dev-instance
//      issuer (HTTPS JWKS — the production verification path) on
//      127.0.0.1:8790, allowed origin http://127.0.0.1:3111, real NATS +
//      Redis + native worker wired when present
//   3. Next.js dev server on 127.0.0.1:3111 with the real Clerk publishable
//      key (from the environment) and NEXT_PUBLIC_SYNC_GATEWAY_URL pointed
//      at the spawned gateway
//
// Fail-closed: every prerequisite is probed; a missing service aborts the
// run with an actionable message instead of a confusing browser failure.
//
// Secrets: nothing real is written to the repo. The Clerk secret key is
// passed via the ambient environment (CI: repository secret / local:
// .env.local). The gateway needs only the ISSUER (public) for JWKS.
// ---------------------------------------------------------------------------
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../.env.local"));
} catch {
  // CI supplies the required Clerk values through the process environment.
}

const require = createRequire(import.meta.url);
const pkg = require("pg");

const ROOT = path.resolve(import.meta.dirname, "..");
// Ephemeral web port by default (explicit CONCORD_E2E_WEB_PORT available
// for CI/debugging): a fixed port makes an immediate rerun race the
// previous child while it is still shutting down.
let webPort = Number(process.env.CONCORD_E2E_WEB_PORT || 0);
// localhost (NOT 127.0.0.1): browser cookies require a hostname domain, and
// the middleware's internal self-proxy dials "localhost" — if the server
// bound only 127.0.0.1, the IPv6 (::1) resolution of localhost would
// ECONNRESET every middleware-matched route. Binding all interfaces covers
// both stacks.
let WEB_ORIGIN = "";
// Use an ephemeral gateway port by default. A fixed port makes an immediate
// rerun race the previous child while it is still shutting down; worse, a
// stale listener can make setup report success while the newly spawned
// gateway has already failed to bind. An explicit port remains available for
// CI/debugging.
const CONFIGURED_GATEWAY_PORT = Number(process.env.CONCORD_E2E_GATEWAY_PORT || 0);
let gatewayPort = CONFIGURED_GATEWAY_PORT;
let gatewayWs = "";

const DB_BASE = process.env.CONCORD_E2E_DB_BASE || "postgres://concord:concord_local_dev@127.0.0.1:5433";
const E2E_DB = `${DB_BASE}/concord_e2e`;

// Real Clerk dev instance (public values, not secrets).
const CLERK_PUBLISHABLE = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
const CLERK_ISSUER =
  process.env.GATEWAY_CLERK_ISSUER ||
  (CLERK_PUBLISHABLE ? issuerFromPublishableKey(CLERK_PUBLISHABLE) : undefined);

const procs = [];
let cleanedUp = false;
let cleanupAuth = async () => {};

function log(step, msg) {
  console.log(`[browser-e2e] ${step}: ${msg}`);
}

function issuerFromPublishableKey(key) {
  // pk_test_<base64url(domain)> — the payload is the bare instance domain
  // (e.g. "fun-blowfish-5798.clerk.accounts.dev"), not a JSON object.
  try {
    const raw = key.split("_")[2].replace(/-/g, "+").replace(/_/g, "/");
    const domain = Buffer.from(raw, "base64").toString("utf8").trim().replace(/\$$/, "");
    if (!domain || domain.includes("{")) return undefined;
    return `https://${domain}`;
  } catch {
    return undefined;
  }
}

async function waitForPort(port, host, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ port, host, timeout: 1500 });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${label}: nothing is listening on ${host}:${port} after ${timeoutMs}ms`);
}

async function freePort(host) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not determine an ephemeral port")));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function probeHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      // Any HTTP response (including 3xx/4xx) means the server is up.
      if (res.status >= 200 && res.status < 600) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label}: HTTP probe failed after ${timeoutMs}ms (${lastErr})`);
}

function must(prereq, message) {
  if (!prereq) {
    console.error(`[browser-e2e] FAIL-CLOSED: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
}

export default async function globalSetup() {
  // ---- Fail-closed prerequisites -------------------------------------------
  must(CLERK_PUBLISHABLE, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set (the browser needs the real Clerk dev instance for sign-in)");
  must(CLERK_ISSUER && CLERK_ISSUER !== "https://", "could not derive the Clerk issuer (bad publishable key?) — set GATEWAY_CLERK_ISSUER explicitly");
  must(CLERK_SECRET, "CLERK_SECRET_KEY is not set (the web tier needs it for server-side auth)");

  const gatewayBin = path.join(ROOT, "rust", "target", "release", "sync-gateway");
  must(fs.existsSync(gatewayBin), "sync-gateway release binary missing — run: (cd rust && cargo build --release)");
  const workerBin = path.join(ROOT, "build", "native", "worker", "concord-worker");
  must(fs.existsSync(workerBin), "concord-worker release binary missing — run: cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build/native --target concord-worker");
  must(fs.existsSync(path.join(ROOT, "public", "crdt-worker.js")), "public/crdt-worker.js missing — run: npm run wasm:build && npm run worker:bundle");

  gatewayPort = CONFIGURED_GATEWAY_PORT || await freePort("127.0.0.1");
  gatewayWs = `ws://127.0.0.1:${gatewayPort}/api/v1/sync`;

  // ---- 1. Clean concord_e2e database --------------------------------------
  const admin = new URL(E2E_DB);
  admin.pathname = "/postgres";
  const adminPool = new pkg.Pool({ connectionString: admin.toString() });
  await adminPool.query(`DROP DATABASE IF EXISTS concord_e2e WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE concord_e2e`);
  await adminPool.end();
  log("db", "recreated concord_e2e");

  execFileSync(process.execPath, [path.join(ROOT, "scripts/db/migrate.mjs"), E2E_DB], {
    cwd: ROOT, stdio: "inherit",
  });
  log("db", "drizzle migrations applied");

  // ---- 1b. Provision deterministic E2E users + org (Clerk Backend API) ----
  // Users are email-verified on creation; the org satisfies the instance's
  // force_organization_selection so first sign-in completes without UI.
  // All throwaway test data on the project's own dev instance.
  const clerkApi = async (path, params, method = "POST") => {
    const res = await fetch(`https://api.clerk.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${CLERK_SECRET}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`clerk ${path} -> ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
  const runId = process.env.CONCORD_E2E_RUN_ID || String(Date.now());
  const users = {};
  const organizationIds = [];

  // Install cleanup before provisioning so a partial Clerk API failure does
  // not leak the users or organizations already created by this run.
  const deleteClerkResource = async (url, label) => {
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${CLERK_SECRET}` },
      });
      if (!res.ok && res.status !== 404) {
        console.warn(`[browser-e2e] cleanup: ${label} delete returned ${res.status}`);
      }
    } catch (error) {
      console.warn(`[browser-e2e] cleanup: ${label} delete failed: ${error.message}`);
    }
  };
  cleanupAuth = async () => {
    for (const organizationId of organizationIds) {
      await deleteClerkResource(
        `https://api.clerk.com/v1/organizations/${organizationId}`,
        "organization",
      );
    }
    for (const record of Object.values(users)) {
      await deleteClerkResource(
        `https://api.clerk.com/v1/users/${record.clerkUserId}`,
        "user",
      );
    }
  };

  try {
    for (const label of ["primary", "persist", "collab-a", "reconnect-a", "isolation-owner", "isolation-stranger", "console-clean", "netfail", "a11y-home", "a11y-editor", "a11y-keyboard", "a11y-names", "smoke"]) {
      const email = `concord.e2e.${label}.${runId}@example.com`;
      const u = await clerkApi("users", {
        email_address: email,
        password: `ConcordE2e-${label}-${runId}!`,
        first_name: "Concord",
        last_name: "E2E",
        skip_password_checks: "true",
        skip_session_creation: "true",
      });
      users[label] = { clerkUserId: u.id, email };
    }
    // One org PER USER: the instance forces organization selection on first
    // sign-in (force_organization_selection), and the task completes only for
    // org members — so every E2E user must own an org before signing in.
    for (const [label, u] of Object.entries(users)) {
      const organization = await clerkApi("organizations", {
        name: `Concord E2E ${label} ${runId}`,
        created_by: u.clerkUserId,
      });
      organizationIds.push(organization.id);
    }
  } catch (error) {
    await cleanupAuth();
    throw error;
  }
  log("clerk", `provisioned ${Object.keys(users).length} E2E users + per-user orgs (run ${runId})`);

  // ---- 1c. Pick the web port (ephemeral by default) ------------------------
  webPort = webPort || await freePort("127.0.0.1");
  WEB_ORIGIN = `http://localhost:${webPort}`;

  // ---- 2. Gateway (real Clerk issuer over HTTPS JWKS) ----------------------
  const gateway = spawn(gatewayBin, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      GATEWAY_BIND_HOST: "127.0.0.1",
      GATEWAY_BIND_PORT: String(gatewayPort),
      GATEWAY_DATABASE_URL: E2E_DB,
      GATEWAY_CLERK_ISSUER: CLERK_ISSUER,
      GATEWAY_ALLOWED_ORIGINS: WEB_ORIGIN,
      GATEWAY_WORKER_BINARY: workerBin,
      GATEWAY_NATS_URL: process.env.CONCORD_E2E_NATS_URL || "nats://127.0.0.1:4222",
      GATEWAY_REDIS_URL: process.env.CONCORD_E2E_REDIS_URL || "redis://127.0.0.1:6379",
      RUST_LOG: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(gateway);
  gateway.stdout.on("data", (d) => process.env.CONCORD_E2E_VERBOSE === "1" && process.stdout.write(`[gateway] ${d}`));
  gateway.stderr.on("data", (d) => process.stdout.write(`[gateway:err] ${d}`));
  await waitForPort(gatewayPort, "127.0.0.1", 30_000, "gateway");
  must(gateway.exitCode === null, "sync-gateway exited before browser setup completed");
  log("gateway", `up on 127.0.0.1:${gatewayPort} (issuer ${CLERK_ISSUER})`);

  // ---- 3. Next.js web tier -------------------------------------------------
  // `next dev` (not a prod build): the browser E2E layer verifies the real
  // development shape of the app; production builds are covered by the
  // existing web CI gate (`npm run build`) and release smoke tests.
  const web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--port", String(webPort)], {
    cwd: ROOT,
    env: {
      ...process.env,
      NEXT_PUBLIC_SYNC_GATEWAY_URL: gatewayWs,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: CLERK_PUBLISHABLE,
      CLERK_SECRET_KEY: CLERK_SECRET,
      DATABASE_URL: E2E_DB,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(web);
  web.stdout.on("data", (d) => process.env.CONCORD_E2E_VERBOSE === "1" && process.stdout.write(`[web] ${d}`));
  web.stderr.on("data", (d) => process.env.CONCORD_E2E_VERBOSE === "1" && process.stderr.write(`[web:err] ${d}`));
  // Probe a static asset so the readiness check cannot invoke auth() before
  // Next has loaded proxy.ts during its first app-route compilation.
  await probeHttp(`${WEB_ORIGIN}/icon.svg`, 90_000, "web");
  // Warm the dev-server route compiles that the specs touch first — the
  // initial Turbopack compile of "/" takes ~20s and a cold document page
  // adds more; warming keeps the first tests inside their poll windows.
  const warm = async (path) => {
    try { await fetch(`${WEB_ORIGIN}${path}`, { redirect: "manual" }); } catch {}
  };
  await warm("/");
  await warm("/crdt-worker.js");
  log("web", `up on ${WEB_ORIGIN} (gateway ${gatewayWs})`);

  // Expose the endpoints to the specs via env (Playwright re-reads env in workers).
  process.env.CONCORD_E2E_BASE_URL = WEB_ORIGIN;
  process.env.CONCORD_E2E_GATEWAY_WS = gatewayWs;
  process.env.CONCORD_E2E_DB = E2E_DB;
  process.env.CONCORD_E2E_ISSUER = CLERK_ISSUER;
  process.env.CONCORD_E2E_USERS = JSON.stringify(users);
  process.env.CONCORD_E2E_RUN_ID = runId;

  // Cleanup on process exit (Playwright calls globalTeardown; this is the belt).
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const p of procs) {
      try { p.kill("SIGTERM"); } catch {}
    }
  };
  const stopProcesses = async () => {
    cleanup();
    await Promise.all(procs.map((p) => new Promise((resolve) => {
      if (p.exitCode !== null || p.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try { p.kill("SIGKILL"); } catch {}
        resolve();
      }, 5_000);
      p.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    })));
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  // Persist proc handles for teardown() below.
  globalThis.__e2eProcs = procs;

  return async () => {
    await stopProcesses();
    await cleanupAuth();
  };
}

export async function teardown() {
  for (const p of globalThis.__e2eProcs || []) {
    try { p.kill("SIGTERM"); } catch {}
  }
  await cleanupAuth();
}
