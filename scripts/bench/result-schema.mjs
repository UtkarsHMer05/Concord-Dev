// P6-M007 — Machine-readable benchmark result schema (shared contract).
//
// Every Phase 6 benchmark harness must emit a JSON object conforming to
// `BenchResult` below (serialization is plain JSON; this module is the
// executable contract + validator used by tooling such as the M042
// regression comparator).
//
// Storage convention:
//   .agent/bench/runs/<runId>/   — raw artifacts (git-ignored)
//   result.json carries the environment snapshot inline (from M006
//   scripts/bench/capture-env.mjs).

/**
 * @typedef {object} BenchEnvironment
 * @property {string} runId
 * @property {string} label
 * @property {string} capturedAt
 * @property {object} git
 * @property {string} git.commit
 * @property {boolean} git.dirty
 */

/**
 * @typedef {object} BenchLatency
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 */

/** Throughput/error counters for one measured window. */
export class BenchResult {
  /**
   * @param {object} init
   * @param {string} init.benchmark       e.g. "BM-THROUGHPUT" | "BM-RECOVERY" | "BM-BROWSER"
   * @param {string} init.cell            workload cell id, e.g. "gw1-c10-d20-low"
   * @param {object} init.workload         { gateways, clients, docs, opsPerSecTarget, seconds, historyOps, tailOps, contention, warmupSeconds }
   * @param {object} init.environment      M006 env snapshot (embed verbatim)
   * @param {number} init.durationMs
   * @param {number} init.operationCount
   * @param {number} init.errorCount
   * @param {number|null} init.throughputOpsPerSec   measured sustained rate (null if not applicable)
   * @param {BenchLatency|null} init.ackLatencyMs
   * @param {BenchLatency|null} init.propagationLatencyMs
   * @param {BenchLatency|null} init.recoveryTimeMs
   * @property {object} init.resources     { cpuPercent, rssBytes, networkBytes }
   * @param {string[]} init.notes           incl. any discarded-run reasons (never silent)
   * @param {boolean} init.correctnessGatePassed  convergence digest / invariants
   */
  constructor(init) {
    this.schema = "concord.bench.result/1";
    this.benchmark = init.benchmark;
    this.cell = init.cell;
    this.workload = init.workload;
    this.environment = init.environment;
    this.durationMs = init.durationMs;
    this.operationCount = init.operationCount;
    this.errorCount = init.errorCount;
    this.throughputOpsPerSec = init.throughputOpsPerSec ?? null;
    this.ackLatencyMs = init.ackLatencyMs ?? null;
    this.propagationLatencyMs = init.propagationLatencyMs ?? null;
    this.recoveryTimeMs = init.recoveryTimeMs ?? null;
    this.resources = init.resources ?? { cpuPercent: null, rssBytes: null, networkBytes: null };
    this.notes = init.notes ?? [];
    this.correctnessGatePassed = init.correctnessGatePassed;
    this.capturedAt = new Date().toISOString();
  }

  toJSON() {
    return { ...this };
  }
}

/** Validate a parsed result.json; returns { ok, errors[] }. */
export function validateBenchResult(obj) {
  const errors = [];
  const req = (field) => {
    if (obj?.[field] === undefined || obj?.[field] === null) errors.push(`missing ${field}`);
  };
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["not an object"] };
  for (const f of ["schema", "benchmark", "cell", "workload", "environment", "durationMs", "operationCount", "errorCount", "correctnessGatePassed", "capturedAt"]) req(f);
  if (obj.schema !== "concord.bench.result/1") errors.push("schema mismatch");
  if (obj.environment?.runId === undefined) errors.push("environment.runId missing (M006 capture required)");
  if (obj.environment?.git?.commit === undefined) errors.push("environment.git.commit missing");
  for (const lat of ["ackLatencyMs", "propagationLatencyMs", "recoveryTimeMs"]) {
    if (obj[lat] && (obj[lat].p50 === undefined || obj[lat].p95 === undefined)) errors.push(`${lat} must carry p50/p95`);
  }
  return { ok: errors.length === 0, errors };
}

// CLI: validate result.json files passed as args.
if (import.meta.filename === process.argv[1]) {
  const { readFileSync } = await import("node:fs");
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node scripts/bench/result-schema.mjs <result.json>...");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const v = validateBenchResult(JSON.parse(readFileSync(f, "utf8")));
    console.log(`${v.ok ? "OK  " : "FAIL"} ${f}${v.ok ? "" : " — " + v.errors.join("; ")}`);
    if (!v.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}
