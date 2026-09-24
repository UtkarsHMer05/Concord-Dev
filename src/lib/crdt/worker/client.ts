// Browser-side client for the CRDT worker (P2-M034).
//
// Typed RPC with correlation ids over postMessage. The pending-request map is
// bounded: a request that overflows it fails immediately with a structured
// error instead of growing without bound; worker termination rejects every
// pending request.
import type { StreamEntryJson } from "../adapter";
import type { WorkerRequest, WorkerResponse, WorkerResultPayload, CrdtWorkerError, WorkerNotification } from "./protocol";

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
    private localOpsListeners = new Set<(ops: Uint8Array[]) => void>();

    constructor(private readonly options: CrdtClientOptions = {}) {}

    private async ensureWorker(): Promise<Worker> {
        if (this.terminated) {
            throw { code: "InvalidArgument", message: "client terminated" } as CrdtWorkerError;
        }
        if (this.worker === null) {
            // P7-M032 (final): the worker is a PRE-BUNDLED static CLASSIC
            // worker (public/crdt-worker.js — `npm run worker:bundle`,
            // IIFE). Constructed from a BLOB of the fetched source:
            // URL-construction of workers proved silently unreliable in
            // the embedded-WebView browsers used for staging/production
            // E2E (both module and classic types intermittently deliver
            // no messages and fire no errors), while BLOB workers
            // responded in 100% of the same probes. The blob: URL carries
            // the creating origin, so the worker's self.location.origin —
            // used by loadFactory to build the absolute importScripts/
            // fetch URLs for the WASM glue — remains the real origin.
            // The fetch is a normal same-origin GET (CSP connect-src
            // 'self'); construction failures surface as rejections.
            // cache: 'reload' — the worker bundle changes per release; a cached old
            // bundle against a new page would pin stale engine code
            // (observed live: a force-cache choice served the pre-fix
            // worker across three production rolls).
            const response = await fetch("/crdt-worker.js", { cache: "reload" });
            if (!response.ok) {
                throw { code: "Unknown", message: `worker source fetch failed: ${response.status}` } as CrdtWorkerError;
            }
            const source = await response.text();
            const blobUrl = URL.createObjectURL(
                new Blob([source], { type: "application/javascript" }),
            );
            this.worker = new Worker(blobUrl);
            this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerNotification>) => {
                const response = event.data;
                // Push notification (no correlation id): fan out to the
                // local-ops listeners (sync seam, D16 additive).
                if (!("id" in response)) {
                    if (response.kind === "localOps" && response.ops.length > 0) {
                        for (const listener of this.localOpsListeners) {
                            listener(response.ops);
                        }
                    }
                    return;
                }
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

    private async call(request: DistributiveOmit<WorkerRequest, "id">): Promise<WorkerResultPayload> {
        if (this.pending.size >= MAX_PENDING) {
            return Promise.reject({
                code: "PendingLimitExceeded",
                message: "too many in-flight worker requests",
            } as CrdtWorkerError);
        }
        const worker = await this.ensureWorker();
        const id = this.nextId++;
        return new Promise<WorkerResultPayload>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            worker.postMessage({ ...request, id } as WorkerRequest);
        });
    }

    // ------------------------------------------------------------------
    // Typed API.
    // ------------------------------------------------------------------

    async init(documentId: string, replicaId: bigint, storageId?: string): Promise<void> {
        await this.call({ kind: "init", documentId, replicaId: replicaId.toString(), storageId });
    }

    applyRemote(ops: Uint8Array[], cursor?: string): Promise<{ applied: number; duplicates: number }> {
        return this.call({ kind: "applyRemote", ops, cursor }) as Promise<{
            applied: number;
            duplicates: number;
        }>;
    }

    async syncCursor(): Promise<string> {
        const result = await this.call({ kind: "getSyncCursor" });
        return (result as { kind: "getSyncCursor"; cursor: string }).cursor;
    }

    async persistSyncCursor(cursor: string): Promise<void> {
        await this.call({ kind: "persistSyncCursor", cursor });
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

    /** The full tombstone-inclusive stream (adapter mapping surface). */
    async exportStream(): Promise<StreamEntryJson[]> {
        const result = await this.call({ kind: "exportStream" });
        return JSON.parse((result as { kind: "exportStream"; json: string }).json) as StreamEntryJson[];
    }

    /**
     * Subscribes to locally generated canonical op bytes (Phase 7 sync
     * seam, D16 additive). The worker pushes a `localOps` notification
     * after each durable local op; the sync session feeds these into its
     * outbox. Returns an unsubscribe function.
     */
    onLocalOps(handler: (ops: Uint8Array[]) => void): () => void {
        this.localOpsListeners.add(handler);
        return () => {
            this.localOpsListeners.delete(handler);
        };
    }

    /** Replica identity + highest own counter (join state summary). */
    async replicaInfo(): Promise<{ replicaId: string; sequence: string }> {
        const result = await this.call({ kind: "replicaInfo" });
        const info = result as { kind: "replicaInfo"; replicaId: string; sequence: string };
        return { replicaId: info.replicaId, sequence: info.sequence };
    }

    /** Own-replica ops past a counter (decimal string) — resumable cursor. */
    async localOpsSince(counter: string): Promise<{ ops: Uint8Array[]; nextCounter: string }> {
        const result = await this.call({ kind: "localOpsSince", counter });
        const since = result as {
            kind: "localOpsSince";
            ops: Uint8Array[];
            nextCounter: string;
        };
        return { ops: since.ops, nextCounter: since.nextCounter };
    }

    /** Atomic snapshot import (stale-client resync port contract). */
    async importSnapshot(snapshot: Uint8Array): Promise<void> {
        await this.call({ kind: "importSnapshot", snapshot });
    }

    terminate(): void {
        this.terminated = true;
        this.failAll({ code: "Unknown", message: "client terminated" });
        this.worker?.terminate();
        this.worker = null;
    }
}
