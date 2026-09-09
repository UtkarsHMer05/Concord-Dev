/**
 * Worker-backed CrdtEnginePort (D16 — Phase 7 product wiring).
 *
 * Bridges the proven collaboration runtime (SyncSession) to the REAL CRDT
 * engine worker instead of the E2E fake port. The port surface
 * (sync-session.ts) maps onto the worker RPC surface (worker/protocol.ts):
 *
 *   applyRemote    → client.applyRemote (idempotent inside the engine; the
 *                    durable log also receives remote ops — M044)
 *   replicaId      → client.replicaInfo().replicaId
 *   localSummary   → client.replicaInfo().sequence (own max counter)
 *   onLocalOps     → client.onLocalOps (worker push notification emitted
 *                    after each durable LOCAL op — remote ops never push)
 *   importSnapshot → client.importSnapshot (atomic fresh-engine swap)
 *   unackedOps     → the PendingOpStore's unacked set, injected here so the
 *                    resync flow (snapshot-resync.ts invariant 1) captures
 *                    the UNSYNCED outbox — never engine internals the import
 *                    replaces.
 *
 * Remote-render hook: after every applyRemote batch that actually applied,
 * the optional onRemoteApplied callback fires — the editor bridge re-renders
 * from the worker's converged state (renderRemote, emitUpdate=false).
 */

import type { ResyncEnginePort } from "./sync-session";
import type { PendingOpStore } from "./pending-store";
import type { CrdtClient } from "../crdt/worker/client";

export interface WorkerEnginePortOptions {
    /** The REAL worker client (owned by the document page). */
    client: CrdtClient;
    /** The document's durable outbox — the UNSYNCED op set source. */
    store: PendingOpStore;
    /** Fires after a remote batch integrated ≥1 new op (editor re-render). */
    onRemoteApplied?: () => void;
}

export class WorkerEnginePort implements ResyncEnginePort {
    private readonly options: WorkerEnginePortOptions;

    constructor(options: WorkerEnginePortOptions) {
        this.options = options;
    }

    async applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }> {
        const result = await this.options.client.applyRemote(ops);
        if (result.applied > 0) {
            this.options.onRemoteApplied?.();
        }
        return result;
    }

    async replicaId(): Promise<string> {
        const info = await this.options.client.replicaInfo();
        return info.replicaId;
    }

    async localSummary(): Promise<string> {
        const info = await this.options.client.replicaInfo();
        return info.sequence;
    }

    onLocalOps(handler: (ops: Uint8Array[]) => void): () => void {
        return this.options.client.onLocalOps(handler);
    }

    async importSnapshot(inner: Uint8Array): Promise<void> {
        await this.options.client.importSnapshot(inner);
        // The base was replaced: the editor must re-render from the new
        // state (the bridge's renderRemote reads the worker, not its cache).
        this.options.onRemoteApplied?.();
    }

    /** The UNSYNCED outbox set (pending + sent — never durably acked). */
    async unackedOps(): Promise<Uint8Array[]> {
        const records = await this.options.store.unackedOps();
        return records.map((record) => record.op);
    }
}
