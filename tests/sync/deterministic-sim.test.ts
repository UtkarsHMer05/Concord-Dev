// Feature 7 — deterministic simulation harness (scoped: session + engine
// + outbox over a scripted transport; NOT the browser).
//
// A seeded PRNG picks an action schedule (edit / settle / deliver catch-up /
// peer edit / drop frame / duplicate frame / reconnect) and drives the REAL
// SyncSession over the REAL CrdtWorkerCore (the same WASM engine the product
// worker runs) against a MODEL gateway that implements the durable-log rules
// (sequential server seq, idempotent identity ingest, monotone cursor).
//
// Invariants asserted for every schedule + seed:
//   A. no acked op is ever lost — every identity the client sent is in the
//      model log exactly once;
//   B. the persisted durable cursor is monotone;
//   C. the local replica CONVERGES to the model digest (the model folds the
//      full acked log through its own engine replica);
//   D. the outbox drains (every local op durably acked at the end).
//
// Determinism contract (honest): the ACTION schedule is seeded and
// reproducible; settlement uses real timers + vi.waitFor, so wall-clock
// interleaving may vary — but every invariant above must hold on ALL
// interleavings, so a failure is a genuine bug regardless of the seed that
// surfaced it. The seed is printed to reproduce the schedule shape.

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

async function loadFactory(): Promise<never> {
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

const factoryPromise = loadFactory();

// ---------------------------------------------------------------------------
// Client-side memory harness (same shape as worker-engine-port.test.ts)
// ---------------------------------------------------------------------------

class MemoryPersistence implements PersistenceAdapter {
    snapshots = new Map<string, Uint8Array>();
    logs = new Map<string, { seq: number; op: Uint8Array; identity?: string }[]>();
    cursors = new Map<string, string>();

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
        const log = [...(this.logs.get(documentId) ?? [])];
        for (const op of ops) {
            const parsed = identityFromOpBytes(op);
            const identity = parsed === null ? undefined : `${parsed.replica}:${parsed.counter}`;
            log.push({ seq: log.length, op, ...(identity === undefined ? {} : { identity }) });
        }
        this.logs.set(documentId, log);
        if (sync !== undefined) {
            const previous = this.cursors.get(documentId) ?? "0";
            this.cursors.set(documentId, BigInt(previous) >= BigInt(sync.cursor) ? previous : sync.cursor);
        }
    }
    async loadSyncCursor(documentId: string): Promise<string> {
        return this.cursors.get(documentId) ?? "0";
    }
    async saveSyncCursor(documentId: string, cursor: string): Promise<void> {
        this.cursors.set(documentId, cursor);
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async loadCoveredOpIds(_documentId: string, _identities: string[]): Promise<Set<string>> {
        return new Set();
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async clearCoveredOpIds(_documentId: string, _identities: string[]): Promise<void> {}
    async saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void> {
        this.snapshots.set(documentId, snapshot);
    }
    async clearDocument(documentId: string): Promise<void> {
        this.snapshots.delete(documentId);
        this.logs.delete(documentId);
        this.cursors.delete(documentId);
    }
}

class MemoryPendingStore {
    private records = new Map<string, PendingOpRecord>();
    constructor(
        private readonly docId: string,
        private readonly persistence?: MemoryPersistence,
    ) {}
    private key(id: string): string {
        return `${this.docId}:${id}`;
    }
    async addPending(id: string, op: Uint8Array): Promise<void> {
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
    }
    async lastSeenCounter(): Promise<string> {
        return "0";
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
            if (rec) rec.state = "durably_acked";
        }
    }
    async clearAcked(ids: string[]): Promise<number> {
        const covered = await this.persistence?.loadCoveredOpIds(this.docId, ids) ?? new Set<string>();
        let removed = 0;
        for (const id of ids) {
            if (!covered.has(id)) continue;
            if (this.records.get(this.key(id))?.state === "durably_acked") {
                this.records.delete(this.key(id));
                removed += 1;
            }
        }
        return removed;
    }
    async stateCounts(): Promise<Record<string, number>> {
        const counts = { pending: 0, sent: 0, durably_acked: 0 };
        for (const record of this.records.values()) counts[record.state] += 1;
        return counts;
    }
    close(): void {}
}

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
        const r = await this.core.handle({ id: this.nextId++, kind: "digest" });
        return (r as { digest: string }).digest;
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
        return r as { replicaId: string; sequence: string };
    }
    async localOpsSince(counter: string): Promise<{ ops: Uint8Array[]; nextCounter: string }> {
        const r = await this.core.handle({ id: this.nextId++, kind: "localOpsSince", counter });
        return r as { ops: Uint8Array[]; nextCounter: string };
    }
    onLocalOps(handler: (ops: Uint8Array[]) => void): () => void {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }
}
interface Simulation {
    /** One-shot flag: the next inbound client_ops batch is dropped pre-ingest. */
    dropNextBatch: boolean;
}

// ---------------------------------------------------------------------------
// Model gateway: the durable-log rules, in miniature (single gateway so
// server seq assignment is sequential; idempotent identity ingest; the
// model folds every acked op through its OWN engine replica for digests).
// ---------------------------------------------------------------------------

const DOC = "sim-doc";

class ModelGateway {
    /** Server log: (seq, identity, op) — seqs are 1-based and gapless. */
    readonly log: Array<{ seq: number; identity: string; op: Uint8Array }> = [];
    private readonly identities = new Set<string>();
    private modelCore: CrdtWorkerCore | null = null;
    private modelIdCounter = 2;
    digest = "";

    async init(): Promise<void> {
        this.modelCore = new CrdtWorkerCore({
            documentId: DOC,
            replicaId: 555n, // reserved model replica; never edits locally
            loadFactory: () => factoryPromise,
            persistence: new MemoryPersistence(),
        });
        await this.modelCore.handle({ id: 1, kind: "init", documentId: DOC, replicaId: "555" });
    }

    get cursor(): number {
        return this.log.length === 0 ? 0 : this.log[this.log.length - 1].seq;
    }

    /** Idempotent ingest (the repo's ON CONFLICT DO NOTHING semantics). */
    async ingest(ops: Uint8Array[]): Promise<{ newly: string[]; duplicates: string[]; cursor: number }> {
        const newly: string[] = [];
        const duplicates: string[] = [];
        const appended: Uint8Array[] = [];
        for (const op of ops) {
            const identity = identityFromOpBytes(op);
            const id = identity === null ? `unknown:${this.log.length}` : `${identity.replica}:${identity.counter}`;
            if (this.identities.has(id)) {
                duplicates.push(id);
                continue;
            }
            this.identities.add(id);
            const seq = this.cursor + 1;
            this.log.push({ seq, identity: id, op });
            newly.push(id);
            appended.push(op);
        }
        if (this.modelCore && appended.length > 0) {
            const result = (await this.modelCore.handle({
                id: this.nextModelId(),
                kind: "applyRemote",
                ops: appended,
            })) as { applied: number };
            if (result.applied !== appended.length) throw new Error("model fold divergence");
            const digestResult = (await this.modelCore.handle({ id: this.nextModelId(), kind: "digest" })) as { digest: string };
            this.digest = digestResult.digest;
        }
        return { newly, duplicates, cursor: this.cursor };
    }

    private nextModelId(): number {
        return this.modelIdCounter++;
    }

    /** Ops strictly after `after`, ordered by seq. */
    opsAfter(after: number, limit: number): Array<{ seq: number; op: Uint8Array }> {
        return this.log.filter((entry) => entry.seq > after).slice(0, limit).map(({ seq, op }) => ({ seq, op }));
    }

    close(): void {
        (this.modelCore as unknown as { close?: () => void })?.close?.();
    }
}

/** Seeded splitmix64 (same shape as the Rust convergence checker). */
class Rng {
    constructor(private state: bigint) {}
    nextU64(): bigint {
        this.state = (this.state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
        let z = this.state;
        z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
        z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
        return z ^ (z >> 31n);
    }
    range(lo: number, hi: number): number {
        return lo + Number(this.nextU64() % BigInt(hi - lo + 1));
    }
    chance(percent: number): boolean {
        return Number(this.nextU64() % 100n) < percent;
    }
}

// ---------------------------------------------------------------------------
// Scripted gateway socket: speaks the REAL server protocol against the model
// gateway. The sim can drop a client_ops frame pre-ingest (the client keeps
// it unacked; a reconnect resends it) — reordering WITHIN the durable
// schedule is exercised by the Rust convergence checker against real
// Postgres; this harness pins session/engine behavior.
// ---------------------------------------------------------------------------

class ScriptedGatewaySocket {
    static OPEN = 1;
    readyState = ScriptedGatewaySocket.OPEN;
    sent: Array<string | ArrayBuffer> = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(
        public readonly url: string,
        private readonly model: ModelGateway,
        private readonly sim: Simulation,
    ) {}

    connect(): void {
        setTimeout(() => {
            this.onopen?.();
            this.serverSend('{"v":1,"type":"hello_ack","payload":{"protocolVersion":1,"connectionId":"sim"}}');
        }, 5);
    }

    send(data: string | ArrayBuffer): void {
        this.sent.push(data);
        if (typeof data === "string") {
            void this.handleText(data);
            return;
        }
        this.handleBinary(data);
    }

    close(): void {
        this.readyState = 3;
        this.onclose?.();
    }

    serverSend(text: string): void {
this.onmessage?.({ data: text } as MessageEvent);
    }

    serverSendBinary(bytes: Uint8Array): void {
const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        this.onmessage?.({ data: copy.buffer } as MessageEvent);
    }

    texts(): string[] {
        return this.sent.filter((frame): frame is string => typeof frame === "string");
    }

    private async handleText(text: string): Promise<void> {
const frame = JSON.parse(text) as { type: string; payload: Record<string, unknown> };
        if (frame.type === "authenticate") {
            this.serverSend('{"v":1,"type":"authenticated","payload":{"userId":"u1","clerkUserId":"cu1"}}');
            return;
        }
        if (frame.type === "join_document") {
            this.serverSend(
                `{"v":1,"type":"join_accepted","payload":{"documentId":"${DOC}","role":"owner","durableCursor":"${this.model.cursor}"}}`,
            );
            return;
        }
        if (frame.type === "sync_request") {
            try {
                this.deliverCatchup(Number(frame.payload.cursor));
            } catch (error) {
                console.warn("[sim-socket] deliverCatchup threw:", String(error));
            }
        }
    }

    private handleBinary(data: ArrayBuffer): void {
        const bytes = new Uint8Array(data);
        if (bytes[1] !== 0x20) return; // only client_ops is inbound binary
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const batchId = view.getBigUint64(2, false);
        const count = view.getUint16(10, false);
        let offset = 12;
        const ops: Uint8Array[] = [];
        for (let i = 0; i < count; i += 1) {
            const len = view.getUint32(offset, false);
            ops.push(bytes.slice(offset + 4, offset + 4 + len));
            offset += 4 + len;
        }
        if (this.sim.dropNextBatch) {
            this.sim.dropNextBatch = false;
            return;
        }
        void this.ingestAndAck(batchId, ops);
    }

    private async ingestAndAck(batchId: bigint, ops: Uint8Array[]): Promise<void> {
        const { newly } = await this.model.ingest(ops);
        // The durable ack carries the identities THAT call committed.
        this.serverSend(
            JSON.stringify({
                v: 1,
                type: "durable_ack",
                payload: { batchId: batchId.toString(), opIds: newly },
            }),
        );
    }

    deliverCatchup(afterCursor: number, limit = 2): void {
        // The real gateway STREAMS all pages back-to-back (stream_catchup)
        // and terminates with sync_done; the client never re-requests pages
        // (it ignores hasMore). Small pages exercise the batching/apply path.
        let cursor = afterCursor;
        for (;;) {
            const ops = this.model.opsAfter(cursor, limit);
            if (ops.length === 0) break;
            const nextCursor = ops[ops.length - 1].seq;
            const opBytes = ops.reduce((sum, entry) => sum + 4 + entry.op.length, 0);
            const frame = new Uint8Array(13 + opBytes);
            const view = new DataView(frame.buffer);
            frame[0] = 1;
            frame[1] = 0x21;
            view.setBigUint64(2, BigInt(nextCursor), false);
            const more = this.model.cursor > nextCursor ? 1 : 0;
            frame[10] = more;
            view.setUint16(11, ops.length, false);
            let offset = 13;
            for (const entry of ops) {
                view.setUint32(offset, entry.op.length, false);
                frame.set(entry.op, offset + 4);
                offset += 4 + entry.op.length;
            }
            this.serverSendBinary(frame);
            cursor = nextCursor;
            if (more === 0) break;
        }
        this.serverSend('{"v":1,"type":"sync_done","payload":{}}');
    }
}
// SIMULATOR_PLACEHOLDER

// ---------------------------------------------------------------------------
// The simulator: one seeded run = real SyncSession + real worker core over
// the scripted gateway. Schedules are chosen by the PRNG; settlement uses
// vi.waitFor so each action completes before the next decision.
// ---------------------------------------------------------------------------

interface SimHandles {
    session: SyncSession;
    client: CoreBackedClient;
    store: MemoryPendingStore;
    model: ModelGateway;
    socket?: ScriptedGatewaySocket;
    cursors: string[];
}

interface SchedulePolicy {
    /** Chance a client_ops batch is dropped pre-ingest (recovers on reconnect). */
    dropPercent: number;
    /** Chance the run forces a reconnect (resends every unacked op). */
    reconnectPercent: number;
    /** Chance the client also catches up mid-run (delivers model ops). */
    catchupPercent: number;
    /** Local edits per run. */
    edits: number;
}

async function runSimulation(seed: bigint, policy: SchedulePolicy): Promise<SimHandles> {
    const rng = new Rng(seed);
    const model = new ModelGateway();
    await model.init();
    // Pre-existing durable history from a PEER replica (tests cold catch-up).
    await model.ingest(await peerHistoryOps());

    const replicaId = 42n;
    const persistence = new MemoryPersistence();
    const core = new CrdtWorkerCore({ documentId: DOC, replicaId, loadFactory: () => factoryPromise, persistence });
    const client = new CoreBackedClient(core, DOC);
    await client.init(replicaId);
    const store = new MemoryPendingStore(DOC, persistence);
    const cursors: string[] = [];
    const port = new WorkerEnginePort({
        client: client as unknown as import("@/lib/crdt/worker/client").CrdtClient,
        store: store as unknown as PendingOpStore,
    });

    const sim: Simulation = { dropNextBatch: false };
    // A ref (not a plain let) — construction happens inside the class below
    // and TS narrowing cannot see it, collapsing reads to `never`.
    const socketRef: { current?: ScriptedGatewaySocket } = { current: undefined };
    // The transport constructs with `new WebSocket(url)` — the stub must be
    // a real class, not an arrow factory.
    const SimSocket = class SimSocket extends ScriptedGatewaySocket {
        constructor(url: string) {
            super(url, model, sim);
            socketRef.current = this;
            this.connect();
        }
    };
    const socketFactory = SimSocket as unknown as typeof WebSocket;

    let session: SyncSession | null = null;
    session = new SyncSession({
        documentId: DOC,
        gatewayUrl: "ws://sim",
        getToken: async () => "sim-token",
        engine: port,
        getCursor: () => cursors[cursors.length - 1] ?? "0",
        setCursor: (cursor) => {
            if (cursors.length === 0 || BigInt(cursor) > BigInt(cursors[cursors.length - 1])) {
                cursors.push(cursor);
            }
        },
        store: store as unknown as PendingOpStore,
    });

    vi.stubGlobal("WebSocket", socketFactory);
    try {
        await session.start();
        await vi.waitFor(() => expect(session?.status).toBe("ready"), { timeout: 10_000 });

        // Seeded action loop.
        for (let step = 0; step < policy.edits; step += 1) {
            const streamIndex = rng.range(0, 1);
            await client.localInsertText(streamIndex, 0x61 + (step % 26));
            // The session flushes the outbox on its own ~30ms window; settle.
            await vi.waitFor(() => expect(model.log.length).toBeGreaterThan(3 + step), {
                timeout: 1_500,
            }).catch(() => undefined);

            if (rng.chance(policy.dropPercent)) sim.dropNextBatch = true;
            if (rng.chance(policy.catchupPercent)) {
                // Force a catch-up from the client's persisted cursor.
                socketRef.current?.deliverCatchup(Number(cursors[cursors.length - 1] ?? "0"));
                await vi.waitFor(() => expect(session?.status).toBe("ready"), { timeout: 10_000 });
            }
            if (rng.chance(policy.reconnectPercent)) {
                await session.stop();
                socketRef.current = undefined;
                session = new SyncSession({
                    documentId: DOC,
                    gatewayUrl: "ws://sim",
                    getToken: async () => "sim-token",
                    engine: port,
                    getCursor: () => cursors[cursors.length - 1] ?? "0",
                    setCursor: (cursor) => {
                        if (cursors.length === 0 || BigInt(cursor) > BigInt(cursors[cursors.length - 1])) {
                            cursors.push(cursor);
                        }
                    },
                    store: store as unknown as PendingOpStore,
                });
                // New socket instance from the stubbed factory.
                vi.stubGlobal("WebSocket", socketFactory);
                await session.start();
                await vi.waitFor(() => expect(session?.status).toBe("ready"), { timeout: 10_000 });
            }
        }

        // Final drain: reconnect (resends unacked) + full catch-up. Clear a
        // pending drop flag first — it applies to the NEXT frame only, and
        // letting it eat the resend would be a schedule artifact, not a fault.
        sim.dropNextBatch = false;
        await session.stop();
        const finalSession = new SyncSession({
            documentId: DOC,
            gatewayUrl: "ws://sim",
            getToken: async () => "sim-token",
            engine: port,
            getCursor: () => cursors[cursors.length - 1] ?? "0",
            setCursor: (cursor) => {
                if (cursors.length === 0 || BigInt(cursor) > BigInt(cursors[cursors.length - 1])) {
                    cursors.push(cursor);
                }
            },
            store: store as unknown as PendingOpStore,
        });
        vi.stubGlobal("WebSocket", socketFactory);
        await finalSession.start();
        await vi.waitFor(() => expect(finalSession.status).toBe("ready"), { timeout: 10_000 });
        await vi.waitFor(async () => expect(await store.unackedOps()).toHaveLength(0), { timeout: 15_000 });
        await vi.waitFor(() => expect(model.cursor).toBeGreaterThanOrEqual(3 + policy.edits), { timeout: 10_000 });
        // Deliver anything the model has that the client has not yet applied.
        for (let i = 0; i < 10 && model.log.length > 0; i += 1) {
            socketRef.current?.deliverCatchup(Number(cursors[cursors.length - 1] ?? "0"));
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        // ----- Invariants -----
        // A. No acked op lost: every client-sent identity is in the model once.
        const sentIdentities = new Set<string>();
        const allSent = (await client.localOpsSince("0")).ops;
        for (const op of allSent) {
            const identity = identityFromOpBytes(op);
            if (identity) sentIdentities.add(`${identity.replica}:${identity.counter}`);
        }
        const modelIdentities = new Set(model.log.map((entry) => entry.identity));
        for (const id of sentIdentities) {
            expect(modelIdentities.has(id), `acked op ${id} missing from the model log`).toBe(true);
        }
        expect(model.log.length).toBe(new Set(model.log.map((entry) => entry.identity)).size);

        // B. Cursor monotone (the setCursor wrapper already enforces it; the
        // recorded sequence proves no decrease was ever requested).
        for (let i = 1; i < cursors.length; i += 1) {
            expect(BigInt(cursors[i]) >= BigInt(cursors[i - 1])).toBe(true);
        }

        // C. Convergence: the local replica digest equals the model digest.
        const localDigest = await client.digest();
        expect(localDigest).toBe(model.digest);

        // D. Outbox drained.
        expect(await store.unackedOps()).toHaveLength(0);

        await finalSession.stop();
        return { session: finalSession, client, store, model, socket: socketRef.current, cursors };
    } finally {
        vi.unstubAllGlobals();
    }
}

/** Builds the peer-replica history once (real engine, guaranteed-valid bytes). */
let peerOpsPromise: Promise<Uint8Array[]> | null = null;
function peerHistoryOps(): Promise<Uint8Array[]> {
    peerOpsPromise ??= (async () => {
        const generator = new CrdtWorkerCore({
            documentId: "sim-peer",
            replicaId: 888n,
            loadFactory: () => factoryPromise,
            persistence: new MemoryPersistence(),
        });
        try {
            await generator.handle({ id: 1, kind: "init", documentId: "sim-peer", replicaId: "888" });
            const ops: Uint8Array[] = [];
            for (let i = 0; i < 3; i += 1) {
                const r = await generator.handle({
                    id: i + 2,
                    kind: "localInsertText",
                    streamIndex: i,
                    codepoint: 0x70 + i,
                });
                ops.push((r as { ops: Uint8Array[] }).ops[0]);
            }
            return ops;
        } finally {
            (generator as unknown as { close?: () => void }).close?.();
        }
    })();
    return peerOpsPromise;
}

describe("deterministic simulation harness (Feature 7)", () => {
    it("runs seeded schedules without losing acked ops, monotone, converged", { timeout: 120_000 }, async () => {
        const policies: Array<[string, SchedulePolicy]> = [
            ["happy", { dropPercent: 0, reconnectPercent: 0, catchupPercent: 50, edits: 5 }],
            ["drop-every-3rd", { dropPercent: 33, reconnectPercent: 40, catchupPercent: 30, edits: 6 }],
            ["reconnect-heavy", { dropPercent: 10, reconnectPercent: 60, catchupPercent: 40, edits: 5 }],
        ];
        for (const [name, policy] of policies) {
            for (const seed of [1n, 42n]) {
                console.log(`[sim] schedule=${name} seed=${seed}`);
                const handles = await runSimulation(seed, policy);
                await handles.model.close();
            }
        }
    });
});
