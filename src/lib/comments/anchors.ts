import type { StreamEntryJson } from "@/lib/crdt/adapter";
import { pmDocToBlocks, type PmNode } from "@/lib/crdt/pm-model";

export interface CrdtAnchorPoint {
  itemId: string;
  side: "before" | "after";
}

export interface CrdtRangeAnchor {
  start: CrdtAnchorPoint;
  end: CrdtAnchorPoint;
}

export type AnchorResolution =
  | { status: "attached"; from: number; to: number }
  | { status: "orphaned" }
  | { status: "unavailable" };

interface TextItemPosition {
  id: string;
  scalar: string;
  from: number;
  to: number;
}

function itemId(entry: StreamEntryJson): string | null {
  if (!/^[1-9][0-9]*$/.test(entry.r) || !/^[1-9][0-9]*$/.test(entry.c)) {
    return null;
  }
  return `${entry.r}:${entry.c}`;
}

function liveTextByBlock(stream: StreamEntryJson[]): StreamEntryJson[][] {
  const blocks: StreamEntryJson[][] = [];
  let current = -1;
  let rootOpen = true;

  for (const entry of stream) {
    if (entry.t) continue;
    if (entry.k === "delim") {
      current = rootOpen ? 0 : current + 1;
      rootOpen = false;
      blocks[current] ??= [];
    } else {
      if (rootOpen) {
        current = 0;
        blocks[current] = [];
        rootOpen = false;
      }
      if (current < 0) current = 0;
      (blocks[current] ??= []).push(entry);
    }
  }
  return blocks;
}

/** Maps supported TipTap text positions to the CRDT's stable item identities. */
function textItemPositions(
  doc: PmNode,
  stream: StreamEntryJson[],
): TextItemPosition[] | null {
  if (!pmDocToBlocks(doc).support.supported) return null;
  const blocks: Array<{ node: PmNode; start: number }> = [];
  const size = (node: PmNode): number => node.type === "text" ? (node.text ?? "").length
    : node.type === "hardBreak" ? 1 : 2 + (node.content ?? []).reduce((sum, child) => sum + size(child), 0);
  const visit = (node: PmNode, start: number) => {
    if (node.type === "paragraph" || node.type === "heading") blocks.push({ node, start });
    else {
      let cursor = node.type === "doc" ? 0 : start + 1;
      for (const child of node.content ?? []) { visit(child, cursor); cursor += size(child); }
    }
  };
  visit(doc, 0);
  const streamBlocks = liveTextByBlock(stream);
  const extra = blocks.length - streamBlocks.length;
  if (extra < 0 || extra > 1) return null;
  // TipTap may append an empty paragraph after a terminal list/heading.
  // The older implicit-root projection may instead prepend one.
  let skipped = 0;
  if (extra === 1) {
    if (!(blocks.at(-1)?.node.content ?? []).length) blocks.pop();
    else if (!(blocks[0]?.node.content ?? []).length) skipped = 1;
    else return null;
  }
  const result: TextItemPosition[] = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const { node, start } = blocks[blockIndex];
    let position = start + 1;
    const expected: Array<{ scalar: string; from: number; to: number }> = [];
    for (const child of node.content ?? []) {
      if (child.type !== "text" && child.type !== "hardBreak") return null;
      for (const scalar of child.type === "hardBreak" ? "\n" : child.text ?? "") {
        expected.push({ scalar, from: position, to: position + scalar.length });
        position += scalar.length;
      }
    }
    const entries = streamBlocks[blockIndex - skipped] ?? [];
    if (entries.length !== expected.length) return null;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const id = itemId(entry);
      if (id === null || entry.s !== expected[i].scalar) return null;
      result.push({ id, ...expected[i] });
    }
  }
  return result;
}

/** Returns stable item IDs for a non-empty editor selection, or null if unsupported. */
export function anchorSelection(
  doc: PmNode,
  stream: StreamEntryJson[],
  from: number,
  to: number,
): CrdtRangeAnchor | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
    return null;
  }
  const items = textItemPositions(doc, stream);
  if (items === null) return null;
  const selected = items.filter((item) => item.from < to && item.to > from);
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  return {
    start: { itemId: first.id, side: "before" },
    end: { itemId: last.id, side: "after" },
  };
}

/** Resolves stored IDs against the current stream; deleted endpoints stay orphaned. */
function resolveFromItems(
  items: TextItemPosition[],
  anchor: CrdtRangeAnchor,
  index?: ReadonlyMap<string, TextItemPosition>,
): AnchorResolution {
  const start = index ? index.get(anchor.start.itemId) : items.find((item) => item.id === anchor.start.itemId);
  const end = index ? index.get(anchor.end.itemId) : items.find((item) => item.id === anchor.end.itemId);
  if (!start || !end) return { status: "orphaned" };
  const from = anchor.start.side === "before" ? start.from : start.to;
  const to = anchor.end.side === "after" ? end.to : end.from;
  if (from >= to) return { status: "orphaned" };
  return {
    status: "attached",
    from,
    to,
  };
}

export function resolveAnchor(
  doc: PmNode,
  stream: StreamEntryJson[],
  anchor: CrdtRangeAnchor,
): AnchorResolution {
  const items = textItemPositions(doc, stream);
  return items === null ? { status: "unavailable" } : resolveFromItems(items, anchor);
}

/** Resolve a visible thread list with one stream traversal, not one per thread. */
export function resolveAnchors(
  doc: PmNode,
  stream: StreamEntryJson[],
  anchors: Array<{ threadId: string; anchor: CrdtRangeAnchor }>,
): Record<string, AnchorResolution> {
  const items = textItemPositions(doc, stream);
  if (items === null) {
    return Object.fromEntries(anchors.map(({ threadId }) => [threadId, { status: "unavailable" as const }]));
  }
  const index = new Map(items.map((item) => [item.id, item]));
  return Object.fromEntries(anchors.map(({ threadId, anchor }) => [
    threadId,
    resolveFromItems(items, anchor, index),
  ]));
}

// ---------------------------------------------------------------------------
// Point anchors (Feature 2, live cursors). A caret is a single position, not
// a range, so it anchors to the CRDT item immediately adjacent to it plus a
// side — the same identity model comments use for range endpoints, so a peer
// caret stays glued to the right character while others edit concurrently.
// ---------------------------------------------------------------------------

export type PointResolution =
  | { status: "attached"; pos: number }
  | { status: "orphaned" }
  | { status: "unavailable" };

/** Anchors a collapsed caret at PM position `pos` to the adjacent text item.
 *  Prefers the item ending exactly at `pos` (caret sits AFTER it) so a caret
 *  typing forward stays welded to the character just typed; falls back to the
 *  item starting at `pos` (BEFORE it). Returns null when no live text item is
 *  adjacent (empty block / unsupported content). */
export function anchorPoint(
  doc: PmNode,
  stream: StreamEntryJson[],
  pos: number,
): CrdtAnchorPoint | null {
  if (!Number.isInteger(pos) || pos < 0) return null;
  const items = textItemPositions(doc, stream);
  if (items === null) return null;
  const after = items.find((item) => item.to === pos);
  if (after) return { itemId: after.id, side: "after" };
  const before = items.find((item) => item.from === pos);
  if (before) return { itemId: before.id, side: "before" };
  return null;
}

function resolvePointFromItems(
  point: CrdtAnchorPoint,
  index: ReadonlyMap<string, TextItemPosition>,
): PointResolution {
  const item = index.get(point.itemId);
  if (!item) return { status: "orphaned" };
  return { status: "attached", pos: point.side === "before" ? item.from : item.to };
}

/** Resolves many caret points in ONE stream traversal (peer cursors). */
export function resolvePointAnchors(
  doc: PmNode,
  stream: StreamEntryJson[],
  points: Array<{ key: string; point: CrdtAnchorPoint }>,
): Record<string, PointResolution> {
  const items = textItemPositions(doc, stream);
  if (items === null) {
    return Object.fromEntries(points.map(({ key }) => [key, { status: "unavailable" as const }]));
  }
  const index = new Map(items.map((item) => [item.id, item]));
  return Object.fromEntries(
    points.map(({ key, point }) => [key, resolvePointFromItems(point, index)]),
  );
}
