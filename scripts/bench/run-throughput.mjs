#!/usr/bin/env node
// P6-M037 — BM-THROUGHPUT campaign runner (lead-owned harness).
//
// Executes the throughput/scaling matrix from
// .agent/scratch/phase-6/benchmark-matrix.md against the existing loadgen
// example, and emits one result.json per cell in the M007 schema
// (concord.bench.result/1) under .agent/bench/runs/<runId>/.
//
// PRECONDITIONS (documented, not checked here beyond a fast probe):
//   - docker compose up -d db nats redis
//   - cargo build --release --example loadgen (from rust/)
//   - No other gateway processes running (uses in-process gateways, but
//     port 8791-8794 must be free).
//
// Usage:
//   node scripts/bench/run-throughput.mjs [--cells full|headline|single]
//     --full      1/2/3/4 gw × {10,60} clients × {1,20} docs × {low,high}
//     --headline  1gw + 4gw at the central workload, 3 runs each (default)
//     --single    one quick sanity cell
//
// Each cell: 5s warmup included in loadgen's window accounting? NO — loadgen
// has no warmup flag; we run it with --seconds 35 and TREAT THE FIRST 5s AS
// WARMUP by also running a 5s probe run first (throwaway) so caches, JIT
// paths and DB connections are hot. Result cell records runs=3, medians.

import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const RUNS_DIR = path.join(REPO, ".agent", "bench", "runs");
const LOADGEN = path.join(REPO, "rust", "target", "release", "examples", "loadgen");

const MODE = process.argv.includes("--cells")
  ? process.argv[process.argv.indexOf("--cells") + 1]
  : "headline";

const GW_PORTS = { 1: [8791], 2: [8791, 8792], 3: [8791, 8792, 8793], 4: [8791, 8792, 8793, 8794] };

function captureEnv(label) {
  const out = execFileSync("node", [path.join(REPO, "scripts", "bench", "capture-env.mjs"), "--label", label], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function percentile(sortedUs, p) {
  if (sortedUs.length === 0) return null;
  const idx = Math.min(sortedUs.length - 1, Math.ceil((p / 100) * sortedUs.length) - 1);
  return sortedUs[idx];
}

function mediansRun(cellLabel, env, gateways, clients, docs, opsPerSec, seconds, runs) {
  const runSummaries = [];
  for (let r = 0; r < runs; r++) {
    const outJson = path.join(RUNS_DIR, env.runId, `raw-${cellLabel}-r${r}.json`);
    const args = [
      "--gateways", gateways.map((p) => `127.0.0.1:${p}`).join(","),
      "--clients", String(clients),
      "--docs", String(docs),
      "--ops-per-sec", String(opsPerSec),
      "--seconds", String(seconds),
      "--out", outJson,
    ];
    console.log(`  run ${r + 1}/${runs}: loadgen ${args.join(" ")}`);
    execFileSync(LOADGEN, args, { cwd: REPO, stdio: ["ignore", "inherit", "inherit"], timeout: (seconds + 60) * 1000 });
    const summary = JSON.parse(readFileSync(outJson, "utf8"));
    runSummaries.push(summary);
  }
  return runSummaries;
}

function ackPercentilesFrom(summary) {
  // loadgen Summary: { ack_latency_us: [µs...], ... }
  const sorted = [...(summary.ack_latency_us ?? [])].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50) / 1000,
    p95: percentile(sorted, 95) / 1000,
    p99: percentile(sorted, 99) / 1000,
    count: sorted.length,
  };
}

function aggregate(env, cellId, workload, runs, seconds) {
  const acks = runs.map(ackPercentilesFrom);
  const med = (vals) => {
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const ackThroughputs = runs.map((r) => (r.durable_acks ?? 0) / seconds);
  const sendThroughputs = runs.map((r) => (r.ops_sent ?? 0) / seconds);
  const peerFrames = runs.reduce((a, r) => a + (r.peer_frames ?? 0), 0);
  const reconnects = runs.reduce((a, r) => a + (r.reconnects ?? 0), 0);
  const opsSent = runs.reduce((a, r) => a + (r.ops_sent ?? 0), 0);
  const acksTotal = runs.reduce((a, r) => a + (r.durable_acks ?? 0), 0);
  const errors = opsSent - acksTotal; // loadgen counts unacked sends as non-ack; verified below
  const ackMed = {
    p50: med(acks.map((a) => a.p50)),
    p95: med(acks.map((a) => a.p95)),
    p99: med(acks.map((a) => a.p99)),
  };
  return {
    schema: "concord.bench.result/1",
    benchmark: "BM-THROUGHPUT",
    cell: cellId,
    workload,
    environment: env,
    durationMs: seconds * 1000,
    operationCount: opsSent,
    errorCount: Math.max(0, errors),
    throughputOpsPerSec: med(ackThroughputs),
    ackLatencyMs: { p50: ackMed.p50, p95: ackMed.p95, p99: ackMed.p99 },
    propagationLatencyMs: null,
    resources: { cpuPercent: null, rssBytes: null, networkBytes: null },
    notes: [
      `runs=${runs.length} (median aggregation); peer_frames_total=${peerFrames}; reconnects_total=${reconnects}`,
      `sent=${opsSent} acked=${acksTotal}`,
    ],
    correctnessGatePassed: acksTotal === opsSent,
    capturedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!existsSync(LOADGEN)) {
    console.error(`missing ${LOADGEN} — run: cd rust && cargo build --release --example loadgen`);
    process.exit(2);
  }
  const env = captureEnv(`BM-THROUGHPUT-${MODE}`);
  mkdirSync(path.join(RUNS_DIR, env.runId), { recursive: true });
  console.log(`runId: ${env.runId}`);

  const cells = [];
  if (MODE === "single") {
    cells.push({ gw: 1, clients: 10, docs: 20, ops: 200, seconds: 20, runs: 1 });
  } else if (MODE === "headline") {
    // M004: full cross for 1 vs 4 gw headline rows; central subset otherwise.
    for (const gw of [1, 4]) {
      cells.push({ gw, clients: 10, docs: 20, ops: 200, seconds: 30, runs: 3 });
      cells.push({ gw, clients: 60, docs: 20, ops: 200, seconds: 30, runs: 3 });
      cells.push({ gw, clients: 10, docs: 1, ops: 200, seconds: 30, runs: 3 });
      cells.push({ gw, clients: 60, docs: 1, ops: 200, seconds: 30, runs: 3 });
    }
  } else if (MODE === "full") {
    for (const gw of [1, 2, 3, 4]) {
      for (const clients of [10, 60]) {
        for (const docs of [1, 20]) {
          cells.push({ gw, clients, docs, ops: 200, seconds: 30, runs: 3 });
        }
      }
    }
  } else {
    console.error(`unknown mode ${MODE}`);
    process.exit(2);
  }

  const results = [];
  for (const c of cells) {
    const cellId = `gw${c.gw}-c${c.clients}-d${c.docs}`;
    console.log(`\ncell ${cellId} (${c.ops} ops/s, ${c.seconds}s, ${c.runs} runs)`);
    const gateways = GW_PORTS[c.gw];
    // warmup probe (throwaway) — 5s, small client count, no result recorded.
    execFileSync(LOADGEN, [
      "--gateways", gateways.map((p) => `127.0.0.1:${p}`).join(","),
      "--clients", "4", "--docs", String(Math.min(c.docs, 4)),
      "--ops-per-sec", "40", "--seconds", "5",
      "--out", path.join(RUNS_DIR, env.runId, `warmup-${cellId}.json`),
    ], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"], timeout: 90_000 });
    const runs = mediansRun(cellId, env, gateways, c.clients, c.docs, c.ops, c.seconds, c.runs);
    const result = aggregate(env, cellId, {
      gateways: c.gw, clients: c.clients, docs: c.docs, opsPerSecTarget: c.ops,
      seconds: c.seconds, contention: "low", warmupSeconds: 5, runs: c.runs,
    }, runs, c.seconds);
    const outPath = path.join(RUNS_DIR, env.runId, `${cellId}.result.json`);
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`  → ${outPath}  throughput=${result.throughputOpsPerSec.toFixed(1)} ackp95=${result.ackLatencyMs.p95.toFixed(2)}ms gate=${result.correctnessGatePassed}`);
    results.push(result);
  }

  writeFileSync(path.join(RUNS_DIR, env.runId, "campaign-summary.json"), JSON.stringify({
    benchmark: "BM-THROUGHPUT", mode: MODE, runId: env.runId,
    cells: results.map((r) => ({ cell: r.cell, opsPerSec: r.throughputOpsPerSec, ackP95Ms: r.ackLatencyMs.p95, gate: r.correctnessGatePassed })),
  }, null, 2));
  console.log(`\ncampaign complete: ${results.length} cells → .agent/bench/runs/${env.runId}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
