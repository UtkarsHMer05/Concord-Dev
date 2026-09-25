import { describe, expect, it } from "vitest";

import {
  anchorSelection,
  resolveAnchor,
  resolveAnchors,
  type CrdtRangeAnchor,
} from "@/lib/comments/anchors";
import type { StreamEntryJson } from "@/lib/crdt/adapter";
import type { PmNode } from "@/lib/crdt/pm-model";

const doc = (text: string): PmNode => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const item = (counter: string, scalar: string, tombstoned = false): StreamEntryJson => ({
  r: "18446744073709551614",
  c: counter,
  k: "text",
  t: tombstoned,
  s: scalar,
  a: {},
});

describe("CRDT comment anchors", () => {
  it("keeps a selection on the same item IDs after inserts before it and across reloads", () => {
    const original = [item("1", "A"), item("2", "B"), item("3", "C")];
    const anchor = anchorSelection(doc("ABC"), original, 2, 3)!;
    expect(anchor.start.itemId).toBe("18446744073709551614:2");
    expect(anchor.end.itemId).toBe(anchor.start.itemId);

    const afterReconnect = [item("4", "X"), ...original];
    expect(resolveAnchor(doc("XABC"), afterReconnect, anchor)).toEqual({
      status: "attached",
      from: 3,
      to: 4,
    });
  });

  it("leaves a deleted passage orphaned instead of moving it to nearby text", () => {
    const anchor: CrdtRangeAnchor = {
      start: { itemId: "7:2", side: "before" },
      end: { itemId: "7:3", side: "after" },
    };
    const stream = [item("1", "X"), item("2", "B", true), item("3", "C", true)];
    expect(resolveAnchor(doc("X"), stream, anchor)).toEqual({ status: "orphaned" });
  });

  it("rejects reversed or zero-width persisted ranges", () => {
    const stream = [item("1", "A"), item("2", "B")];
    expect(resolveAnchor(doc("AB"), stream, {
      start: { itemId: "18446744073709551614:2", side: "after" },
      end: { itemId: "18446744073709551614:1", side: "before" },
    })).toEqual({ status: "orphaned" });
    expect(resolveAnchor(doc("AB"), stream, {
      start: { itemId: "18446744073709551614:1", side: "after" },
      end: { itemId: "18446744073709551614:1", side: "before" },
    })).toEqual({ status: "orphaned" });
  });

  it("reports an unsupported current document as unavailable", () => {
    const stream = [item("1", "A")];
    expect(resolveAnchor({ type: "doc", content: [{ type: "image" }] }, stream, {
      start: { itemId: "18446744073709551614:1", side: "before" },
      end: { itemId: "18446744073709551614:1", side: "after" },
    })).toEqual({ status: "unavailable" });
  });

  it("resolves a thread batch against one current document state", () => {
    const stream = [item("1", "A"), item("2", "B"), item("3", "C")];
    const result = resolveAnchors(doc("ABC"), stream, [
      { threadId: "first", anchor: { start: { itemId: "18446744073709551614:1", side: "before" }, end: { itemId: "18446744073709551614:1", side: "after" } } },
      { threadId: "last", anchor: { start: { itemId: "18446744073709551614:3", side: "before" }, end: { itemId: "18446744073709551614:3", side: "after" } } },
    ]);
    expect(result).toEqual({
      first: { status: "attached", from: 1, to: 2 },
      last: { status: "attached", from: 3, to: 4 },
    });
  });

  it("maps UTF-16 editor positions onto Unicode scalar IDs", () => {
    const stream = [item("1", "😀"), item("2", "a")];
    const anchor = anchorSelection(doc("😀a"), stream, 1, 2);
    expect(anchor).toEqual({
      start: { itemId: "18446744073709551614:1", side: "before" },
      end: { itemId: "18446744073709551614:1", side: "after" },
    });
  });
});
