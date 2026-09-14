// ---------------------------------------------------------------------------
// Browser E2E global setup: provision the full stack Playwright talks to.
//
//   1. concord_e2e database on the compose Postgres (dropped + recreated +
//      drizzle-migrated on every run — a clean, deterministic DB)
//   2. Rust sync-gateway release binary with the REAL Clerk dev-instance
//      issuer (HTTPS JWKS — the production verification path) on
//      an isolated loopback port, allowed origin on the dedicated localhost
//      port, real NATS + Redis + native worker wired when present. Set
//      CONCORD_E2E_REQUIRE_INTERNAL_AUTH=1 to require credential-bearing
//      NATS/Redis URLs instead of the unauthenticated development defaults.
//   3. Next.js dev server on an isolated localhost port (or a production
//      `next build` + generated standalone-server pair when
//      CONCORD_E2E_MODE=production) with
//      the real Clerk publishable key and NEXT_PUBLIC_SYNC_GATEWAY_URL pointed
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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { stageStandalone } from "./e2e/prepare-standalone.mjs";

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../.env.local"));
} catch {
  // CI supplies the required Clerk values through the process environment.
}

const require = createRequire(import.meta.url);
const pkg = require("pg");

const ROOT = path.resolve(import.meta.dirname, "..");
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const DEFAULT_WEB_PORT = 3111;
const E2E_EMAIL_PREFIX = "concord.e2e.";
const E2E_EMAIL_SUFFIX = "@example.com";
const E2E_ORG_PREFIX = "Concord E2E ";
const E2E_USER_EMAIL_RE = /^concord\.e2e\.[a-z0-9-]+\.[a-z0-9-]+@example\.com$/i;
const E2E_ORGANIZATION_NAME_RE = /^Concord E2E [a-z0-9-]+ [a-z0-9-]+$/i;
// A stale cleanup must never race a still-running test. Keep this fixed and
// deliberately conservative; the janitor only removes resources older than
// one day and only when they match the explicit E2E namespace below.
const STALE_RESOURCE_AGE_MS = 24 * 60 * 60 * 1000;
const CLERK_PAGE_SIZE = 100;
const CLERK_MAX_PAGES = 100;
const FULL_USER_LABELS = Object.freeze([
  "primary",
  "persist",
  "collab-a",
  "reconnect-a",
  "isolation-owner",
  "isolation-stranger",
  "console-clean",
  "netfail",
  "a11y-home",
  "a11y-editor",
  "a11y-keyboard",
  "a11y-names",
]);
const SMOKE_USER_LABELS = Object.freeze(["smoke"]);
// Playwright resolves `use.baseURL` before globalSetup runs. The default is
// therefore intentionally fixed and shared with playwright.config.ts; the
// run lock below prevents two authenticated harnesses in this checkout from
// racing over it. A caller may provide a different port before Playwright
// loads the config.
let webPort = 0;
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
let gatewayPort = 0;
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
let cleanupAuth = async () => true;
let authCleanupDone = false;
let e2eLockFd = null;
let e2eLockPath = "";
let processHandlersInstalled = false;
let signalCleanupPromise = null;

function log(step, msg) {
  console.log(`[browser-e2e] ${step}: ${msg}`);
}

function inferMode() {
  const mode = (process.env.CONCORD_E2E_MODE || "dev").trim().toLowerCase();
  if (mode !== "dev" && mode !== "production") {
    throw new Error(`CONCORD_E2E_MODE must be "dev" or "production" (received "${mode}")`);
  }
  return mode;
}

function parsePort(value, name) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${name} must be an integer from 1 to 65535 (received "${value}")`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535 (received "${value}")`);
  }
  return port;
}

function resolveWebOrigin() {
  const configuredBase = process.env.CONCORD_E2E_BASE_URL;
  const configuredPort = process.env.CONCORD_E2E_WEB_PORT;
  let parsed;

  try {
    parsed = new URL(configuredBase || `http://localhost:${configuredPort || DEFAULT_WEB_PORT}`);
  } catch {
    throw new Error("CONCORD_E2E_BASE_URL must be a valid local http origin");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("CONCORD_E2E_BASE_URL must use http://; this harness does not terminate TLS");
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("CONCORD_E2E_BASE_URL must point to localhost, 127.0.0.1, or ::1");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("CONCORD_E2E_BASE_URL must be an origin without credentials, a path, query, or fragment");
  }

  const basePort = parsed.port ? parsePort(parsed.port, "CONCORD_E2E_BASE_URL port") : 80;
  if (configuredPort) {
    const requestedPort = parsePort(configuredPort, "CONCORD_E2E_WEB_PORT");
    if (parsed.port && requestedPort !== basePort) {
      throw new Error("CONCORD_E2E_WEB_PORT does not match the port in CONCORD_E2E_BASE_URL");
    }
    parsed.port = String(requestedPort);
  } else if (!parsed.port) {
    // An origin without a port would otherwise target port 80 while the
    // harness starts an isolated local server. Keep the caller's host/scheme
    // but supply the documented harness port.
    parsed.port = String(DEFAULT_WEB_PORT);
  }

  webPort = parsePort(parsed.port, "web port");
  return parsed.origin;
}

function cliProjectValues() {
  const values = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" && args[i + 1]) {
      values.push(args[i + 1]);
      i += 1;
    } else if (arg.startsWith("--project=")) {
      values.push(arg.slice("--project=".length));
    }
  }
  return values;
}

function safeNamespacePart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function safeNamespace(value, maxLength = 32) {
  const normalized = safeNamespacePart(value);
  if (normalized.length <= maxLength) return normalized;

  // Preserve a stable uniqueness suffix instead of silently truncating two
  // caller-supplied run ids to the same Clerk email/org namespace.
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  const prefixLength = Math.max(1, maxLength - digest.length - 1);
  return `${normalized.slice(0, prefixLength).replace(/-+$/g, "")}-${digest}`;
}

function inferProject() {
  const explicit = process.env.CONCORD_E2E_PROJECT || process.env.PLAYWRIGHT_PROJECT;
  if (explicit) return safeNamespace(explicit);
  const projects = cliProjectValues().map(safeNamespace).filter(Boolean);
  return safeNamespace(projects.length > 0 ? projects.join("-") : "all");
}

function inferProfile() {
  const explicit = (process.env.CONCORD_E2E_PROFILE || "").trim().toLowerCase();
  if (explicit) {
    if (explicit === "full" || explicit === "smoke" || explicit === "all") return explicit;
    throw new Error(`CONCORD_E2E_PROFILE must be "full", "smoke", or "all" (received "${explicit}")`);
  }

  // Playwright does not expose the selected project/test-file to globalSetup
  // directly. Package-script lifecycle metadata and CLI paths provide a
  // conservative fallback for the repository's smoke invocations.
  const invocation = [
    process.env.npm_lifecycle_event || "",
    process.env.PLAYWRIGHT_TEST_FILES || "",
    ...process.argv,
  ].join(" ");
  const projects = cliProjectValues().map(safeNamespace).filter(Boolean);
  const smokeFileSelected = /(?:^|[\s/\\])smoke\.spec\.(?:[cm]?[jt]sx?)(?:$|[\s])/i.test(invocation);
  const fullFileSelected = /(?:^|[\s/\\])(?:journey|a11y)\.spec\.(?:[cm]?[jt]sx?)(?:$|[\s])/i.test(invocation);
  // An explicit file is authoritative: `--project=chromium smoke.spec.ts`
  // is the supported Chromium smoke command and must not provision the full
  // journey's user set merely because the browser project is Chromium.
  const smokeSelected =
    smokeFileSelected ||
    /test:browser:smoke/i.test(invocation) ||
    (!fullFileSelected && projects.some((project) => project === "firefox" || project === "webkit"));
  const fullSelected = fullFileSelected || (!smokeFileSelected && projects.includes("chromium"));

  if (smokeSelected && fullSelected) return "all";
  if (smokeSelected) return "smoke";
  if (fullSelected) return "full";
  // With no CLI project/file filter, Playwright selects every project. The
  // project testMatch rules then require the union of full + smoke users.
  return "all";
}

function makeRunNamespace() {
  const explicit = safeNamespace(process.env.CONCORD_E2E_RUN_ID);
  if (explicit) return explicit;

  const project = inferProject() || "e2e";
  const githubRun = safeNamespace(process.env.GITHUB_RUN_ID);
  if (githubRun) {
    const attempt = safeNamespace(process.env.GITHUB_RUN_ATTEMPT || "1");
    const job = safeNamespace(process.env.GITHUB_JOB || "e2e");
    return safeNamespace(["gh", githubRun, attempt, job, project].join("-"));
  }

  // Local runs are serialized by the checkout lock. Include a stable checkout
  // fingerprint as well as the project so two independent clones can use the
  // same Clerk test instance without deleting each other's disposable users.
  // CI supplies the unique GitHub run/attempt identity above.
  const checkout = createHash("sha256").update(ROOT).digest("hex").slice(0, 10);
  return safeNamespace(["local", checkout, project].join("-"));
}

function inspectInternalUrl(raw, name, protocols) {
  if (!raw) return { present: false, hasCredentials: false, authenticated: false };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    must(false, `${name} must be a valid URL when provided`);
  }
  must(protocols.includes(parsed.protocol), `${name} must use ${protocols.join(" or ")}`);
  must(
    parsed.pathname === "/" && !parsed.search && !parsed.hash,
    `${name} must not include a path, query, or fragment`,
  );
  const hasCredentials = Boolean(parsed.username || parsed.password);
  return {
    present: true,
    hasCredentials,
    authenticated: Boolean(parsed.username) && Boolean(parsed.password),
  };
}

function requireInternalAuthUrls() {
  const nats = inspectInternalUrl(process.env.CONCORD_E2E_NATS_URL, "CONCORD_E2E_NATS_URL", ["nats:", "tls:"]);
  const redis = inspectInternalUrl(process.env.CONCORD_E2E_REDIS_URL, "CONCORD_E2E_REDIS_URL", ["redis:", "rediss:"]);
  const required = process.env.CONCORD_E2E_REQUIRE_INTERNAL_AUTH === "1";
  const credentialedConfiguration = nats.hasCredentials || redis.hasCredentials;

  if (required || credentialedConfiguration) {
    must(
      nats.authenticated,
      "authenticated internal E2E mode requires CONCORD_E2E_NATS_URL with username and password",
    );
    must(
      redis.authenticated,
      "authenticated internal E2E mode requires CONCORD_E2E_REDIS_URL with username and password",
    );
    return true;
  }

  // Plain unauthenticated URLs remain an intentional local-development
  // fallback. Any partial/malformed credential configuration has already
  // failed above instead of silently downgrading to those defaults.
  return false;
}

function requireStrictClaimPolicy(webOrigin) {
  if (process.env.CONCORD_E2E_REQUIRE_CLAIM_POLICY !== "1") return;
  must(
    Boolean(process.env.GATEWAY_CLERK_AUDIENCE),
    "CONCORD_E2E_REQUIRE_CLAIM_POLICY=1 requires GATEWAY_CLERK_AUDIENCE",
  );
  must(
    resolveRunOrigin(process.env.GATEWAY_CLERK_AUTHORIZED_PARTY, webOrigin) === webOrigin,
    "CONCORD_E2E_REQUIRE_CLAIM_POLICY=1 requires GATEWAY_CLERK_AUTHORIZED_PARTY to resolve to the E2E web origin",
  );
  must(
    resolveRunOrigin(process.env.CONCORD_APP_ORIGIN, webOrigin) === webOrigin,
    "CONCORD_E2E_REQUIRE_CLAIM_POLICY=1 requires CONCORD_APP_ORIGIN to resolve to the E2E web origin",
  );
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireRunLock(runId, profile) {
  e2eLockPath = path.join(ROOT, "node_modules", ".concord-e2e.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      e2eLockFd = fs.openSync(e2eLockPath, "wx");
      fs.writeFileSync(
        e2eLockFd,
        JSON.stringify({ pid: process.pid, runId, profile, startedAt: new Date().toISOString() }),
      );
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let owner;
      try {
        const stat = fs.lstatSync(e2eLockPath);
        if (stat.isSymbolicLink()) {
          throw new Error("lock path is a symbolic link");
        }
        owner = JSON.parse(fs.readFileSync(e2eLockPath, "utf8"));
      } catch (readError) {
        throw new Error(`browser E2E lock exists and cannot be inspected safely (${readError.message})`);
      }

      const ownerPid = Number(owner?.pid);
      if (processIsAlive(ownerPid)) {
        throw new Error(`another browser E2E run is active (pid ${ownerPid}); wait for it to finish before starting another run`);
      }
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
        throw new Error("browser E2E lock exists without a valid owner; remove it only after confirming no E2E run is active");
      }

      // The owner is definitely gone, so this exact lock file is stale. A
      // lock with an unknown owner is never removed automatically.
      try {
        fs.unlinkSync(e2eLockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("could not acquire the browser E2E lock");
}

function releaseRunLock() {
  if (e2eLockFd !== null) {
    try { fs.closeSync(e2eLockFd); } catch {}
    e2eLockFd = null;
  }
  if (!e2eLockPath) return;
  try {
    const owner = JSON.parse(fs.readFileSync(e2eLockPath, "utf8"));
    if (Number(owner?.pid) === process.pid) fs.unlinkSync(e2eLockPath);
  } catch {
    // Cleanup is best-effort on process exit. A future run will inspect the
    // owner PID and remove only a lock whose owner is definitely gone.
  }
  e2eLockPath = "";
}

function killProcessesSync() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of procs) {
    try { child.kill("SIGTERM"); } catch {}
  }
}

async function stopProcesses() {
  killProcessesSync();
  await Promise.all(procs.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  })));
}

async function cleanupAuthWithRetry() {
  let complete = await cleanupAuth();
  if (!complete && !authCleanupDone) complete = await cleanupAuth();
  if (!complete) log("cleanup", "one or more Clerk resources could not be deleted; teardown will not claim full cleanup");
  return complete;
}

function installProcessHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on("exit", () => {
    killProcessesSync();
    releaseRunLock();
  });
  const handleSignal = (exitCode) => {
    if (signalCleanupPromise) return;
    signalCleanupPromise = (async () => {
      // Signal cleanup is asynchronous because Clerk deletions are network
      // operations. Keep the lock until both children and owned resources
      // have had a chance to shut down; the synchronous exit handler remains
      // the final safety net for the process itself.
      await Promise.allSettled([stopProcesses(), cleanupAuthWithRetry()]);
      releaseRunLock();
      process.exit(exitCode);
    })().catch((error) => {
      console.warn(`[browser-e2e] signal cleanup incomplete (${error.message})`);
      releaseRunLock();
      process.exit(exitCode);
    });
  };
  process.once("SIGINT", () => handleSignal(130));
  process.once("SIGTERM", () => handleSignal(143));
}

function childExitGuard(child, label) {
  let rejectGuard;
  const promise = new Promise((_, reject) => { rejectGuard = reject; });
  // The readiness caller may dispose the listeners just as a child exits;
  // mark the rejection handled so that race does not become an unrelated
  // unhandled-rejection failure in the Playwright runner.
  promise.catch(() => {});
  const onError = (error) => rejectGuard(new Error(`${label} failed to start: ${error.message}`));
  const onExit = (code, signal) => {
    const status = signal ? `signal ${signal}` : `code ${code}`;
    rejectGuard(new Error(`${label} exited before readiness (${status})`));
  };
  child.once("error", onError);
  child.once("exit", onExit);
  return {
    promise,
    dispose() {
      child.off("error", onError);
      child.off("exit", onExit);
    },
  };
}

function resolveRunOrigin(value, webOrigin) {
  return value === "$CONCORD_E2E_WEB_ORIGIN" || value === "${CONCORD_E2E_WEB_ORIGIN}"
    ? webOrigin
    : value;
}

function profileUserLabels(profile) {
  if (profile === "smoke") return [...SMOKE_USER_LABELS];
  if (profile === "full") return [...FULL_USER_LABELS];
  if (profile === "all") return [...new Set([...FULL_USER_LABELS, ...SMOKE_USER_LABELS])];
  throw new Error(`unknown browser E2E provisioning profile "${profile}"`);
}

function isSafeClerkId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{2,128}$/.test(value);
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

async function probeHttp(
  url,
  timeoutMs,
  label,
  child = null,
  acceptsStatus = (status) => status >= 200 && status < 400,
) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  const guard = child ? childExitGuard(child, label) : null;
  try {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${label} exited before readiness`);
    }
    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const res = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(5_000, remainingMs)),
        });
        // Readiness must not turn an application 5xx into a false green. A
        // redirect is still a valid HTTP response for the web root, while a
        // static asset and the gateway health endpoint are expected to be 2xx.
        const status = res.status;
        await res.body?.cancel();
        if (acceptsStatus(status)) return;
        lastErr = `status ${status}`;
      } catch (error) {
        lastErr = error instanceof Error ? error.message : String(error);
      }
      const delay = new Promise((resolve) => setTimeout(resolve, 500));
      if (guard) await Promise.race([delay, guard.promise]);
      else await delay;
    }
    throw new Error(`${label}: HTTP probe failed after ${timeoutMs}ms (${lastErr})`);
  } finally {
    guard?.dispose();
  }
}

function must(prereq, message) {
  if (!prereq) {
    console.error(`[browser-e2e] FAIL-CLOSED: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function resourceCreatedAtMs(resource) {
  const raw = resource?.created_at ?? resource?.createdAt;
  if (typeof raw === "string" && !/^\d+(?:\.\d+)?$/.test(raw)) {
    const parsedDate = Date.parse(raw);
    return Number.isFinite(parsedDate) ? parsedDate : null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  // Clerk currently returns epoch milliseconds; tolerate seconds without
  // making an invalid timestamp eligible for destructive cleanup.
  return parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
}

function isExplicitE2eUser(resource) {
  return isSafeClerkId(resource?.id) && (resource?.email_addresses || []).some((address) => {
    const email = typeof address === "string" ? address : address?.email_address;
    return typeof email === "string" && E2E_USER_EMAIL_RE.test(email);
  });
}

function isExplicitE2eOrganization(resource) {
  const name = resource?.name;
  return isSafeClerkId(resource?.id) && typeof name === "string" && E2E_ORGANIZATION_NAME_RE.test(name);
}

async function listClerkCollection(clerkApi, resource) {
  const result = [];
  for (let page = 0; page < CLERK_MAX_PAGES; page += 1) {
    const data = await clerkApi(resource, {
      limit: String(CLERK_PAGE_SIZE),
      offset: String(page * CLERK_PAGE_SIZE),
    }, "GET");
    const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    result.push(...items);
    if (items.length < CLERK_PAGE_SIZE) break;
  }
  return result;
}

async function janitorClerkResources(clerkApi, deleteClerkResource) {
  const cutoff = Date.now() - STALE_RESOURCE_AGE_MS;
  let deletedOrganizations = 0;
  let deletedUsers = 0;
  try {
    // Delete organizations first so their stale memberships do not block user
    // deletion. A resource without a trustworthy creation timestamp is never
    // touched.
    const organizations = await listClerkCollection(clerkApi, "organizations");
    for (const organization of organizations) {
      const createdAt = resourceCreatedAtMs(organization);
      if (!isExplicitE2eOrganization(organization) || createdAt === null || createdAt >= cutoff) continue;
      const deleted = await deleteClerkResource(
        `https://api.clerk.com/v1/organizations/${encodeURIComponent(organization.id)}`,
        "stale organization",
      );
      if (deleted) deletedOrganizations += 1;
    }

    const users = await listClerkCollection(clerkApi, "users");
    for (const user of users) {
      const createdAt = resourceCreatedAtMs(user);
      if (!isExplicitE2eUser(user) || createdAt === null || createdAt >= cutoff) continue;
      const deleted = await deleteClerkResource(
        `https://api.clerk.com/v1/users/${encodeURIComponent(user.id)}`,
        "stale user",
      );
      if (deleted) deletedUsers += 1;
    }
    log("janitor", `removed ${deletedOrganizations} stale organizations and ${deletedUsers} stale users (age >= 24h)`);
  } catch (error) {
    // Stale cleanup is best-effort. Failing closed for provisioning remains
    // the important safety property; a temporary list failure must not cause
    // a run to delete anything outside the explicit namespace.
    log("janitor", `skipped (${error.message})`);
  }
}

export default async function globalSetup() {
  const mode = inferMode();
  const profile = inferProfile();
  const runId = makeRunNamespace();
  const authenticatedInternalServices = requireInternalAuthUrls();

  // ---- Fail-closed prerequisites -------------------------------------------
  must(
    CLERK_PUBLISHABLE,
    "authenticated browser E2E requires NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; no Clerk key is generated. Use playwright.public.config.ts for the secretless static lane",
  );
  must(
    CLERK_ISSUER && CLERK_ISSUER !== "https://",
    "could not derive the Clerk issuer (bad publishable key?) — set GATEWAY_CLERK_ISSUER explicitly",
  );
  must(
    CLERK_SECRET,
    "authenticated browser E2E requires CLERK_SECRET_KEY; no Clerk secret is generated. Use playwright.public.config.ts for the secretless static lane",
  );

  const gatewayBin = path.join(ROOT, "rust", "target", "release", "sync-gateway");
  must(fs.existsSync(gatewayBin), "sync-gateway release binary missing — run: (cd rust && cargo build --release)");
  const workerBin = path.join(ROOT, "build", "native", "worker", "concord-worker");
  must(fs.existsSync(workerBin), "concord-worker release binary missing — run: cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build/native --target concord-worker");
  must(fs.existsSync(path.join(ROOT, "public", "crdt-worker.js")), "public/crdt-worker.js missing — run: npm run wasm:build && npm run worker:bundle");
  must(fs.existsSync(NEXT_BIN), "Next.js binary missing — run: npm install");

  acquireRunLock(runId, profile);
  installProcessHandlers();
  globalThis.__e2eProcs = procs;

  try {

    const configuredGatewayPort = process.env.CONCORD_E2E_GATEWAY_PORT
      ? parsePort(process.env.CONCORD_E2E_GATEWAY_PORT, "CONCORD_E2E_GATEWAY_PORT")
      : 0;
    gatewayPort = configuredGatewayPort || await freePort("127.0.0.1");
    gatewayWs = `ws://127.0.0.1:${gatewayPort}/api/v1/sync`;
    // Production Next inlines NEXT_PUBLIC_* during `npm run build`, so the
    // gateway endpoint and web origin are resolved before that build. The
    // web origin also has to match the baseURL already resolved by Playwright.
    WEB_ORIGIN = resolveWebOrigin();
    requireStrictClaimPolicy(WEB_ORIGIN);

    if (authenticatedInternalServices) {
      execFileSync(process.execPath, [path.join(ROOT, "scripts/e2e/verify-infra-auth.mjs")], {
        cwd: ROOT,
        env: process.env,
        stdio: "inherit",
      });
      log("infra", "authenticated NATS JetStream and Redis ACL probes passed");
    } else {
      log(
        "infra",
        "using optional local broker URLs without credential-bearing probes; set CONCORD_E2E_REQUIRE_INTERNAL_AUTH=1 for the authenticated contract",
      );
    }

    // ---- 1. Clean concord_e2e database ------------------------------------
    const admin = new URL(E2E_DB);
    admin.pathname = "/postgres";
    const adminPool = new pkg.Pool({ connectionString: admin.toString() });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS concord_e2e WITH (FORCE)`);
      await adminPool.query(`CREATE DATABASE concord_e2e`);
    } finally {
      await adminPool.end();
    }
    log("db", "recreated concord_e2e");

    execFileSync(process.execPath, [path.join(ROOT, "scripts/db/migrate.mjs"), E2E_DB], {
      cwd: ROOT, stdio: "inherit",
    });
    log("db", "drizzle migrations applied");

    // ---- 1b. Provision E2E users + org (Clerk Backend API) ----------------
    // Users are email-verified on creation; the org satisfies the instance's
    // force_organization_selection so first sign-in completes without UI.
    // All throwaway test data on the project's own dev instance.
    const clerkApi = async (endpoint, params = {}, method = "POST") => {
      const url = new URL(`https://api.clerk.com/v1/${endpoint}`);
      const request = {
        method,
        headers: {
          Authorization: `Bearer ${CLERK_SECRET}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      };
      if (method === "GET") {
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      } else if (method !== "DELETE") {
        request.body = new URLSearchParams(params).toString();
      }
      const res = await fetch(url, request);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`clerk ${endpoint} -> ${res.status}`);
      return data;
    };
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
          return false;
        }
        return true;
      } catch (error) {
        console.warn(`[browser-e2e] cleanup: ${label} delete failed (${error.message})`);
        return false;
      }
    };
    authCleanupDone = false;
    cleanupAuth = async () => {
      if (authCleanupDone) return true;
      let complete = true;
      for (const organizationId of organizationIds) {
        if (!isSafeClerkId(organizationId)) {
          console.warn("[browser-e2e] cleanup: organization id was invalid; refusing to construct a delete URL");
          complete = false;
          continue;
        }
        const deleted = await deleteClerkResource(
          `https://api.clerk.com/v1/organizations/${encodeURIComponent(organizationId)}`,
          "organization",
        );
        if (!deleted) complete = false;
      }
      for (const record of Object.values(users)) {
        if (!isSafeClerkId(record.clerkUserId)) {
          console.warn("[browser-e2e] cleanup: user id was invalid; refusing to construct a delete URL");
          complete = false;
          continue;
        }
        const deleted = await deleteClerkResource(
          `https://api.clerk.com/v1/users/${encodeURIComponent(record.clerkUserId)}`,
          "user",
        );
        if (!deleted) complete = false;
      }
      authCleanupDone = complete;
      return complete;
    };

    await janitorClerkResources(clerkApi, deleteClerkResource);

    try {
      const labels = profileUserLabels(profile);
      for (const label of labels) {
        const email = `${E2E_EMAIL_PREFIX}${label}.${runId}${E2E_EMAIL_SUFFIX}`;
        const u = await clerkApi("users", {
          email_address: email,
          first_name: "Concord",
          last_name: "E2E",
          // Sign-in tickets authenticate these disposable users. Do not
          // manufacture password credentials that the test never consumes.
          // Clerk requires this explicit opt-out on password-enabled
          // instances; the dedicated E2E instance must retain a usable
          // non-password sign-in method for ticket completion.
          skip_password_requirement: "true",
          skip_session_creation: "true",
        });
        must(isSafeClerkId(u?.id), `Clerk user provisioning returned an invalid id for E2E label "${label}"`);
        users[label] = { clerkUserId: u.id, email };
      }
      // One org PER USER: the instance forces organization selection on first
      // sign-in (force_organization_selection), and the task completes only for
      // org members — so every E2E user must own an org before signing in.
      for (const [label, u] of Object.entries(users)) {
        const organization = await clerkApi("organizations", {
          name: `${E2E_ORG_PREFIX}${label} ${runId}`,
          created_by: u.clerkUserId,
        });
        must(
          isSafeClerkId(organization?.id),
          `Clerk organization provisioning returned an invalid id for E2E label "${label}"`,
        );
        organizationIds.push(organization.id);
      }
    } catch (error) {
      await cleanupAuthWithRetry();
      throw error;
    }
    log("clerk", `provisioned ${Object.keys(users).length} E2E users + per-user orgs (profile ${profile}, run ${runId})`);

    process.env.CONCORD_E2E_PROFILE = profile;
    const configuredAuthorizedParty = resolveRunOrigin(
      process.env.GATEWAY_CLERK_AUTHORIZED_PARTY,
      WEB_ORIGIN,
    );

    // ---- 2. Gateway (real Clerk issuer over HTTPS JWKS) --------------------
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
        // A credential-bearing test endpoint is meaningful only when the
        // gateway itself refuses to fall back to its local-only paths. Keep
        // ordinary developer runs permissive, but make the trusted CI mode
        // exercise the same fail-closed contract as cloud gateways.
        ...(authenticatedInternalServices
          ? { GATEWAY_REQUIRE_INTERNAL_SERVICES: "true" }
          : {}),
        ...(process.env.GATEWAY_CLERK_AUDIENCE
          ? { GATEWAY_CLERK_AUDIENCE: process.env.GATEWAY_CLERK_AUDIENCE }
          : {}),
        ...(configuredAuthorizedParty
          ? { GATEWAY_CLERK_AUTHORIZED_PARTY: configuredAuthorizedParty }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(gateway);
    gateway.stdout.on("data", (d) => process.env.CONCORD_E2E_VERBOSE === "1" && process.stdout.write(`[gateway] ${d}`));
    gateway.stderr.on("data", (d) => process.stdout.write(`[gateway:err] ${d}`));
    await probeHttp(
      `http://127.0.0.1:${gatewayPort}/api/v1/health/ready`,
      30_000,
      "gateway readiness",
      gateway,
      (status) => status === 200,
    );
    log("gateway", `ready on 127.0.0.1:${gatewayPort} (issuer configured)`);

    // ---- 3. Next.js web tier -----------------------------------------------
    // Public values must be present in the environment before a production
    // build: Next inlines NEXT_PUBLIC_* into the client bundle. Dev keeps the
    // previous hot-reload behavior and reads the same values at runtime.
    const webEnv = {
      ...process.env,
      NEXT_PUBLIC_SYNC_GATEWAY_URL: gatewayWs,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: CLERK_PUBLISHABLE,
      CLERK_SECRET_KEY: CLERK_SECRET,
      DATABASE_URL: E2E_DB,
      NEXT_TELEMETRY_DISABLED: "1",
      ...(resolveRunOrigin(process.env.CONCORD_APP_ORIGIN, WEB_ORIGIN)
        ? { CONCORD_APP_ORIGIN: resolveRunOrigin(process.env.CONCORD_APP_ORIGIN, WEB_ORIGIN) }
        : {}),
      CONCORD_REQUIRE_TLS: "0",
    };
    let web;
    if (mode === "production") {
      log("web", "building production Next app");
      execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
        cwd: ROOT,
        // The repository's next.config.ts emits standalone output whenever
        // VERCEL is falsey. Do not let a developer/runner's ambient VERCEL=1
        // switch this verification onto a different deployment shape.
        env: { ...webEnv, NODE_ENV: "production", VERCEL: "" },
        stdio: "inherit",
      });
      // This checkout's Next configuration emits standalone output outside
      // Vercel. `next start` rejects that output by design; stage the static
      // and public trees exactly as docker/web.Dockerfile does, then run the
      // generated standalone server that release images actually execute.
      const standaloneServer = stageStandalone(ROOT);
      web = spawn(process.execPath, [standaloneServer], {
        cwd: ROOT,
        env: { ...webEnv, NODE_ENV: "production", VERCEL: "", HOSTNAME: "0.0.0.0", PORT: String(webPort) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      web = spawn(process.execPath, [NEXT_BIN, "dev", "--port", String(webPort)], {
        cwd: ROOT,
        env: webEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    procs.push(web);
    web.stdout.on("data", (d) => process.env.CONCORD_E2E_VERBOSE === "1" && process.stdout.write(`[web] ${d}`));
    web.stderr.on("data", (d) => process.env.CONCORD_E2E_VERBOSE === "1" && process.stderr.write(`[web:err] ${d}`));
    // Probe a static asset so the readiness check cannot invoke auth() before
    // Next has loaded proxy.ts during its first app-route compilation.
    const webReadinessTimeout = mode === "production" ? 60_000 : 90_000;
    await probeHttp(`${WEB_ORIGIN}/icon.svg`, webReadinessTimeout, "web static asset", web, (status) => status === 200);
    // These probes both prime the dev compiler and verify the production
    // standalone server serves the entry route and the actual worker asset.
    await probeHttp(`${WEB_ORIGIN}/`, webReadinessTimeout, "web app", web);
    await probeHttp(`${WEB_ORIGIN}/crdt-worker.js`, webReadinessTimeout, "web worker asset", web, (status) => status === 200);
    log("web", `up on ${WEB_ORIGIN} (mode ${mode})`);

    // Expose the endpoints to the specs via env (Playwright re-reads env in workers).
    process.env.CONCORD_E2E_BASE_URL = WEB_ORIGIN;
    process.env.CONCORD_E2E_GATEWAY_WS = gatewayWs;
    process.env.CONCORD_E2E_DB = E2E_DB;
    process.env.CONCORD_E2E_ISSUER = CLERK_ISSUER;
    process.env.CONCORD_E2E_USERS = JSON.stringify(users);
    process.env.CONCORD_E2E_RUN_ID = runId;
    process.env.CONCORD_E2E_MODE = mode;

    return async () => {
      await stopProcesses();
      await cleanupAuthWithRetry();
      releaseRunLock();
    };
  } catch (error) {
    await stopProcesses();
    await cleanupAuthWithRetry();
    releaseRunLock();
    throw error;
  }
}

export async function teardown() {
  await stopProcesses();
  await cleanupAuthWithRetry();
  releaseRunLock();
}
