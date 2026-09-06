#!/usr/bin/env node
// WASM smoke test (P2-M030 acceptance): instantiate the module, create a
// document, generate one local insert, read back the visible state.
// Run: node wasm/smoke.mjs   (after npm run wasm:build)
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

let failures = 0;
function check(name, condition) {
    if (condition) {
        console.log(`PASS ${name}`);
    } else {
        failures += 1;
        console.error(`FAIL ${name}`);
    }
}

const source = await readFile(path.join(distDir, "concord-crdt.js"), "utf8");
// Evaluate the Emscripten factory in this module's scope. The glue no longer
// supports Module.wasmBinary, so instantiation is provided explicitly.
const load = new Function(
    `${source}; return loadConcordCrdt;`,
)();
const wasmBinary = await readFile(path.join(distDir, "concord-crdt.wasm"));
const factory = await load({
    instantiateWasm(info, receiveInstance) {
        WebAssembly.instantiate(wasmBinary, info).then((result) =>
            receiveInstance(result.instance),
        );
        return {};
    },
});

const handle = factory._concord_create(42n);
check("engine created", handle != null && handle !== 0);

const size = factory._concord_stream_size(handle);
check("empty stream", size === 0);

// Local insert: 'h' at position 0. Generation stashes the op; sizing probes
// never create extra ops. First call with cap=0 returns -(required length).
const required = factory._concord_local_insert_text(handle, 0, 0x68, null, 0);
check("size probe returns negative required", required < 0);
const needed = -required;
const outPtr = factory._concord_alloc(needed);
const written = factory._concord_last_op(handle, outPtr, needed);
check("op serialized", written === needed);

// Replay through apply_remote: must report duplicate (0).
const duplicate = factory._concord_apply_remote(handle, outPtr, written);
check("duplicate delivery ignored", duplicate === 0);

// Visible state reflects the insert.
const jsonRequired = factory._concord_visible_json(handle, null, 0);
const jsonLen = -jsonRequired;
const jsonPtr = factory._concord_alloc(jsonLen);
factory._concord_visible_json(handle, jsonPtr, jsonLen);
const json = new TextDecoder().decode(factory.HEAPU8.slice(jsonPtr, jsonPtr + jsonLen));
check("visible document contains h", json.includes('"t":"h"') || json.includes('h'));

factory._concord_free(outPtr);
factory._concord_free(jsonPtr);
factory._concord_destroy(handle);

if (failures > 0) {
    process.exit(1);
}
console.log("WASM smoke passed.");
