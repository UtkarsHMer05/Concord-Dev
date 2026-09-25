import { describe, expect, it } from "vitest";

import {
  loadLocalDrafts,
  mergeSelectedDraftChanges,
  planDraftMerge,
  saveLocalDrafts,
  type LocalDraft,
  type TipTapDocument,
} from "../src/lib/drafts";

const block = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...texts: string[]): TipTapDocument => ({ type: "doc", content: texts.map(block) });

function draft(base: TipTapDocument, content: TipTapDocument): LocalDraft {
  return {
    id: "draft-1",
    documentId: "doc-1",
    name: "Try another wording",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    baseContentVersion: 4,
    baseContent: base,
    content,
  };
}

describe("parallel draft block merge", () => {
  it("merges selected non-overlapping blocks into a stale main document", () => {
    const saved = draft(doc("A", "B", "C", "D"), doc("A", "B from draft", "C", "D"));
    const current = doc("A", "B", "C from main", "D");
    const plan = planDraftMerge(saved, current, 5);

    expect(plan.stale).toBe(true);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].conflict).toBe(false);
    expect(plan.changes[0].baseBlocks).toEqual([block("B")]);
    expect(plan.changes[0].currentBlocks).toEqual([block("B")]);

    const proposal = mergeSelectedDraftChanges(saved, current, 5, ["change-0"]);
    expect(proposal.content).toEqual(doc("A", "B from draft", "C from main", "D"));
    expect(proposal.baseContentVersion).toBe(4);
    expect(proposal.observedContentVersion).toBe(5);
  });

  it("blocks a draft change when the main document changed the same block", () => {
    const saved = draft(doc("A", "B", "C"), doc("A", "draft B", "C"));
    const current = doc("A", "main B", "C");
    const plan = planDraftMerge(saved, current, 5);

    expect(plan.changes[0].conflict).toBe(true);
    expect(plan.changes[0].currentBlocks).toEqual([block("main B")]);
    expect(() => mergeSelectedDraftChanges(saved, current, 5, ["change-0"])).toThrow(/conflicting/);
  });

  it("maps an insertion around a concurrent insertion before its anchor", () => {
    const saved = draft(doc("A", "B", "C"), doc("A", "Draft insert", "B", "C"));
    const current = doc("Main insert", "A", "B", "C");
    const proposal = mergeSelectedDraftChanges(saved, current, 5, ["change-0"]);

    expect(proposal.content).toEqual(doc("Main insert", "A", "Draft insert", "B", "C"));
  });

  it("applies multiple selected hunks after an independent main deletion", () => {
    const saved = draft(
      doc("A", "B", "C", "D", "E"),
      doc("A", "draft B", "C", "draft D", "E"),
    );
    const current = doc("B", "main C", "D", "E");
    const plan = planDraftMerge(saved, current, 5);
    expect(plan.changes.map((change) => change.conflict)).toEqual([false, false]);

    const proposal = mergeSelectedDraftChanges(
      saved,
      current,
      5,
      plan.changes.map((change) => change.id).reverse(),
    );
    expect(proposal.content).toEqual(doc("draft B", "main C", "draft D", "E"));
  });

  it("flags competing insertions at the same base position", () => {
    const saved = draft(doc("A", "B"), doc("A", "draft insert", "B"));
    const current = doc("A", "main insert", "B");
    expect(planDraftMerge(saved, current, 5).changes[0].conflict).toBe(true);
  });

  it("rejects duplicate selected change IDs", () => {
    const saved = draft(doc("A", "B"), doc("A", "draft B"));
    expect(() => mergeSelectedDraftChanges(saved, saved.baseContent, 4, ["change-0", "change-0"]))
      .toThrow(/only be selected once/);
  });

  it("recognizes a draft change that is already present in main", () => {
    const saved = draft(doc("A", "B", "C"), doc("A", "draft B", "C"));
    const current = doc("A", "draft B", "C");
    const plan = planDraftMerge(saved, current, 5);

    expect(plan.changes[0].alreadyApplied).toBe(true);
    expect(plan.changes[0].conflict).toBe(false);
    expect(() => mergeSelectedDraftChanges(saved, current, 5, ["change-0"])).toThrow(/already present/);
  });

  it("treats a deletion versus an edit as a conflict", () => {
    const saved = draft(doc("A", "B", "C"), doc("A", "C"));
    const current = doc("A", "edited B", "C");
    expect(planDraftMerge(saved, current, 5).changes[0].conflict).toBe(true);
  });
});

describe("browser-local draft storage", () => {
  it("isolates account and document keys and ignores malformed records", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const saved = draft(doc("A"), doc("B"));

    saveLocalDrafts("doc-1", "user/1", [saved], storage);
    expect(loadLocalDrafts("doc-1", "user/1", storage)).toEqual([saved]);
    expect(loadLocalDrafts("doc-1", "user-2", storage)).toEqual([]);
    expect(loadLocalDrafts("doc-2", "user/1", storage)).toEqual([]);

    values.set("concord.drafts.v1.user%2F1.doc-1", "{broken");
    expect(loadLocalDrafts("doc-1", "user/1", storage)).toEqual([]);
  });

  it("bounds local draft count and storage bytes", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const saved = draft(doc("A"), doc("B"));
    expect(() => saveLocalDrafts("doc-1", "user/1", Array(21).fill(saved), storage))
      .toThrow(/20 draft limit/);
    expect(() => saveLocalDrafts("doc-1", "user/1", [draft(doc("x".repeat(2 * 1024 * 1024)), doc("B"))], storage))
      .toThrow(/2 MiB/);
  });
});
