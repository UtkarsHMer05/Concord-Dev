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
    importScripts(url: string): void;
    location: { origin: string };
    /** Set by the Emscripten glue's UMD global when loaded via importScripts. */
    loadConcordCrdt?: (options?: Record<string, unknown>) => Promise<ConcordModule>;
}
declare const self: WorkerGlobal;

async function loadFactory(): Promise<ConcordModule> {
    // The generated glue is a static public asset (staged by wasm:build).
    // Loaded via importScripts() — the CLASSIC worker loader. This worker
    // is shipped pre-bundled as a CLASSIC worker (public/crdt-worker.js,
    // `npm run worker:bundle`, IIFE format) because module workers proved
    // unreliable in the embedded-WebView browser used for E2E (silently
    // dropping every message; the identical code as a classic worker
    // responds — control-verified), while importScripts is the classic
    // standard. Loading history (all observed live on production):
    //   1. new Function(source) — CSP-blocked (no 'unsafe-eval').
    //   2. dynamic import() — UMD glue has no ESM export → .default
    //      undefined; adding the ESM tail worked only where module workers
    //      themselves worked.
    //   3. importScripts — CSP-clean (script-src 'self'), classic-worker
    //      native, sets the UMD global `loadConcordCrdt`. The URL is
    //      resolved to a FULL absolute URL first: importScripts resolves
    //      root-relative paths against the worker script's base, which
    //      broke in blob-context debugging and varies by embedding — the
    //      absolute form is correct from every base.
    self.importScripts(new URL("/wasm/concord-crdt.js", self.location.origin).href);
    const factory = self.loadConcordCrdt;
    if (typeof factory !== "function") {
        throw new Error("wasm glue did not define loadConcordCrdt after importScripts");
    }
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
