import { describe, expect, it } from "vitest";

import { anchorPoint, resolvePointAnchors } from "@/lib/comments/anchors";
import type { StreamEntryJson } from "@/lib/crdt/adapter";
import type { PmNode } from "@/lib/crdt/pm-model";

const doc = (text: string): PmNode => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const REPLICA = "18446744073709551614";
const item = (counter: string, scalar: string, tombstoned = false): StreamEntryJson => ({
  r: REPLICA,
  c: counter,
  k: "text",
  t: tombstoned,
  s: scalar,
  a: {},
});

describe("CRDT presence point anchors (Feature 2)", () => {
  it("anchors a caret to the item it sits after, and resolves back to the same position", () => {
    const stream = [item("1", "A"), item("2", "B"), item("3", "C")];
    // Caret between A and B (pos 2): prefers the item ENDING there.
    const point = anchorPoint(doc("ABC"), stream, 2);
    expect(point).toEqual({ itemId: `${REPLICA}:1`, side: "after" });

    const resolved = resolvePointAnchors(doc("ABC"), stream, [{ key: "peer", point: point! }]);
    expect(resolved.peer).toEqual({ status: "attached", pos: 2 });
  });

  it("anchors the document-start caret before the first item", () => {
    const stream = [item("1", "A"), item("2", "B")];
    expect(anchorPoint(doc("AB"), stream, 1)).toEqual({ itemId: `${REPLICA}:1`, side: "before" });
    expect(anchorPoint(doc("AB"), stream, 3)).toEqual({ itemId: `${REPLICA}:2`, side: "after" });
  });

  it("stays glued to its character when text is inserted before it", () => {
    const original = [item("1", "A"), item("2", "B"), item("3", "C")];
    const point = anchorPoint(doc("ABC"), original, 2)!; // after 'A'

    const afterInsert = [item("4", "X"), ...original];
    const resolved = resolvePointAnchors(doc("XABC"), afterInsert, [{ key: "peer", point }]);
    // 'A' moved to positions 2..3, so the caret after it is now pos 3.
    expect(resolved.peer).toEqual({ status: "attached", pos: 3 });
  });

  it("anchors on a fresh document whose leading block is empty (canonical root-drop)", () => {
    // A blank document: the editor renders [empty paragraph, typed text]
    // after the first Enter, but the canonical view drops the empty ROOT
    // block. The typing side's caret must still anchor (regression for the
    // live finding: presence/comment anchoring was unavailable on any doc
    // with an empty first block).
    const stream = [item("1", "P", false), item("2", "Q", false)];
    const doc: PmNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "PQ" }] },
      ],
    };
    // Positions: the empty block occupies 0..1, so 'P' spans 3..4, 'Q' 4..5.
    expect(anchorPoint(doc, stream, 4)).toEqual({ itemId: `${REPLICA}:1`, side: "after" });
    expect(anchorPoint(doc, stream, 3)).toEqual({ itemId: `${REPLICA}:1`, side: "before" });
    expect(anchorPoint(doc, stream, 5)).toEqual({ itemId: `${REPLICA}:2`, side: "after" });
    // A LEADING block with content can never be the dropped root: that is
    // genuine drift and must stay unavailable.
    const drift: PmNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "X" }] },
        { type: "paragraph", content: [{ type: "text", text: "PQ" }] },
      ],
    };
    expect(anchorPoint(drift, stream, 3)).toBeNull();
  });

  it("orphans a caret whose item was deleted and flags an unsupported document", () => {
    const deleted = [item("1", "A"), item("2", "B", true)];
    const point = { itemId: `${REPLICA}:2`, side: "after" as const };
    expect(resolvePointAnchors(doc("A"), deleted, [{ key: "p", point }]).p).toEqual({
      status: "orphaned",
    });
    expect(
      resolvePointAnchors({ type: "doc", content: [{ type: "image" }] }, deleted, [
        { key: "p", point },
      ]).p,
    ).toEqual({ status: "unavailable" });
  });
});
