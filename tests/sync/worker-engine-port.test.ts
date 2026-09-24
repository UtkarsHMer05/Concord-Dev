// D16 (Phase 7): the REAL sync seam — WorkerEnginePort over a real
// CrdtWorkerCore (same WASM engine the product worker runs), plus the new
// worker RPCs (replicaInfo / localOpsSince / importSnapshot) and the
// local-ops push subscription the SyncSession consumes.
//
// Covers:
// - replicaInfo: join-summary format (decimal replica id + own counter);
// - applyRemote idempotence through the port (duplicates counted);
// - onLocalOps: local ops observed after durable append, remote ops are NOT
//   pushed (only local generation pushes);
// - localOpsSince: resumable own-op cursor, other replicas filtered out;
// - importSnapshot: atomic base replacement (visible state swap);
// - unackedOps: sourced from the PendingOpStore (unsynced set), not the
//   engine log (remote ops never enter the resend set).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { PersistenceAdapter, LocalState } from "@/lib/crdt/worker/idb";
import { WorkerEnginePort } from "@/lib/sync/worker-engine-port";
import type { PendingOpStore, PendingOpRecord } from "@/lib/sync/pending-store";
import { identityFromOpBytes } from "@/lib/sync/identities";
import { SyncSession } from "@/lib/sync/sync-session";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wasmDist = path.join(repoRoot, "wasm/dist");

async function loadFactory() {
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

class MemoryPersistence implements PersistenceAdapter {
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
class MemoryPendingStore {
    private records = new Map<string, PendingOpRecord>();
    private lastCounter = 0n;
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

const DOC = "worker-port-doc";

class MockSessionSocket {
    static instances: MockSessionSocket[] = [];
    static OPEN = 1;
    readyState = MockSessionSocket.OPEN;
    binaryType = "";
    sent: Array<string | ArrayBuffer> = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string) {
        if (!url) throw new Error("mock socket requires a URL");
        MockSessionSocket.instances.push(this);
    }

    send(data: string | ArrayBuffer): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3;
        this.onclose?.();
    }

    serverSend(data: string | ArrayBuffer): void {
        this.onmessage?.({ data } as MessageEvent);
    }

    texts(): string[] {
        return this.sent.filter((frame): frame is string => typeof frame === "string");
    }
}

async function authenticateAndJoin(socket: MockSessionSocket): Promise<void> {
    socket.onopen?.();
    socket.serverSend('{"v":1,"type":"hello_ack","payload":{"protocolVersion":1,"connectionId":"test"}}');
    await vi.waitFor(() => expect(socket.texts().some((frame) => frame.includes('"authenticate"'))).toBe(true));
    socket.serverSend('{"v":1,"type":"authenticated","payload":{"userId":"u1","clerkUserId":"cu1"}}');
    await vi.waitFor(() => expect(socket.texts().some((frame) => frame.includes('"join_document"'))).toBe(true));
    socket.serverSend('{"v":1,"type":"join_accepted","payload":{"documentId":"worker-port-doc","role":"owner","durableCursor":"0"}}');
    await vi.waitFor(() => expect(socket.texts().some((frame) => frame.includes('"sync_request"'))).toBe(true));
}

function syncBatch(cursor: number, op: Uint8Array): ArrayBuffer {
    const frame = new Uint8Array(17 + op.length);
    const view = new DataView(frame.buffer);
    frame[0] = 1;
    frame[1] = 0x21;
    view.setBigUint64(2, BigInt(cursor), false);
    frame[10] = 0;
    view.setUint16(11, 1, false);
    view.setUint32(13, op.length, false);
    frame.set(op, 17);
    return frame.buffer;
}

/**
 * CrdtClient-shaped adapter delegating to a real CrdtWorkerCore — the same
 * real-engine seam the bridge.test.ts CoreBackedClient uses, extended with
 * the D16 sync-seam methods (replicaInfo/localOpsSince/importSnapshot) and
 * a faithful onLocalOps push (local ops only, exactly what the worker's
 * localOps notification delivers in the browser).
 */
class CoreBackedClient {
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

interface Harness {
    client: CoreBackedClient;
    core: CrdtWorkerCore;
    persistence: MemoryPersistence;
    store: MemoryPendingStore;
    port: WorkerEnginePort;
}

async function newHarness(replicaId = 4242n): Promise<Harness> {
    const persistence = new MemoryPersistence();
    const core = new CrdtWorkerCore({
        documentId: DOC,
        replicaId,
        loadFactory,
        persistence,
    });
    const client = new CoreBackedClient(core, DOC);
    await client.init(replicaId);
    const store = new MemoryPendingStore(DOC, persistence);
    const port = new WorkerEnginePort({
        client: client as unknown as import("@/lib/crdt/worker/client").CrdtClient,
        store: store as unknown as PendingOpStore,
    });
    return { client, core, persistence, store, port };
}

describe("new worker RPCs: replicaInfo / localOpsSince / importSnapshot", () => {
    it("replicaInfo reports the replica id and own counter as decimal strings", async () => {
        const h = await newHarness();
        await h.client.localInsertText(0, 0x61);
        await h.client.localInsertText(1, 0x62);
        const info = await h.client.replicaInfo();
        expect(info.replicaId).toBe("4242");
        expect(info.sequence).toBe("2");
        // Empty replica: sequence 0 (the join summary baseline).
        const fresh = await newHarness(9999n);
        expect((await fresh.client.replicaInfo()).sequence).toBe("0");
    });

    it("localOpsSince returns own ops past a counter and skips other replicas", async () => {
        const h = await newHarness();
        await h.client.localInsertText(0, 0x61);
        await h.client.localInsertText(1, 0x62);

        // Everything past counter 0.
        const all = await h.client.localOpsSince("0");
        expect(all.ops).toHaveLength(2);
        expect(all.nextCounter).toBe("2");

        // Nothing past counter 2 (the high-water mark).
        const none = await h.client.localOpsSince("2");
        expect(none.ops).toHaveLength(0);
        expect(none.nextCounter).toBe("2");

        // A REMOTE op (different replica) appended to the durable log must
        // NOT appear in the own-op stream — only this replica's ops ever
        // enter the client outbox. Remote ops join the log (M044) via
        // applyRemote; own-op filtering is by replica id.
        const peer = await newHarness(8n);
        const peerOp = (await peer.client.localInsertText(0, 0x71))[0];
        await h.client.applyRemote([peerOp]);
        const still = await h.client.localOpsSince("0");
        expect(still.ops).toHaveLength(2);
        for (const op of still.ops) {
            expect(identityFromOpBytes(op)?.replica).toBe(4242n);
        }
    });

    it("importSnapshot atomically replaces the base (visible state swaps)", async () => {
        const source = await newHarness(7n);
        await source.client.localInsertText(0, 0x68); // h
        await source.client.localInsertText(1, 0x69); // i
        const snapshot = await source.client.exportSnapshot();

        const target = await newHarness(4242n);
        await target.client.localInsertText(0, 0x7a); // z — pre-import state
        expect(JSON.parse(await target.client.visibleJson())).toMatchObject({
            blocks: [{ runs: [{ t: "z" }] }],
        });

        await target.client.importSnapshot(snapshot);
        const visible = JSON.parse(await target.client.visibleJson()) as {
            blocks: { runs: { t: string }[] }[];
        };
        expect(visible.blocks[0].runs[0].t).toBe("hi");
    });
});

describe("WorkerEnginePort over the real engine (D16)", () => {
    it("applyRemote is idempotent and fires the remote-render hook only for new ops", async () => {
        const remoteRenders: number[] = [];
        const persistence = new MemoryPersistence();
        const core = new CrdtWorkerCore({
            documentId: DOC,
            replicaId: 7n,
            loadFactory,
            persistence,
        });
        const client = new CoreBackedClient(core, DOC);
        await client.init(7n);
        const store = new MemoryPendingStore(DOC, persistence);
        const port = new WorkerEnginePort({
            client: client as unknown as import("@/lib/crdt/worker/client").CrdtClient,
            store: store as unknown as PendingOpStore,
            onRemoteApplied: () => remoteRenders.push(Date.now()),
        });

        // A remote peer's op (real bytes from a second real engine).
        const peer = await newHarness(8n);
        const peerOp = (await peer.client.localInsertText(0, 0x71))[0];

        const first = await port.applyRemote([peerOp]);
        expect(first.applied).toBe(1);
        expect(first.duplicates).toBe(0);
        expect(remoteRenders).toHaveLength(1);

        // Idempotent re-delivery: duplicate counted, NO re-render (the
        // editor would otherwise thrash on every redundant batch).
        const second = await port.applyRemote([peerOp]);
        expect(second.applied).toBe(0);
        expect(second.duplicates).toBe(1);
        expect(remoteRenders).toHaveLength(1);
    });

    it("onLocalOps observes locally generated ops and never remote ones", async () => {
        const h = await newHarness();
        const observed: Uint8Array[][] = [];
        h.port.onLocalOps((ops) => observed.push(ops));

        await h.client.localInsertText(0, 0x61);
        expect(observed).toHaveLength(1);
        expect(observed[0]).toHaveLength(1);
        expect(identityFromOpBytes(observed[0][0])?.replica).toBe(4242n);

        // Remote application through the port does NOT push local ops.
        const peer = await newHarness(8n);
        const peerOp = (await peer.client.localInsertText(0, 0x71))[0];
        await h.port.applyRemote([peerOp]);
        expect(observed).toHaveLength(1); // still only the local op
    });

    it("port summary matches the join-summary contract (decimal strings)", async () => {
        const h = await newHarness();
        await h.client.localInsertText(0, 0x61);
        expect(await h.port.replicaId()).toBe("4242");
        expect(await h.port.localSummary()).toBe("1");
        // Both must be canonical u64 decimals (what the gateway parses).
        expect(await h.port.replicaId()).toMatch(/^(?:0|[1-9][0-9]*)$/);
        expect(await h.port.localSummary()).toMatch(/^(?:0|[1-9][0-9]*)$/);
    });

    it("unackedOps reads the UNSYNCED outbox (pending + sent), never the engine log", async () => {
        const h = await newHarness();
        const local = await h.client.localInsertText(0, 0x61);
        const id = identityFromOpBytes(local[0])!;
        const idStr = `${id.replica}:${id.counter}`;

        // Nothing pending yet: the outbox is the resend set, not the log.
        expect(await h.port.unackedOps()).toHaveLength(0);

        // Two ops in the outbox: one pending, one sent.
        const local2 = await h.client.localInsertText(1, 0x62);
        const id2 = identityFromOpBytes(local2[0])!;
        await h.store.addPending(idStr, local[0]);
        await h.store.addPending(`${id2.replica}:${id2.counter}`, local2[0]);
        await h.store.markSent([idStr]);
        const unacked = await h.port.unackedOps();
        expect(unacked).toHaveLength(2);

        // Durable ack removes one from the resend set.
        await h.store.markDurablyAcked([idStr]);
        expect(await h.port.unackedOps()).toHaveLength(1);
        expect(identityFromOpBytes((await h.port.unackedOps())[0])?.counter).toBe(id2.counter);
    });
});

describe("SyncSession durability recovery over the real worker core", () => {
    it("backfills a worker-log/outbox crash gap and retries a failed checkpoint without skipping ops", async () => {
        const original = await newHarness(7n);
        const persisted = await original.core.handle({
            id: 100,
            kind: "localInsertText",
            streamIndex: 0,
            codepoint: 0x61,
        }) as { ops: Uint8Array[] };
        const reloadedCore = new CrdtWorkerCore({
            documentId: DOC,
            replicaId: 7n,
            loadFactory,
            persistence: original.persistence,
        });
        const client = new CoreBackedClient(reloadedCore, DOC);
        await client.init(7n);
        const store = new MemoryPendingStore(DOC, original.persistence);
        store.failNextAdd = true;
        const localErrors: string[] = [];
        const port = new WorkerEnginePort({
            client: client as unknown as import("@/lib/crdt/worker/client").CrdtClient,
            store: store as unknown as PendingOpStore,
        });
        const session = new SyncSession({
            documentId: DOC,
            gatewayUrl: "ws://test",
            getToken: async () => "test",
            engine: port,
            getCursor: () => "0",
            setCursor: () => {},
            store: store as unknown as PendingOpStore,
            onLocalError: (message) => localErrors.push(message),
        });
        vi.stubGlobal("WebSocket", MockSessionSocket);
        MockSessionSocket.instances.length = 0;
        try {
            await session.start();
            expect(await store.lastSeenCounter()).toBe("0");
            expect(localErrors).toContain("simulated outbox transaction failure");

            // A later local notification forces a log backfill before its own
            // higher counter can advance the durable outbox checkpoint.
            await client.localInsertText(1, 0x62);
            await vi.waitFor(async () => {
                expect(await store.lastSeenCounter()).toBe("2");
                expect(await store.unackedOps()).toHaveLength(2);
            });
            const rows = await store.unackedOps();
            expect(rows.map((row) => identityFromOpBytes(row.op)?.counter)).toEqual([1n, 2n]);
            expect(rows[0].op).toEqual(persisted.ops[0]);
        } finally {
            await session.stop();
            vi.unstubAllGlobals();
        }
    });

    it("persists each catch-up batch before advancing the durable cursor", async () => {
        const target = await newHarness(7n);
        const source = await newHarness(8n);
        const remote = (await source.client.localInsertText(0, 0x72))[0];
        let releaseAppend!: () => void;
        let markAppendStarted!: () => void;
        const appendStarted = new Promise<void>((resolve) => { markAppendStarted = resolve; });
        const appendWait = new Promise<void>((resolve) => { releaseAppend = resolve; });
        target.persistence.appendGate = { started: markAppendStarted, wait: appendWait };
        let cursor = "0";
        const port = new WorkerEnginePort({
            client: target.client as unknown as import("@/lib/crdt/worker/client").CrdtClient,
            store: target.store as unknown as PendingOpStore,
        });
        const session = new SyncSession({
            documentId: DOC,
            gatewayUrl: "ws://test",
            getToken: async () => "test",
            engine: port,
            getCursor: () => cursor,
            setCursor: (value) => { cursor = value; },
            store: target.store as unknown as PendingOpStore,
        });
        vi.stubGlobal("WebSocket", MockSessionSocket);
        MockSessionSocket.instances.length = 0;
        try {
            await session.start();
            const socket = MockSessionSocket.instances.at(-1)!;
            await authenticateAndJoin(socket);
            socket.serverSend(syncBatch(42, remote));
            await appendStarted;
            expect(cursor).toBe("0");
            expect(await target.persistence.loadSyncCursor(DOC)).toBe("0");
            expect(target.persistence.logs.get(DOC) ?? []).toHaveLength(0);
            socket.serverSend('{"v":1,"type":"sync_done","payload":{}}');
            await Promise.resolve();
            expect(cursor).toBe("0");
            releaseAppend();
            await vi.waitFor(() => expect(cursor).toBe("42"));
            expect(target.persistence.logs.get(DOC)).toHaveLength(1);
            expect(await target.persistence.loadSyncCursor(DOC)).toBe("42");
            expect(target.persistence.logs.get(DOC)?.[0].coveredAtCursor).toBeUndefined();
        } finally {
            releaseAppend();
            await session.stop();
            vi.unstubAllGlobals();
        }
    });

    it("persists duplicate-only catch-up cursor atomically, then prunes proof after ACK compaction", async () => {
        const h = await newHarness(7n);
        const local = (await h.client.localInsertText(0, 0x72))[0];
        const identity = identityFromOpBytes(local)!;
        const id = `${identity.replica}:${identity.counter}`;
        await h.store.addPending(id, local);
        await h.store.markDurablyAcked([id]);

        h.persistence.failNextAppend = true;
        await expect(h.port.applyRemote([local], "42")).rejects.toThrow(
            "simulated IndexedDB transaction failure",
        );
        expect(h.persistence.logs.get(DOC) ?? []).toHaveLength(1);
        expect(await h.port.syncCursor()).toBe("0");
        expect(h.persistence.logs.get(DOC)?.[0].coveredAtCursor).toBeUndefined();
        expect(await h.store.clearAcked([id])).toBe(0);
        expect((await h.store.stateCounts()).durably_acked).toBe(1);

        await expect(h.port.applyRemote([local], "42")).resolves.toMatchObject({
            applied: 0,
            duplicates: 1,
        });
        expect(await h.port.syncCursor()).toBe("42");
        expect(h.persistence.logs.get(DOC)).toHaveLength(1);
        expect(h.persistence.logs.get(DOC)?.[0].coveredAtCursor).toBe("42");
        expect(await h.store.clearAcked([id])).toBe(1);
        expect((await h.store.stateCounts()).durably_acked).toBe(0);
        expect(h.persistence.logs.get(DOC)?.[0].coveredAtCursor).toBeUndefined();
    });

    it("keeps durable ACK rows until a later completed catch-up compacts them", async () => {
        const h = await newHarness(4242n);
        await h.client.localInsertText(0, 0x78);
        const localId = identityFromOpBytes((await h.client.localOpsSince("0")).ops[0])!;
        const outboxStates: Array<{
            pending: number;
            sent: number;
            durablyAcked: number;
            serverConfirmed: boolean;
        }> = [];
        const session = new SyncSession({
            documentId: DOC,
            gatewayUrl: "ws://test",
            getToken: async () => "test",
            engine: h.port,
            getCursor: () => "0",
            setCursor: () => {},
            store: h.store as unknown as PendingOpStore,
            onOutboxState: (state) => outboxStates.push(state),
        });
        vi.stubGlobal("WebSocket", MockSessionSocket);
        MockSessionSocket.instances.length = 0;
        try {
            await session.start();
            expect(outboxStates.at(-1)).toEqual({
                pending: 1,
                sent: 0,
                durablyAcked: 0,
                serverConfirmed: false,
            });
            const socket = MockSessionSocket.instances.at(-1)!;
            await authenticateAndJoin(socket);
            socket.serverSend('{"v":1,"type":"sync_done","payload":{}}');
            await vi.waitFor(async () => {
                expect((await h.store.stateCounts()).sent).toBe(1);
            });

            socket.serverSend(JSON.stringify({
                v: 1,
                type: "durable_ack",
                payload: { batchId: "1", opIds: [`${localId.replica}:${localId.counter}`] },
            }));
            await vi.waitFor(async () => {
                expect((await h.store.stateCounts()).durably_acked).toBe(1);
            });
            expect(await h.store.ackedIds()).toHaveLength(1);

            // A new sync_done stands in for a reconnect catch-up that has
            // not supplied durable coverage, so it cannot compact the row.
            socket.serverSend('{"v":1,"type":"sync_done","payload":{}}');
            await vi.waitFor(() => expect(outboxStates.at(-1)).toMatchObject({
                durablyAcked: 1,
                serverConfirmed: false,
            }));
            expect((await h.store.stateCounts()).durably_acked).toBe(1);
            expect(outboxStates.at(-1)).toMatchObject({ durablyAcked: 1, serverConfirmed: false });

            // Only the exact ACKed identity inside a catch-up batch, persisted
            // with cursor 42, proves it is safe to remove.
            const localOp = (await h.client.localOpsSince("0")).ops[0];
            socket.serverSend(syncBatch(42, localOp));
            await vi.waitFor(async () => expect(await h.port.syncCursor()).toBe("42"));
            socket.serverSend('{"v":1,"type":"sync_done","payload":{}}');
            await vi.waitFor(async () => {
                expect((await h.store.stateCounts()).durably_acked).toBe(0);
            });
            expect(await h.store.ackedIds()).toHaveLength(0);
            expect(outboxStates.at(-1)).toEqual({
                pending: 0,
                sent: 0,
                durablyAcked: 0,
                serverConfirmed: true,
            });
        } finally {
            await session.stop();
            vi.unstubAllGlobals();
        }
    });
});
