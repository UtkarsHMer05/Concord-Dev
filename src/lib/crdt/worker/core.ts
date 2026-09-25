// CRDT worker core (P2-M034/M036/M037).
//
// Owns one ConcordEngine plus the durable local state via a persistence
// adapter. The class is transport-agnostic (testable in Node); the worker
// entry (crdt-worker.ts) wires it to postMessage, and the browser adapter
// wires it to IndexedDB.
//
// Local durability rule (M036): a local editor mutation is locally committed
// only after (a) the CRDT operation is integrated in the engine and (b) its
// serialized form is appended to the durable operation log. Acknowledgements
// happen after persistence; persistence failures surface as structured
// errors, never silent loss.
import { ConcordEngine, CrdtError, SUPPORTED_PROTOCOL_VERSION } from "../runtime";
import type { LoadConcordCrdtFactory } from "../wasm-types";
import type { PersistenceAdapter } from "./idb";
import type { WorkerRequest, WorkerResultPayload } from "./protocol";

/**
 * Reads (replicaId, counter, lamport) from a serialized operation frame
 * (PROTOCOL §7 header layout: version u8, type u8, replica u64, counter u64,
 * lamport u64 — little-endian).
 */
function readOpIdentity(frame: Uint8Array): { replicaId: bigint; counter: bigint; lamport: bigint } | null {
    if (frame.length < 26) {
        return null;
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const replicaId = view.getBigUint64(2, true);
    const counter = view.getBigUint64(10, true);
    const lamport = view.getBigUint64(18, true);
    return { replicaId, counter, lamport };
}

export interface WorkerCoreConfig {
    documentId: string;
    /** Per-user local namespace; defaults to documentId for legacy callers. */
    storageId?: string;
    /** Stable replica identity for this browser+document pair. */
    replicaId: bigint;
    /** Injected Emscripten module factory. */
    loadFactory: LoadConcordCrdtFactory;
    persistence: PersistenceAdapter;
}

export class CrdtWorkerCore {
    private engine: ConcordEngine | null = null;
    private starting: Promise<void> | null = null;

    constructor(private readonly config: WorkerCoreConfig) {}

    /**
     * First-open content is local bootstrap state, not a user edit. Generate
     * it from one deterministic, document-scoped origin so every fresh
     * replica gets the same item identities. The seed origin never enters the
     * client outbox (localOpsSince filters it out), and therefore never
     * crosses the gateway's authenticated user-ownership boundary.
     */
    private seedReplicaId(): bigint {
        let hash = 0xcbf29ce484222325n;
        for (const byte of new TextEncoder().encode(this.config.documentId)) {
            hash ^= BigInt(byte);
            hash = BigInt.asUintN(64, hash * 0x100000001b3n);
        }
        return (hash & ((1n << 62n) - 1n)) || 1n;
    }

    private get storageId(): string {
        return this.config.storageId ?? this.config.documentId;
    }

    private async ensureEngine(): Promise<ConcordEngine> {
        if (this.engine !== null) {
            return this.engine;
        }
        if (this.starting === null) {
            this.starting = this.restore();
        }
        await this.starting;
        if (this.engine === null) {
            throw new CrdtError("StateCorruption", "engine restoration failed");
        }
        return this.engine;
    }

    private async restore(): Promise<void> {
        const state = await this.config.persistence.loadLocalState(this.storageId);
        if (state.snapshot !== null) {
            // M037: snapshot + full op-log replay (idempotent by design).
            this.engine = await ConcordEngine.importFromSnapshot(
                this.config.replicaId,
                state.snapshot,
                this.config.loadFactory,
            );
            this.replayAndRestoreAllocation(state.ops);
            return;
        }
        this.engine = await ConcordEngine.create(
            this.config.replicaId,
            this.config.loadFactory,
        );
        // Replay any log entries that predate a lost snapshot.
        this.replayAndRestoreAllocation(state.ops);
    }

    /**
     * Replays durable ops and restores the replica's own generator state:
     * counters/lamport are monotonic per replica, so a replica must advance
     * past everything its history shows it has generated — even though replay
     * does not go through the generator. Without this, a reloaded replica
     * would re-use identities (silent no-op duplicates — a real M037 bug the
     * restoration tests caught).
     */
    private replayAndRestoreAllocation(ops: Uint8Array[]): void {
        if (this.engine === null || ops.length === 0) {
            return;
        }
        let maxOwnCounter = 0n;
        let maxLamport = 0n;
        for (const op of ops) {
            this.engine.applyRemote(op);
            const id = readOpIdentity(op);
            if (id !== null) {
                if (id.replicaId === this.config.replicaId) {
                    if (id.counter > maxOwnCounter) maxOwnCounter = id.counter;
                }
                if (id.lamport > maxLamport) maxLamport = id.lamport;
            }
        }
        this.engine.restoreAllocationState(maxOwnCounter + 1n, maxLamport + 1n);
    }

    /** Discard uncommitted engine state if the durable append fails. */
    private async appendOrReset(
        ops: Uint8Array[],
        sync?: { cursor: string; coveredOpIds: string[] },
    ): Promise<void> {
        if (ops.length === 0 && sync === undefined) {
            return;
        }
        try {
            await this.config.persistence.appendOps(this.storageId, ops, sync);
        } catch (error) {
            this.engine?.free();
            this.engine = null;
            this.starting = null;
            throw error;
        }
    }

    async handle(request: WorkerRequest): Promise<WorkerResultPayload> {
        switch (request.kind) {
            case "init": {
                if (SUPPORTED_PROTOCOL_VERSION !== 1) {
                    throw new CrdtError("UnsupportedVersion", "protocol version mismatch");
                }
                if (request.documentId !== this.config.documentId ||
                    (request.storageId !== undefined && request.storageId !== this.storageId)) {
                    throw new CrdtError("InvalidArgument", "worker identity changed after initialization");
                }
                await this.ensureEngine();
                return { kind: "init", ready: true };
            }

            case "loadSnapshot": {
                const engine = await this.ensureEngine();
                const restored = await ConcordEngine.importFromSnapshot(
                    this.config.replicaId,
                    request.snapshot,
                    this.config.loadFactory,
                );
                try {
                    await this.config.persistence.saveSnapshot(this.storageId, request.snapshot);
                } catch (error) {
                    restored.free();
                    throw error;
                }
                engine.free();
                this.engine = restored;
                return { kind: "loadSnapshot", streamSize: restored.streamSize() };
            }

            case "applyRemote": {
                const engine = await this.ensureEngine();
                let applied = 0;
                let duplicates = 0;
                const durable: Uint8Array[] = [];
                for (const bytes of request.ops) {
                    if (engine.applyRemote(bytes) === "applied") {
                        applied += 1;
                        durable.push(bytes);
                    } else {
                        duplicates += 1;
                    }
                }
                // Received remote ops join the durable log: a reload replays
                // the full replica history (origin + remote), so no received
                // content is ever lost across a reload (M044 gap this fixed).
                if (durable.length > 0 || request.cursor !== undefined) {
                    const coveredOpIds = request.cursor === undefined
                        ? []
                        : request.ops.flatMap((op) => {
                            const id = readOpIdentity(op);
                            return id === null || id.replicaId !== this.config.replicaId
                                ? []
                                : [`${id.replicaId}:${id.counter}`];
                        });
                    await this.appendOrReset(durable, request.cursor === undefined
                        ? undefined
                        : { cursor: request.cursor, coveredOpIds });
                }
                return { kind: "applyRemote", applied, duplicates, ops: durable };
            }

            case "seed": {
                const engine = await this.ensureEngine();
                if (request.ops.length === 0) {
                    return { kind: "seed", ops: [] };
                }
                const seedEngine = await ConcordEngine.create(
                    this.seedReplicaId(),
                    this.config.loadFactory,
                );
                const generated: Uint8Array[] = [];
                try {
                    for (const operation of request.ops) {
                        switch (operation.kind) {
                            case "insertText":
                                generated.push(seedEngine.localInsertText(operation.streamIndex, operation.codepoint ?? 0x20));
                                break;
                            case "insertDelimiter":
                                generated.push(seedEngine.localInsertDelimiter(operation.streamIndex, operation.blockType ?? "paragraph"));
                                break;
                            case "delete": {
                                const op = seedEngine.localDelete(operation.streamIndex);
                                if (op !== null) generated.push(op);
                                break;
                            }
                            case "setAttr":
                                generated.push(seedEngine.localSetAttr(operation.streamIndex, operation.name ?? "", operation.value ?? null));
                                break;
                        }
                    }
                    const durable: Uint8Array[] = [];
                    for (const op of generated) {
                        if (engine.applyRemote(op) === "applied") durable.push(op);
                    }
                    await this.appendOrReset(durable);
                    return { kind: "seed", ops: generated };
                } finally {
                    seedEngine.free();
                }
            }

            case "localInsertText": {
                const engine = await this.ensureEngine();
                const op = engine.localInsertText(request.streamIndex, request.codepoint);
                await this.appendOrReset([op]);
                return { kind: "localOps", ops: [op], streamSize: engine.streamSize() };
            }

            case "localInsertDelimiter": {
                const engine = await this.ensureEngine();
                const op = engine.localInsertDelimiter(request.streamIndex, request.blockType);
                await this.appendOrReset([op]);
                return { kind: "localOps", ops: [op], streamSize: engine.streamSize() };
            }

            case "localDelete": {
                const engine = await this.ensureEngine();
                const op = engine.localDelete(request.streamIndex);
                if (op === null) {
                    return { kind: "localOps", ops: [], streamSize: engine.streamSize() };
                }
                await this.appendOrReset([op]);
                return { kind: "localOps", ops: [op], streamSize: engine.streamSize() };
            }

            case "localSetAttr": {
                const engine = await this.ensureEngine();
                const op = engine.localSetAttr(request.streamIndex, request.name, request.value);
                await this.appendOrReset([op]);
                return { kind: "localOps", ops: [op], streamSize: engine.streamSize() };
            }

            case "visibleJson": {
                const engine = await this.ensureEngine();
                return { kind: "visibleJson", json: engine.visibleJson() };
            }

            case "digest": {
                const engine = await this.ensureEngine();
                return { kind: "digest", digest: engine.digest() };
            }

            case "streamSize": {
                const engine = await this.ensureEngine();
                return { kind: "streamSize", size: engine.streamSize() };
            }

            case "exportSnapshot": {
                const engine = await this.ensureEngine();
                const snapshot = engine.exportSnapshot();
                await this.config.persistence.saveSnapshot(this.storageId, snapshot);
                return { kind: "exportSnapshot", snapshot };
            }

            case "exportOps": {
                // Verification surface: the durable local log (test harness).
                const state = await this.config.persistence.loadLocalState(this.storageId);
                return { kind: "exportOps", ops: state.ops };
            }

            case "exportStream": {
                // Adapter mapping surface: full tombstone-inclusive stream.
                const engine = await this.ensureEngine();
                return { kind: "exportStream", json: engine.streamJson() };
            }

            // ---- Phase 7 sync-seam additions (D16, additive only) ---------

            case "replicaInfo": {
                // Join-summary surface: replica identity + the highest
                // contiguous own-replica counter observed in the durable
                // log (the local summary the gateway join frame carries).
                await this.ensureEngine();
                const state = await this.config.persistence.loadLocalState(
                    this.storageId,
                );
                let maxOwnCounter = 0n;
                for (const op of state.ops) {
                    const id = readOpIdentity(op);
                    if (id !== null && id.replicaId === this.config.replicaId) {
                        if (id.counter > maxOwnCounter) maxOwnCounter = id.counter;
                    }
                }
                return {
                    kind: "replicaInfo",
                    replicaId: this.config.replicaId.toString(),
                    sequence: maxOwnCounter.toString(),
                };
            }

            case "localOpsSince": {
                // Own-replica op stream past a counter (decimal string):
                // the sync session's local-op subscription cursor. Ops from
                // other replicas are filtered out — only THIS replica's
                // generated ops ever enter the client outbox.
                await this.ensureEngine();
                const state = await this.config.persistence.loadLocalState(
                    this.storageId,
                );
                const since = BigInt(request.counter);
                const ops: Uint8Array[] = [];
                let nextCounter = since;
                for (const op of state.ops) {
                    const id = readOpIdentity(op);
                    if (id === null || id.replicaId !== this.config.replicaId) {
                        continue;
                    }
                    if (id.counter > since) {
                        ops.push(op);
                        nextCounter = id.counter;
                    }
                }
                return {
                    kind: "localOpsSince",
                    ops,
                    nextCounter: nextCounter.toString(),
                };
            }

            case "importSnapshot": {
                // Atomic snapshot import for the stale-client resync flow
                // (P5-M031 port contract): build fresh, swap only on
                // success. Same engine semantics as loadSnapshot; kept as a
                // distinct kind so the sync seam cannot be confused with
                // the editor's loadSnapshot path.
                const engine = await this.ensureEngine();
                const restored = await ConcordEngine.importFromSnapshot(
                    this.config.replicaId,
                    request.snapshot,
                    this.config.loadFactory,
                );
                try {
                    await this.config.persistence.saveSnapshot(this.storageId, request.snapshot);
                } catch (error) {
                    restored.free();
                    throw error;
                }
                engine.free();
                this.engine = restored;
                return { kind: "importSnapshot", streamSize: restored.streamSize() };
            }

            case "getSyncCursor": {
                const cursor = await this.config.persistence.loadSyncCursor?.(this.storageId) ?? "0";
                return { kind: "getSyncCursor", cursor };
            }

            case "persistSyncCursor": {
                if (this.config.persistence.saveSyncCursor === undefined) {
                    throw new CrdtError("StateCorruption", "sync cursor persistence unavailable");
                }
                await this.config.persistence.saveSyncCursor(this.storageId, request.cursor);
                return { kind: "persistSyncCursor", cursor: request.cursor };
            }
        }
    }
}
