"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  loadLocalDrafts,
  mergeSelectedDraftChanges,
  MAX_LOCAL_DRAFTS,
  planDraftMerge,
  readTipTapDocument,
  saveLocalDrafts,
  type DraftMergeProposal,
  type LocalDraft,
} from "@/lib/drafts";

export interface DraftsPanelProps {
  documentId: string;
  /** Local drafts are private to this signed-in account and browser profile. */
  userId: string | null;
  currentContent: unknown;
  currentContentVersion: number;
  canEdit: boolean;
  /**
   * Consumer applies this TipTap JSON through the live editor/CRDT transaction
   * path. This panel never writes the transitional whole-document save API.
   */
  onApply: (proposal: DraftMergeProposal) => void | Promise<void>;
}

function cloneDocument(value: unknown) {
  const doc = readTipTapDocument(value);
  return doc ? JSON.parse(JSON.stringify(doc)) as typeof doc : null;
}

function plainEditableText(block: Record<string, unknown>): string | null {
  if (block.type !== "paragraph" && block.type !== "heading") return null;
  if (!Array.isArray(block.content)) return block.content === undefined ? "" : null;
  let result = "";
  for (const node of block.content) {
    if (
      typeof node !== "object" || node === null || Array.isArray(node) ||
      (node as Record<string, unknown>).type !== "text" ||
      typeof (node as Record<string, unknown>).text !== "string" ||
      "marks" in node
    ) {
      return null;
    }
    result += (node as { text: string }).text;
  }
  return result;
}

function blockPreview(blocks: Record<string, unknown>[]): string {
  if (blocks.length === 0) return "(deleted / empty)";
  return blocks.map((block) => {
    const text = plainEditableText(block);
    return text ?? JSON.stringify(block);
  }).join("\n\n");
}

export function DraftsPanel({
  documentId,
  userId,
  currentContent,
  currentContentVersion,
  canEdit,
  onApply,
}: DraftsPanelProps) {
  const [drafts, setDrafts] = useState<LocalDraft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [selectedChangeIds, setSelectedChangeIds] = useState<string[]>([]);
  const [newDraftName, setNewDraftName] = useState("");
  const [storageStatus, setStorageStatus] = useState("Loading local drafts…");
  const [applyStatus, setApplyStatus] = useState("");
  const [applying, setApplying] = useState(false);
  const draftsRef = useRef<LocalDraft[]>([]);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      draftsRef.current = [];
      dirtyRef.current = false;
      setDrafts([]);
      setSelectedDraftId(null);
      setSelectedChangeIds([]);
      if (!userId) {
        setStorageStatus("Sign in to use browser-local drafts.");
        return;
      }
      try {
        const stored = loadLocalDrafts(documentId, userId, window.localStorage);
        draftsRef.current = stored;
        setDrafts(stored);
        setSelectedDraftId(stored[0]?.id ?? null);
        setStorageStatus("Drafts are stored on this device.");
      } catch {
        setStorageStatus("Browser storage is unavailable; draft changes will not survive reload.");
      }
    });
    return () => { active = false; };
  }, [documentId, userId]);

  const flushDrafts = (snapshot = draftsRef.current) => {
    if (!userId || !dirtyRef.current) return;
    try {
      saveLocalDrafts(documentId, userId, snapshot, window.localStorage);
      dirtyRef.current = false;
      setStorageStatus("Saved on this device.");
    } catch {
      setStorageStatus("Could not save draft changes on this device.");
    }
  };

  useEffect(() => {
    const flush = () => flushDrafts();
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
    // A document/account switch flushes the old scoped key before loading the new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, userId]);

  const replaceDrafts = (next: LocalDraft[], persistNow = false) => {
    draftsRef.current = next;
    dirtyRef.current = true;
    setDrafts(next);
    setStorageStatus("Draft changes are waiting to be saved on this device.");
    if (persistNow) flushDrafts(next);
  };

  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? null;
  const plan = useMemo(() => {
    if (!selectedDraft || !readTipTapDocument(currentContent)) return null;
    try {
      return planDraftMerge(selectedDraft, currentContent, currentContentVersion);
    } catch {
      return null;
    }
  }, [currentContent, currentContentVersion, selectedDraft]);

  const createDraft = () => {
    const baseContent = cloneDocument(currentContent);
    if (draftsRef.current.length >= MAX_LOCAL_DRAFTS) {
      setStorageStatus(`This document already has ${MAX_LOCAL_DRAFTS} local drafts. Delete one to make room.`);
      return;
    }
    if (!baseContent || !userId) {
      setStorageStatus("A valid TipTap document and signed-in account are required.");
      return;
    }
    const now = new Date().toISOString();
    const draft: LocalDraft = {
      id: crypto.randomUUID(),
      documentId,
      name: newDraftName.trim() || "Untitled draft",
      createdAt: now,
      updatedAt: now,
      baseContentVersion: currentContentVersion,
      baseContent,
      content: cloneDocument(baseContent)!,
    };
    replaceDrafts([draft, ...draftsRef.current], true);
    setSelectedDraftId(draft.id);
    setSelectedChangeIds([]);
    setNewDraftName("");
    setApplyStatus("");
  };

  const updateDraft = (id: string, update: (draft: LocalDraft) => LocalDraft) => {
    replaceDrafts(draftsRef.current.map((draft) => draft.id === id ? update(draft) : draft));
    setSelectedChangeIds([]);
  };

  const updateName = (draft: LocalDraft, name: string) => {
    updateDraft(draft.id, (value) => ({ ...value, name, updatedAt: new Date().toISOString() }));
  };

  const updateBlock = (draft: LocalDraft, index: number, text: string) => {
    const content = draft.content.content.slice();
    const block = content[index];
    content[index] = {
      ...block,
      content: text === "" ? [] : [{ type: "text", text }],
    };
    updateDraft(draft.id, (value) => ({
      ...value,
      content: { ...value.content, content },
      updatedAt: new Date().toISOString(),
    }));
  };

  const addParagraph = (draft: LocalDraft) => {
    updateDraft(draft.id, (value) => ({
      ...value,
      content: {
        ...value.content,
        content: [...value.content.content, { type: "paragraph" }],
      },
      updatedAt: new Date().toISOString(),
    }));
    flushDrafts(draftsRef.current);
  };

  const deleteDraft = (draft: LocalDraft) => {
    const next = draftsRef.current.filter((value) => value.id !== draft.id);
    replaceDrafts(next, true);
    if (selectedDraftId === draft.id) setSelectedDraftId(next[0]?.id ?? null);
    setSelectedChangeIds([]);
  };

  const toggleChange = (id: string, checked: boolean) => {
    setSelectedChangeIds((current) =>
      checked ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    );
  };

  const applySelected = async () => {
    if (!selectedDraft || !plan || !canEdit || selectedChangeIds.length === 0) return;
    setApplying(true);
    setApplyStatus("");
    try {
      const proposal = mergeSelectedDraftChanges(
        selectedDraft,
        currentContent,
        currentContentVersion,
        selectedChangeIds,
      );
      await onApply(proposal);
      setApplyStatus("Sent to the editor. Check the document save status for durability.");
      setSelectedChangeIds([]);
    } catch (error) {
      setApplyStatus(error instanceof Error ? error.message : "Could not apply selected blocks.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <section aria-label="Parallel drafts" className="rounded-md border bg-background p-4">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Parallel drafts</h2>
          <p className="text-sm text-muted-foreground">{storageStatus}</p>
        </div>
        <div className="flex gap-2">
          <Input
            aria-label="New draft name"
            className="w-44"
            disabled={!canEdit || !userId || drafts.length >= MAX_LOCAL_DRAFTS}
            maxLength={120}
            onChange={(event) => setNewDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") createDraft();
            }}
            placeholder="Draft name"
            value={newDraftName}
          />
          <Button disabled={!canEdit || !userId || drafts.length >= MAX_LOCAL_DRAFTS} onClick={createDraft} size="sm" type="button" variant="outline">
            New draft
          </Button>
        </div>
      </header>

      {!canEdit && (
        <p className="mb-3 rounded border px-3 py-2 text-sm" role="status">
          Drafts are read-only for your current document role.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Draft list" className="space-y-1">
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No local drafts yet.</p>
          ) : drafts.map((draft) => (
            <button
              aria-current={selectedDraftId === draft.id ? "true" : undefined}
              className="block w-full rounded px-2 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted"
              key={draft.id}
              onClick={() => {
                setSelectedDraftId(draft.id);
                setSelectedChangeIds([]);
              }}
              type="button"
            >
              <span className="block truncate font-medium">{draft.name || "Untitled draft"}</span>
              <span className="text-xs text-muted-foreground">
                Base version {draft.baseContentVersion}
              </span>
            </button>
          ))}
        </nav>

        {selectedDraft && plan ? (
          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="sr-only" htmlFor="selected-draft-name">Draft name</label>
              <Input
                disabled={!canEdit}
                id="selected-draft-name"
                onBlur={() => flushDrafts()}
                onChange={(event) => updateName(selectedDraft, event.target.value)}
                value={selectedDraft.name}
              />
              <Button disabled={!canEdit} onClick={() => deleteDraft(selectedDraft)} size="sm" type="button" variant="outline">
                Delete draft
              </Button>
            </div>

            <div className="rounded border p-3 text-sm" role="status">
              {plan.stale
                ? "Main document changed since version " + selectedDraft.baseContentVersion + ". Unchanged blocks can merge; overlapping changes are blocked."
                : "Draft is based on current content version " + currentContentVersion + "."}
              <span className="ml-2 text-muted-foreground">Current version: {currentContentVersion}</span>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-medium">Draft blocks</h3>
                <Button disabled={!canEdit} onClick={() => addParagraph(selectedDraft)} size="sm" type="button" variant="outline">
                  Add paragraph
                </Button>
              </div>
              <ol className="space-y-2">
                {selectedDraft.content.content.map((block, index) => {
                  const editableText = plainEditableText(block);
                  return (
                    <li className="flex items-start gap-2" key={index}>
                      {editableText === null ? (
                        <pre className="min-w-0 flex-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                          {JSON.stringify(block, null, 2)}
                          {"\n"}Read-only here; rich or structured blocks are preserved unchanged.
                        </pre>
                      ) : (
                        <>
                          <label className="sr-only" htmlFor={"draft-block-" + index}>
                            Draft block {index + 1} text
                          </label>
                          <Input
                            disabled={!canEdit}
                            id={"draft-block-" + index}
                            onBlur={() => flushDrafts()}
                            onChange={(event) => updateBlock(selectedDraft, index, event.target.value)}
                            value={editableText}
                          />
                        </>
                      )}
                      <Button
                        aria-label={"Delete draft block " + (index + 1)}
                        disabled={!canEdit}
                        onClick={() => {
                          const content = selectedDraft.content.content.filter((_, blockIndex) => blockIndex !== index);
                          updateDraft(selectedDraft.id, (value) => ({
                            ...value,
                            content: { ...value.content, content },
                            updatedAt: new Date().toISOString(),
                          }));
                          flushDrafts(draftsRef.current);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Delete
                      </Button>
                    </li>
                  );
                })}
              </ol>
              <p className="mt-2 text-xs text-muted-foreground">
                This prototype edits plain paragraph and heading text. Rich text and structured blocks stay intact and read-only.
              </p>
            </div>

            <div className="space-y-3">
              <h3 className="font-medium">Compare and select changes</h3>
              {plan.changes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No draft changes to merge.</p>
              ) : plan.changes.map((change) => {
                const comparisons = [
                  { label: "Base", blocks: change.baseBlocks },
                  { label: "Current main", blocks: change.currentBlocks },
                  { label: "Draft", blocks: change.replacement },
                ];
                return (
                  <fieldset className="rounded border p-3" key={change.id}>
                    <legend className="px-1 text-sm font-medium">
                      {change.conflict
                        ? "Conflict — same blocks changed in main"
                        : change.alreadyApplied ? "Already present in main" : "Draft change"}
                      {" · "}block {change.start + 1}
                    </legend>
                    <label className="mb-2 flex items-center gap-2 text-sm">
                      <input
                        checked={selectedChangeIds.includes(change.id)}
                        disabled={!canEdit || change.conflict || change.alreadyApplied}
                        onChange={(event) => toggleChange(change.id, event.target.checked)}
                        type="checkbox"
                      />
                      Include this block change
                    </label>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {comparisons.map(({ label, blocks }) => (
                        <details className="min-w-0 rounded bg-muted/50 p-2 text-xs" key={label}>
                          <summary className="cursor-pointer font-medium">{label}</summary>
                          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                            {blockPreview(blocks)}
                          </pre>
                        </details>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={!canEdit || applying || selectedChangeIds.length === 0}
                onClick={() => void applySelected()}
                type="button"
              >
                {applying ? "Applying…" : "Apply selected to editor"}
              </Button>
              {applyStatus ? <p className="text-sm" role="status">{applyStatus}</p> : null}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a draft or create one from the current editor content.
          </p>
        )}
      </div>
    </section>
  );
}
