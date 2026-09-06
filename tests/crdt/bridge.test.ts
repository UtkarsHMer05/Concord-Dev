// P2 final-gate regression: the product seed path. start() must emit the
// server seed into the CRDT replica (the old dead guard left the engine empty
// while the editor showed content), must not deadlock on the
// start/transaction coordination, and the post-seed baseline must be stable.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";

import { CrdtEditorBridge, type BridgeState } from "@/lib/crdt/editor-bridge";
import type { StreamEntryJson } from "@/lib/crdt/adapter";
import { blocksToPmDoc, pmDocToBlocks, type PmNode } from "@/lib/crdt/pm-model";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { PersistenceAdapter, LocalState } from "@/lib/crdt/worker/idb";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wasmDist = path.join(repoRoot, "wasm/dist");

async function loadFactory() {
    const source = await readFile(path.join(wasmDist, "concord-crdt.js"), "utf8");
    const binary = await readFile(path.join(wasmDist, "concord-crdt.wasm"));
    const load = new Function(`${source}; return loadConcordCrdt;`)();
    return (await load({
        instantiateWasm(info: WebAssembly.Imports, receiveInstance: (i: WebAssembly.Instance) => void) {
            WebAssembly.instantiate(binary, info).then((r) => receiveInstance(r.instance));
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

/** CrdtClient-shaped adapter delegating to a real CrdtWorkerCore. */
class CoreBackedClient {
    private nextId = 1;

    constructor(
        private readonly core: CrdtWorkerCore,
        private readonly documentId: string,
    ) {}

    async init(replicaId: bigint): Promise<void> {
        await this.core.handle({
            id: this.nextId++,
            kind: "init",
            documentId: this.documentId,
            replicaId: replicaId.toString(),
        });
    }

    async localInsertText(streamIndex: number, codepoint: number): Promise<Uint8Array[]> {
        const r = await this.core.handle({ id: this.nextId++, kind: "localInsertText", streamIndex, codepoint });
        return (r as { ops: Uint8Array[] }).ops;
    }

    async localInsertDelimiter(streamIndex: number, blockType: string): Promise<Uint8Array[]> {
        const r = await this.core.handle({ id: this.nextId++, kind: "localInsertDelimiter", streamIndex, blockType });
        return (r as { ops: Uint8Array[] }).ops;
    }

    async localDelete(streamIndex: number): Promise<Uint8Array[]> {
        const r = await this.core.handle({ id: this.nextId++, kind: "localDelete", streamIndex });
        return (r as { ops: Uint8Array[] }).ops;
    }

    async localSetAttr(streamIndex: number, name: string, value: string | null): Promise<Uint8Array[]> {
        const r = await this.core.handle({ id: this.nextId++, kind: "localSetAttr", streamIndex, name, value });
        return (r as { ops: Uint8Array[] }).ops;
    }

    async visibleJson(): Promise<string> {
        const r = await this.core.handle({ id: this.nextId++, kind: "visibleJson" });
        return (r as { json: string }).json;
    }

    async exportStream(): Promise<StreamEntryJson[]> {
        const r = await this.core.handle({ id: this.nextId++, kind: "exportStream" });
        return JSON.parse((r as { json: string }).json) as StreamEntryJson[];
    }

    async exportOps(): Promise<Uint8Array[]> {
        const r = await this.core.handle({ id: this.nextId++, kind: "exportOps" });
        return (r as { ops: Uint8Array[] }).ops;
    }
}

/** Minimal TipTap editor stub: setContent/getJSON over held PM JSON. */
function fakeEditor(): Editor & { current: PmNode | null } {
    const editor = {
        current: null as PmNode | null,
        commands: {
            setContent(json: PmNode, opts: { emitUpdate: boolean }) {
                // The bridge must suppress updates — feedback-loop guard (M038).
                if (opts.emitUpdate) {
                    throw new Error("bridge setContent must use emitUpdate:false");
                }
                editor.current = json;
            },
        },
        getJSON(): PmNode {
            return editor.current as PmNode;
        },
    };
    return editor as unknown as Editor & { current: PmNode | null };
}

const DOC = "bridge-seed-doc";

function seedPmDoc(): PmNode {
    return {
        type: "doc",
        content: [
            { type: "paragraph", content: [{ type: "text", text: "hello world" }] },
            { type: "paragraph", content: [{ type: "text", text: "second" }] },
        ],
    };
}

interface VisibleDoc {
    blocks: { runs: { t: string }[] }[];
}

describe("editor bridge seed path (final gate)", () => {
    it("emits the server seed into the replica and keeps a stable baseline", async () => {
        const persistence = new MemoryPersistence();
        const core = new CrdtWorkerCore({ documentId: DOC, replicaId: 7n, loadFactory, persistence });
        const client = new CoreBackedClient(core, DOC);
        const editor = fakeEditor();
        const statuses: BridgeState[] = [];

        const bridge = new CrdtEditorBridge({
            editor: editor as unknown as Editor,
            client: client as unknown as CrdtClient,
            documentId: DOC,
            seedPmDoc: seedPmDoc(),
            onStatusChange: (s) => statuses.push(s),
        });

        // Must RESOLVE — awaiting start coordination from within the seed
        // emission would self-deadlock; this assertion pins that fix too.
        const state = await bridge.start();
        expect(state.mode).toBe("crdt");
        expect(statuses.some((s) => s.mode === "crdt")).toBe(true);

        // THE regression: the seed reached the durable replica (the old dead
        // guard `seedIsNew && !crdtIsEmpty` never fired, leaving the engine
        // empty while the editor showed content).
        const visible = JSON.parse(await client.visibleJson()) as VisibleDoc;
        expect(visible.blocks[0].runs[0].t).toBe("hello world");
        expect(visible.blocks[1].runs[0].t).toBe("second");
        const durableAfterSeed = (await client.exportOps()).length;
        expect(durableAfterSeed).toBeGreaterThan(0);

        // Reconciling identical content is a no-op (stable baseline).
        await bridge.onLocalTransaction(editor);
        expect((await client.exportOps()).length).toBe(durableAfterSeed);

        // Typing appends within range: "hello world" → "hello world!!".
        const typed = pmDocToBlocks(seedPmDoc());
        typed.blocks[0].chars.push({ scalar: "!", marks: {} }, { scalar: "!", marks: {} });
        editor.current = blocksToPmDoc(typed.blocks);
        await bridge.onLocalTransaction(editor);
        const afterTyping = JSON.parse(await client.visibleJson()) as VisibleDoc;
        expect(afterTyping.blocks[0].runs[0].t).toBe("hello world!!");
        expect(afterTyping.blocks[1].runs[0].t).toBe("second");

        // Reload: a fresh worker core over the same durable store restores
        // the seed + the typed edit (local durability, M036/M037).
        const reloaded = new CrdtWorkerCore({ documentId: DOC, replicaId: 7n, loadFactory, persistence });
        await reloaded.handle({ id: 10_000, kind: "init", documentId: DOC, replicaId: "7" });
        const restoredResp = (await reloaded.handle({
            id: 10_001,
            kind: "visibleJson",
        })) as { json: string };
        const restored = JSON.parse(restoredResp.json) as VisibleDoc;
        expect(restored.blocks[0].runs[0].t).toBe("hello world!!");
        expect(restored.blocks[1].runs[0].t).toBe("second");
    });
});