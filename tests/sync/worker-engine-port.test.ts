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
import { describe, expect, it } from "vitest";

import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { PersistenceAdapter, LocalState } from "@/lib/crdt/worker/idb";
import { WorkerEnginePort } from "@/lib/sync/worker-engine-port";
import type { PendingOpStore, PendingOpRecord } from "@/lib/sync/pending-store";
import { identityFromOpBytes } from "@/lib/sync/identities";

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
    logs = new Map<string, { seq: number; op: Uint8Array }[]>();

    async loadLocalState(documentId: string): Promise<LocalState> {
        return {
            snapshot: this.snapshots.get(documentId) ?? null,
            ops: (this.logs.get(documentId) ?? []).map((entry) => entry.op),
        };
    }
    async appendOps(documentId: string, ops: Uint8Array[]): Promise<void> {
        const log = this.logs.get(documentId) ?? [];
        for (const op of ops) {
            log.push({ seq: log.length, op });
        }
        this.logs.set(documentId, log);
    }
    async saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void> {
        this.snapshots.set(documentId, snapshot);
    }
    async clearDocument(documentId: string): Promise<void> {
        this.logs.delete(documentId);
        this.snapshots.delete(documentId);
    }
}

/** In-memory PendingOpStore with the same contract the IDB one has. */
class MemoryPendingStore {
    private records = new Map<string, PendingOpRecord>();

    constructor(private readonly docId: string) {}

    private key(id: string): string {
        return `${this.docId}:${id}`;
    }

    async addPending(id: string, op: Uint8Array): Promise<void> {
        this.records.set(this.key(id), {
            id: this.key(id) as PendingOpRecord["id"],
            op,
            state: "pending",
            seq: this.records.size,
            savedAt: Date.now(),
        });
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
    async clearAcked(): Promise<number> {
        return 0;
    }
    async stateCounts(): Promise<Record<string, number>> {
        return { pending: 0, sent: 0, durably_acked: 0 };
    }
    close(): void {}
}

const DOC = "worker-port-doc";

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
    async applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }> {
        return (await this.core.handle({ id: this.nextId++, kind: "applyRemote", ops })) as {
            applied: number;
            duplicates: number;
        };
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
    const store = new MemoryPendingStore(DOC);
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
        const store = new MemoryPendingStore(DOC);
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
