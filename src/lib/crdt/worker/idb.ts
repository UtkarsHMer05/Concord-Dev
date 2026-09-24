// Durable local persistence adapter (P2-M035/M036).
//
// Storage authority split (docs/CONSISTENCY_MODEL.md §6): IndexedDB holds the
// LOCAL replica state — document snapshot + durable local operation log.
// Document metadata, ownership, and ACLs remain authoritative in PostgreSQL
// (Phase 1 control plane). IndexedDB is local replica durability, never
// server durability.
//
// Schema (version 3):
//   "snapshots" (key = documentId)     → { documentId, snapshot, savedAt }
//   "oplog"     (key = `${documentId}:${seq}`) → { key, documentId, seq, op, identity?, coveredAtCursor? }
//   "syncState" (key = documentId)     → { documentId, cursor }
// Catch-up proof is stored on the existing oplog row for that operation, so
// it cannot grow a second per-op log. Version 2 coverage rows are migrated.
//
// All operations run inside IDB transactions; failed writes reject and are
// surfaced to the caller (never swallowed).

export const DB_NAME = "concord-crdt";
export const DB_VERSION = 3;
const SYNC_STATE = "syncState";
const COVERAGE = "coverage";

/** Local records are isolated by authenticated account when one is known. */
export function replicaStorageId(documentId: string, userId?: string | null): string {
    return userId ? `${documentId}:user:${encodeURIComponent(userId)}` : documentId;
}

export interface SnapshotRecord {
    documentId: string;
    snapshot: Uint8Array;
    savedAt: number;
}

export interface OpLogRecord {
    key: string;
    documentId: string;
    seq: number;
    op: Uint8Array;
    identity?: string;
    coveredAtCursor?: string;
}

export interface LocalState {
    snapshot: Uint8Array | null;
    /** Durable local ops, ordered by sequence. */
    ops: Uint8Array[];
}

export interface PersistenceAdapter {
    loadLocalState(documentId: string): Promise<LocalState>;
    appendOps(
        documentId: string,
        ops: Uint8Array[],
        sync?: { cursor: string; coveredOpIds: string[] },
    ): Promise<void>;
    loadSyncCursor?(documentId: string): Promise<string>;
    saveSyncCursor?(documentId: string, cursor: string): Promise<void>;
    loadCoveredOpIds?(documentId: string, identities: string[]): Promise<Set<string>>;
    clearCoveredOpIds?(documentId: string, identities: string[]): Promise<void>;
    saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void>;
    clearDocument(documentId: string): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            const tx = request.transaction!;
            if (!db.objectStoreNames.contains("snapshots")) {
                db.createObjectStore("snapshots", { keyPath: "documentId" });
            }
            let oplog: IDBObjectStore;
            if (!db.objectStoreNames.contains("oplog")) {
                oplog = db.createObjectStore("oplog", { keyPath: "key" });
            } else {
                oplog = tx.objectStore("oplog");
            }
            if (!oplog.indexNames.contains("byDocument")) {
                oplog.createIndex("byDocument", "documentId", { unique: false });
            }
            if (!oplog.indexNames.contains("byDocumentIdentity")) {
                oplog.createIndex("byDocumentIdentity", ["documentId", "identity"], { unique: false });
            }
            if (!db.objectStoreNames.contains(SYNC_STATE)) {
                db.createObjectStore(SYNC_STATE, { keyPath: "documentId" });
            }
            // Preserve v2 exact-coverage proof while moving it onto the
            // existing op-log row. The versionchange transaction keeps this
            // migration atomic with removal of the old coverage store.
            const legacyCoverage = db.objectStoreNames.contains(COVERAGE)
                ? tx.objectStore(COVERAGE)
                : null;
            const cursorRequest = oplog.openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor === null) {
                    if (legacyCoverage !== null) db.deleteObjectStore(COVERAGE);
                    return;
                }
                const record = cursor.value as OpLogRecord;
                const identity = opIdentity(record.op);
                if (identity !== null) record.identity = identity;
                const updateAndContinue = (proof?: CoverageRecord) => {
                    if (proof !== undefined) {
                        try {
                            record.coveredAtCursor = maxCursor(
                                record.coveredAtCursor ?? "0",
                                proof.cursor,
                            );
                        } catch {
                            tx.abort();
                            return;
                        }
                    }
                    cursor.update(record);
                    cursor.continue();
                };
                if (legacyCoverage !== null && identity !== null) {
                    const proofRequest = legacyCoverage.get(
                        `${record.documentId}:${identity}`,
                    ) as IDBRequest<CoverageRecord | undefined>;
                    proofRequest.onsuccess = () => updateAndContinue(proofRequest.result);
                } else {
                    updateAndContinue();
                }
            };
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
}

function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
}

function transactionDone(tx: IDBTransaction, message: string): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error(message));
        tx.onabort = () => reject(tx.error ?? new Error(`${message} (aborted)`));
    });
}

interface SyncStateRecord {
    documentId: string;
    cursor: string;
}

interface CoverageRecord {
    key: string;
    documentId: string;
    identity: string;
    cursor: string;
}

function opIdentity(op: Uint8Array): string | null {
    if (op.length < 18 || op[0] !== 1) return null;
    const view = new DataView(op.buffer, op.byteOffset, op.byteLength);
    const replica = view.getBigUint64(2, true);
    const counter = view.getBigUint64(10, true);
    return replica > 0n && counter > 0n ? `${replica}:${counter}` : null;
}

function maxCursor(left: string, right: string): string {
    if (!/^(?:0|[1-9][0-9]*)$/.test(left) || !/^(?:0|[1-9][0-9]*)$/.test(right)) {
        throw new TypeError("sync cursor must be a non-negative decimal string");
    }
    return BigInt(left) >= BigInt(right) ? left : right;
}

/** Cursor and per-op proof are committed with the catch-up op log in one transaction. */
export async function readCoveredOpIds(documentId: string, identities: string[]): Promise<Set<string>> {
    if (identities.length === 0) return new Set();
    const db = await openDatabase();
    try {
        const tx = db.transaction([SYNC_STATE, "oplog"], "readonly");
        const done = transactionDone(tx, "sync coverage read failed");
        const current = await awaitRequest(
            tx.objectStore(SYNC_STATE).get(documentId) as IDBRequest<SyncStateRecord | undefined>,
        );
        const index = tx.objectStore("oplog").index("byDocumentIdentity");
        const rows = await Promise.all(identities.map((identity) => awaitRequest(
            index.getAll([documentId, identity]) as IDBRequest<OpLogRecord[]>,
        )));
        await done;
        const cursor = current?.cursor ?? "0";
        return new Set(identities.filter((_identity, index) => {
            return rows[index].some((record) => {
                const coveredAt = record.coveredAtCursor;
                return coveredAt !== undefined && maxCursor(cursor, coveredAt) === cursor;
            });
        }));
    } finally {
        db.close();
    }
}

/** Prune proof after the corresponding ACK row has been durably compacted. */
export async function clearCoveredOpIds(documentId: string, identities: string[]): Promise<void> {
    if (identities.length === 0) return;
    const db = await openDatabase();
    try {
        const tx = db.transaction("oplog", "readwrite");
        const done = transactionDone(tx, "sync coverage prune failed");
        const store = tx.objectStore("oplog");
        const index = store.index("byDocumentIdentity");
        for (const identity of new Set(identities)) {
            const records = await awaitRequest(
                index.getAll([documentId, identity]) as IDBRequest<OpLogRecord[]>,
            );
            for (const record of records) {
                if (record.coveredAtCursor === undefined) continue;
                delete record.coveredAtCursor;
                store.put(record);
            }
        }
        await done;
    } finally {
        db.close();
    }
}

/** Detect retained document-only state without loading or importing its payload. */
export async function hasReplicaData(documentId: string): Promise<boolean> {
    const db = await openDatabase();
    try {
        const tx = db.transaction(["snapshots", "oplog"], "readonly");
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed"));
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB read aborted"));
        });
        const [snapshot, count] = await Promise.all([
            awaitRequest(tx.objectStore("snapshots").get(documentId)),
            awaitRequest(tx.objectStore("oplog").index("byDocument").count(documentId)),
            done,
        ]).then(([snapshot, count]) => [snapshot, count] as const);
        return snapshot !== undefined || count > 0;
    } finally {
        db.close();
    }
}

/** IndexedDB-backed adapter for browser use. */
export class IdbPersistence implements PersistenceAdapter {
    private db: Promise<IDBDatabase>;

    constructor() {
        this.db = openDatabase();
    }

    async loadLocalState(documentId: string): Promise<LocalState> {
        const db = await this.db;
        const tx = db.transaction(["snapshots", "oplog"], "readonly");
        const snapshotStore = tx.objectStore("snapshots");
        const oplogStore = tx.objectStore("oplog");
        const index = oplogStore.index("byDocument");

        const snapshotRecord = (await awaitRequest(
            snapshotStore.get(documentId) as IDBRequest<SnapshotRecord | undefined>,
        )) as SnapshotRecord | undefined;
        const opRecords = (await awaitRequest(
            index.getAll(documentId) as IDBRequest<OpLogRecord[]>,
        )) as OpLogRecord[];

        opRecords.sort((a, b) => a.seq - b.seq);
        return {
            snapshot: snapshotRecord?.snapshot ?? null,
            ops: opRecords.map((record) => record.op),
        };
    }

    async appendOps(
        documentId: string,
        ops: Uint8Array[],
        sync?: { cursor: string; coveredOpIds: string[] },
    ): Promise<void> {
        if (ops.length === 0 && sync === undefined) {
            return;
        }
        const db = await this.db;
        const names = sync === undefined ? ["oplog"] : ["oplog", SYNC_STATE];
        const tx = db.transaction(names, "readwrite");
        const done = transactionDone(tx, "IndexedDB append failed");
        const store = tx.objectStore("oplog");
        for (const op of ops) {
            const seq = await awaitRequest(store.count() as IDBRequest<number>);
            const key = `${documentId}:${seq}`;
            const identity = opIdentity(op);
            const record: OpLogRecord = identity === null
                ? { key, documentId, seq, op }
                : { key, documentId, seq, op, identity };
            store.put(record);
        }
        if (sync !== undefined) {
            const syncState = tx.objectStore(SYNC_STATE);
            const previous = await awaitRequest(
                syncState.get(documentId) as IDBRequest<SyncStateRecord | undefined>,
            );
            const cursor = maxCursor(previous?.cursor ?? "0", sync.cursor);
            syncState.put({ documentId, cursor } satisfies SyncStateRecord);
            const index = store.index("byDocumentIdentity");
            for (const identity of new Set(sync.coveredOpIds)) {
                const records = await awaitRequest(
                    index.getAll([documentId, identity]) as IDBRequest<OpLogRecord[]>,
                );
                for (const record of records) {
                    record.coveredAtCursor = maxCursor(record.coveredAtCursor ?? "0", sync.cursor);
                    store.put(record);
                }
            }
        }
        await done;
    }

    async loadSyncCursor(documentId: string): Promise<string> {
        const db = await this.db;
        const tx = db.transaction(SYNC_STATE, "readonly");
        const done = transactionDone(tx, "sync cursor read failed");
        const row = await awaitRequest(
            tx.objectStore(SYNC_STATE).get(documentId) as IDBRequest<SyncStateRecord | undefined>,
        );
        await done;
        return row?.cursor ?? "0";
    }

    async saveSyncCursor(documentId: string, cursor: string): Promise<void> {
        const db = await this.db;
        const tx = db.transaction(SYNC_STATE, "readwrite");
        const done = transactionDone(tx, "sync cursor write failed");
        const store = tx.objectStore(SYNC_STATE);
        const previous = await awaitRequest(
            store.get(documentId) as IDBRequest<SyncStateRecord | undefined>,
        );
        store.put({ documentId, cursor: maxCursor(previous?.cursor ?? "0", cursor) } satisfies SyncStateRecord);
        await done;
    }

    loadCoveredOpIds(documentId: string, identities: string[]): Promise<Set<string>> {
        return readCoveredOpIds(documentId, identities);
    }

    clearCoveredOpIds(documentId: string, identities: string[]): Promise<void> {
        return clearCoveredOpIds(documentId, identities);
    }

    async saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void> {
        const db = await this.db;
        const tx = db.transaction("snapshots", "readwrite");
        const record: SnapshotRecord = { documentId, snapshot, savedAt: Date.now() };
        tx.objectStore("snapshots").put(record);
        await transactionDone(tx, "IndexedDB snapshot failed");
    }

    async clearDocument(documentId: string): Promise<void> {
        const db = await this.db;
        const tx = db.transaction(["snapshots", "oplog", SYNC_STATE], "readwrite");
        tx.objectStore("snapshots").delete(documentId);
        tx.objectStore(SYNC_STATE).delete(documentId);
        const index = tx.objectStore("oplog").index("byDocument");
        const records = (await awaitRequest(
            index.getAll(documentId) as IDBRequest<OpLogRecord[]>,
        )) as OpLogRecord[];
        for (const record of records) {
            tx.objectStore("oplog").delete(record.key);
        }
        await transactionDone(tx, "IndexedDB clear failed");
    }
}
