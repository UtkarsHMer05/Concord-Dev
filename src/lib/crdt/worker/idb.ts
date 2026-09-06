// Durable local persistence adapter (P2-M035/M036).
//
// Storage authority split (docs/CONSISTENCY_MODEL.md §6): IndexedDB holds the
// LOCAL replica state — document snapshot + durable local operation log.
// Document metadata, ownership, and ACLs remain authoritative in PostgreSQL
// (Phase 1 control plane). IndexedDB is local replica durability, never
// server durability.
//
// Schema (version 1):
//   "snapshots" (key = documentId)     → { documentId, snapshot, savedAt }
//   "oplog"     (key = `${documentId}:${seq}`) → { key, documentId, seq, op }
//
// All operations run inside IDB transactions; failed writes reject and are
// surfaced to the caller (never swallowed).

export const DB_NAME = "concord-crdt";
export const DB_VERSION = 1;

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
}

export interface LocalState {
    snapshot: Uint8Array | null;
    /** Durable local ops, ordered by sequence. */
    ops: Uint8Array[];
}

export interface PersistenceAdapter {
    loadLocalState(documentId: string): Promise<LocalState>;
    appendOps(documentId: string, ops: Uint8Array[]): Promise<void>;
    saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void>;
    clearDocument(documentId: string): Promise<void>;
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("snapshots")) {
                db.createObjectStore("snapshots", { keyPath: "documentId" });
            }
            if (!db.objectStoreNames.contains("oplog")) {
                const store = db.createObjectStore("oplog", { keyPath: "key" });
                store.createIndex("byDocument", "documentId", { unique: false });
            }
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

    async appendOps(documentId: string, ops: Uint8Array[]): Promise<void> {
        if (ops.length === 0) {
            return;
        }
        const db = await this.db;
        const tx = db.transaction("oplog", "readwrite");
        const store = tx.objectStore("oplog");
        for (const op of ops) {
            const seq = await awaitRequest(store.count() as IDBRequest<number>);
            const key = `${documentId}:${seq}`;
            const record: OpLogRecord = { key, documentId, seq, op };
            store.put(record);
        }
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB append failed"));
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB append aborted"));
        });
    }

    async saveSnapshot(documentId: string, snapshot: Uint8Array): Promise<void> {
        const db = await this.db;
        const tx = db.transaction("snapshots", "readwrite");
        const record: SnapshotRecord = { documentId, snapshot, savedAt: Date.now() };
        tx.objectStore("snapshots").put(record);
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB snapshot failed"));
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB snapshot aborted"));
        });
    }

    async clearDocument(documentId: string): Promise<void> {
        const db = await this.db;
        const tx = db.transaction(["snapshots", "oplog"], "readwrite");
        tx.objectStore("snapshots").delete(documentId);
        const index = tx.objectStore("oplog").index("byDocument");
        const records = (await awaitRequest(
            index.getAll(documentId) as IDBRequest<OpLogRecord[]>,
        )) as OpLogRecord[];
        for (const record of records) {
            tx.objectStore("oplog").delete(record.key);
        }
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB clear failed"));
        });
    }
}
