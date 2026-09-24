/**
 * Local pending-operation outbox with durable ACK tracking (P3-M032).
 *
 * Extends the Phase 2 IndexedDB durability with per-operation send states:
 *   pending → sent → durably_acked
 *
 * Rules (Phase 3 prompt M032):
 * - unacknowledged operations survive reload (IndexedDB);
 * - retries reuse the SAME stable operation identity (Phase 2 canonical
 *   bytes are the identity — never regenerated);
 * - durable ACKs update local persistence;
 * - metadata needed for safe reconnect is never prematurely deleted.
 *
 * The store is deliberately independent of the transport: SyncSession
 * drives it (send window + resend on READY).
 */

import type { OpIdentityString } from "./identities";
import { clearCoveredOpIds, readCoveredOpIds, replicaStorageId } from "@/lib/crdt/worker/idb";

export type OpSendState = "pending" | "sent" | "durably_acked";

export interface PendingOpRecord {
  /** Stable operation identity ("replica:counter"). */
  id: OpIdentityString;
  /** Canonical Phase 2 operation bytes (verbatim, identity-stable). */
  op: Uint8Array;
  state: OpSendState;
  /** Monotonic local sequence for stable ordering. */
  seq: number;
  savedAt: number;
}

interface DbStores {
  db: IDBDatabase;
}

const OUTBOX_DB = "concord-sync";
const OUTBOX_VERSION = 3;
const STORE = "outbox";
const META = "meta";

function legacyOutboxRange(state: OpSendState, documentId: string): IDBKeyRange {
  // Legacy IDs were `${documentId}:${replica}:${counter}` with a decimal
  // replica. User-scoped records start `${documentId}:user:...`; bounding
  // the first post-document segment to decimal digits excludes them.
  const prefix = `${documentId}:`;
  return IDBKeyRange.bound([state, `${prefix}1`], [state, `${prefix}9\uffff`]);
}

// Date.now() is useful for preserving a mostly chronological resend order,
// but it is not unique: a single fast typing burst can generate several ops
// in one millisecond, and separate tabs can share the same clock value.
// Sequence is an ordering hint, not an identity, so ties are legal and are
// resolved by the stable operation id in unackedOps().
let lastIssuedSequence = 0;

function nextSequence(): number {
  const now = Date.now();
  lastIssuedSequence = Math.max(now, lastIssuedSequence + 1);
  return lastIssuedSequence;
}

function openOutbox(): Promise<DbStores> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DB, OUTBOX_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("state", "state", { unique: false });
        store.createIndex("seq", "seq", { unique: false });
      } else {
        // Version 1 incorrectly made the timestamp ordering hint unique.
        // Rebuild that index during the versioned upgrade so existing
        // browsers are repaired without deleting the durable outbox.
        const store = request.transaction!.objectStore(STORE);
        if (store.indexNames.contains("seq")) {
          store.deleteIndex("seq");
        }
        store.createIndex("seq", "seq", { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "documentId" });
      }
      const outbox = request.transaction!.objectStore(STORE);
      if (!outbox.indexNames.contains("stateId")) {
        outbox.createIndex("stateId", ["state", "id"], { unique: false });
      }
    };
    request.onsuccess = () => resolve({ db: request.result });
    request.onerror = () => reject(request.error ?? new Error("outbox open failed"));
  });
}

/**
 * Durable outbox for one document (records are namespaced per document via
 * id prefix "docId:replica:counter" so one DB serves all documents).
 */
export class PendingOpStore {
  private constructor(private readonly stores: DbStores, private readonly storageId: string) {}

  static async open(documentId: string, userId?: string | null): Promise<PendingOpStore> {
    const stores = await openOutbox();
    return new PendingOpStore(stores, replicaStorageId(documentId, userId));
  }

  static async hasLegacyUnacked(documentId: string): Promise<boolean> {
    const { db } = await openOutbox();
    try {
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index("stateId");
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("outbox read failed"));
        tx.onabort = () => reject(tx.error ?? new Error("outbox read aborted"));
      });
      const count = (request: IDBRequest<number>) => new Promise<number>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("outbox count failed"));
      });
      const [[pending, sent]] = await Promise.all([
        Promise.all([
          count(index.count(legacyOutboxRange("pending", documentId))),
          count(index.count(legacyOutboxRange("sent", documentId))),
        ]),
        done,
      ]);
      return pending + sent > 0;
    } finally {
      db.close();
    }
  }

  private key(id: OpIdentityString): string {
    return `${this.storageId}:${id}`;
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.stores.db.transaction(STORE, mode).objectStore(STORE);
  }

  private request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("outbox request failed"));
    });
  }

  private completed(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("outbox transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("outbox transaction aborted"));
    });
  }

  private async write<T>(
    stores: string | string[],
    operation: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const tx = this.stores.db.transaction(stores, "readwrite");
    const done = this.completed(tx);
    try {
      const result = await operation(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // It may already have completed or aborted.
      }
      await done.catch(() => {});
      throw error;
    }
  }

  /** Last own op copied from the worker log into this outbox. */
  async lastSeenCounter(): Promise<string> {
    const tx = this.stores.db.transaction(META, "readonly");
    const row = await this.request<{ documentId: string; counter: string } | undefined>(
      tx.objectStore(META).get(this.storageId),
    );
    return row?.counter ?? "0";
  }

  /** Records a freshly generated local op as pending (durable immediately). */
  async addPending(id: OpIdentityString, op: Uint8Array): Promise<void> {
    const record: PendingOpRecord = {
      id: `${this.storageId}:${id}` as OpIdentityString,
      op,
      state: "pending",
      seq: nextSequence(),
      savedAt: Date.now(),
    };
    await this.write([STORE, META], async (tx) => {
      const outbox = tx.objectStore(STORE);
      const existing = await this.request<PendingOpRecord | undefined>(outbox.get(record.id));
      if (existing === undefined) {
        outbox.put(record);
      }
      const meta = tx.objectStore(META);
      const seen = await this.request<{ documentId: string; counter: string } | undefined>(
        meta.get(this.storageId),
      );
      const counter = id.split(":").at(-1) ?? "0";
      if (BigInt(counter) > BigInt(seen?.counter ?? "0")) {
        meta.put({ documentId: this.storageId, counter });
      }
    });
  }

  /** All not-yet-acked ops (pending + sent) in stable seq order — the resend set. */
  async unackedOps(): Promise<PendingOpRecord[]> {
    const index = this.tx("readonly").index("stateId");
    const prefix = `${this.storageId}:`;
    const [pending, sent] = await Promise.all(
      (["pending", "sent"] as const).map((state) =>
        this.request<PendingOpRecord[]>(index.getAll(IDBKeyRange.bound(
          [state, prefix], [state, `${prefix}\uffff`],
        ))),
      ),
    );
    return [...pending, ...sent]
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  }

  async ackedIds(): Promise<OpIdentityString[]> {
    const prefix = `${this.storageId}:`;
    const records = await this.request<PendingOpRecord[]>(
      this.tx("readonly").index("stateId").getAll(IDBKeyRange.bound(
        ["durably_acked", prefix], ["durably_acked", `${prefix}\uffff`],
      )),
    );
    return records.map((record) => record.id.slice(prefix.length));
  }

  /** Marks ops as sent (still durable; a crash before ACK resends them). */
  async markSent(ids: OpIdentityString[]): Promise<void> {
    await this.transition(ids, "sent");
  }

  /** Durable ACK received: transition to durably_acked (kept for safe
   * reconnect bookkeeping, compacted by clearAcked below). */
  async markDurablyAcked(ids: OpIdentityString[]): Promise<void> {
    await this.transition(ids, "durably_acked");
  }

  private async transition(ids: OpIdentityString[], state: OpSendState): Promise<void> {
    if (ids.length === 0) return;
    await this.write(STORE, async (tx) => {
      const store = tx.objectStore(STORE);
      await Promise.all(
        ids.map(async (id) => {
          const key = this.key(id);
          const record = await this.request<PendingOpRecord | undefined>(store.get(key));
          if (record !== undefined && record.state !== "durably_acked") {
            record.state = state;
            await this.request(store.put(record));
          }
        }),
      );
    });
  }

  /**
   * Compaction: remove a durable ACK only when the CRDT database records
   * that exact op in a catch-up batch at or before its durable cursor.
   * Uncovered ACKs and all un-acked records remain available across reloads.
   */
    async clearAcked(ids: OpIdentityString[]): Promise<number> {
        if (ids.length === 0) return 0;
        const covered = await readCoveredOpIds(this.storageId, ids);
        if (covered.size === 0) return 0;
        const removedIds = await this.write(STORE, async (tx) => {
            const store = tx.objectStore(STORE);
            const removed: OpIdentityString[] = [];
            for (const id of ids) {
                if (!covered.has(id)) continue;
                const key = this.key(id);
                const record = await this.request<PendingOpRecord | undefined>(store.get(key));
                if (record !== undefined && record.state === "durably_acked") {
                    await this.request(store.delete(key));
                    removed.push(id);
                }
            }
            return removed;
        });
        // The outbox row is already safely removed. Pruning is a bounded
        // cleanup on the existing oplog rows, and can be retried harmlessly.
        await clearCoveredOpIds(this.storageId, removedIds);
        return removedIds.length;
    }

  /** Diagnostics: counts per state. */
  async stateCounts(): Promise<Record<OpSendState, number>> {
    const tx = this.stores.db.transaction(STORE, "readonly");
    const index = tx.objectStore(STORE).index("stateId");
    const prefix = `${this.storageId}:`;
    const done = this.completed(tx);
    const [values] = await Promise.all([
      Promise.all([
        this.request<number>(index.count(IDBKeyRange.bound(["pending", prefix], ["pending", `${prefix}\uffff`]))),
        this.request<number>(index.count(IDBKeyRange.bound(["sent", prefix], ["sent", `${prefix}\uffff`]))),
        this.request<number>(index.count(IDBKeyRange.bound(["durably_acked", prefix], ["durably_acked", `${prefix}\uffff`]))),
      ]),
      done,
    ]);
    return { pending: values[0], sent: values[1], durably_acked: values[2] };
  }

  close(): void {
    this.stores.db.close();
  }
}
