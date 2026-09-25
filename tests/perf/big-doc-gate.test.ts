import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ConcordModule } from "@/lib/crdt/wasm-types";

import { ConcordEngine } from "@/lib/crdt/runtime";

/**
 * Feature 6 — perf regression GATE (env-gated: CONCORD_PERF_GATE=1).
 *
 * Skipped in normal CI (timing bounds flake on loaded runners); run it
 * locally or in a dedicated job to catch big-O regressions:
 *
 *   CONCORD_PERF_GATE=1 npx vitest run tests/perf/big-doc-gate.test.ts --project unit
 *
 * The point is TREND detection with deliberately loose bounds (the
 * measurement harness scripts/bench/big-doc-bench.mjs records precise
 * p50/p95 against .agent/bench/baselines/). These asserts pin the
 * asymptotics: a change that turns the O(n) fold into something worse, or
 * O(1) snapshot import into an O(n) replay, fails here long before users
 * feel it. Current headroom (2026-09-25 baseline): fold ~39ms p50 at
 * 100k ops (2.6M ops/s), snapshot import ~37ms — the 30s/5s bounds are
 * ~750x/100x headroom.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let factoryPromise: Promise<ConcordModule> | null = null;

/** The runtime AWAITS the loader passed in — hand the function, not the module. */
function getFactory(): Promise<ConcordModule> {
  factoryPromise ??= (async () => {
    const source = await readFile(path.join(repoRoot, "wasm/dist/concord-crdt.js"), "utf8");
    const binary = await readFile(path.join(repoRoot, "wasm/dist/concord-crdt.wasm"));
    const load = new Function(`${source}; return loadConcordCrdt;`)();
    return (await load({
      instantiateWasm(info: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance) => void) {
        WebAssembly.instantiate(binary, info).then((result) => receiveInstance(result.instance));
        return {};
      },
    })) as Promise<ConcordModule>;
  })();
  return factoryPromise;
}

const OP_COUNT = 100_000;
const FOLD_BUDGET_MS = 30_000;
const SNAPSHOT_IMPORT_BUDGET_MS = 5_000;

async function buildSourceOps(): Promise<Uint8Array[]> {
  const source = await ConcordEngine.create(11n, getFactory);
  try {
    const ops: Uint8Array[] = [];
    let streamIndex = 0;
    for (let i = 0; i < OP_COUNT; i += 1) {
      if (i > 0 && i % 2500 === 0) {
        ops.push(source.localInsertDelimiter(streamIndex, "paragraph"));
        streamIndex += 1;
      } else {
        ops.push(source.localInsertText(streamIndex, 97 + (i % 26)));
      }
    }
    return ops;
  } finally {
    source.free();
  }
}

describe.skipIf(!process.env.CONCORD_PERF_GATE)("100k-op perf gate (CONCORD_PERF_GATE=1)", () => {
  it("folds 100k ops well inside the budget and keeps snapshot import O(snapshot)", async () => {
    const ops = await buildSourceOps();
    expect(ops.length).toBe(OP_COUNT);

    const engine = await ConcordEngine.create(100n, getFactory);
    try {
      const startedAt = performance.now();
      for (const op of ops) engine.applyRemote(op);
      const foldMs = performance.now() - startedAt;
      // Convergence sanity alongside the timing gate.
      expect(engine.digest()).toMatch(/^sha256:[0-9a-f]{64}$/);

      const snapshot = engine.exportSnapshot();
      const importStartedAt = performance.now();
      const imported = await ConcordEngine.importFromSnapshot(900n, snapshot, getFactory);
      const importMs = performance.now() - importStartedAt;
      try {
        expect(imported.digest()).toBe(engine.digest());
      } finally {
        imported.free();
      }

      expect(foldMs).toBeLessThan(FOLD_BUDGET_MS);
      expect(importMs).toBeLessThan(SNAPSHOT_IMPORT_BUDGET_MS);
      console.log(
        `[perf-gate] fold ${OP_COUNT} ops: ${foldMs.toFixed(1)}ms (${Math.round(OP_COUNT / (foldMs / 1000)).toLocaleString()} ops/s), snapshot import: ${importMs.toFixed(1)}ms, snapshot ${snapshot.length.toLocaleString()} bytes`,
      );
    } finally {
      engine.free();
    }
  }, 120_000);
});
