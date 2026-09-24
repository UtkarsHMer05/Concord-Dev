// Measures the editor's WASM export plus client JSON.parse; worker RPC,
// IndexedDB, and TipTap mapping are outside this local benchmark.
// Run after `npm run wasm:build`:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types wasm/bench-export.mjs
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConcordEngine } from "../src/lib/crdt/runtime.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasmDir = path.join(root, "public", "wasm");
const source = await readFile(path.join(wasmDir, "concord-crdt.js"), "utf8");
const load = new Function(`${source}; return loadConcordCrdt;`)();
const wasmBinary = await readFile(path.join(wasmDir, "concord-crdt.wasm"));
const loadFactory = () => load({
    instantiateWasm(info, receiveInstance) {
        WebAssembly.instantiate(wasmBinary, info).then(({ instance }) => receiveInstance(instance));
        return {};
    },
});

const engine = await ConcordEngine.create(1n, loadFactory);
const sizes = [100, 1_000, 5_000];
const runs = 7;

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

try {
    for (const size of sizes) {
        for (let index = engine.streamSize(); index < size; index += 1) {
            engine.localInsertText(index, 0x61);
        }

        const warmup = JSON.parse(engine.streamJson());
        if (warmup.length !== size) throw new Error(`expected ${size} entries, got ${warmup.length}`);

        const samples = [];
        let outputBytes = 0;
        for (let run = 0; run < runs; run += 1) {
            const start = performance.now();
            const json = engine.streamJson();
            const entries = JSON.parse(json);
            samples.push(performance.now() - start);
            outputBytes = Buffer.byteLength(json);
            if (entries.length !== size) throw new Error(`expected ${size} entries, got ${entries.length}`);
        }

        const ms = median(samples);
        console.log(`${size} entries: ${ms.toFixed(3)} ms/export, ${(ms * 1_000 / size).toFixed(3)} µs/entry, ${outputBytes} JSON bytes`);
    }
} finally {
    engine.free();
}
