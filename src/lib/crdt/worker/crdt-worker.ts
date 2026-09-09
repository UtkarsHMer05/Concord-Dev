// Worker entry point (P2-M034): wires the testable CrdtWorkerCore to the
// postMessage transport. The browser bundle imports the Emscripten factory
// from the staged WASM artifacts (wasm/dist → public/wasm via wasm:build).
import type { ConcordModule } from "../wasm-types";
import { IdbPersistence } from "./idb";
import { CrdtWorkerCore } from "./core";
import type { WorkerRequest, WorkerResponse, WorkerNotification } from "./protocol";

/** Minimal worker-global surface (lib.dom worker types are not in tsconfig lib). */
interface WorkerGlobal {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: WorkerResponse | WorkerNotification): void;
}
declare const self: WorkerGlobal;

async function loadFactory(): Promise<ConcordModule> {
    // The generated glue is a static public asset (staged by wasm:build),
    // fetched as text and evaluated inside the worker: dynamic import of an
    // absolute URL is disallowed inside module workers in some engines, and
    // the bundler must not follow the generated file. The factory's
    // instantiateWasm hook instantiates the binary fetched from /wasm/.
    const response = await fetch("/wasm/concord-crdt.js");
    if (!response.ok) {
        throw new Error(`wasm glue fetch failed: ${response.status}`);
    }
    const source = await response.text();
    const evaluate = new Function(
        `${source}\n; return loadConcordCrdt;`,
    ) as () => (
        options?: Record<string, unknown>,
    ) => Promise<ConcordModule>;
    const factory = evaluate();
    const binaryResponse = await fetch("/wasm/concord-crdt.wasm");
    if (!binaryResponse.ok) {
        throw new Error(`wasm binary fetch failed: ${binaryResponse.status}`);
    }
    const wasmBinary = await binaryResponse.arrayBuffer();
    return factory({
        instantiateWasm(
            info: WebAssembly.Imports,
            receiveInstance: (instance: WebAssembly.Instance) => void,
        ) {
            void WebAssembly.instantiate(wasmBinary, info).then((result) =>
                receiveInstance(result.instance),
            );
            return {} as WebAssembly.WebAssemblyInstantiatedSource;
        },
    });
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
            // Local-op push notification (Phase 7 sync seam, D16 additive):
            // after a durable local op the sync session's subscription
            // observes the bytes. Remote applications (applyRemote) are NOT
            // local ops and never push.
            if (result.kind === "localOps" && result.ops.length > 0) {
                self.postMessage({ kind: "localOps", ops: result.ops });
            }
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
