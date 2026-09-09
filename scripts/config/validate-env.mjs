#!/usr/bin/env node
// P7-M013 — Environment contract validator (executable half of
// docs/CONFIGURATION.md).
//
// Validates that the CURRENT process environment (or an env file via
// --env-file) contains every variable a given deployment scope needs —
// presence + FORMAT only. Never reads, prints, or checks secret VALUES;
// secrets are only ever reported as "present"/"missing"/"malformed".
//
// The matrix below is hand-synced with the source contracts:
//   - web:     src/server/env.ts (zod schema)
//   - gateway: rust/sync-gateway/src/config.rs (fail-fast Config::from_env,
//              exit code 2 on config errors) + GATEWAY_RATE_CONNECT_PER_MIN
//              (ephemeral/ratelimit.rs, optional, invalid = silently kept
//              default) + RUST_LOG (tracing filter)
//   - worker:  GATEWAY_WORKER_BINARY path contract (config.rs validates it
//              is a readable FILE when set)
// When the source contracts change, this matrix must change with them —
// docs/CONFIGURATION.md documents the same matrix in prose.
//
// Usage:
//   node scripts/config/validate-env.mjs                     # dev scope
//   node scripts/config/validate-env.mjs --scope prod
//   node scripts/config/validate-env.mjs --env-file .env.local
//   node scripts/config/validate-env.mjs --scope prod --json # CI-friendly
//
// Exit codes: 0 = pass, 1 = missing/invalid variables (names printed).

import fs from "node:fs";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Variable matrix. required: which scopes need it. kind: secret | public.
// format: presence-only unless a format function is given.
// ---------------------------------------------------------------------------

const POSTGRES_URL = (v) => /^postgres(ql)?:\/\/\S+/.test(v);
const HTTPS_URL = (v) => /^https:\/\/\S+/.test(v);
const WS_URL = (v) => /^(nats|redis):\/\/\S+/.test(v);
const POSITIVE_INT = (v) => /^\d+$/.test(v) && Number(v) >= 1;
const PORT = (v) => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536;
const IP_ADDR = (v) =>
  /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(v) &&
  v.split(".").every((o) => Number(o) <= 255);
const BOOLEAN = (v) => /^(true|false)$/i.test(v);
const RATIO = (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) >= 0 && Number(v) <= 1;
const CLERK_PUBLISHABLE = (v) => /^pk_(test|live)_[A-Za-z0-9_-]+$/.test(v);
const CLERK_SECRET = (v) => /^sk_(test|live)_[A-Za-z0-9_-]+$/.test(v);
const CLERK_ISSUER = (v) => /^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev\/?$/.test(v) ||
  /^https:\/\/clerk\.[a-z0-9.-]+\/?$/.test(v);

/**
 * @typedef {Object} VarSpec
 * @property {string} service - web | gateway | infra
 * @property {string[]} required - scopes where the variable is required
 * @property {"secret"|"public"} kind
 * @property {string} what - human description (no values)
 * @property {string} failure - what happens when missing/invalid
 * @property {(v: string) => boolean} [format] - format check (presence-only when absent)
 */

/** @type {Record<string, VarSpec>} */
const MATRIX = {
  // --- web app (src/server/env.ts zod contract) ---------------------------
  DATABASE_URL: {
    service: "web",
    required: ["dev", "staging", "prod"],
    kind: "secret",
    what: "PostgreSQL connection string for the web app (drizzle/pg pool)",
    failure: "getServerEnv() throws on first server-side data access (zod min(1) + postgres:// regex)",
    format: POSTGRES_URL,
  },
  CLERK_SECRET_KEY: {
    service: "web",
    required: ["dev", "staging", "prod"],
    kind: "secret",
    what: "Clerk server API key (backend auth calls; never in the client bundle)",
    failure: "zod min(1) fails -> getServerEnv() throws; Clerk backend calls fail",
    format: CLERK_SECRET,
  },
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: {
    service: "web",
    required: ["dev", "staging", "prod"],
    kind: "public",
    what: "Clerk publishable key (browser-visible by design, NEXT_PUBLIC_ prefix)",
    failure: "zod min(1) fails -> getServerEnv() throws; ClerkProvider cannot initialize",
    format: CLERK_PUBLISHABLE,
  },
  DATABASE_TEST_URL: {
    service: "web",
    required: [], // test harnesses only
    kind: "secret",
    what: "PostgreSQL URL for the isolated test DB (integration tests; never prod data)",
    failure: "scripts/db/migrate.mjs --test and integration suites refuse to run",
    format: POSTGRES_URL,
  },

  // --- gateway (rust/sync-gateway/src/config.rs) ---------------------------
  GATEWAY_DATABASE_URL: {
    service: "gateway",
    required: ["dev", "staging", "prod"],
    kind: "secret",
    what: "PostgreSQL connection string for the gateway (durable op log)",
    failure: "ConfigError::Missing -> process exit 2 before anything starts",
    format: POSTGRES_URL,
  },
  GATEWAY_CLERK_ISSUER: {
    service: "gateway",
    required: ["dev", "staging", "prod"],
    kind: "public",
    what: "Clerk JWT issuer (https://<instance>.clerk.accounts.dev or https://clerk.<domain>)",
    failure: "ConfigError::Missing -> process exit 2; JWKS fetch fails -> every authenticate is rejected",
    format: CLERK_ISSUER,
  },
  GATEWAY_BIND_HOST: {
    service: "gateway",
    required: ["staging", "prod"], // containers must bind 0.0.0.0
    kind: "public",
    what: "TCP bind host; MUST be an IP literal (containers: 0.0.0.0)",
    failure: "hostname (e.g. localhost) -> ConfigError::Invalid, exit 2 (fail-fast, not a panic in main)",
    format: IP_ADDR,
  },
  GATEWAY_BIND_PORT: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "TCP bind port (default 8787; compose/gateway-cluster use 8791-8793)",
    failure: "non-numeric -> ConfigError::Invalid, exit 2",
    format: PORT,
  },
  GATEWAY_ALLOWED_ORIGINS: {
    service: "gateway",
    required: ["staging", "prod"],
    kind: "public",
    what: "Comma-separated browser origins allowed to open WebSockets (default http://localhost:3000)",
    failure: "missing in prod = only localhost accepted: real browser origins rejected on upgrade",
  },
  GATEWAY_MAX_FRAME_SIZE: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Max accepted WS frame bytes (default 8 MiB, min 1024; PROTOCOL 9.11)",
    failure: "< 1024 or non-numeric -> ConfigError::Invalid, exit 2",
    format: POSITIVE_INT,
  },
  GATEWAY_QUEUE_CAPACITY: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Per-connection outbound frame queue (default 512, must be >= 1)",
    failure: "0 or non-numeric -> ConfigError::Invalid, exit 2",
    format: POSITIVE_INT,
  },
  GATEWAY_HEARTBEAT_INTERVAL_SECS: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Server->client heartbeat interval seconds (default 30)",
    failure: "non-numeric -> ConfigError::Invalid, exit 2",
    format: POSITIVE_INT,
  },
  GATEWAY_IDLE_TIMEOUT_SECS: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Idle connection drop timeout seconds (default 120)",
    failure: "non-numeric -> ConfigError::Invalid, exit 2",
    format: POSITIVE_INT,
  },
  GATEWAY_DB_POOL_SIZE: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "PostgreSQL pool connections per gateway (default 8, must be >= 1)",
    failure: "0 or non-numeric -> ConfigError::Invalid, exit 2",
    format: POSITIVE_INT,
  },
  GATEWAY_JWKS_FILE: {
    service: "gateway",
    required: [],
    kind: "secret",
    what: "Optional local JWKS file — dev/E2E ONLY (never production; prod uses HTTPS issuer)",
    failure: "file unreadable -> token verification fails closed (all auth rejected)",
  },
  GATEWAY_NATS_URL: {
    service: "gateway",
    required: ["staging", "prod"], // distributed mode expected beyond dev
    kind: "secret",
    what: "NATS URL; absent = single-gateway mode (no cross-gateway fanout)",
    failure: "unreachable -> fail-soft: local clients still served, cross-gateway degraded",
    format: WS_URL,
  },
  GATEWAY_NATS_SUBJECT_PREFIX: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "NATS subject namespace (default concord.dev; names the JetStream stream + subjects)",
    failure: "absent = default namespace used; all gateways in one deployment MUST share one prefix",
  },
  GATEWAY_ID: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Stable per-process gateway identity (logs/origin suppression/metrics; not correctness)",
    failure: "non-u64 -> ConfigError::Invalid, exit 2; absent = generated (nonzero)",
    format: POSITIVE_INT,
  },
  GATEWAY_REDIS_URL: {
    service: "gateway",
    required: [], // presence optional by design (ephemeral tier)
    kind: "secret",
    what: "Redis URL; absent = local-only rate limiting, presence disabled",
    failure: "unreachable -> fail-soft (rate limiting local, presence off)",
    format: WS_URL,
  },
  GATEWAY_RATE_CONNECT_PER_MIN: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Connect-rate budget per minute (default 240; overrides the connect policy)",
    failure: "invalid/absent value is silently ignored (default kept) — no startup failure",
    format: POSITIVE_INT,
  },
  GATEWAY_OTEL_ENABLED: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "OpenTelemetry tracing toggle (default false = zero behavior change)",
    failure: "non-boolean -> ConfigError::Invalid, exit 2",
    format: BOOLEAN,
  },
  GATEWAY_OTEL_ENDPOINT: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "OTLP collector endpoint (default http://127.0.0.1:4317)",
    failure: "absent = loopback default; unreachable collector = spans dropped after timeout",
  },
  GATEWAY_OTEL_SAMPLE_RATIO: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Parent-based sampling ratio [0.0, 1.0] (default 1.0)",
    failure: "outside [0,1] or non-numeric -> ConfigError::Invalid, exit 2",
    format: RATIO,
  },
  GATEWAY_OTEL_EXPORTER: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "OTel exporter: otlp (default) | stdout | memory (tests)",
    failure: "unknown value -> ConfigError::Invalid, exit 2",
    format: (v) => ["otlp", "stdout", "memory"].includes(v.toLowerCase()),
  },
  GATEWAY_DEBUG_OP_IDS: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "Debug op-id attribution in spans/logs (default false; bounded cardinality)",
    failure: "non-boolean -> ConfigError::Invalid, exit 2",
    format: BOOLEAN,
  },
  GATEWAY_WORKER_BINARY: {
    service: "gateway",
    required: ["prod"], // maintenance must run in prod; optional dev/staging
    kind: "public",
    what: "Path to the native maintenance worker; absent = maintenance scheduler OFF",
    failure: "path set but not a readable file -> ConfigError::Invalid, exit 2",
    format: (v) => fs.existsSync(v) && fs.statSync(v).isFile(),
  },
  RUST_LOG: {
    service: "gateway",
    required: [],
    kind: "public",
    what: "tracing filter (default info; e.g. sync_gateway=debug)",
    failure: "invalid directive string -> tracing falls back gracefully / logs error",
  },
};

const SCOPES = ["dev", "staging", "prod"];

// ---------------------------------------------------------------------------
// Env-file loading (format: KEY=VALUE lines, # comments, no interpolation).
// ---------------------------------------------------------------------------

function parseEnvFile(path) {
  const out = {};
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

const { values: argv } = parseArgs({
  options: {
    scope: { type: "string", default: "dev" },
    "env-file": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (argv.help) {
  console.log(`Usage: node scripts/config/validate-env.mjs [--scope dev|staging|prod] [--env-file FILE] [--json]

Validates presence + format (never values) of every environment variable
the chosen scope requires. Matrix source of truth: docs/CONFIGURATION.md.`);
  process.exit(0);
}

const scope = argv.scope;
if (!SCOPES.includes(scope)) {
  console.error(`error: unknown scope "${scope}" (expected one of: ${SCOPES.join(", ")})`);
  process.exit(1);
}

let fileEnv = {};
if (argv["env-file"]) {
  if (!fs.existsSync(argv["env-file"])) {
    console.error(`error: env file not found: ${argv["env-file"]}`);
    process.exit(1);
  }
  fileEnv = parseEnvFile(argv["env-file"]);
}

// Precedence: real environment wins over the env file (matches how the
// processes actually read config — env-file supplies what the environment
// lacks, never overrides deployed secrets).
const env = { ...fileEnv, ...process.env };

const missing = [];
const malformed = [];

for (const [name, spec] of Object.entries(MATRIX)) {
  const value = env[name];
  const requiredHere = spec.required.includes(scope);
  const isSet = value !== undefined && value !== "";

  if (requiredHere && !isSet) {
    missing.push(name);
    continue;
  }
  if (!isSet) continue; // optional here
  if (spec.format && !spec.format(String(value))) {
    malformed.push(name);
  }
}

// Scoping note: --env-file + dev scope by default mirrors the local dev
// flow (.env.local). GATEWAY_* values belong to gateway deployments; a dev
// scope check passes them as OPTIONAL (absence = single-gateway mode) but
// still validates FORMAT when present.

if (argv.json) {
  console.log(
    JSON.stringify(
      {
        scope,
        envFile: argv["env-file"] ?? null,
        checked: Object.keys(MATRIX).length,
        missing,
        malformed,
        result: missing.length === 0 && malformed.length === 0 ? "pass" : "fail",
      },
      null,
      2,
    ),
  );
} else {
  console.log(`scope: ${scope}${argv["env-file"] ? ` (env file: ${argv["env-file"]})` : ""}`);
  for (const name of missing) {
    console.log(`  MISSING   ${name} — ${MATRIX[name].what}`);
  }
  for (const name of malformed) {
    console.log(`  MALFORMED ${name} — ${MATRIX[name].what}`);
  }
  if (missing.length === 0 && malformed.length === 0) {
    console.log(
      `OK: ${Object.keys(MATRIX).length} variables checked — all required-for-${scope} present, all set values well-formed.`,
    );
  } else {
    console.log(`FAIL: ${missing.length} missing, ${malformed.length} malformed.`);
    console.log("Full matrix with failure behavior per variable: docs/CONFIGURATION.md");
  }
}

if (missing.length > 0 || malformed.length > 0) {
  process.exit(1);
}
