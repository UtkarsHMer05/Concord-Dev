import type { CrdtRangeAnchor } from "./anchors";

export type PendingComment = {
  id: string;
  documentId: string;
  userId: string;
  createdAt: string;
  error?: string;
} & (
  | {
      kind: "thread";
      threadId: string;
      messageId: string;
      anchor: CrdtRangeAnchor;
      quote: string;
      body: string;
    }
  | { kind: "reply"; threadId: string; messageId: string; body: string }
);

/**
 * One storage key per pending item, not one key for the whole queue: two
 * tabs of the same account share localStorage, and a whole-queue writer
 * would let either tab silently drop the other tab's queued-but-unsaved
 * comments. Per-item writes are additively concurrent; removals are keyed
 * by the item id, so a stale view can only fail to find its own item.
 */
export type OutboxStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

const MAX_OUTBOX_ITEMS = 100;

/** Legacy whole-queue key from the pre-per-item build; migrated on read. */
function legacyQueueKey(documentId: string, userId: string): string {
  return `concord.comments.v1.${encodeURIComponent(userId)}.${encodeURIComponent(documentId)}`;
}

function itemKeyPrefix(documentId: string, userId: string): string {
  return `${legacyQueueKey(documentId, userId)}.outbox.`;
}

function itemKey(documentId: string, userId: string, id: string): string {
  return `${itemKeyPrefix(documentId, userId)}${encodeURIComponent(id)}`;
}

/** The queue's scope boundary; kept as the exported scope-isolation contract. */
export function commentOutboxKey(documentId: string, userId: string): string {
  return legacyQueueKey(documentId, userId);
}

function isPendingComment(value: unknown, documentId: string, userId: string): value is PendingComment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<PendingComment>;
  if (
    item.documentId !== documentId || item.userId !== userId ||
    typeof item.id !== "string" || typeof item.threadId !== "string" ||
    typeof item.messageId !== "string" || typeof item.body !== "string" ||
    typeof item.createdAt !== "string" ||
    (item.error !== undefined && typeof item.error !== "string")
  ) return false;
  if (item.kind === "reply") return true;
  if (item.kind !== "thread" || typeof item.quote !== "string" || typeof item.anchor !== "object" || item.anchor === null) {
    return false;
  }
  return true;
}

function parseItem(raw: string | null, documentId: string, userId: string): PendingComment | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPendingComment(parsed, documentId, userId) ? parsed : null;
  } catch {
    return null;
  }
}

function byCreatedAtThenId(left: PendingComment, right: PendingComment): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function eachKey(store: OutboxStorage, visit: (key: string) => void): void {
  // Snapshot the key list first: a concurrent writer may mutate storage
  // (Web Storage semantics make `key(i)` unstable under mutation).
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null) keys.push(key);
  }
  keys.forEach(visit);
}

export function readCommentOutbox(
  documentId: string,
  userId: string,
  storage?: OutboxStorage,
): PendingComment[] {
  const store = storage ?? window.localStorage;
  const items = new Map<string, PendingComment>();
  try {
    const prefix = itemKeyPrefix(documentId, userId);
    eachKey(store, (key) => {
      if (!key.startsWith(prefix)) return;
      const item = parseItem(store.getItem(key), documentId, userId);
      if (item) items.set(item.id, item);
    });

    // Migrate a legacy whole-queue entry written by an older build so a
    // queued comment survives the upgrade; unreadable entries are dropped.
    const legacyRaw = store.getItem(legacyQueueKey(documentId, userId));
    if (legacyRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(legacyRaw);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (isPendingComment(entry, documentId, userId) && !items.has(entry.id)) {
              items.set(entry.id, entry);
              store.setItem(itemKey(documentId, userId, entry.id), JSON.stringify(entry));
            }
          }
        }
      } catch {
        // Unreadable legacy payload: nothing salvageable.
      }
      store.removeItem(legacyQueueKey(documentId, userId));
    }
  } catch {
    return [];
  }
  return [...items.values()].sort(byCreatedAtThenId).slice(-MAX_OUTBOX_ITEMS);
}

/** Writes exactly one item's key; safe to call from concurrent tabs. */
export function saveCommentOutboxItem(
  documentId: string,
  userId: string,
  item: PendingComment,
  storage?: OutboxStorage,
): void {
  const store = storage ?? window.localStorage;
  if (!isPendingComment(item, documentId, userId)) {
    throw new Error("Comment outbox scope or shape mismatch");
  }
  const key = itemKey(documentId, userId, item.id);
  let isNew = false;
  try {
    isNew = store.getItem(key) === null;
  } catch {
    throw new Error("Comment outbox storage is unavailable");
  }
  if (isNew && countCommentOutboxItems(documentId, userId, store) >= MAX_OUTBOX_ITEMS) {
    throw new Error("Comment outbox limit exceeded (100 pending per document)");
  }
  store.setItem(key, JSON.stringify(item));
}

export function deleteCommentOutboxItem(
  documentId: string,
  userId: string,
  id: string,
  storage?: OutboxStorage,
): void {
  (storage ?? window.localStorage).removeItem(itemKey(documentId, userId, id));
}

function countCommentOutboxItems(
  documentId: string,
  userId: string,
  store: OutboxStorage,
): number {
  let count = 0;
  const prefix = itemKeyPrefix(documentId, userId);
  eachKey(store, (key) => {
    if (key.startsWith(prefix)) count += 1;
  });
  return count;
}

/** Pure in-memory removal for UI state; pair with deleteCommentOutboxItem. */
export function removeCommentOutboxItem(
  items: PendingComment[],
  id: string,
): PendingComment[] {
  return items.filter((item) => item.id !== id);
}
