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
const OUTBOX_VERSION = 2;
const STORE = "outbox";

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
  private constructor(private readonly stores: DbStores, private readonly documentId: string) {}

  static async open(documentId: string): Promise<PendingOpStore> {
    const stores = await openOutbox();
    return new PendingOpStore(stores, documentId);
  }

  private key(id: OpIdentityString): string {
    return `${this.documentId}:${id}`;
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

  /** Records a freshly generated local op as pending (durable immediately). */
  async addPending(id: OpIdentityString, op: Uint8Array): Promise<void> {
    const record: PendingOpRecord = {
      id: `${this.documentId}:${id}` as OpIdentityString,
      op,
      state: "pending",
      seq: nextSequence(),
      savedAt: Date.now(),
    };
    await this.request(this.tx("readwrite").put(record));
  }

  /** All not-yet-acked ops (pending + sent) in stable seq order — the resend set. */
  async unackedOps(): Promise<PendingOpRecord[]> {
    const all = await this.request<PendingOpRecord[]>(this.tx("readonly").getAll());
    return all
      .filter((r) => r.id.startsWith(`${this.documentId}:`) && r.state !== "durably_acked")
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
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
    const store = this.tx("readwrite");
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
  }

  /**
   * Compaction: remove durably-acked records once the server cursor makes
   * them redundant (their content is durable in PostgreSQL). Called after
   * a successful catch-up confirms the cursor moved past them. Never called
   * on un-acked records — those must survive (M032 rule).
   */
  async clearAcked(ids: OpIdentityString[]): Promise<number> {
    if (ids.length === 0) return 0;
    const store = this.tx("readwrite");
    let removed = 0;
    for (const id of ids) {
      const key = this.key(id);
      const record = await this.request<PendingOpRecord | undefined>(store.get(key));
      if (record !== undefined && record.state === "durably_acked") {
        await this.request(store.delete(key));
        removed += 1;
      }
    }
    return removed;
  }

  /** Diagnostics: counts per state. */
  async stateCounts(): Promise<Record<OpSendState, number>> {
    const all = await this.request<PendingOpRecord[]>(this.tx("readonly").getAll());
    const counts: Record<OpSendState, number> = { pending: 0, sent: 0, durably_acked: 0 };
    for (const record of all) {
      if (record.id.startsWith(`${this.documentId}:`)) {
        counts[record.state] += 1;
      }
    }
    return counts;
  }

  close(): void {
    this.stores.db.close();
  }
}
