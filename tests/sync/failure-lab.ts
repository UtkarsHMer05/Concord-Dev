// Developer lab: real SyncSession + WorkerEnginePort + WASM; model transport
// and memory storage. Live infrastructure coverage is a separate CLI lane.
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { z } from "zod";
import { CrdtWorkerCore } from "@/lib/crdt/worker/core";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import type { PendingOpStore } from "@/lib/sync/pending-store";
import { identityFromOpBytes } from "@/lib/sync/identities";
import { SyncSession } from "@/lib/sync/sync-session";
import { WorkerEnginePort } from "@/lib/sync/worker-engine-port";
import { loadFactory, MemoryPersistence, MemoryPendingStore, CoreBackedClient } from "./engine-harness";

const actionSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("edit"), client: z.number().int().min(0).max(2), codepoint: z.number().int().min(32).max(0x10ffff).refine((n) => n < 0xd800 || n > 0xdfff), index: z.number().int().min(0).max(2000) }),
    z.object({ kind: z.enum(["connect", "disconnect", "drop-send", "drop-ack", "duplicate"]), client: z.number().int().min(0).max(2) }),
    z.object({ kind: z.enum(["restart-gateway", "recover"]) }),
]);
const opSchema = z.object({ step: z.number().int().min(0).max(199), client: z.number().int().min(0).max(2), identity: z.string().regex(/^\d+:\d+$/), bytes: z.string().max(4096).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
export const traceSchema = z.object({
    version: z.literal(1), name: z.string().min(1).max(120),
    mode: z.enum(["fixed", "legacy-replica-alias"]),
    actions: z.array(actionSchema).min(1).max(200),
    operations: z.array(opSchema).max(600).default([]),
});
export type LabTrace = z.infer<typeof traceSchema>;
type Action = LabTrace["actions"][number];
type WireEvent = { step: number; client: number; direction: string; kind: string; data?: unknown };
type ClientState = { name: string; replica: string; status: string; pending: number; sent: number; acknowledged: number; cursor: string; digest: string; content: unknown };
type Observation = { step: number; action: Action | { kind: "final-recovery" }; durableOperations: number; gatewayDigest: string; clients: ClientState[] };
export type LabResult = { trace: LabTrace; scope: string; scheduleHash: string; passed: boolean; failure: { invariant: string; message: string } | null; observations: Observation[]; wire: WireEvent[] };

export const scenarios: LabTrace[] = [
    { version: 1, name: "Offline edits, duplicate delivery, lost acknowledgement and gateway restart", mode: "fixed", operations: [], actions: [
        { kind: "connect", client: 0 }, { kind: "connect", client: 1 }, { kind: "connect", client: 2 },
        { kind: "edit", client: 0, index: 0, codepoint: 65 }, { kind: "disconnect", client: 1 },
        { kind: "edit", client: 1, index: 0, codepoint: 66 }, { kind: "drop-ack", client: 2 },
        { kind: "edit", client: 2, index: 0, codepoint: 67 }, { kind: "duplicate", client: 0 },
        { kind: "restart-gateway" }, { kind: "recover" },
    ] },
    { version: 1, name: "Dropped send retains pending operations until reconnect", mode: "fixed", operations: [], actions: [
        { kind: "connect", client: 0 }, { kind: "drop-send", client: 0 },
        { kind: "edit", client: 0, index: 0, codepoint: 0x1f680 },
        { kind: "disconnect", client: 0 }, { kind: "recover" },
    ] },
    { version: 1, name: "Two tabs allocate independent replica identities", mode: "fixed", operations: [], actions: [
        { kind: "edit", client: 2, index: 0, codepoint: 90 },
        { kind: "edit", client: 0, index: 0, codepoint: 65 },
        { kind: "edit", client: 1, index: 0, codepoint: 66 },
        { kind: "recover" }, { kind: "duplicate", client: 2 },
    ] },
];

class InvariantError extends Error {
    constructor(readonly invariant: string, message: string) { super(message); }
}
const DOC = "concord-failure-lab";
const names = ["Alice", "Bob", "Reviewer"];
const identity = (op: Uint8Array) => {
    const parsed = identityFromOpBytes(op);
    if (!parsed) throw new InvariantError("invalid_operation", "Engine emitted an operation without an identity.");
    return `${parsed.replica}:${parsed.counter}`;
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

export async function runTrace(input: LabTrace): Promise<LabResult> {
    const trace = traceSchema.parse(input);
    const operations: LabTrace["operations"] = [];
    const wire: WireEvent[] = []; const observations: Observation[] = [];
    const log: { op: Uint8Array; identity: string }[] = [];
    const generated = new Map<string, Uint8Array>();
    const cores: { client: CoreBackedClient; store: MemoryPendingStore; port: WorkerEnginePort; session: SyncSession | null; socket?: LabSocket; dropSend: boolean; dropAck: boolean; cursor: string; replica: string }[] = [];
    let step = -1; let tail = Promise.resolve(); let localError: string | null = null;
    const gateway = new CoreBackedClient(new CrdtWorkerCore({ documentId: DOC, replicaId: 999n, loadFactory, persistence: new MemoryPersistence() }), DOC);
    await gateway.init(999n);
    const emit = (client: number, direction: string, kind: string, data?: unknown) => wire.push({ step, client, direction, kind, ...(data === undefined ? {} : { data }) });

    class LabSocket {
        static OPEN = 1; readyState = 1; batches = 0;
        onopen: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readonly clientId: number;
        constructor(url: string) {
            this.clientId = Number(new URL(url).pathname.slice(1));
            cores[this.clientId].socket = this;
            setTimeout(() => { if (this.readyState !== 1) return; this.onopen?.(); this.control("hello_ack", { protocolVersion: 1, connectionId: `lab-${this.clientId}`, capabilities: ["rich-text-v2"] }); }, 1);
        }
        control(type: string, payload: unknown) {
            if (this.readyState !== 1) return;
            emit(this.clientId, "server → client", type, payload);
            this.onmessage?.({ data: JSON.stringify({ v: 1, type, payload }) } as MessageEvent);
        }
        close() { this.readyState = 3; this.onclose?.(); }
        send(data: string | ArrayBuffer | Uint8Array) {
            if (this.readyState !== 1) throw new Error("Closed lab socket");
            if (typeof data === "string") {
                const frame = JSON.parse(data);
                // Authentication is a model handshake; never record tokens.
                emit(this.clientId, "client → server", frame.type, frame.type === "authenticate" ? { modelAuthentication: true } : frame.payload);
                if (frame.type === "authenticate") this.control("authenticated", { userId: "lab", clerkUserId: "lab" });
                if (frame.type === "join_document") this.control("join_accepted", { documentId: DOC, role: "owner", durableCursor: String(log.length) });
                if (frame.type === "sync_request") this.catchup(Number(frame.payload.cursor));
                return;
            }
            const b = new Uint8Array(data); const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
            if (b[1] !== 0x20) throw new Error("Unexpected lab frame");
            const batchId = view.getBigUint64(2, false).toString();
            const count = view.getUint16(10, false); const ops: Uint8Array[] = [];
            let offset = 12;
            for (let i = 0; i < count; i++) { const len = view.getUint32(offset, false); ops.push(b.slice(offset + 4, offset + 4 + len)); offset += 4 + len; }
            this.batches++;
            emit(this.clientId, "client → server", "client_ops", { batchId, operations: ops.map((op) => ({ identity: identity(op), bytes: Buffer.from(op).toString("base64") })) });
            const owner = cores[this.clientId];
            if (owner.dropSend) { owner.dropSend = false; emit(this.clientId, "fault", "send dropped before ingest"); return; }
            tail = tail.then(async () => {
                for (const op of ops) {
                    const id = identity(op); const existing = log.find((entry) => entry.identity === id);
                    if (existing && !sameBytes(existing.op, op)) throw new InvariantError("replica_identity_collision", `Different bytes share operation ${id}.`);
                    if (!existing) { await gateway.applyRemote([op]); log.push({ op, identity: id }); }
                }
                emit(this.clientId, "model transaction", "committed", { cursor: String(log.length), identities: ops.map(identity) });
                if (owner.dropAck) { owner.dropAck = false; emit(this.clientId, "fault", "acknowledgement interrupted after commit"); }
                else this.control("durable_ack", { batchId, opIds: ops.map(identity) });
            }).catch((e) => { localError = String(e); });
        }
        catchup(after: number) {
            for (let cursor = after; cursor < log.length;) {
                const entries = log.slice(cursor, cursor + 2); cursor += entries.length;
                const bytes = new Uint8Array(13 + entries.reduce((n, entry) => n + 4 + entry.op.length, 0));
                const view = new DataView(bytes.buffer); bytes[0] = 1; bytes[1] = 0x21;
                view.setBigUint64(2, BigInt(cursor), false); bytes[10] = cursor < log.length ? 1 : 0; view.setUint16(11, entries.length, false);
                let offset = 13;
                for (const { op } of entries) { view.setUint32(offset, op.length, false); bytes.set(op, offset + 4); offset += 4 + op.length; }
                emit(this.clientId, "server → client", "sync_batch", { cursor: String(cursor), identities: entries.map((entry) => entry.identity), bytes: Buffer.from(bytes).toString("base64") });
                this.onmessage?.({ data: bytes.buffer } as MessageEvent);
            }
            this.control("sync_done", {});
        }
    }

    const connect = async (id: number) => {
        const c = cores[id]; await c.session?.stop();
        c.session = new SyncSession({ documentId: DOC, gatewayUrl: `ws://failure-lab/${id}`, getToken: async () => "model-token",
            engine: c.port, store: c.store as unknown as PendingOpStore, getCursor: () => c.cursor,
            setCursor: (cursor) => { if (BigInt(cursor) < BigInt(c.cursor)) localError = "Cursor decreased"; c.cursor = cursor; },
            onLocalError: (message) => { localError = message; }, onError: (code, message) => { localError = `${code}: ${message}`; },
        });
        await c.session.start();
        await vi.waitFor(() => { if (c.session?.status !== "ready") throw new Error("Waiting for model handshake"); }, { timeout: 3000, interval: 5 });
    };
    const recover = async () => {
        for (let id = 0; id < 3; id++) {
            cores[id].dropAck = false; cores[id].dropSend = false;
            await connect(id);
            await vi.waitFor(async () => { if ((await cores[id].store.unackedOps()).length) throw new Error("Waiting for outbox drain"); }, { timeout: 3000, interval: 5 });
        }
        await tail;
        const digest = await gateway.digest();
        for (const c of cores) {
            c.session!.syncNow();
            await vi.waitFor(async () => { if (await c.client.digest() !== digest || BigInt(await c.client.syncCursor()) !== BigInt(log.length)) throw new Error("Waiting for durable catch-up"); }, { timeout: 3000, interval: 5 });
        }
    };
    const observe = async (action: Observation["action"]) => {
        const clients: ClientState[] = [];
        for (const [id, c] of cores.entries()) {
            const counts = await c.store.stateCounts();
            clients.push({ name: names[id], replica: c.replica, status: c.session?.status ?? "offline", pending: counts.pending, sent: counts.sent, acknowledged: c.store.observedAckIds.size, cursor: await c.client.syncCursor(), digest: await c.client.digest(), content: JSON.parse(await c.client.visibleJson()) });
        }
        observations.push({ step, action, clients, durableOperations: log.length, gatewayDigest: await gateway.digest() });
    };
    let failure: LabResult["failure"] = null;
    vi.stubGlobal("WebSocket", LabSocket);
    try {
        for (let id = 0; id < 3; id++) {
            const replica = trace.mode === "legacy-replica-alias" && id === 1 ? "101" : String(101 + id);
            const persistence = new MemoryPersistence();
            const client = new CoreBackedClient(new CrdtWorkerCore({ documentId: DOC, replicaId: BigInt(replica), loadFactory, persistence }), DOC);
            await client.init(BigInt(replica));
            const store = new MemoryPendingStore(DOC, persistence);
            cores.push({ client, store, port: new WorkerEnginePort({ client: client as unknown as CrdtClient, store: store as unknown as PendingOpStore }), session: null, cursor: "0", replica, dropAck: false, dropSend: false });
        }
        for (step = 0; step < trace.actions.length; step++) {
            const action = trace.actions[step];
            if (action.kind === "edit") {
                const c = cores[action.client]; const before = c.socket?.batches ?? 0;
                const dropped = c.dropSend || c.dropAck;
                const ops = await c.client.localInsertText(action.index, action.codepoint);
                for (const op of ops) {
                    const entry = { step, client: action.client, identity: identity(op), bytes: Buffer.from(op).toString("base64") };
                    const expected = trace.operations[operations.length];
                    if (trace.operations.length && (!expected || JSON.stringify(expected) !== JSON.stringify(entry))) throw new InvariantError("trace_bytes_mismatch", "Recorded operation bytes do not match this replay. Use the matching engine version.");
                    operations.push(entry);
                    if (!c.session) await c.store.addPending(entry.identity, op);
                    const earlier = generated.get(entry.identity);
                    if (earlier && !sameBytes(earlier, op)) throw new InvariantError("replica_identity_collision", `Alice and Bob generated different bytes for ${entry.identity}.`);
                    generated.set(entry.identity, op);
                }
                if (c.session?.status === "ready") {
                    await vi.waitFor(() => { if ((c.socket?.batches ?? 0) <= before) throw new Error("Waiting for outgoing batch"); }, { timeout: 3000, interval: 5 });
                    await tail;
                    if (!dropped) await vi.waitFor(async () => { if ((await c.store.unackedOps()).length) throw new Error("Waiting for acknowledgement"); }, { timeout: 3000, interval: 5 });
                }
            } else if (action.kind === "connect") await connect(action.client);
            else if (action.kind === "disconnect") { await cores[action.client].session?.stop(); cores[action.client].session = null; }
            else if (action.kind === "drop-send") cores[action.client].dropSend = true;
            else if (action.kind === "drop-ack") cores[action.client].dropAck = true;
            else if (action.kind === "duplicate") { cores[action.client].socket?.catchup(0); await new Promise((resolve) => setTimeout(resolve, 10)); }
            else if (action.kind === "restart-gateway") { await tail; for (const c of cores) { await c.session?.stop(); c.session = null; } emit(-1, "fault", "model gateway restarted; committed log retained"); }
            else if (action.kind === "recover") await recover();
            if (localError) throw new InvariantError("session_error", localError);
            await observe(action);
        }
        await recover(); await observe({ kind: "final-recovery" });
        if (trace.operations.length && operations.length !== trace.operations.length) throw new InvariantError("trace_bytes_mismatch", "Replay produced a different operation count.");
        for (const c of cores) for (const id of c.store.observedAckIds) {
            if (!log.some((entry) => entry.identity === id)) throw new InvariantError("acknowledged_operation_missing", `${id} was acknowledged but is absent from the model log.`);
        }
        if (log.length !== generated.size) throw new InvariantError("operation_missing", "A generated operation did not become durable.");
    } catch (error) {
        failure = { invariant: error instanceof InvariantError ? error.invariant : "schedule_error", message: error instanceof Error ? error.message : String(error) };
        if (cores.length === 3) await observe(trace.actions[step] ?? { kind: "final-recovery" });
    } finally {
        for (const c of cores) await c.session?.stop();
        vi.unstubAllGlobals();
    }
    return { trace: { ...trace, operations }, scope: "Real session and WASM; simulated transport and memory persistence", scheduleHash: createHash("sha256").update(JSON.stringify(trace.actions)).digest("hex"), passed: failure === null, failure, observations, wire };
}

// ponytail: bounded delta debugging over at most 200 actions. Reports a
// one-action-minimal schedule, not a globally shortest trace; upgrade only
// if real failures need richer dependency-aware reduction.
export async function minimizeTrace(input: LabTrace, budget = 60) {
    const original = await runTrace(input);
    if (!original.failure || ["trace_bytes_mismatch", "schedule_error"].includes(original.failure.invariant)) throw new Error("Minimization needs a valid trace with a reproduced invariant failure.");
    let result = original; let attempts = 0; let width = Math.ceil(input.actions.length / 2);
    while (width >= 1 && attempts < budget) {
        let reduced = false;
        for (let offset = 0; offset < result.trace.actions.length && attempts < budget; offset += width) {
            const actions = result.trace.actions.filter((_, index) => index < offset || index >= offset + width);
            if (!actions.length) continue;
            attempts++;
            const candidate = await runTrace({ ...result.trace, actions, operations: [] });
            if (candidate.failure?.invariant === original.failure.invariant) { result = candidate; reduced = true; break; }
        }
        if (!reduced) width = Math.floor(width / 2);
        else width = Math.min(width, Math.ceil(result.trace.actions.length / 2));
    }
    return { originalActions: input.actions.length, reducedActions: result.trace.actions.length, attempts, oneActionMinimal: width === 0, result };
}
