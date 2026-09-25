/** Local parallel drafts and conservative top-level TipTap block merging. */

export type DraftBlock = Record<string, unknown>;

export interface TipTapDocument extends Record<string, unknown> {
  type: "doc";
  content: DraftBlock[];
}

export interface LocalDraft {
  id: string;
  documentId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  baseContentVersion: number;
  baseContent: TipTapDocument;
  content: TipTapDocument;
}

interface BlockHunk {
  start: number;
  end: number;
  replacement: DraftBlock[];
}

export interface DraftMergeChange extends BlockHunk {
  id: string;
  baseBlocks: DraftBlock[];
  currentBlocks: DraftBlock[];
  conflict: boolean;
  alreadyApplied: boolean;
}

export interface DraftMergePlan {
  stale: boolean;
  changes: DraftMergeChange[];
}

export interface DraftMergeProposal {
  draftId: string;
  baseContentVersion: number;
  observedContentVersion: number;
  selectedChangeIds: string[];
  content: TipTapDocument;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const MAX_LOCAL_DRAFTS = 20;
const MAX_DRAFT_STORAGE_BYTES = 2 * 1024 * 1024;

export function readTipTapDocument(value: unknown): TipTapDocument | null {
  if (!isRecord(value) || value.type !== "doc" || !Array.isArray(value.content)) {
    return null;
  }
  if (!value.content.every(isRecord)) return null;
  return value as TipTapDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (isRecord(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "undefined";
}

function equal(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function signatureCounts(blocks: DraftBlock[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    const signature = stableJson(block);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

/**
 * Uses unique unchanged blocks as anchors. Repeated/ambiguous blocks collapse
 * into a larger hunk, which can cause a safe conflict but cannot misattach an
 * edit. This is O(n log n) time and O(n) memory; richer duplicate matching can
 * be added if real draft workloads show excessive conservative conflicts.
 */
function diffBlocks(base: DraftBlock[], changed: DraftBlock[]): BlockHunk[] {
  if (equal(base, changed)) return [];
  const baseCounts = signatureCounts(base);
  const changedCounts = signatureCounts(changed);
  const changedIndexes = new Map<string, number>();
  changed.forEach((block, index) => {
    const signature = stableJson(block);
    if (changedCounts.get(signature) === 1) changedIndexes.set(signature, index);
  });

  const candidates: Array<{ base: number; changed: number }> = [];
  base.forEach((block, index) => {
    const signature = stableJson(block);
    const changedIndex = changedIndexes.get(signature);
    if (baseCounts.get(signature) === 1 && changedIndex !== undefined) {
      candidates.push({ base: index, changed: changedIndex });
    }
  });

  // Longest increasing subsequence of changed indexes provides ordered anchors.
  const tails: number[] = [];
  const tailCandidates: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  candidates.forEach((candidate, candidateIndex) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (tails[mid] < candidate.changed) low = mid + 1;
      else high = mid;
    }
    tails[low] = candidate.changed;
    previous[candidateIndex] = low > 0 ? tailCandidates[low - 1] : -1;
    tailCandidates[low] = candidateIndex;
  });

  const anchors: Array<{ base: number; changed: number }> = [];
  let cursor = tailCandidates[tails.length - 1] ?? -1;
  while (cursor >= 0) {
    anchors.push(candidates[cursor]);
    cursor = previous[cursor];
  }
  anchors.reverse();

  const hunks: BlockHunk[] = [];
  let baseCursor = 0;
  let changedCursor = 0;
  for (const anchor of anchors) {
    if (baseCursor < anchor.base || changedCursor < anchor.changed) {
      hunks.push({
        start: baseCursor,
        end: anchor.base,
        replacement: changed.slice(changedCursor, anchor.changed),
      });
    }
    baseCursor = anchor.base + 1;
    changedCursor = anchor.changed + 1;
  }
  if (baseCursor < base.length || changedCursor < changed.length) {
    hunks.push({ start: baseCursor, end: base.length, replacement: changed.slice(changedCursor) });
  }
  return hunks;
}

function sameHunk(left: BlockHunk, right: BlockHunk): boolean {
  return left.start === right.start && left.end === right.end && equal(left.replacement, right.replacement);
}

function overlaps(left: BlockHunk, right: BlockHunk): boolean {
  const leftInsert = left.start === left.end;
  const rightInsert = right.start === right.end;
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) return left.start >= right.start && left.start <= right.end;
  if (rightInsert) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

export function planDraftMerge(
  draft: LocalDraft,
  currentContentValue: unknown,
  currentContentVersion: number,
): DraftMergePlan {
  const currentContent = readTipTapDocument(currentContentValue);
  if (!currentContent) throw new Error("Current content is not a TipTap document");

  const draftHunks = diffBlocks(draft.baseContent.content, draft.content.content);
  const currentHunks = diffBlocks(draft.baseContent.content, currentContent.content);
  const changes = draftHunks.map((hunk, index): DraftMergeChange => {
    const overlapping = currentHunks.filter((current) => overlaps(hunk, current));
    const alreadyApplied = overlapping.length === 1 && sameHunk(hunk, overlapping[0]);
    const before = currentHunks.filter((current) => current.end <= hunk.start);
    const currentStart = hunk.start + before.reduce(
      (shift, current) => shift + current.replacement.length - (current.end - current.start),
      0,
    );
    const currentBlocks = overlapping.length
      ? overlapping.flatMap((current) => current.replacement)
      : currentContent.content.slice(currentStart, currentStart + (hunk.end - hunk.start));
    return {
      ...hunk,
      id: "change-" + index,
      baseBlocks: draft.baseContent.content.slice(hunk.start, hunk.end),
      currentBlocks,
      conflict: overlapping.length > 0 && !alreadyApplied,
      alreadyApplied,
    };
  });

  return {
    stale: currentContentVersion !== draft.baseContentVersion || !equal(currentContent.content, draft.baseContent.content),
    changes,
  };
}

export function mergeSelectedDraftChanges(
  draft: LocalDraft,
  currentContentValue: unknown,
  currentContentVersion: number,
  selectedChangeIds: string[],
): DraftMergeProposal {
  const currentContent = readTipTapDocument(currentContentValue);
  if (!currentContent) throw new Error("Current content is not a TipTap document");
  if (new Set(selectedChangeIds).size !== selectedChangeIds.length) {
    throw new Error("A draft change may only be selected once");
  }
  const plan = planDraftMerge(draft, currentContent, currentContentVersion);
  const selected = selectedChangeIds.map((id) => plan.changes.find((change) => change.id === id));
  if (selected.some((change) => !change || change.conflict || change.alreadyApplied)) {
    throw new Error("Selected draft changes are missing, conflicting, or already present");
  }

  const mainHunks = diffBlocks(draft.baseContent.content, currentContent.content);
  const blocks = currentContent.content.slice();
  let selectedShift = 0;
  const orderedChanges = (selected as DraftMergeChange[]).slice().sort((left, right) => left.start - right.start);
  for (const change of orderedChanges) {
    const precedingMain = mainHunks
      .filter((main) => main.end <= change.start)
      .reduce((shift, main) => shift + main.replacement.length - (main.end - main.start), 0);
    const start = change.start + precedingMain + selectedShift;
    blocks.splice(start, change.end - change.start, ...change.replacement);
    selectedShift += change.replacement.length - (change.end - change.start);
  }

  return {
    draftId: draft.id,
    baseContentVersion: draft.baseContentVersion,
    observedContentVersion: currentContentVersion,
    selectedChangeIds: orderedChanges.map((change) => change.id),
    content: { ...currentContent, content: blocks },
  };
}

function draftStorageKey(documentId: string, userId: string): string {
  return "concord.drafts.v1." + encodeURIComponent(userId) + "." + encodeURIComponent(documentId);
}

function isLocalDraft(value: unknown, documentId: string): value is LocalDraft {
  if (!isRecord(value)) return false;
  return value.documentId === documentId && typeof value.id === "string" &&
    typeof value.name === "string" && typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" && typeof value.baseContentVersion === "number" &&
    readTipTapDocument(value.baseContent) !== null && readTipTapDocument(value.content) !== null;
}

export function loadLocalDrafts(documentId: string, userId: string, storage: DraftStorage): LocalDraft[] {
  const raw = storage.getItem(draftStorageKey(documentId, userId));
  if (!raw) return [];
  if (new TextEncoder().encode(raw).byteLength > MAX_DRAFT_STORAGE_BYTES) {
    throw new Error("Saved drafts exceed the 2 MiB local storage limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const drafts = parsed.filter((item): item is LocalDraft => isLocalDraft(item, documentId));
  if (drafts.length > MAX_LOCAL_DRAFTS) throw new Error("Saved drafts exceed the 20 draft limit");
  return drafts;
}

export function saveLocalDrafts(
  documentId: string,
  userId: string,
  drafts: LocalDraft[],
  storage: DraftStorage,
): void {
  if (drafts.length > MAX_LOCAL_DRAFTS) throw new Error("Local drafts exceed the 20 draft limit");
  if (drafts.some((draft) => draft.documentId !== documentId)) throw new Error("Local draft document scope mismatch");
  const serialized = JSON.stringify(drafts);
  if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_STORAGE_BYTES) {
    throw new Error("Drafts exceed the 2 MiB local storage limit");
  }
  storage.setItem(draftStorageKey(documentId, userId), serialized);
}
