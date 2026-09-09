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
function readOpIdentity(frame: Uint8Array): { replicaId: bigint; counter: number; lamport: number } | null {
    if (frame.length < 26) {
        return null;
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const replicaId = view.getBigUint64(2, true);
    const counter = view.getUint32(10, true);
    const lamport = view.getUint32(18, true);
    return { replicaId, counter, lamport };
}

export interface WorkerCoreConfig {
    documentId: string;
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
        const state = await this.config.persistence.loadLocalState(this.config.documentId);
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
        let maxOwnCounter = 0;
        let maxLamport = 0;
        for (const op of ops) {
            this.engine.applyRemote(op);
            const id = readOpIdentity(op);
            if (id !== null) {
                if (id.replicaId === this.config.replicaId) {
                    maxOwnCounter = Math.max(maxOwnCounter, id.counter);
                }
                maxLamport = Math.max(maxLamport, id.lamport);
            }
        }
        this.engine.restoreAllocationState(BigInt(maxOwnCounter) + 1n, BigInt(maxLamport) + 1n);
    }

    async handle(request: WorkerRequest): Promise<WorkerResultPayload> {
        switch (request.kind) {
            case "init": {
                if (SUPPORTED_PROTOCOL_VERSION !== 1) {
                    throw new CrdtError("UnsupportedVersion", "protocol version mismatch");
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
                engine.free();
                this.engine = restored;
                await this.config.persistence.saveSnapshot(this.config.documentId, request.snapshot);
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
                if (durable.length > 0) {
                    await this.config.persistence.appendOps(this.config.documentId, durable);
                }
                return { kind: "applyRemote", applied, duplicates, ops: durable };
            }

            case "localInsertText": {
                const engine = await this.ensureEngine();
                const op = engine.localInsertText(request.streamIndex, request.codepoint);
                await this.config.persistence.appendOps(this.config.documentId, [op]);
                return { kind: "localOps", ops: [op], streamSize: engine.streamSize() };
            }

            case "localInsertDelimiter": {
                const engine = await this.ensureEngine();
                const op = engine.localInsertDelimiter(request.streamIndex, request.blockType);
                await this.config.persistence.appendOps(this.config.documentId, [op]);
                return { kind: "localOps", ops: [op], streamSize: engine.streamSize() };
            }

            case "localDelete": {
                const engine = await this.ensureEngine();
                const op = engine.localDelete(request.streamIndex);
                if (op === null) {
                    return { kind: "localOps", ops: [], streamSize: engine.streamSize() };
                }
                await this.config.persistence.appendOps(this.config.documentId, [op]);
                return { kind: "localOps", ops: [op], streamSize: engine.streamSize() };
            }

            case "localSetAttr": {
                const engine = await this.ensureEngine();
                const op = engine.localSetAttr(request.streamIndex, request.name, request.value);
                await this.config.persistence.appendOps(this.config.documentId, [op]);
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
                await this.config.persistence.saveSnapshot(this.config.documentId, snapshot);
                return { kind: "exportSnapshot", snapshot };
            }

            case "exportOps": {
                // Verification surface: the durable local log (test harness).
                const state = await this.config.persistence.loadLocalState(this.config.documentId);
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
                    this.config.documentId,
                );
                let maxOwnCounter = 0n;
                for (const op of state.ops) {
                    const id = readOpIdentity(op);
                    if (id !== null && id.replicaId === this.config.replicaId) {
                        maxOwnCounter = BigInt(
                            Math.max(Number(maxOwnCounter), id.counter),
                        );
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
                    this.config.documentId,
                );
                const since = BigInt(request.counter);
                const ops: Uint8Array[] = [];
                let nextCounter = since;
                for (const op of state.ops) {
                    const id = readOpIdentity(op);
                    if (id === null || id.replicaId !== this.config.replicaId) {
                        continue;
                    }
                    if (BigInt(id.counter) > since) {
                        ops.push(op);
                        nextCounter = BigInt(id.counter);
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
                engine.free();
                this.engine = restored;
                await this.config.persistence.saveSnapshot(
                    this.config.documentId,
                    request.snapshot,
                );
                return { kind: "importSnapshot", streamSize: restored.streamSize() };
            }
        }
    }
}
