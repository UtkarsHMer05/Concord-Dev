// TipTap ⇄ CRDT reconciliation adapter (P2-M038..M040).
//
// Architecture (documented for M038):
//
//   Local PM transaction ──(diff vs CRDT canonical blocks)──▶ CRDT ops ──▶ worker
//   Remote CRDT ops ──(canonical blocks)──▶ PM JSON ──setContent(emitUpdate=false)
//
// Feedback-loop prevention: remote-driven editor updates are applied through
// TipTap's setContent with emitUpdate=false, so onUpdate never fires for
// them; local transactions flow only through onUpdate. There is exactly one
// data-flow direction per update — no transaction can loop.
//
// Reconciliation emits ops in STREAM space (tombstone-inclusive positions):
// deletes use exact per-char stream indices via a visible→stream map
// (tombstone-safe), insert runs use a forward cursor, and every index derived
// from the original stream snapshot is corrected by the running insert shift
// of the batch — so multi-op batches (seeding several blocks into an empty
// replica, mid-document pastes) land exactly where the editor placed them.
// Unsupported content is detected by the pm-model layer and falls
// back to the Phase 1 persistence path — never silently corrupted.
//
// Multi-replica convergence is exercised in the deterministic harness
// (M043): the product UI has one live replica until Phase 3's transport.

import type { CanonicalBlock } from "./pm-model";
import type { ConcordEngine } from "./runtime";

export interface StreamEntryJson {
    r: string; // replica id (decimal string)
    c: number; // counter
    k: "text" | "delim";
    t: boolean; // tombstoned
    s: string; // scalar (text items)
    a: Record<string, string>;
}

export interface ReconcileOp {
    kind: "insertText" | "insertDelimiter" | "delete" | "setAttr";
    /** Stream-space position (tombstone-inclusive). */
    streamIndex: number;
    codepoint?: number;
    blockType?: string;
    name?: string;
    value?: string | null;
}

interface LiveIndex {
    /** live (visible) position → stream index. */
    liveToStream: number[];
    /** stream index → live position (-1 for tombstones). */
    streamToLive: number[];
    /** For each block: the stream index where it starts (null = stream start). */
    blockStarts: (number | null)[];
}

function buildLiveIndex(stream: StreamEntryJson[]): LiveIndex {
    const liveToStream: number[] = [];
    const streamToLive: number[] = [];
    const blockStarts: (number | null)[] = [null]; // block 0 = stream start
    let blockIdx = 0;
    for (let i = 0; i < stream.length; ++i) {
        const entry = stream[i];
        if (entry.t) {
            streamToLive.push(-1);
            continue;
        }
        streamToLive.push(liveToStream.length);
        liveToStream.push(i);
        if (entry.k === "delim") {
            if (blockIdx === 0 && i === 0) {
                // A leading delimiter IS block 0's delimiter (no ghost block).
                blockStarts[0] = 0;
            } else {
                blockIdx += 1;
                blockStarts[blockIdx] = i;
            }
        }
    }
    return { liveToStream, streamToLive, blockStarts };
}

function blockAttrAnchor(live: LiveIndex, blockIdx: number): number {
    // setAttr targets the block's delimiter item; a delimiter-less block 0
    // (no leading delimiter) targets its first live item.
    const start = live.blockStarts[blockIdx];
    if (start !== null && start !== undefined && start < live.streamToLive.length && live.streamToLive[start] >= 0) {
        return start;
    }
    return firstLiveOfBlock(live, blockIdx);
}

function firstLiveOfBlock(live: LiveIndex, blockIdx: number): number {
    // Stream index (tombstone-inclusive space) of the block's first live item.
    const start = live.blockStarts[blockIdx];
    if (start === null || start === undefined) {
        return 0;
    }
    if (start < live.streamToLive.length && live.streamToLive[start] >= 0) {
        return start; // the item at `start` is live — its stream index IS start
    }
    for (let i = start + 1; i < live.streamToLive.length; ++i) {
        if (live.streamToLive[i] >= 0) {
            return i;
        }
    }
    return live.streamToLive.length;
}

/**
 * Stream indices of a block's live (visible) chars, in visible order.
 * The diff works in visible space and must map back onto tombstone-shifted
 * stream positions — visible offset ≠ stream offset once tombstones exist.
 */
function blockLiveStreamIndices(live: LiveIndex, blockIdx: number): number[] {
    const start = live.blockStarts[blockIdx];
    const end = endOfBlock(live, blockIdx);
    const hasLiveDelimiter =
        start !== null &&
        start !== undefined &&
        start < live.streamToLive.length &&
        live.streamToLive[start] >= 0;
    const from = hasLiveDelimiter ? (start as number) + 1 : firstLiveOfBlock(live, blockIdx);
    const to = end === null ? live.streamToLive.length : end;
    const indices: number[] = [];
    for (let i = from; i < to; ++i) {
        if (i >= 0 && i < live.streamToLive.length && live.streamToLive[i] >= 0) {
            indices.push(i);
        }
    }
    return indices;
}

/**
 * Mutable batch state: every item inserted by an earlier op of this batch
 * shifts the stream tail by one — the engine's local insert at index i
 * occupies position i and moves the previous tail right. All indices derived
 * from the ORIGINAL stream snapshot must therefore add `shift`.
 */
interface BatchCtx {
    /** Items inserted by earlier ops of this batch. */
    shift: number;
}

/**
 * Diffs two canonical block sequences and emits CRDT operations that
 * transform the current engine stream into `after`.
 */
export function reconcile(
    before: CanonicalBlock[],
    after: CanonicalBlock[],
    stream: StreamEntryJson[],
): ReconcileOp[] {
    const ops: ReconcileOp[] = [];
    const live = buildLiveIndex(stream);
    const ctx: BatchCtx = { shift: 0 };

    const blockEq = (a: CanonicalBlock, b: CanonicalBlock) =>
        a.type === b.type && a.attrs["type"] === b.attrs["type"];
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && blockEq(before[prefix], after[prefix])) {
        prefix += 1;
    }
    let suffix = 0;
    while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        blockEq(before[before.length - 1 - suffix], after[after.length - 1 - suffix])
    ) {
        suffix += 1;
    }

    // 1. Prefix-matched blocks: reconcile chars + attrs.
    for (let b = 0; b < prefix; ++b) {
        reconcileBlockChars(ops, live, before[b], after[b], b, ctx);
        reconcileBlockAttrs(ops, live, before[b], after[b], b, ctx);
    }

    // 2. Removed middle blocks: delete their items (reverse stream order).
    for (let b = before.length - 1 - suffix; b >= prefix; --b) {
        const start = live.blockStarts[b];
        const end = endOfBlock(live, b);
        const from = start === null || start === undefined ? 0 : start;
        const to = end === null ? live.streamToLive.length : end;
        for (let i = to - 1; i >= from; --i) {
            if (i < live.streamToLive.length && live.streamToLive[i] >= 0) {
                ops.push({ kind: "delete", streamIndex: i + ctx.shift });
            }
        }
    }

    // 3. Added middle blocks: insert delimiter + chars before the suffix
    //    region (or at the stream end when no suffix remains). Consecutive
    //    added blocks chain off the running cursor so they keep their order.
    let insertCursor: number | null = null;
    for (let b = prefix; b < after.length - suffix; ++b) {
        if (insertCursor === null) {
            insertCursor =
                suffix > 0
                    ? firstLiveOfBlock(live, before.length - suffix) + ctx.shift
                    : live.streamToLive.length + ctx.shift;
        }
        insertCursor = insertWholeBlock(ops, after[b], insertCursor, ctx);
    }

    // 4. Suffix-matched blocks: reconcile chars + attrs.
    for (let s = 0; s < suffix; ++s) {
        const beforeIdx = before.length - suffix + s;
        const afterIdx = after.length - suffix + s;
        reconcileBlockChars(ops, live, before[beforeIdx], after[afterIdx], beforeIdx, ctx);
        reconcileBlockAttrs(ops, live, before[beforeIdx], after[afterIdx], beforeIdx, ctx);
    }

    return ops;
}

function reconcileBlockAttrs(
    ops: ReconcileOp[],
    live: LiveIndex,
    beforeBlock: CanonicalBlock,
    afterBlock: CanonicalBlock,
    blockIdx: number,
    ctx: BatchCtx,
): void {
    for (const name of new Set([...Object.keys(beforeBlock.attrs), ...Object.keys(afterBlock.attrs)])) {
        if (name === "type") {
            continue;
        }
        if (beforeBlock.attrs[name] !== afterBlock.attrs[name]) {
            ops.push({
                kind: "setAttr",
                streamIndex: blockAttrAnchor(live, blockIdx) + ctx.shift,
                name,
                value: afterBlock.attrs[name] ?? null,
            });
        }
    }
}

function reconcileBlockChars(
    ops: ReconcileOp[],
    live: LiveIndex,
    beforeBlock: CanonicalBlock,
    afterBlock: CanonicalBlock,
    blockIdx: number,
    ctx: BatchCtx,
): void {
    const bc = beforeBlock.chars;
    const ac = afterBlock.chars;

    // Common prefix/suffix over (scalar, marks).
    let p = 0;
    while (p < bc.length && p < ac.length && charsEqual(bc[p], ac[p])) {
        ++p;
    }
    let s = 0;
    while (
        s < bc.length - p &&
        s < ac.length - p &&
        charsEqual(bc[bc.length - 1 - s], ac[ac.length - 1 - s])
    ) {
        ++s;
    }

    // Exact visible→stream mapping for this block's chars (tombstone-safe).
    const liveIndices = blockLiveStreamIndices(live, blockIdx);
    const start = live.blockStarts[blockIdx];
    const hasLiveDelimiter =
        start !== null &&
        start !== undefined &&
        start < live.streamToLive.length &&
        live.streamToLive[start] >= 0;
    const contentStart = hasLiveDelimiter
        ? (start as number) + 1
        : firstLiveOfBlock(live, blockIdx);

    // Deletes: reverse visible order; tombstones keep stream indices stable,
    // but earlier batch inserts shift them right by ctx.shift.
    for (let c = bc.length - 1 - s; c >= p; --c) {
        if (c < liveIndices.length) {
            ops.push({ kind: "delete", streamIndex: liveIndices[c] + ctx.shift });
        }
        // c beyond the stream's live chars: state drift — nothing to delete.
    }

    // Inserts: forward cursor starting at the current stream position of the
    // first changed char (or the block's content end for pure appends); each
    // inserted char shifts the tail, advancing both cursor and ctx.shift.
    let cursor: number;
    if (p < liveIndices.length) {
        cursor = liveIndices[p] + ctx.shift;
    } else if (liveIndices.length > 0) {
        cursor = liveIndices[liveIndices.length - 1] + 1 + ctx.shift;
    } else {
        cursor = contentStart + ctx.shift;
    }
    for (let c = p; c < ac.length - s; ++c) {
        const ch = ac[c];
        ops.push({
            kind: "insertText",
            streamIndex: cursor,
            codepoint: ch.scalar.codePointAt(0) ?? 0x20,
        });
        for (const [name, value] of Object.entries(ch.marks)) {
            ops.push({ kind: "setAttr", streamIndex: cursor, name, value });
        }
        cursor += 1;
        ctx.shift += 1;
    }
}

function insertWholeBlock(
    ops: ReconcileOp[],
    block: CanonicalBlock,
    cursor: number,
    ctx: BatchCtx,
): number {
    // `cursor` is the CURRENT stream insertion point (already shift-adjusted
    // by the caller): the delimiter goes there, chars follow contiguously.
    // Returns the next block's insertion point (current stream end of the
    // inserted content).
    ops.push({
        kind: "insertDelimiter",
        streamIndex: cursor,
        blockType: block.attrs["type"] ?? "paragraph",
    });
    ctx.shift += 1;
    let charCursor = cursor + 1;
    for (const ch of block.chars) {
        ops.push({
            kind: "insertText",
            streamIndex: charCursor,
            codepoint: ch.scalar.codePointAt(0) ?? 0x20,
        });
        for (const [name, value] of Object.entries(ch.marks)) {
            ops.push({ kind: "setAttr", streamIndex: charCursor, name, value });
        }
        charCursor += 1;
        ctx.shift += 1;
    }
    for (const [name, value] of Object.entries(block.attrs)) {
        if (name !== "type") {
            ops.push({ kind: "setAttr", streamIndex: cursor, name, value });
        }
    }
    return charCursor;
}

function endOfBlock(live: LiveIndex, blockIdx: number): number | null {
    const next = live.blockStarts[blockIdx + 1];
    return next === undefined ? null : next;
}

function charsEqual(
    a: { scalar: string; marks: Record<string, string> },
    b: { scalar: string; marks: Record<string, string> },
): boolean {
    return a.scalar === b.scalar && sameMarks(a.marks, b.marks);
}

function sameMarks(a: Record<string, string>, b: Record<string, string>): boolean {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) {
        return false;
    }
    return ka.every((key) => a[key] === b[key]);
}

/** Applies reconcile ops to the engine in order. */
export function applyReconcileOpsSync(engine: ConcordEngine, ops: ReconcileOp[]): Uint8Array[] {
    const serialized: Uint8Array[] = [];
    for (const op of ops) {
        switch (op.kind) {
            case "insertText":
                serialized.push(engine.localInsertText(op.streamIndex, op.codepoint ?? 0x20));
                break;
            case "insertDelimiter":
                serialized.push(
                    engine.localInsertDelimiter(op.streamIndex, op.blockType ?? "paragraph"),
                );
                break;
            case "delete":
                engine.localDelete(op.streamIndex);
                break;
            case "setAttr":
                serialized.push(
                    engine.localSetAttr(op.streamIndex, op.name ?? "", op.value ?? null),
                );
                break;
        }
    }
    return serialized;
}

export async function applyReconcileOps(
    engine: ConcordEngine,
    ops: ReconcileOp[],
): Promise<Uint8Array[]> {
    return applyReconcileOpsSync(engine, ops);
}
