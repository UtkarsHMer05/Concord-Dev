#!/usr/bin/env node
// Feature 6 — BM-BIGDOC: 100k-op document WASM benchmark (Node measurement
// tool, NOT a vitest test).
//
// Measures the REAL browser-served WASM engine (public/wasm artifacts)
// through the same ABI call sequence src/lib/crdt/runtime.ts uses —
// the exact fold path the time-travel scrubber and gateway reconstruction
// ride. Scenarios:
//
//   1. fold-100k        — fresh engine, applyRemote over the whole op log
//                         (per-op latency + total; throughput derived).
//   2. export-snapshot  — exportSnapshot() of the folded 100k state.
//   3. import-snapshot  — importFromSnapshot() of that snapshot (the
//                         O(snapshot) restore/resync path).
//   4. digest           — canonical digest() read.
//
// Correctness gates (every measured run): all fold digests are identical
// across runs and replicas, and the imported snapshot's digest EQUALS the
// folded digest — engine parity, not just timing.
//
// ENVIRONMENT HONESTY: Node-instrumented measurement of the real WASM
// binary, not a browser main thread. Engine work runs in a Web Worker in
// the real app. Report numbers with that caveat.
//
// Usage:  node scripts/bench/big-doc-bench.mjs [--ops 100000] [--runs 3]
//         [--write-baseline]
// Emits:  JSON summary to stdout; with --write-baseline also
//         .agent/bench/baselines/big-doc-baseline.json
// Requires: npm run wasm:build (public/wasm artifacts present).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const WASM_GLUE = path.join(REPO, "public", "wasm", "concord-crdt.js");
const WASM_BIN = path.join(REPO, "public", "wasm", "concord-crdt.wasm");
const BASELINE_DIR = path.join(REPO, ".agent", "bench", "baselines");

if (!existsSync(WASM_GLUE) || !existsSync(WASM_BIN)) {
  console.error("missing public/wasm/concord-crdt.{js,wasm} — run: npm run wasm:build");
  process.exit(2);
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}
const OP_COUNT = argValue("--ops", 100_000);
const RUNS = argValue("--runs", 3);

// ---------------------------------------------------------------------------
// WASM engine driver (ABI mirror of src/lib/crdt/runtime.ts)
// ---------------------------------------------------------------------------

const ERR_BASE = -1000;
const isErrorStatus = (status) => status < ERR_BASE + 100;

async function loadWasmEngineModule() {
  const source = readFileSync(WASM_GLUE, "utf8");
  const binary = readFileSync(WASM_BIN);
  const load = new Function(`${source}; return loadConcordCrdt;`)();
  return load({
    instantiateWasm(info, receiveInstance) {
      WebAssembly.instantiate(binary, info).then((result) => receiveInstance(result.instance));
      return {};
    },
  });
}

class WasmEngine {
  constructor(module, handle) {
    this.module = module;
    this.handle = handle;
    this.outBuffer = 0;
    this.outCapacity = 0;
  }

  static create(module, replicaId) {
    const handle = module._concord_create(replicaId);
    if (handle === 0) throw new Error("engine creation failed");
    return new WasmEngine(module, handle);
  }

  static importFromSnapshot(module, replicaId, snapshot) {
    const pointer = module._concord_alloc(snapshot.length);
    module.HEAPU8.set(snapshot, pointer);
    const handle = module._concord_create_from_snapshot(replicaId, pointer, snapshot.length);
    module._concord_free(pointer);
    if (handle === 0) throw new Error("snapshot import failed");
    return new WasmEngine(module, handle);
  }

  free() {
    if (this.outBuffer !== 0) this.module._concord_free(this.outBuffer);
    this.module._concord_destroy(this.handle);
  }

  ensureBuffer(required) {
    if (this.outCapacity < required) {
      if (this.outBuffer !== 0) this.module._concord_free(this.outBuffer);
      this.outBuffer = this.module._concord_alloc(required);
      this.outCapacity = required;
    }
  }

  copyOut(required) {
    return this.module.HEAPU8.slice(this.outBuffer, this.outBuffer + required);
  }

  localInsertText(streamIndex, codepoint) {
    this.ensureBuffer(Math.max(this.outCapacity, 256));
    let status = this.module._concord_local_insert_text(this.handle, streamIndex, codepoint, this.outBuffer, this.outCapacity);
    if (isErrorStatus(status)) throw new Error(`local insert failed: ${status}`);
    if (status < 0) {
      const required = -status;
      this.ensureBuffer(required);
      status = this.module._concord_last_op(this.handle, this.outBuffer, this.outCapacity);
      if (isErrorStatus(status)) throw new Error(`last_op recovery failed: ${status}`);
    }
    return this.copyOut(status);
  }

  localInsertDelimiter(streamIndex) {
    const blockType = new TextEncoder().encode("paragraph");
    const pointer = this.module._concord_alloc(blockType.length);
    this.module.HEAPU8.set(blockType, pointer);
    try {
      this.ensureBuffer(Math.max(this.outCapacity, 256));
      let status = this.module._concord_local_insert_delimiter(this.handle, streamIndex, pointer, blockType.length, this.outBuffer, this.outCapacity);
      if (isErrorStatus(status)) throw new Error(`local delimiter failed: ${status}`);
      if (status < 0) {
        const required = -status;
        this.ensureBuffer(required);
        status = this.module._concord_last_op(this.handle, this.outBuffer, this.outCapacity);
        if (isErrorStatus(status)) throw new Error(`last_op recovery failed: ${status}`);
      }
      return this.copyOut(status);
    } finally {
      this.module._concord_free(pointer);
    }
  }

  applyRemote(bytes) {
    const pointer = this.module._concord_alloc(bytes.length);
    this.module.HEAPU8.set(bytes, pointer);
    try {
      const status = this.module._concord_apply_remote(this.handle, pointer, bytes.length);
      if (isErrorStatus(status)) throw new Error(`apply_remote failed: ${status}`);
      return status === 1 ? "applied" : "duplicate";
    } finally {
      this.module._concord_free(pointer);
    }
  }

  runReadCall(invoke) {
    const probe = invoke(0, 0);
    if (probe < 0) throw new Error(`engine read failed: ${probe}`);
    if (probe === 0) return new Uint8Array(0);
    this.ensureBuffer(probe);
    const status = invoke(this.outBuffer, this.outCapacity);
    if (status < 0) throw new Error(`engine read failed: ${status}`);
    return this.copyOut(status);
  }

  digest() {
    return new TextDecoder().decode(
      this.runReadCall((ptr, cap) => this.module._concord_digest(this.handle, ptr, cap)),
    );
  }

  exportSnapshot() {
    return this.runReadCall((ptr, cap) =>
      this.module._concord_export_snapshot(this.handle, ptr, cap),
    );
  }
}

// ---------------------------------------------------------------------------
// Workload + measurement
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    runs: sorted.length,
    minMs: Number(sorted[0].toFixed(2)),
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

async function main() {
  const wasm = await loadWasmEngineModule();

  // 1. Build the 100k-op document once: 40 paragraphs x ~2,499 chars.
  //    (A realistic "large novel chapter" shape, delimiter every 2,500 ops.)
  const source = WasmEngine.create(wasm, 11n);
  const ops = [];
  let streamIndex = 0;
  const startedAt = performance.now();
  for (let i = 0; i < OP_COUNT; i += 1) {
    if (i > 0 && i % 2500 === 0) {
      ops.push(source.localInsertDelimiter(streamIndex));
      streamIndex += 1;
    } else {
      ops.push(source.localInsertText(streamIndex, 97 + (i % 26)));
    }
  }
  const generationMs = performance.now() - startedAt;
  const sourceDigest = source.digest();
  source.free();
  if (!/^sha256:[0-9a-f]{64}$/.test(sourceDigest)) throw new Error("generation digest is not canonical");
  if (ops.length !== OP_COUNT) throw new Error(`generated ${ops.length} ops, expected ${OP_COUNT}`);

  // 2. Measure fold / export / import / digest across runs.
  const foldMs = [];
  const exportMs = [];
  const importMs = [];
  const digestMs = [];
  let referenceDigest = null;
  for (let run = 0; run < RUNS; run += 1) {
    const engine = WasmEngine.create(wasm, 100n + BigInt(run));

    const t0 = performance.now();
    for (const op of ops) engine.applyRemote(op);
    foldMs.push(performance.now() - t0);

    const t1 = performance.now();
    const snapshot = engine.exportSnapshot();
    exportMs.push(performance.now() - t1);

    const t2 = performance.now();
    const imported = WasmEngine.importFromSnapshot(wasm, 900n + BigInt(run), snapshot);
    importMs.push(performance.now() - t2);

    const t3 = performance.now();
    const digest = engine.digest();
    digestMs.push(performance.now() - t3);
    const importedDigest = imported.digest();
    imported.free();

    if (referenceDigest === null) referenceDigest = digest;
    if (digest !== referenceDigest) throw new Error(`run ${run}: fold digest diverged from run 0`);
    if (importedDigest !== digest) throw new Error(`run ${run}: snapshot import digest != fold digest`);
    engine.free();
  }

  const foldSummary = summarize(foldMs);
  const summary = {
    schema: "concord.bench.bigdoc/1",
    ops: OP_COUNT,
    runs: RUNS,
    generationMs: Number(generationMs.toFixed(2)),
    fold: { ...foldSummary, throughputOpsPerSec: Math.round(OP_COUNT / (foldSummary.p50Ms / 1000)) },
    exportSnapshot: summarize(exportMs),
    importSnapshot: summarize(importMs),
    digestRead: summarize(digestMs),
    snapshotBytes: null,
    digest: referenceDigest,
    notes: "Node-instrumented WASM (browser-served binary); app runs engine ops in a Web Worker.",
  };

  // Record the snapshot size from one extra export (keeps timing runs pure).
  {
    const engine = WasmEngine.create(wasm, 950n);
    for (const op of ops) engine.applyRemote(op);
    summary.snapshotBytes = engine.exportSnapshot().length;
    engine.free();
  }

  console.log(JSON.stringify(summary, null, 2));

  if (process.argv.includes("--write-baseline")) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    const target = path.join(BASELINE_DIR, "big-doc-baseline.json");
    writeFileSync(target, JSON.stringify(summary, null, 2) + "\n");
    console.error(`baseline written: ${path.relative(REPO, target)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
