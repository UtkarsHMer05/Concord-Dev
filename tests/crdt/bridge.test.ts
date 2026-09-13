// P2 final-gate regression: the product seed path. start() must emit the
// server seed into the CRDT replica (the old dead guard left the engine empty
// while the editor showed content), must not deadlock on the
// start/transaction coordination, and the post-seed baseline must be stable.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";

import { CrdtEditorBridge, replicaIdForDocument, type BridgeState } from "@/lib/crdt/editor-bridge";

it("allocates client replicas outside the maintenance namespace and retains legacy IDs", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
    });
    vi.stubGlobal("crypto", {
        getRandomValues: (bytes: Uint8Array) => bytes.fill(0),
    });
    try {
        const fresh = replicaIdForDocument("new");
        expect(fresh & (1n << 63n)).not.toBe(0n);
        expect(fresh).not.toBe(0x53595343n);
        expect(fresh).not.toBe(0x52455354n);
        stored.set("concord.replica.existing", "42");
        expect(replicaIdForDocument("existing")).toBe(42n);
    } finally {
        vi.unstubAllGlobals();
    }
});
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
// ---------------------------------------------------------------------------
// P7-M024: renderRemote coalescing (staging fanout-render stall regression).
// ---------------------------------------------------------------------------

describe("renderRemote coalescing (P7-M024 staging regression)", () => {
    /** A client whose visibleJson resolves after N ticks — models the async
     *  worker RPC; `calls` counts RPCs issued. */
    class CountingClient {
        calls = 0;
        constructor(private readonly delegate: CoreBackedClient) {}
        // Full CrdtClient surface via prototype delegation — only
        // visibleJson is instrumented (counts + async delay).
        init = (documentId: string, replicaId: bigint) => this.delegate.init(replicaId);
        exportStream = () => this.delegate.exportStream();
        exportOps = () => this.delegate.exportOps();
        async visibleJson(): Promise<string> {
            this.calls += 1;
            await new Promise((r) => setTimeout(r, 5));
            return this.delegate.visibleJson();
        }
    }

    it("a burst of renders coalesces to few RPCs and converges to the final state", async () => {
        const core = new CrdtWorkerCore({ documentId: "coalesce-doc", replicaId: 9n, loadFactory, persistence: new MemoryPersistence() });
        await core.handle({ id: 1, kind: "init", documentId: "coalesce-doc", replicaId: "9" });
        const delegate = new CoreBackedClient(core, "coalesce-doc");
        const client = new CountingClient(delegate);
        const editor = fakeEditor();
        const bridge = new CrdtEditorBridge({
            editor,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: client as any,
            documentId: "coalesce-doc",
            seedPmDoc: null,
        });
        const state = await bridge.start();
        expect(state.mode).toBe("crdt");

        // Simulate a fanout burst: 6 rapid renderRemote calls, un-awaited —
        // exactly what N consecutive onRemoteApplied batches produce.
        const renders = Array.from({ length: 6 }, () => bridge.renderRemote());
        await Promise.all(renders);
        // All 6 calls resolved; the coalescer ran at most 2 sequential
        // renders (one in-flight + one trailing) — never 6 racing RPCs.
        expect(client.calls).toBeLessThanOrEqual(3);
        // The editor holds a document (converged state rendered).
        expect(editor.current).not.toBeNull();
    });

    it("a render failure never wedges the pipeline (next render still works)", async () => {
        const core = new CrdtWorkerCore({ documentId: "wedge-doc", replicaId: 10n, loadFactory, persistence: new MemoryPersistence() });
        await core.handle({ id: 1, kind: "init", documentId: "wedge-doc", replicaId: "10" });
        const delegate = new CoreBackedClient(core, "wedge-doc");
        // A client that fails the FIRST visibleJson, then recovers.
        let failNext = false;
        const flaky = {
            init: (documentId: string, replicaId: bigint) => delegate.init(replicaId),
            exportStream: () => delegate.exportStream(),
            exportOps: () => delegate.exportOps(),
            visibleJson: async () => {
                if (failNext) {
                    failNext = false;
                    throw new Error("worker RPC failed (simulated)");
                }
                return delegate.visibleJson();
            },
        };
        const editor = fakeEditor();
        const bridge = new CrdtEditorBridge({
            editor,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: flaky as any,
            documentId: "wedge-doc",
            seedPmDoc: null,
        });
        const state = await bridge.start();
        expect(state.mode).toBe("crdt");

        // Arm the failure AFTER start, then render: the failure must NOT
        // reject (the old code's unhandled rejection silently killed every
        // later render on staging).
        failNext = true;
        await expect(bridge.renderRemote()).resolves.toBeUndefined();
        // The pipeline recovers on the next call.
        await expect(bridge.renderRemote()).resolves.toBeUndefined();
        expect(editor.current).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// P7-M033: render watchdog (production fanout-render freeze regression).
// ---------------------------------------------------------------------------

describe("renderRemote watchdog (P7-M033 production regression)", () => {
    it("a never-settling visibleJson cannot wedge the pipeline (watchdog recovers)", async () => {
        const core = new CrdtWorkerCore({ documentId: "watchdog-doc", replicaId: 11n, loadFactory, persistence: new MemoryPersistence() });
        await core.handle({ id: 1, kind: "init", documentId: "watchdog-doc", replicaId: "11" });
        const delegate = new CoreBackedClient(core, "watchdog-doc");
        // A client whose visibleJson HANGS on demand — models the
        // never-settling worker RPC observed during a historical
        // production-shaped exercise (the
        // coalescer absorbed every later render into one that never
        // returned; the editor froze for the rest of the session).
        let hangNext = false;
        const hanging = {
            init: (documentId: string, replicaId: bigint) => delegate.init(replicaId),
            exportStream: () => delegate.exportStream(),
            exportOps: () => delegate.exportOps(),
            visibleJson: () => {
                if (hangNext) {
                    hangNext = false;
                    return new Promise<string>(() => {
                        // Never settles — the wedge.
                    });
                }
                return delegate.visibleJson();
            },
        };
        const editor = fakeEditor();
        const bridge = new CrdtEditorBridge({
            editor,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            client: hanging as any,
            documentId: "watchdog-doc",
            seedPmDoc: null,
        });
        const state = await bridge.start();
        expect(state.mode).toBe("crdt");

        // Arm the hang, then render: the watchdog must abort the pass and
        // release the pipeline instead of absorbing later renders forever.
        hangNext = true;
        const wedgedRender = bridge.renderRemote();
        // A second render arriving mid-wedge — under the old code this
        // resolved only when the hung RPC did (i.e., never).
        const trailingRender = bridge.renderRemote();
        // Both must resolve (the watchdog aborts the hung pass; the
        // trailing flag re-renders with a healthy RPC).
        await expect(wedgedRender).resolves.toBeUndefined();
        await expect(trailingRender).resolves.toBeUndefined();
        // The pipeline is alive: a fresh render succeeds and converges.
        await expect(bridge.renderRemote()).resolves.toBeUndefined();
        expect(editor.current).not.toBeNull();
    }, 30_000);
});
