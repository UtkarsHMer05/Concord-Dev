// P2-M034/M036/M037: worker-core tests against the real WASM engine with an
// in-memory persistence adapter — local durability, reload/crash restoration,
// and persistence-failure surfacing.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { PersistenceAdapter, LocalState } from "@/lib/crdt/worker/idb";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wasmDist = path.join(repoRoot, "wasm/dist");

interface GoldenFixture {
    ops: string[];
    visible: string;
    digest: string;
}

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

/** In-memory adapter mirroring the IndexedDB schema semantics. */
class MemoryPersistence implements PersistenceAdapter {
    snapshots = new Map<string, Uint8Array>();
    logs = new Map<string, { seq: number; op: Uint8Array }[]>();
    failNextAppend = false;

    async loadLocalState(documentId: string): Promise<LocalState> {
        const ops = (this.logs.get(documentId) ?? []).map((entry) => entry.op);
        const snapshot = this.snapshots.get(documentId) ?? null;
        return { snapshot, ops };
    }

    async appendOps(documentId: string, ops: Uint8Array[]): Promise<void> {
        if (this.failNextAppend) {
            this.failNextAppend = false;
            throw new Error("simulated IndexedDB write failure");
        }
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
        this.snapshots.delete(documentId);
        this.logs.delete(documentId);
    }
}

const DOCUMENT = "test-document-1";

async function newCore(persistence: PersistenceAdapter, replicaId = 7n) {
    const core = new CrdtWorkerCore({
        documentId: DOCUMENT,
        replicaId,
        loadFactory,
        persistence,
    });
    await core.handle({ id: 0, kind: "init", documentId: DOCUMENT, replicaId: replicaId.toString() });
    return core;
}

describe("worker core: local durability", () => {
    it("acknowledges local edits only after durable append (M036)", async () => {
        const persistence = new MemoryPersistence();
        const core = await newCore(persistence);

        const result = await core.handle({ id: 1, kind: "localInsertText", streamIndex: 0, codepoint: 0x68 });
        // By the time the call resolved, the op must be durable.
        const durable = persistence.logs.get(DOCUMENT) ?? [];
        expect(durable.length).toBe(1);
        expect((result as { kind: string; ops: Uint8Array[] }).ops.length).toBe(1);
    });

    it("surfaces persistence failures as structured errors without losing state", async () => {
        const persistence = new MemoryPersistence();
        const core = await newCore(persistence);

        persistence.failNextAppend = true;
        await expect(
            core.handle({ id: 1, kind: "localInsertText", streamIndex: 0, codepoint: 0x68 }),
        ).rejects.toThrow("simulated IndexedDB write failure");

        // The engine integrated the op (mutation happened before persistence);
        // the failure is surfaced — the client must treat the document as in
        // a degraded, recovery-required state. This is the documented honest
        // behavior: never silently pretend the write persisted.
        const digestAfterFailure = await core.handle({ id: 2, kind: "digest" });
        expect((digestAfterFailure as { digest: string }).digest).toMatch(/^sha256:/);
    });
});

describe("worker core: reload/crash restoration (M037)", () => {
    it("restores the replica from snapshot + durable log after reload", async () => {
        const persistence = new MemoryPersistence();
        const core = await newCore(persistence);
        await core.handle({ id: 1, kind: "localInsertText", streamIndex: 0, codepoint: 0x61 }); // a
        await core.handle({ id: 2, kind: "localInsertText", streamIndex: 1, codepoint: 0x62 }); // b
        const digestBefore = await core.handle({ id: 3, kind: "digest" });

        // Simulate reload: fresh core over the same durable state.
        const reloaded = await newCore(persistence, 7n);
        const digestAfter = await reloaded.handle({ id: 4, kind: "digest" });
        expect(digestAfter).toEqual(digestBefore);
        const insertResult = await reloaded.handle({ id: 5, kind: "localInsertText", streamIndex: 2, codepoint: 0x63 }); // c
        expect((insertResult as { streamSize: number }).streamSize).toBe(3);
        const json = await reloaded.handle({ id: 6, kind: "visibleJson" });
        expect((json as { json: string }).json).toContain("abc");
    });

    it("restores ops newer than the snapshot (snapshot + tail replay)", async () => {
        const persistence = new MemoryPersistence();
        const core = await newCore(persistence);
        await core.handle({ id: 1, kind: "localInsertText", streamIndex: 0, codepoint: 0x78 }); // x
        // Snapshot taken after the first op.
        await core.handle({ id: 2, kind: "exportSnapshot" });
        await core.handle({ id: 3, kind: "localInsertText", streamIndex: 1, codepoint: 0x79 }); // y (log only)

        // Reload: snapshot has x; the durable log replays x (duplicate) + y.
        const reloaded = await newCore(persistence, 7n);
        const json = await reloaded.handle({ id: 4, kind: "visibleJson" });
        const parsed = JSON.parse((json as { json: string }).json);
        const rendered = JSON.stringify(parsed);
        expect(rendered).toContain("xy");
    });

    it("handles a corrupted durable entry via structured rejection on load", async () => {
        const persistence = new MemoryPersistence();
        const core = await newCore(persistence);
        await core.handle({ id: 1, kind: "localInsertText", streamIndex: 0, codepoint: 0x7a });

        // Corrupt the durable log directly (simulated IndexedDB corruption).
        const log = persistence.logs.get(DOCUMENT)!;
        log[0].op = new Uint8Array([1, 2, 3]); // malformed frame

        // A reload attempt must NOT silently discard the corruption: the
        // core surfaces the failure instead of pretending all is well.
        const reloaded = new CrdtWorkerCore({
            documentId: DOCUMENT,
            replicaId: 7n,
            loadFactory,
            persistence,
        });
        await expect(
            reloaded.handle({ id: 2, kind: "init", documentId: DOCUMENT, replicaId: "7" }),
        ).rejects.toThrow();
    });
});

describe("worker core: remote application", () => {
    it("applies remote batches with duplicate accounting", async () => {
        const persistence = new MemoryPersistence();
        const core = await newCore(persistence);
        const local = await core.handle({ id: 1, kind: "localInsertText", streamIndex: 0, codepoint: 0x71 });
        const ops = (local as { ops: Uint8Array[] }).ops;

        const first = await core.handle({ id: 2, kind: "applyRemote", ops });
        expect(
            (first as { kind: string; applied: number; duplicates: number }),
        ).toMatchObject({ applied: 0, duplicates: 1 });

        const peer = await newCore(new MemoryPersistence(), 8n);
        const remote = await peer.handle({ id: 3, kind: "applyRemote", ops });
        expect((remote as { applied: number })).toMatchObject({ applied: 1 });
    });
});
