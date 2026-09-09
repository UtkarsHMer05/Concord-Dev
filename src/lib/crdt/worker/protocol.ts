// Typed Web Worker protocol for CRDT execution (P2-M034).
//
// All messages carry a correlation id; responses either fulfill the request
// or return a structured error. Binary payloads (operations, snapshots) are
// transferred as Uint8Array — transferable ArrayBuffers are used by the
// client where the buffer is not needed afterwards.

export type WorkerRequest =
    | { id: number; kind: "init"; documentId: string; replicaId: string }
    | { id: number; kind: "loadSnapshot"; snapshot: Uint8Array }
    | { id: number; kind: "applyRemote"; ops: Uint8Array[] }
    | { id: number; kind: "localInsertText"; streamIndex: number; codepoint: number }
    | { id: number; kind: "localInsertDelimiter"; streamIndex: number; blockType: string }
    | { id: number; kind: "localDelete"; streamIndex: number }
    | { id: number; kind: "localSetAttr"; streamIndex: number; name: string; value: string | null }
    | { id: number; kind: "visibleJson" }
    | { id: number; kind: "digest" }
    | { id: number; kind: "streamSize" }
    | { id: number; kind: "exportSnapshot" }
    | { id: number; kind: "exportOps" }
    | { id: number; kind: "exportStream" }
    // ---- Phase 7 sync-seam additions (D16, additive only) -----------------
    // The sync session (src/lib/sync/sync-session.ts) drives the worker as a
    // CrdtEnginePort; these requests expose replica identity, the local op
    // identity stream, and atomic snapshot import over the same RPC channel.
    | { id: number; kind: "replicaInfo" }
    | { id: number; kind: "localOpsSince"; counter: string }
    | { id: number; kind: "importSnapshot"; snapshot: Uint8Array };

export type CrdtWorkerError = {
    code: string;
    message: string;
};

export type WorkerResponse =
    | { id: number; ok: true; result: WorkerResultPayload }
    | { id: number; ok: false; error: CrdtWorkerError };

/**
 * Worker → client push notification (no correlation id; additive Phase 7
 * sync-seam surface). Emitted after a LOCAL op-generating request durably
 * persists, so the sync session can observe local ops without wrapping
 * every editor-bridge call.
 */
export type WorkerNotification = { kind: "localOps"; ops: Uint8Array[] };

export type WorkerResultPayload =
    | { kind: "init"; ready: true }
    | { kind: "loadSnapshot"; streamSize: number }
    | { kind: "applyRemote"; applied: number; duplicates: number; ops: Uint8Array[] }
    | { kind: "localOps"; ops: Uint8Array[]; streamSize: number }
    | { kind: "visibleJson"; json: string }
    | { kind: "digest"; digest: string }
    | { kind: "streamSize"; size: number }
    | { kind: "exportSnapshot"; snapshot: Uint8Array }
    | { kind: "exportOps"; ops: Uint8Array[] }
    | { kind: "exportStream"; json: string }
    // ---- Phase 7 sync-seam additions (D16, additive only) -----------------
    | { kind: "replicaInfo"; replicaId: string; sequence: string }
    | { kind: "localOpsSince"; ops: Uint8Array[]; nextCounter: string }
    | { kind: "importSnapshot"; streamSize: number };
