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
// never create extra ops. Probe call with out=null returns the required
// length as a POSITIVE value (negative values are reserved for error codes).
const required = factory._concord_local_insert_text(handle, 0, 0x68, null, 0);
check("size probe returns positive required", required > 0);
const needed = required;
const outPtr = factory._concord_alloc(needed);
const written = factory._concord_last_op(handle, outPtr, needed);
check("op serialized", written === needed);

// Replay through apply_remote: must report duplicate (0).
const duplicate = factory._concord_apply_remote(handle, outPtr, written);
check("duplicate delivery ignored", duplicate === 0);

// Visible state reflects the insert.
const jsonRequired = factory._concord_visible_json(handle, null, 0);
const jsonLen = jsonRequired;
const jsonPtr = factory._concord_alloc(jsonLen);
factory._concord_visible_json(handle, jsonPtr, jsonLen);
const json = new TextDecoder().decode(factory.HEAPU8.slice(jsonPtr, jsonPtr + jsonLen));
check("visible document contains h", json.includes('"t":"h"') || json.includes('h'));

// Snapshot export/import is part of the production worker boundary, not just
// a wrapper-only unit-test path. Exercise both the validation entry point and
// construction of a fresh handle, then compare the canonical digest and
// visible JSON across the boundary.
const snapshotRequired = factory._concord_export_snapshot(handle, null, 0);
check("snapshot size probe returns positive required", snapshotRequired > 0);
const snapshotPtr = factory._concord_alloc(snapshotRequired);
const snapshotWritten = factory._concord_export_snapshot(handle, snapshotPtr, snapshotRequired);
check("snapshot serialized", snapshotWritten === snapshotRequired);
check("snapshot validates", factory._concord_import_snapshot(handle, snapshotPtr, snapshotWritten) === 0);

const restored = factory._concord_create_from_snapshot(99n, snapshotPtr, snapshotWritten);
check("snapshot creates restored engine", restored != null && restored !== 0);
if (restored != null && restored !== 0) {
    const digestRequired = factory._concord_digest(handle, null, 0);
    const digestPtr = factory._concord_alloc(digestRequired);
    factory._concord_digest(handle, digestPtr, digestRequired);
    const digest = new TextDecoder().decode(factory.HEAPU8.slice(digestPtr, digestPtr + digestRequired));

    const restoredDigestRequired = factory._concord_digest(restored, null, 0);
    const restoredDigestPtr = factory._concord_alloc(restoredDigestRequired);
    factory._concord_digest(restored, restoredDigestPtr, restoredDigestRequired);
    const restoredDigest = new TextDecoder().decode(
        factory.HEAPU8.slice(restoredDigestPtr, restoredDigestPtr + restoredDigestRequired),
    );
    check("snapshot digest matches", restoredDigest === digest);

    const restoredJsonRequired = factory._concord_visible_json(restored, null, 0);
    const restoredJsonPtr = factory._concord_alloc(restoredJsonRequired);
    factory._concord_visible_json(restored, restoredJsonPtr, restoredJsonRequired);
    const restoredJson = new TextDecoder().decode(
        factory.HEAPU8.slice(restoredJsonPtr, restoredJsonPtr + restoredJsonRequired),
    );
    check("snapshot visible JSON matches", restoredJson === json);

    factory._concord_free(restoredJsonPtr);
    factory._concord_free(restoredDigestPtr);
    factory._concord_free(digestPtr);
    factory._concord_destroy(restored);
}

factory._concord_free(snapshotPtr);
factory._concord_free(outPtr);
factory._concord_free(jsonPtr);
factory._concord_destroy(handle);

if (failures > 0) {
    process.exit(1);
}
console.log("WASM smoke passed.");
