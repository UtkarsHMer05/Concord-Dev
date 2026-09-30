// Shared real-WASM test seam. Memory adapters model persistence; they do not
// claim IndexedDB or PostgreSQL coverage. Browser/live lanes verify those.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { PersistenceAdapter, LocalState } from "@/lib/crdt/worker/idb";
import type { PendingOpRecord } from "@/lib/sync/pending-store";
import { identityFromOpBytes } from "@/lib/sync/identities";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wasmDist = path.join(repoRoot, "wasm/dist");
async function instantiateFactory() {
    const source = await readFile(path.join(wasmDist, "concord-crdt.js"), "utf8");
    const binary = await readFile(path.join(wasmDist, "concord-crdt.wasm"));
    const load = new Function(`${source}; return loadConcordCrdt;`)();
    return (await load({
        instantiateWasm(
            info: WebAssembly.Imports,
            receiveInstance: (instance: WebAssembly.Instance) => void,
        ) {
            WebAssembly.instantiate(binary, info).then((result) =>
                receiveInstance(result.instance),
            );
            return {};
        },
    })) as never;
}

let factory: Promise<never> | undefined;
export function loadFactory(): Promise<never> {
    return factory ??= instantiateFactory();
}

export class MemoryPersistence implements PersistenceAdapter {
    snapshots = new Map<string, Uint8Array>();
    logs = new Map<string, {
        seq: number;
        op: Uint8Array;
        identity?: string;
        coveredAtCursor?: string;
    }[]>();
    cursors = new Map<string, string>();
    appendGate: { started: () => void; wait: Promise<void> } | null = null;
    failNextAppend = false;

    async loadLocalState(documentId: string): Promise<LocalState> {
        return {
            snapshot: this.snapshots.get(documentId) ?? null,
            ops: (this.logs.get(documentId) ?? []).map((entry) => entry.op),
        };
    }
    async appendOps(
        documentId: string,
        ops: Uint8Array[],
        sync?: { cursor: string; coveredOpIds: string[] },
    ): Promise<void> {
        if (this.appendGate !== null) {
            const gate = this.appendGate;
            this.appendGate = null;
            gate.started();
            await gate.wait;
        }
        if (this.failNextAppend) {
            this.failNextAppend = false;
            throw new Error("simulated IndexedDB transaction failure");
        }
        const log = [...(this.logs.get(documentId) ?? [])];
        for (const op of ops) {
            const parsed = identityFromOpBytes(op);
            const identity = parsed === null ? undefined : `${parsed.replica}:${parsed.counter}`;
            log.push(identity === undefined
                ? { seq: log.length, op }
                : { seq: log.length, op, identity });
        }
        if (sync !== undefined) {
            const previous = this.cursors.get(documentId) ?? "0";
            this.cursors.set(documentId, BigInt(previous) >= BigInt(sync.cursor) ? previous : sync.cursor);
            for (const identity of sync.coveredOpIds) {
                for (const record of log) {
                    if (record.identity !== identity) continue;
                    const previousCoverage = record.coveredAtCursor ?? "0";
                    record.coveredAtCursor = BigInt(previousCoverage) >= BigInt(sync.cursor)
                        ? previousCoverage
                        : sync.cursor;
                }
            }
        }
        this.logs.set(documentId, log);
    }
    async loadSyncCursor(documentId: string): Promise<string> {
        return this.cursors.get(documentId) ?? "0";
    }
    async saveSyncCursor(documentId: string, cursor: string): Promise<void> {
        const previous = this.cursors.get(documentId) ?? "0";
        this.cursors.set(documentId, BigInt(previous) >= BigInt(cursor) ? previous : cursor);
    }
    async loadCoveredOpIds(documentId: string, identities: string[]): Promise<Set<string>> {
        const cursor = BigInt(this.cursors.get(documentId) ?? "0");
        const records = this.logs.get(documentId) ?? [];
        return new Set(identities.filter((id) => records.some((record) =>
            record.identity === id && record.coveredAtCursor !== undefined &&
            BigInt(record.coveredAtCursor) <= cursor,
        )));
    }
    async clearCoveredOpIds(documentId: string, identities: string[]): Promise<void> {
        const covered = new Set(identities);
        for (const record of this.logs.get(documentId) ?? []) {
            if (record.identity !== undefined && covered.has(record.identity)) {
                delete record.coveredAtCursor;
            }
        }
    }
    async saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void> {
        this.snapshots.set(documentId, snapshot);
    }
    async clearDocument(documentId: string): Promise<void> {
        this.logs.delete(documentId);
        this.snapshots.delete(documentId);
        this.cursors.delete(documentId);
    }
}

/** In-memory PendingOpStore with the same contract the IDB one has. */
export class MemoryPendingStore {
    private records = new Map<string, PendingOpRecord>();
    private lastCounter = 0n;
    readonly observedAckIds = new Set<string>();
    failNextAdd = false;

    constructor(private readonly docId: string, private readonly persistence?: MemoryPersistence) {}

    private key(id: string): string {
        return `${this.docId}:${id}`;
    }

    async addPending(id: string, op: Uint8Array): Promise<void> {
        if (this.failNextAdd) {
            this.failNextAdd = false;
            throw new Error("simulated outbox transaction failure");
        }
        const key = this.key(id);
        if (!this.records.has(key)) {
            this.records.set(key, {
                id: key as PendingOpRecord["id"],
                op,
                state: "pending",
                seq: this.records.size,
                savedAt: Date.now(),
            });
        }
        const counter = BigInt(id.split(":").at(-1) ?? "0");
        if (counter > this.lastCounter) this.lastCounter = counter;
    }
    async lastSeenCounter(): Promise<string> {
        return this.lastCounter.toString();
    }
    async unackedOps(): Promise<PendingOpRecord[]> {
        return [...this.records.values()]
            .filter((r) => r.state !== "durably_acked")
            .sort((a, b) => a.seq - b.seq);
    }
    async markSent(ids: string[]): Promise<void> {
        for (const id of ids) {
            const rec = this.records.get(this.key(id));
            if (rec && rec.state !== "durably_acked") rec.state = "sent";
        }
    }
    async markDurablyAcked(ids: string[]): Promise<void> {
        for (const id of ids) this.observedAckIds.add(id);
        for (const id of ids) {
            const rec = this.records.get(this.key(id));
            if (rec && rec.state !== "durably_acked") rec.state = "durably_acked";
        }
    }
    async ackedIds(): Promise<string[]> {
        return [...this.records.values()]
            .filter((record) => record.state === "durably_acked")
            .map((record) => record.id.slice(`${this.docId}:`.length));
    }
    async clearAcked(ids: string[]): Promise<number> {
        const covered = await this.persistence?.loadCoveredOpIds(this.docId, ids) ?? new Set<string>();
        const removed: string[] = [];
        for (const id of ids) {
            if (!covered.has(id)) continue;
            const key = this.key(id);
            if (this.records.get(key)?.state === "durably_acked") {
                this.records.delete(key);
                removed.push(id);
            }
        }
        await this.persistence?.clearCoveredOpIds(this.docId, removed);
        return removed.length;
    }
    async stateCounts(): Promise<Record<string, number>> {
        const counts = { pending: 0, sent: 0, durably_acked: 0 };
        for (const record of this.records.values()) {
            counts[record.state] += 1;
        }
        return counts;
    }
    close(): void {}
}

export class CoreBackedClient {
    private nextId = 1;
    private listeners = new Set<(ops: Uint8Array[]) => void>();

    constructor(
        private readonly core: CrdtWorkerCore,
        private readonly documentId: string,
    ) {}

    private notifyLocal(ops: Uint8Array[]): void {
        if (ops.length === 0) return;
        for (const listener of this.listeners) listener(ops);
    }

    async init(replicaId: bigint): Promise<void> {
        await this.core.handle({
            id: this.nextId++,
            kind: "init",
            documentId: this.documentId,
            replicaId: replicaId.toString(),
        });
    }
    async localInsertText(streamIndex: number, codepoint: number): Promise<Uint8Array[]> {
        const r = await this.core.handle({
            id: this.nextId++,
            kind: "localInsertText",
            streamIndex,
            codepoint,
        });
        const ops = (r as { ops: Uint8Array[] }).ops;
        this.notifyLocal(ops); // mirrors the worker localOps push
        return ops;
    }
    async localDelete(streamIndex: number): Promise<Uint8Array[]> {
        const r = await this.core.handle({ id: this.nextId++, kind: "localDelete", streamIndex });
        const ops = (r as { ops: Uint8Array[] }).ops;
        this.notifyLocal(ops);
        return ops;
    }
    async applyRemote(ops: Uint8Array[], cursor?: string): Promise<{ applied: number; duplicates: number }> {
        return (await this.core.handle({ id: this.nextId++, kind: "applyRemote", ops, cursor })) as {
            applied: number;
            duplicates: number;
        };
    }
    async digest(): Promise<string> {
        const result = await this.core.handle({ id: this.nextId++, kind: "digest" });
        return (result as { digest: string }).digest;
    }
    async syncCursor(): Promise<string> {
        const r = await this.core.handle({ id: this.nextId++, kind: "getSyncCursor" });
        return (r as { kind: "getSyncCursor"; cursor: string }).cursor;
    }
    async persistSyncCursor(cursor: string): Promise<void> {
        await this.core.handle({ id: this.nextId++, kind: "persistSyncCursor", cursor });
    }
    async replicaInfo(): Promise<{ replicaId: string; sequence: string }> {
        const r = await this.core.handle({ id: this.nextId++, kind: "replicaInfo" });
        return r as { kind: "replicaInfo"; replicaId: string; sequence: string };
    }
    async localOpsSince(counter: string): Promise<{ ops: Uint8Array[]; nextCounter: string }> {
        const r = await this.core.handle({
            id: this.nextId++,
            kind: "localOpsSince",
            counter,
        });
        return r as { kind: "localOpsSince"; ops: Uint8Array[]; nextCounter: string };
    }
    async importSnapshot(snapshot: Uint8Array): Promise<void> {
        await this.core.handle({ id: this.nextId++, kind: "importSnapshot", snapshot });
    }
    async exportSnapshot(): Promise<Uint8Array> {
        const r = await this.core.handle({ id: this.nextId++, kind: "exportSnapshot" });
        return (r as { snapshot: Uint8Array }).snapshot;
    }
    async visibleJson(): Promise<string> {
        const r = await this.core.handle({ id: this.nextId++, kind: "visibleJson" });
        return (r as { json: string }).json;
    }
    onLocalOps(handler: (ops: Uint8Array[]) => void): () => void {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }
}
