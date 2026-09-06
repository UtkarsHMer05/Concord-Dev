// Type declarations for the Emscripten-generated module
// (wasm/dist/concord-crdt.js). Hand-written to keep the generated artifact
// out of the type surface (P2-M031/M033).
export type LoadConcordCrdtFactory = () => Promise<ConcordModule>;

export interface ConcordModule {
    HEAPU8: Uint8Array;

    _concord_create(replicaId: bigint): number;
    _concord_destroy(handle: number): void;
    _concord_alloc(bytes: number): number;
    _concord_free(pointer: number): void;

    _concord_local_insert_text(
        handle: number, streamIndex: number, codepoint: number,
        out: number, cap: number,
    ): number;
    _concord_local_insert_delimiter(
        handle: number, streamIndex: number, blockType: number, blockTypeLen: number,
        out: number, cap: number,
    ): number;
    _concord_local_delete(handle: number, streamIndex: number, out: number, cap: number): number;
    _concord_local_set_attr(
        handle: number, streamIndex: number,
        name: number, nameLen: number,
        value: number, valueLen: number,
        out: number, cap: number,
    ): number;
    _concord_last_op(handle: number, out: number, cap: number): number;

    _concord_apply_remote(handle: number, bytes: number, len: number): number;

    _concord_stream_size(handle: number): number;
    _concord_visible_json(handle: number, out: number, cap: number): number;
    _concord_digest(handle: number, out: number, cap: number): number;
    _concord_pending_count(handle: number): number;

    _concord_export_snapshot(handle: number, out: number, cap: number): number;
    _concord_create_from_snapshot(replicaId: bigint, bytes: number, len: number): number;
    _concord_restore_allocation(handle: number, nextCounter: bigint, lamport: bigint): void;
    _concord_stream_json(handle: number, out: number, cap: number): number;
    _concord_import_snapshot(handle: number, bytes: number, len: number): number;
}
