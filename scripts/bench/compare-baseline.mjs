#!/usr/bin/env node
// P6-M042 — Performance-regression baseline comparator (SA-CI6).
//
// Compares a results directory (M007 `concord.bench.result/1` result.json
// files, e.g. from scripts/bench/run-throughput.mjs or a downloaded CI
// artifact) against a baseline (file-or-dir of result.jsons in the same
// schema), matching cells by id and flagging regressions:
//
//   - ack p95 latency (ms):   regression when it grows by > threshold-pct
//   - throughput (ops/sec):   regression when it shrinks by > threshold-pct
//
// Environment honesty (prompt §8 / benchmark-matrix.md run discipline):
//   - Every result.json embeds the M006 environment snapshot. When the two
//     sides come from DIFFERENT machines (os.arch + hardware.model +
//     hardware.cpuModel all compared), numbers are NOT comparable as
//     headline evidence — the tool refuses to silently gate on them:
//     by default it WARNS LOUDLY and marks every compared cell
//     `envMismatch: true`, and the verdict carries `"envComparable":
//     false`. Pass `--force` to compare anyway (CI trend detection across
//     runner generations uses this deliberately, with the mismatch
//     recorded in the verdict JSON).
//   - Correctness gate first: any cell whose `correctnessGatePassed` is
//     false is a REGRESSION regardless of latency/throughput deltas.
//
// Baseline storage (paths are plain args — the tool stays agnostic):
//   - LOCAL: .agent/bench/baselines/<name>/   (git-ignored)
//   - CI:    a downloaded artifact dir from a pinned release tag
//
// Usage:
//   node scripts/bench/compare-baseline.mjs \
//     --results  <dir>          (or a single result.json)
//     --baseline <file-or-dir>
//     [--threshold-pct 25]     (default 25)
//     [--json out]              (also write machine-readable verdict file)
//     [--force]                 (compare despite environment mismatch)
//     [--quiet]                 (human summary only; no per-cell table)
//
// Exit codes: 0 = clean / only improvements; 1 = regression detected;
// 2 = usage error or unreadable inputs. NEVER exits non-zero for an
// environment mismatch alone (that would hide real regressions behind
// infrastructure noise) unless --force is absent AND every matched cell
// is env-mismatched, in which case exit 0 with a LOUD warning — a human
// reads the verdict and re-runs like-for-like.

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function argValue(name, { required = false, fallback = null } = {}) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) {
    if (required) {
      console.error(`compare-baseline: missing required --${name}`);
      process.exit(2);
    }
    return fallback;
  }
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`compare-baseline: --${name} requires a value`);
    process.exit(2);
  }
  return v;
}

const RESULTS = argValue("results", { required: true });
const BASELINE = argValue("baseline", { required: true });
const THRESHOLD_PCT = Number(argValue("threshold-pct", { fallback: "25" }));
const JSON_OUT = argValue("json", { fallback: null });
const FORCE = process.argv.includes("--force");
const QUIET = process.argv.includes("--quiet");

if (!Number.isFinite(THRESHOLD_PCT) || THRESHOLD_PCT <= 0) {
  console.error(`compare-baseline: --threshold-pct must be a positive number (got ${THRESHOLD_PCT})`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Loading: accept a single result.json OR a directory of *.result.json /
// result.json files (M007 schema).
// ---------------------------------------------------------------------------
function loadResultsFrom(target, side) {
  if (!existsSync(target)) {
    console.error(`compare-baseline: ${side} path not found: ${target}`);
    process.exit(2);
  }
  const files = [];
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const name of readdirSync(target).sort()) {
      if (name.endsWith(".result.json") || name === "result.json") files.push(path.join(target, name));
    }
  } else {
    files.push(target);
  }
  if (files.length === 0) {
    console.error(`compare-baseline: ${side} dir has no result.json files: ${target}`);
    process.exit(2);
  }
  const results = new Map(); // cell id -> result object (first wins; duplicate cell = reported)
  const duplicates = [];
  for (const f of files) {
    let obj;
    try {
      obj = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      console.error(`compare-baseline: unparseable JSON in ${f}: ${e.message}`);
      process.exit(2);
    }
    if (obj?.schema !== "concord.bench.result/1") {
      console.error(`compare-baseline: ${f} is not an M007 result (schema: ${obj?.schema})`);
      process.exit(2);
    }
    if (results.has(obj.cell)) duplicates.push(obj.cell);
    else results.set(obj.cell, obj);
  }
  return { results, files, duplicates };
}

// ---------------------------------------------------------------------------
// Environment comparability: same os.arch + hardware model + cpu model.
// Missing hardware fields (capture-env on an unsupported platform) count
// as unknown, not mismatch — but at least os.arch must match.
// ---------------------------------------------------------------------------
function envKey(env) {
  const hw = env?.hardware ?? {};
  const os = env?.os ?? {};
  return [
    os.arch ?? "?",
    hw.model ?? "?",
    hw.cpuModel ?? "?",
    hw.cores ?? "?",
  ].join("|");
}

function envDescription(env) {
  const hw = env?.hardware ?? {};
  const os = env?.os ?? {};
  return [
    os.platform === "darwin" ? "macOS" : os.platform ?? "?",
    os.arch ?? "?",
    hw.cpuModel ?? "unknown-cpu",
    hw.model ? `(${hw.model})` : "",
  ].filter(Boolean).join(" ");
}

function envComparable(a, b) {
  // Unknown-vs-unknown hardware on the same arch is comparable-enough to
  // compare with a warning; different arch is a hard mismatch.
  if ((a?.os?.arch ?? "?") !== (b?.os?.arch ?? "?")) return false;
  const ka = envKey(a);
  const kb = envKey(b);
  if (ka === kb) return true;
  // Same arch, one side missing hardware info: comparable-with-warning.
  const aUnknown = (a?.hardware?.model ?? null) === null || (a?.hardware?.cpuModel ?? null) === null;
  const bUnknown = (b?.hardware?.model ?? null) === null || (b?.hardware?.cpuModel ?? null) === null;
  return aUnknown || bUnknown;
}

// ---------------------------------------------------------------------------
// Per-cell comparison
// ---------------------------------------------------------------------------
function pct(from, to) {
  if (!Number.isFinite(from) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

function compareCell(cell, cur, base, envMismatch) {
  const notes = [];
  const verdict = {
    cell,
    baselineRunId: base.environment?.runId ?? null,
    resultsRunId: cur.environment?.runId ?? null,
    envMismatch,
    correctness: "pass",
    ackP95: null,
    throughput: null,
    regression: false,
    notes,
  };

  // Correctness gate dominates: a failed gate is a regression no matter
  // what the timings say (benchmark-matrix.md: "no silent discards").
  if (cur.correctnessGatePassed === false || base.correctnessGatePassed === false) {
    verdict.correctness = cur.correctnessGatePassed === false ? "fail(current)" : "fail(baseline)";
    verdict.regression = true;
    notes.push(`correctnessGatePassed: baseline=${base.correctnessGatePassed} current=${cur.correctnessGatePassed}`);
  }

  const baseP95 = base.ackLatencyMs?.p95;
  const curP95 = cur.ackLatencyMs?.p95;
  if (Number.isFinite(baseP95) && Number.isFinite(curP95)) {
    const delta = pct(baseP95, curP95);
    verdict.ackP95 = { baselineMs: baseP95, currentMs: curP95, deltaPct: delta };
    // Latency UP is a regression.
    if (delta !== null && delta > THRESHOLD_PCT) {
      verdict.regression = true;
      notes.push(`ack p95 latency up ${delta.toFixed(1)}% (${baseP95}ms → ${curP95}ms, threshold ${THRESHOLD_PCT}%)`);
    }
  } else {
    notes.push("ackLatencyMs.p95 missing on one side — latency not compared");
  }

  const baseThr = base.throughputOpsPerSec;
  const curThr = cur.throughputOpsPerSec;
  if (Number.isFinite(baseThr) && Number.isFinite(curThr)) {
    const delta = pct(baseThr, curThr);
    verdict.throughput = { baselineOpsPerSec: baseThr, currentOpsPerSec: curThr, deltaPct: delta };
    // Throughput DOWN is a regression.
    if (delta !== null && delta < -THRESHOLD_PCT) {
      verdict.regression = true;
      notes.push(`throughput down ${(-delta).toFixed(1)}% (${baseThr} → ${curThr} ops/s, threshold ${THRESHOLD_PCT}%)`);
    }
  } else {
    notes.push("throughputOpsPerSec missing on one side — throughput not compared");
  }

  if (envMismatch) {
    notes.push(
      `ENVIRONMENT MISMATCH: baseline ran on ${envDescription(base.environment)}; ` +
        `current on ${envDescription(cur.environment)} — timing deltas across machines are NOT headline evidence`,
    );
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const curSide = loadResultsFrom(RESULTS, "--results");
const baseSide = loadResultsFrom(BASELINE, "--baseline");

const cells = [...new Set([...curSide.results.keys(), ...baseSide.results.keys()])].sort();
const cellVerdicts = [];
const regressions = [];
const onlyIn = { results: [], baseline: [] };

// Any single environment snapshot per side is representative of the side's
// machine (all results in one run share one env). Compare pairwise per cell
// so a mixed-machine directory still gets honest per-cell mismatches.
let envComparableOverall = true;

for (const cell of cells) {
  const cur = curSide.results.get(cell);
  const base = baseSide.results.get(cell);
  if (!cur) { onlyIn.baseline.push(cell); continue; }
  if (!base) { onlyIn.results.push(cell); continue; }
  const mismatch = !envComparable(cur.environment, base.environment);
  if (mismatch) envComparableOverall = false;
  const v = compareCell(cell, cur, base, mismatch);
  cellVerdicts.push(v);
  if (v.regression) regressions.push(v);
}

const verdict = {
  schema: "concord.bench.comparison/1",
  resultsPath: RESULTS,
  baselinePath: BASELINE,
  thresholdPct: THRESHOLD_PCT,
  envComparable: envComparableOverall,
  forced: FORCE && !envComparableOverall,
  baselineEnv: baseSide.results.size
    ? envDescription(baseSide.results.values().next().value.environment)
    : "n/a",
  resultsEnv: curSide.results.size
    ? envDescription(curSide.results.values().next().value.environment)
    : "n/a",
  matchedCells: cellVerdicts.length,
  regressionCells: regressions.map((r) => r.cell),
  cellsMissingInResults: onlyIn.baseline,
  cellsMissingInBaseline: onlyIn.results,
  duplicateCellsInInputs: [...new Set([...curSide.duplicates, ...baseSide.duplicates])],
  verdict: regressions.length === 0 ? "CLEAN" : "REGRESSION",
  details: cellVerdicts,
};

// ---------------------------------------------------------------------------
// Human summary (honest, loud on mismatch, never hides regressions)
// ---------------------------------------------------------------------------
if (!QUIET) {
  console.log(`compare-baseline: ${cellVerdicts.length} matched cell(s), threshold ${THRESHOLD_PCT}%`);
  console.log(`  baseline: ${BASELINE} [${verdict.baselineEnv}]`);
  console.log(`  results:  ${RESULTS} [${verdict.resultsEnv}]`);
  if (onlyIn.baseline.length) console.log(`  only in baseline (skipped): ${onlyIn.baseline.join(", ")}`);
  if (onlyIn.results.length) console.log(`  only in results (new cells, no baseline yet): ${onlyIn.results.join(", ")}`);
  if (verdict.duplicateCellsInInputs.length) {
    console.log(`  WARNING duplicate cell ids in inputs (first file wins): ${verdict.duplicateCellsInInputs.join(", ")}`);
  }
  for (const v of cellVerdicts) {
    const p95 = v.ackP95 ? `${v.ackP95.baselineMs.toFixed(2)}→${v.ackP95.currentMs.toFixed(2)}ms (${v.ackP95.deltaPct >= 0 ? "+" : ""}${v.ackP95.deltaPct?.toFixed(1)}%)` : "n/a";
    const thr = v.throughput ? `${v.throughput.baselineOpsPerSec.toFixed(1)}→${v.throughput.currentOpsPerSec.toFixed(1)} ops/s (${v.throughput.deltaPct >= 0 ? "+" : ""}${v.throughput.deltaPct?.toFixed(1)}%)` : "n/a";
    const flag = v.regression ? "REGRESSION" : v.envMismatch ? "mismatch" : "ok";
    console.log(`  [${flag.padEnd(10)}] ${v.cell}: ack p95 ${p95}; throughput ${thr}`);
    for (const n of v.notes) console.log(`      - ${n}`);
  }
  if (!envComparableOverall) {
    console.log("");
    console.log("  ============================ ENVIRONMENT MISMATCH ============================");
    console.log("  Baseline and results come from DIFFERENT machines.");
    console.log("  Timing deltas above are cross-machine and are NOT valid headline evidence.");
    console.log("  Compare like-with-like (same os.arch + hardware model), or re-run on the");
    console.log("  baseline machine. CI trend detection may pass --force to record deltas.");
    console.log("  ==============================================================================");
  }
  console.log("");
  if (regressions.length === 0) {
    console.log(`verdict: CLEAN — no cell regressed beyond ${THRESHOLD_PCT}%`);
  } else {
    console.log(`verdict: REGRESSION — ${regressions.length} cell(s) beyond ${THRESHOLD_PCT}%:`);
    for (const r of regressions) console.log(`  - ${r.cell}: ${r.notes.join("; ")}`);
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(verdict, null, 2) + "\n");
  if (!QUIET) console.log(`machine-readable verdict written: ${JSON_OUT}`);
}

process.exit(regressions.length > 0 ? 1 : 0);
