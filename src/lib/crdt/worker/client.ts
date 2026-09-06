// Browser-side client for the CRDT worker (P2-M034).
//
// Typed RPC with correlation ids over postMessage. The pending-request map is
// bounded: a request that overflows it fails immediately with a structured
// error instead of growing without bound; worker termination rejects every
// pending request.
import type { WorkerRequest, WorkerResponse, WorkerResultPayload, CrdtWorkerError } from "./protocol";

const MAX_PENDING = 256;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Pending = {
    resolve: (payload: WorkerResultPayload) => void;
    reject: (error: CrdtWorkerError) => void;
};

export interface CrdtClientOptions {
    /** Factory for the Worker (injectable for tests). */
    createWorker?: () => Worker;
}

export class CrdtClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private terminated = false;

    constructor(private readonly options: CrdtClientOptions = {}) {}

    private ensureWorker(): Worker {
        if (this.terminated) {
            throw { code: "InvalidArgument", message: "client terminated" } as CrdtWorkerError;
        }
        if (this.worker === null) {
            this.worker = new Worker(
                new URL("./crdt-worker.ts", import.meta.url),
                { type: "module" },
            );
            this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
                const response = event.data;
                const pending = this.pending.get(response.id);
                if (pending === undefined) {
                    return; // stale response for an already-failed request
                }
                this.pending.delete(response.id);
                if (response.ok) {
                    pending.resolve(response.result);
                } else {
                    pending.reject(response.error);
                }
            };
            this.worker.onerror = () => {
                this.failAll({ code: "Unknown", message: "worker crashed" });
            };
            this.worker.onmessageerror = () => {
                this.failAll({ code: "Unknown", message: "worker message decoding failed" });
            };
        }
        return this.worker;
    }

    private failAll(error: CrdtWorkerError): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private call(request: DistributiveOmit<WorkerRequest, "id">): Promise<WorkerResultPayload> {
        if (this.pending.size >= MAX_PENDING) {
            return Promise.reject({
                code: "PendingLimitExceeded",
                message: "too many in-flight worker requests",
            } as CrdtWorkerError);
        }
        const worker = this.ensureWorker();
        const id = this.nextId++;
        return new Promise<WorkerResultPayload>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            worker.postMessage({ ...request, id } as WorkerRequest);
        });
    }

    // ------------------------------------------------------------------
    // Typed API.
    // ------------------------------------------------------------------

    async init(documentId: string, replicaId: bigint): Promise<void> {
        await this.call({ kind: "init", documentId, replicaId: replicaId.toString() });
    }

    applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }> {
        return this.call({ kind: "applyRemote", ops }) as Promise<{
            applied: number;
            duplicates: number;
        }>;
    }

    localInsertText(streamIndex: number, codepoint: number): Promise<Uint8Array[]> {
        return this.call({ kind: "localInsertText", streamIndex, codepoint }).then(
            (result) => (result as { kind: "localOps"; ops: Uint8Array[] }).ops,
        );
    }

    localInsertDelimiter(streamIndex: number, blockType: string): Promise<Uint8Array[]> {
        return this.call({ kind: "localInsertDelimiter", streamIndex, blockType }).then(
            (result) => (result as { kind: "localOps"; ops: Uint8Array[] }).ops,
        );
    }

    localDelete(streamIndex: number): Promise<Uint8Array[]> {
        return this.call({ kind: "localDelete", streamIndex }).then(
            (result) => (result as { kind: "localOps"; ops: Uint8Array[] }).ops,
        );
    }

    localSetAttr(streamIndex: number, name: string, value: string | null): Promise<Uint8Array[]> {
        return this.call({ kind: "localSetAttr", streamIndex, name, value }).then(
            (result) => (result as { kind: "localOps"; ops: Uint8Array[] }).ops,
        );
    }

    async visibleJson(): Promise<string> {
        const result = await this.call({ kind: "visibleJson" });
        return (result as { kind: "visibleJson"; json: string }).json;
    }

    async digest(): Promise<string> {
        const result = await this.call({ kind: "digest" });
        return (result as { kind: "digest"; digest: string }).digest;
    }

    async streamSize(): Promise<number> {
        const result = await this.call({ kind: "streamSize" });
        return (result as { kind: "streamSize"; size: number }).size;
    }

    async exportSnapshot(): Promise<Uint8Array> {
        const result = await this.call({ kind: "exportSnapshot" });
        return (result as { kind: "exportSnapshot"; snapshot: Uint8Array }).snapshot;
    }

    /** The durable local operation log (verification surface). */
    async exportOps(): Promise<Uint8Array[]> {
        const result = await this.call({ kind: "exportOps" });
        return (result as { kind: "exportOps"; ops: Uint8Array[] }).ops;
    }

    terminate(): void {
        this.terminated = true;
        this.failAll({ code: "Unknown", message: "client terminated" });
        this.worker?.terminate();
        this.worker = null;
    }
}
