// TypeScript runtime wrapper around the Concord CRDT WebAssembly module
// (P2-M033).
//
// The only supported boundary for application code: no React component or
// worker may touch the raw Emscripten exports. Responsibilities:
// - lazy module loading (injected factory: browser bundle or test harness),
// - engine lifecycle + memory ownership (handles, output buffers),
// - typed operations and structured errors,
// - protocol/version compatibility checks,
// - binary payload conversion (Uint8Array ↔ module heap).
import type { LoadConcordCrdtFactory, ConcordModule } from "./wasm-types";

/** Protocol version the wrapper is compiled against (PROTOCOL §1). */
export const SUPPORTED_PROTOCOL_VERSION = 1;

export type CrdtErrorCode =
    | "UnsupportedVersion"
    | "UnknownOpType"
    | "InvalidReplicaId"
    | "InvalidCounter"
    | "InvalidLamport"
    | "InvalidUnicodeScalar"
    | "InvalidString"
    | "UnknownAttributeName"
    | "InvalidAttributeValue"
    | "OpTooLarge"
    | "MalformedFrame"
    | "SnapshotVersionUnsupported"
    | "PendingLimitExceeded"
    | "CounterOverflow"
    | "InvalidArgument"
    | "StateCorruption"
    | "Unknown";

export class CrdtError extends Error {
    readonly code: CrdtErrorCode;

    constructor(code: CrdtErrorCode, message: string) {
        super(message);
        this.name = "CrdtError";
        this.code = code;
    }
}

/** Result of applying a remote operation. */
export type ApplyRemoteResult = "applied" | "duplicate";

interface EngineInternals {
    handle: number;
    module: ConcordModule;
    outBuffer: number;
    outCapacity: number;
}

// ABI error encoding: -1000 - ErrorCode (see wasm/src/bindings.cpp).
const ERR_BASE = -1000;

const ERROR_NAMES: readonly string[] = [
    "Ok",
    "UnsupportedVersion",
    "UnknownOpType",
    "InvalidReplicaId",
    "InvalidCounter",
    "InvalidLamport",
    "InvalidUnicodeScalar",
    "InvalidString",
    "UnknownAttributeName",
    "InvalidAttributeValue",
    "OpTooLarge",
    "MalformedFrame",
    "SnapshotVersionUnsupported",
    "PendingLimitExceeded",
    "CounterOverflow",
    "InvalidArgument",
    "StateCorruption",
];

function decode_error(status: number, message: string): CrdtError {
    const index = ERR_BASE - status;
    const name =
        index >= 0 && index < ERROR_NAMES.length
            ? (ERROR_NAMES[index] as CrdtErrorCode)
            : "Unknown";
    return new CrdtError(name, message);
}

function is_error_status(status: number): boolean {
    return status < ERR_BASE + 100;
}

/**
 * One CRDT replica engine. Single-threaded by contract: use it from one
 * worker (or one test) at a time — see the Phase 2 concurrency decision.
 */
export class ConcordEngine {
    private internals: EngineInternals | null;

    private constructor(internals: EngineInternals) {
        this.internals = internals;
    }

    /**
     * Creates an engine for a new replica. `loadFactory` injects the
     * Emscripten module factory (browser bundle: dynamic import of the
     * generated glue; tests: eval/File-based loader).
     */
    static async create(
        replicaId: bigint,
        loadFactory: LoadConcordCrdtFactory,
    ): Promise<ConcordEngine> {
        const loaded = await loadFactory();
        const handle = loaded._concord_create(replicaId);
        if (handle === 0) {
            throw new CrdtError("Unknown", "engine creation failed");
        }
        return new ConcordEngine({ handle, module: loaded, outBuffer: 0, outCapacity: 0 });
    }

    /** Restores an engine from a snapshot produced by exportSnapshot(). */
    static async importFromSnapshot(
        replicaId: bigint,
        snapshot: Uint8Array,
        loadFactory: LoadConcordCrdtFactory,
    ): Promise<ConcordEngine> {
        const loaded = await loadFactory();
        const pointer = loaded._concord_alloc(snapshot.length);
        loaded.HEAPU8.set(snapshot, pointer);
        const handle = loaded._concord_create_from_snapshot(replicaId, pointer, snapshot.length);
        loaded._concord_free(pointer);
        if (handle === 0) {
            throw new CrdtError("SnapshotVersionUnsupported", "snapshot import failed");
        }
        return new ConcordEngine({ handle, module: loaded, outBuffer: 0, outCapacity: 0 });
    }

    /** Releases the engine. The instance must not be used afterwards. */
    free(): void {
        if (this.internals === null) {
            return;
        }
        const { module, handle, outBuffer } = this.internals;
        if (outBuffer !== 0) {
            module._concord_free(outBuffer);
        }
        module._concord_destroy(handle);
        this.internals = null;
    }

    private assertLive(): EngineInternals {
        if (this.internals === null) {
            throw new CrdtError("InvalidArgument", "engine already freed");
        }
        return this.internals;
    }

    // ------------------------------------------------------------------
    // Output-buffer plumbing: one growable module-heap buffer reused by all
    // read calls. Callers copy out immediately — the buffer is reused by the
    // next call.
    // ------------------------------------------------------------------

    private ensureBuffer(internals: EngineInternals, required: number): void {
        if (internals.outCapacity < required) {
            if (internals.outBuffer !== 0) {
                internals.module._concord_free(internals.outBuffer);
            }
            internals.outBuffer = internals.module._concord_alloc(required);
            internals.outCapacity = required;
        }
    }

    private copyOut(internals: EngineInternals, required: number): Uint8Array {
        if (required < 0) {
            throw new CrdtError("Unknown", "negative output length");
        }
        if (required === 0) {
            return new Uint8Array(0);
        }
        return internals.module.HEAPU8.slice(
            internals.outBuffer,
            internals.outBuffer + required,
        );
    }

    /**
     * Read calls: side-effect free, so the probe pattern is safe — call with
     * capacity 0 (ABI returns -(required) without writing), grow, call again.
     */
    private runReadCall(
        internals: EngineInternals,
        invoke: (ptr: number, cap: number) => number,
    ): Uint8Array {
        // Sizing probe (out=null, cap=0) returns the required length as a
        // POSITIVE value; negative values are reserved for error codes. The
        // previous "-required" probe encoding collided with the error range
        // for outputs >= ~900 bytes — every real document — and misread
        // successful sizing as failures (DEC-027).
        const probe = invoke(0, 0);
        if (probe < 0) {
            throw decode_error(probe, "engine call failed");
        }
        if (probe === 0) {
            return new Uint8Array(0);
        }
        this.ensureBuffer(internals, probe);
        const status = invoke(internals.outBuffer, internals.outCapacity);
        if (status < 0) {
            throw decode_error(status, "engine call failed");
        }
        return this.copyOut(internals, status);
    }

    /**
     * Generating calls: each invocation creates ONE operation (integrated
     * immediately), so they must never be re-invoked for sizing. The binding
     * stashes the serialized op; an insufficient buffer is recovered through
     * the side-effect-free _concord_last_op.
     */
    private runGeneratingCall(
        internals: EngineInternals,
        invoke: (ptr: number, cap: number) => number,
    ): Uint8Array {
        this.ensureBuffer(internals, Math.max(internals.outCapacity, 256));
        let status = invoke(internals.outBuffer, internals.outCapacity);
        if (is_error_status(status)) {
            throw decode_error(status, "local operation failed");
        }
        if (status < 0) {
            // The op was integrated; recover its bytes from the stash.
            const required = -status;
            this.ensureBuffer(internals, required);
            status = internals.module._concord_last_op(
                internals.handle,
                internals.outBuffer,
                internals.outCapacity,
            );
            if (is_error_status(status)) {
                throw decode_error(status, "last_op recovery failed");
            }
        }
        return this.copyOut(internals, status);
    }

    // ------------------------------------------------------------------
    // Local generation (each returns the serialized operation for delivery
    // and persistence).
    // ------------------------------------------------------------------

    localInsertText(streamIndex: number, codepoint: number): Uint8Array {
        const internals = this.assertLive();
        return this.runGeneratingCall(internals, (ptr, cap) =>
            internals.module._concord_local_insert_text(
                internals.handle, streamIndex, codepoint, ptr, cap),
        );
    }

    localInsertDelimiter(streamIndex: number, blockType: string): Uint8Array {
        const internals = this.assertLive();
        const encoded = new TextEncoder().encode(blockType);
        const pointer = internals.module._concord_alloc(encoded.length);
        internals.module.HEAPU8.set(encoded, pointer);
        try {
            return this.runGeneratingCall(internals, (ptr, cap) =>
                internals.module._concord_local_insert_delimiter(
                    internals.handle, streamIndex, pointer, encoded.length, ptr, cap),
            );
        } finally {
            internals.module._concord_free(pointer);
        }
    }

    /** Returns null when the delete was an idempotent no-op. */
    localDelete(streamIndex: number): Uint8Array | null {
        const internals = this.assertLive();
        const bytes = this.runGeneratingCall(internals, (ptr, cap) =>
            internals.module._concord_local_delete(internals.handle, streamIndex, ptr, cap),
        );
        return bytes.length === 0 ? null : bytes;
    }

    localSetAttr(streamIndex: number, name: string, value: string | null): Uint8Array {
        const internals = this.assertLive();
        const nameBytes = new TextEncoder().encode(name);
        const namePtr = internals.module._concord_alloc(nameBytes.length);
        internals.module.HEAPU8.set(nameBytes, namePtr);
        const hasValue = value !== null;
        const valueBytes = hasValue ? new TextEncoder().encode(value as string) : new Uint8Array(0);
        const valuePtr = hasValue ? internals.module._concord_alloc(valueBytes.length) : 0;
        if (hasValue) {
            internals.module.HEAPU8.set(valueBytes, valuePtr);
        }
        try {
            return this.runGeneratingCall(internals, (ptr, cap) =>
                internals.module._concord_local_set_attr(
                    internals.handle, streamIndex, namePtr, nameBytes.length,
                    valuePtr, hasValue ? valueBytes.length : -1, ptr, cap),
            );
        } finally {
            internals.module._concord_free(namePtr);
            if (hasValue) {
                internals.module._concord_free(valuePtr);
            }
        }
    }

    // ------------------------------------------------------------------
    // Remote application / reads / persistence.
    // ------------------------------------------------------------------

    applyRemote(bytes: Uint8Array): ApplyRemoteResult {
        const internals = this.assertLive();
        const pointer = internals.module._concord_alloc(bytes.length);
        internals.module.HEAPU8.set(bytes, pointer);
        try {
            const status = internals.module._concord_apply_remote(
                internals.handle, pointer, bytes.length);
            if (is_error_status(status)) {
                throw decode_error(status, "apply_remote failed");
            }
            return status === 1 ? "applied" : "duplicate";
        } finally {
            internals.module._concord_free(pointer);
        }
    }

    streamSize(): number {
        const internals = this.assertLive();
        return internals.module._concord_stream_size(internals.handle);
    }

    /** Canonical visible document JSON (identical bytes on native and WASM). */
    visibleJson(): string {
        const internals = this.assertLive();
        return new TextDecoder().decode(
            this.runReadCall(internals, (ptr, cap) =>
                internals.module._concord_visible_json(internals.handle, ptr, cap)),
        );
    }

    digest(): string {
        const internals = this.assertLive();
        return new TextDecoder().decode(
            this.runReadCall(internals, (ptr, cap) =>
                internals.module._concord_digest(internals.handle, ptr, cap)),
        );
    }

    pendingCount(): number {
        const internals = this.assertLive();
        return internals.module._concord_pending_count(internals.handle);
    }

    /**
     * Restores the generator allocation state after a durable-log replay
     * (counters/lamport are per-replica monotonic — M037).
     */
    restoreAllocationState(nextCounter: bigint, lamport: bigint): void {
        const internals = this.assertLive();
        internals.module._concord_restore_allocation(internals.handle, nextCounter, lamport);
    }

    exportSnapshot(): Uint8Array {
        const internals = this.assertLive();
        return this.runReadCall(internals, (ptr, cap) =>
            internals.module._concord_export_snapshot(internals.handle, ptr, cap),
        );
    }

    /**
     * The full tombstone-inclusive item stream (adapter mapping surface).
     */
    streamJson(): string {
        const internals = this.assertLive();
        return new TextDecoder().decode(
            this.runReadCall(internals, (ptr, cap) =>
                internals.module._concord_stream_json(internals.handle, ptr, cap)),
        );
    }
}
