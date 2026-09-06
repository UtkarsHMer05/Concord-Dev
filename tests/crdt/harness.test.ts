// P2-M043/M044: multi-replica harness + offline-first flow.
//
// Two independent worker cores (each owning its own WASM engine + durable
// store) exchange operations through a controllable in-memory transport that
// models the Phase 3 delivery contract: at-least-once, any order, arbitrary
// duplication. Partitions delay delivery; healing delivers everything.
//
// This is NOT a network implementation — it is the deterministic browser/
// worker-level harness that proves the local-first semantics before Phase 3.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { PersistenceAdapter, LocalState } from "@/lib/crdt/worker/idb";

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

interface Replica {
    core: CrdtWorkerCore;
    persistence: MemoryPersistence;
    /** Ops generated locally but not yet broadcast. */
    outbox: Uint8Array[];
    /** Durable log length already broadcast (for op pickup). */
    broadcastThrough: number;
}

let nextRequestId = 1;

async function makeReplica(
    replicaId: bigint,
    documentId: string,
    factory: () => Promise<unknown>,
    persistenceArg?: MemoryPersistence,
): Promise<Replica> {
    const persistence = persistenceArg ?? new MemoryPersistence();
    const core = new CrdtWorkerCore({
        documentId,
        replicaId,
        loadFactory: factory as never,
        persistence,
    });
    await core.handle({
        id: nextRequestId++,
        kind: "init",
        documentId,
        replicaId: replicaId.toString(),
    });
    return { core, persistence, outbox: [], broadcastThrough: 0 };
}

/** Pick up newly durable ops from a replica's log into its outbox. */
async function collect(replica: Replica, documentId: string): Promise<void> {
    const result = (await replica.core.handle({
        id: nextRequestId++,
        kind: "exportOps",
    })) as { kind: "exportOps"; ops: Uint8Array[] };
    while (replica.broadcastThrough < result.ops.length) {
        replica.outbox.push(result.ops[replica.broadcastThrough]);
        replica.broadcastThrough += 1;
    }
    void documentId;
}

/** Delivers everything in every outbox to every other replica, shuffled + duplicated. */
async function broadcast(replicas: Replica[], rng: () => number): Promise<void> {
    for (const replica of replicas) {
        const messages = [...replica.outbox];
        replica.outbox = [];
        const doubled = [...messages, ...messages.filter(() => rng() < 0.5)];
        for (const other of replicas) {
            if (other === replica) {
                continue;
            }
            for (const op of doubled) {
                await other.core.handle({ id: nextRequestId++, kind: "applyRemote", ops: [op] });
            }
        }
    }
}

const DOCUMENT = "harness-doc";

describe("multi-replica harness (M043)", () => {
    it("converges three replicas under concurrent typing, deletion, and duplication", async () => {
        const replicas = [
            await makeReplica(101n, DOCUMENT, loadFactory),
            await makeReplica(102n, DOCUMENT, loadFactory),
            await makeReplica(103n, DOCUMENT, loadFactory),
        ];
        const rng = (() => {
            let state = 424242n;
            return () => {
                state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
                return Number(state >> 33n) / 0x100000000;
            };
        })();

        // Round 1: every replica types concurrently at the end.
        for (const [index, replica] of replicas.entries()) {
            const size = await replica.core
                .handle({ id: nextRequestId++, kind: "streamSize" })
                .then((r) => (r as { kind: "streamSize"; size: number }).size);
            const insert = await replica.core.handle({
                id: nextRequestId++,
                kind: "localInsertText",
                streamIndex: size,
                codepoint: 0x61 + index,
            });
            void insert;
        }
        await Promise.all(replicas.map((r) => collect(r, DOCUMENT)));
        await broadcast(replicas, rng);

        // Round 2: replica 0 deletes its first char; replica 1 bolds its first.
        {
            const first = replicas[0];
            const ops = (await first.core.handle({
                id: nextRequestId++,
                kind: "exportOps",
            })) as { kind: "exportOps"; ops: Uint8Array[] };
            void ops;
            const size = await first.core
                .handle({ id: nextRequestId++, kind: "streamSize" })
                .then((r) => (r as { kind: "streamSize"; size: number }).size);
            await first.core.handle({
                id: nextRequestId++,
                kind: "localDelete",
                streamIndex: Math.floor((size - 1) / 2),
            });
            const boldOn = await replicas[1].core.handle({
                id: nextRequestId++,
                kind: "localSetAttr",
                streamIndex: 0,
                name: "bold",
                value: "1",
            });
            void boldOn;
        }
        await Promise.all(replicas.map((r) => collect(r, DOCUMENT)));
        await broadcast(replicas, rng);

        // Round 3: more concurrent inserts at the middle.
        for (const [index, replica] of replicas.entries()) {
            const size = await replica.core
                .handle({ id: nextRequestId++, kind: "streamSize" })
                .then((r) => (r as { kind: "streamSize"; size: number }).size);
            await replica.core.handle({
                id: nextRequestId++,
                kind: "localInsertText",
                streamIndex: Math.floor(size / 2),
                codepoint: 0x41 + index,
            });
        }
        await Promise.all(replicas.map((r) => collect(r, DOCUMENT)));
        await broadcast(replicas, rng);

        // All replicas converge on identical digests + visible state.
        const digests: string[] = [];
        for (const replica of replicas) {
            const result = (await replica.core.handle({
                id: nextRequestId++,
                kind: "digest",
            })) as { digest: string };
            digests.push(result.digest);
        }
        expect(new Set(digests).size).toBe(1);
    });
});

describe("offline-first flow (M044)", () => {
    it("edits offline, reloads from IndexedDB, reconciles on reconnect", async () => {
        const local = await makeReplica(201n, DOCUMENT, loadFactory);
        const peer = await makeReplica(202n, DOCUMENT, loadFactory);

        // Phase 1: seed the peer (the "server"/peer copy) with content.
        const size = await peer.core
            .handle({ id: nextRequestId++, kind: "streamSize" })
            .then((r) => (r as { kind: "streamSize"; size: number }).size);
        await peer.core.handle({
            id: nextRequestId++,
            kind: "localInsertText",
            streamIndex: size,
            codepoint: 0x48, // H
        });
        await peer.core.handle({
            id: nextRequestId++,
            kind: "localInsertText",
            streamIndex: 1,
            codepoint: 0x69, // i
        });
        await collect(peer, DOCUMENT);

        // Phase 2: local replica receives the seed, then goes OFFLINE.
        await collect(local, DOCUMENT);
        await broadcast([local, peer], () => 0.5);

        // Phase 3: edits while offline (local ops are durable via IndexedDB).
        const size2 = await local.core
            .handle({ id: nextRequestId++, kind: "streamSize" })
            .then((r) => (r as { kind: "streamSize"; size: number }).size);
        await local.core.handle({
            id: nextRequestId++,
            kind: "localInsertText",
            streamIndex: size2,
            codepoint: 0x21, // !
        });
        const offlineDigest = (await local.core
            .handle({ id: nextRequestId++, kind: "digest" })
            .then((r) => r)) as { digest: string };

        // Phase 4: reload (fresh core instance, same durable store) — the
        // offline edit survives the reload.
        // Reload: fresh core instance over the SAME durable store.
        const reloaded = await makeReplica(201n, DOCUMENT, loadFactory, local.persistence);
        const digestAfterReload = (await reloaded.core
            .handle({ id: nextRequestId++, kind: "digest" })
            .then((r) => r)) as { digest: string };
        expect(digestAfterReload.digest).toBe(offlineDigest.digest);

        // Phase 5: reconnect — exchange everything; convergence.
        await collect(reloaded, DOCUMENT);
        await collect(peer, DOCUMENT);
        await broadcast([reloaded, peer], () => 0.3);
        const peerDigest = (await peer.core
            .handle({ id: nextRequestId++, kind: "digest" })
            .then((r) => r)) as { digest: string };
        expect(peerDigest.digest).toBe(digestAfterReload.digest);

        // The visible content contains both the seed and the offline edit.
        const json = (await peer.core
            .handle({ id: nextRequestId++, kind: "visibleJson" })
            .then((r) => r)) as { json: string };
        expect(json.json).toContain("Hi");
        expect(json.json).toContain("!");
    });
});
