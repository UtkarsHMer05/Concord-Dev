import { describe, expect, it } from "vitest";

import {
  commentOutboxKey,
  deleteCommentOutboxItem,
  readCommentOutbox,
  removeCommentOutboxItem,
  saveCommentOutboxItem,
  type PendingComment,
} from "@/lib/comments/outbox";

class MemoryStorage {
  private readonly entries = new Map<string, string>();
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
  get length() { return this.entries.size; }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
}

const thread: PendingComment = {
  id: "thread:thread-id",
  kind: "thread",
  threadId: "thread-id",
  messageId: "message-id",
  documentId: "doc-a",
  userId: "user-a",
  anchor: {
    start: { itemId: "7:1", side: "before" },
    end: { itemId: "7:3", side: "after" },
  },
  quote: "selected words",
  body: "Please clarify this.",
  createdAt: "2026-09-25T10:00:00.000Z",
};

describe("offline comment outbox", () => {
  it("keeps a failed item and its retry identity across reloads, then removes it after acknowledgement", () => {
    const storage = new MemoryStorage();
    const failed = { ...thread, error: "Connection failed" };
    saveCommentOutboxItem("doc-a", "user-a", failed, storage);

    const afterReload = readCommentOutbox("doc-a", "user-a", storage);
    expect(afterReload).toEqual([failed]);
    expect(removeCommentOutboxItem(afterReload, thread.id)).toEqual([]);

    deleteCommentOutboxItem("doc-a", "user-a", thread.id, storage);
    expect(readCommentOutbox("doc-a", "user-a", storage)).toEqual([]);
  });

  it("keeps each account and document in a separate browser queue", () => {
    const storage = new MemoryStorage();
    saveCommentOutboxItem("doc-a", "user-a", thread, storage);

    expect(commentOutboxKey("doc-a", "user-a")).not.toBe(commentOutboxKey("doc-a", "user-b"));
    expect(readCommentOutbox("doc-a", "user-b", storage)).toEqual([]);
    expect(readCommentOutbox("doc-b", "user-a", storage)).toEqual([]);
  });

  it("a second tab queuing a comment cannot overwrite the first tab's queued item", () => {
    // Two tabs of the same account share localStorage. Each tab enqueues
    // from its own in-memory view without reading the other's item first —
    // whole-queue writes made the second write drop the first item.
    const storage = new MemoryStorage();
    const secondTabItem: PendingComment = {
      id: "reply:reply-id",
      kind: "reply",
      threadId: "thread-id",
      messageId: "message-id-2",
      documentId: "doc-a",
      userId: "user-a",
      body: "Also this.",
      createdAt: "2026-09-25T10:00:01.000Z",
    };

    saveCommentOutboxItem("doc-a", "user-a", thread, storage); // tab A
    saveCommentOutboxItem("doc-a", "user-a", secondTabItem, storage); // tab B

    expect(readCommentOutbox("doc-a", "user-a", storage)).toEqual([thread, secondTabItem]);
  });

  it("caps the queue at 100 pending items per document and account", () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 100; index += 1) {
      saveCommentOutboxItem("doc-a", "user-a", { ...thread, id: `reply:${index}` }, storage);
    }
    expect(() =>
      saveCommentOutboxItem("doc-a", "user-a", { ...thread, id: "reply:100" }, storage),
    ).toThrow(/limit/);
    // Updating an existing item (retry error state) never trips the cap.
    saveCommentOutboxItem("doc-a", "user-a", { ...thread, id: "reply:0", error: "x" }, storage);
  });

  it("migrates a legacy whole-queue entry into per-item keys on first read", () => {
    const storage = new MemoryStorage();
    storage.setItem(commentOutboxKey("doc-a", "user-a"), JSON.stringify([thread]));

    expect(readCommentOutbox("doc-a", "user-a", storage)).toEqual([thread]);
    expect(storage.getItem(commentOutboxKey("doc-a", "user-a"))).toBeNull();
    expect(readCommentOutbox("doc-a", "user-a", storage)).toEqual([thread]);
  });
});
