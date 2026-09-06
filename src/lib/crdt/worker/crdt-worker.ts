// Worker entry point (P2-M034): wires the testable CrdtWorkerCore to the
// postMessage transport. The browser bundle imports the Emscripten factory
// from the staged WASM artifacts (wasm/dist → public/wasm via wasm:build).
import type { ConcordModule } from "../wasm-types";
import { IdbPersistence } from "./idb";
import { CrdtWorkerCore } from "./core";
import type { WorkerRequest, WorkerResponse } from "./protocol";

/** Minimal worker-global surface (lib.dom worker types are not in tsconfig lib). */
interface WorkerGlobal {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: WorkerResponse): void;
}
declare const self: WorkerGlobal;

async function loadFactory(): Promise<ConcordModule> {
    // The generated glue is a static public asset (staged by wasm:build),
    // intentionally hidden from the bundler and fetched at runtime; the .wasm
    // sits beside it under /wasm/.
    const importGenerated = new Function(
        "specifier",
        "return import(specifier);",
    ) as (specifier: string) => Promise<{ default?: unknown }>;
    const generated = await importGenerated("/wasm/concord-crdt.js");
    const factory = (generated.default ?? generated) as (
        options?: Record<string, unknown>,
    ) => Promise<ConcordModule>;
    return factory({
        locateFile: (file: string) => `/wasm/${file}`,
    });
}

function replicaIdFor(documentId: string): bigint {
    const key = `concord.replica.${documentId}`;
    const stored = globalThis.localStorage?.getItem(key) ?? null;
    if (stored !== null) {
        return BigInt(stored);
    }
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    bytes[0] |= 1; // never zero
    const value = new DataView(bytes.buffer).getBigUint64(0);
    try {
        globalThis.localStorage?.setItem(key, value.toString());
    } catch {
        // localStorage unavailable (private mode): identity is per session.
    }
    return value;
}

let core: CrdtWorkerCore | null = null;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    const respond = (response: WorkerResponse) => {
        self.postMessage(response);
    };

    void (async () => {
        try {
            if (core === null) {
                // The first request must be "init" carrying the document and
                // the replica identity (workers have no localStorage).
                if (request.kind !== "init") {
                    throw new TypeError("worker must be initialized first");
                }
                core = new CrdtWorkerCore({
                    documentId: request.documentId,
                    replicaId: BigInt(request.replicaId),
                    loadFactory,
                    persistence: new IdbPersistence(),
                });
            }
            const result = await core.handle(request);
            respond({ id: request.id, ok: true, result });
        } catch (error) {
            respond({
                id: request.id,
                ok: false,
                error:
                    error instanceof Error
                        ? { code: (error as { code?: string }).code ?? "Unknown", message: error.message }
                        : { code: "Unknown", message: "worker failure" },
            });
        }
    })();
};
