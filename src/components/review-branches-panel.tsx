"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditorStore } from "@/store/use-editor-store";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import {
  reviewRequest, ReviewRequestError, pendingMergeRequests, saveMergeRequest, clearMergeRequest,
  type ReviewBranch, type BranchComparison, type ReviewMergeRequest, type MergeRecord,
} from "@/lib/review-branches";

interface BranchList { branches: ReviewBranch[]; sourceBranch: ReviewBranch | null }
interface Revision { revisionId: string; label: string; kind: string }
const endpoint = (id: string) => `/api/gateway/documents/${id}/branches`;

export function ReviewBranchBanner({ documentId }: { documentId: string }) {
  const { getToken } = useAuth(); const [branch, setBranch] = useState<ReviewBranch | null>(null);
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL) return;
    let active = true;
    void reviewRequest<BranchList>(endpoint(documentId), getToken).then((data) => { if (active) setBranch(data.sourceBranch); }, () => {});
    return () => { active = false; };
  }, [documentId, getToken]);
  return branch && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background px-3 py-2 text-sm" aria-label="Review branch information">
    <GitBranch className="size-4" aria-hidden="true" /><span className="font-medium">Review branch: {branch.name}</span>
    <Link href={`/documents/${branch.mainDocumentId}`} className="underline underline-offset-4">Open main document</Link>
    <span className="text-muted-foreground">Based on saved version at sequence {branch.baseSeq}</span>
  </div>;
}

export function ReviewBranchesPanel({ documentId, canCreate, client, syncNow, renderPreview }: {
  documentId: string; canCreate: boolean; client: CrdtClient | null; syncNow: () => void;
  renderPreview: (content: unknown) => ReactNode;
}) {
  const { getToken, userId } = useAuth();
  const flush = useEditorStore((state) => state.flushEditorBridge);
  const [list, setList] = useState<BranchList | null>(null); const [revisions, setRevisions] = useState<Revision[]>([]);
  const [name, setName] = useState(""); const [base, setBase] = useState("");
  const [comparison, setComparison] = useState<BranchComparison | null>(null);
  const [choices, setChoices] = useState<Record<string, "apply" | "branch">>({});
  const [pending, setPending] = useState<ReviewMergeRequest[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const creation = useRef<{ branchId: string; baseRevisionId: string; name: string } | null>(null);
  const activeBranch = useRef<ReviewBranch | null>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error || notice) feedback.current?.focus();
  }, [error, notice]);

  const loadPending = useCallback((branch: ReviewBranch) => {
    if (!userId) return [];
    const requests = pendingMergeRequests(window.localStorage, userId, branch.mainDocumentId, branch.documentId);
    setPending(requests); return requests;
  }, [userId]);
  const refresh = useCallback(async () => {
    if (!process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL) { setError("Shared reviews need the sync gateway. Your local drafts remain available in Drafts."); return; }
    try {
      const data = await reviewRequest<BranchList>(endpoint(documentId), getToken); setList(data); setError("");
      if (!data.sourceBranch && canCreate) {
        const history = await reviewRequest<{ revisions: Revision[] }>(`/api/gateway/documents/${documentId}/revisions?limit=100`, getToken);
        const named = history.revisions.filter((r) => r.kind === "named"); setRevisions(named); setBase((old) => old || named[0]?.revisionId || "");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load review branches."); }
  }, [documentId, getToken, canCreate]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  const verifyLocal = async (data: BranchComparison) => {
    if (!client || !flush) throw new Error("Wait for the editor to load before reviewing durable changes.");
    await flush(); syncNow();
    const expected = documentId === data.branch.documentId ? data.branchDigest : data.mainDigest;
    if (await client.digest() !== expected) throw new Error("This editor has changes that are still syncing. Reconnect, wait for Saved, then refresh the comparison.");
  };
  const compare = async (branch: ReviewBranch, verify = true) => {
    setBusy(true); setError(""); setChoices({}); setComparison(null); activeBranch.current = branch;
    try {
      const saved = loadPending(branch);
      const data = await reviewRequest<BranchComparison>(`${endpoint(branch.mainDocumentId)}/${branch.documentId}`, getToken);
      setComparison(data);
      if (verify && !saved.length) await verifyLocal(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not compare this branch."); }
    finally { setBusy(false); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); if (!base || !name.trim()) return;
    setBusy(true); setError(""); setNotice("");
    if (!creation.current || creation.current.name !== name.trim() || creation.current.baseRevisionId !== base) {
      creation.current = { branchId: crypto.randomUUID(), baseRevisionId: base, name: name.trim() };
    }
    try {
      const branch = await reviewRequest<ReviewBranch>(endpoint(documentId), getToken, { method: "POST", body: JSON.stringify(creation.current) });
      creation.current = null; setName(""); await refresh();
      setNotice(`“${branch.name}” created from a durable saved version. Open it to edit and invite reviewers.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Branch creation failed. Retry with the same name and base version."); }
    finally { setBusy(false); }
  };
  const merge = async (retry?: ReviewMergeRequest) => {
    const branch = activeBranch.current;
    if (!branch || !userId || (!comparison && !retry)) return;
    setBusy(true); setError(""); setNotice("");
    let request: ReviewMergeRequest | undefined;
    try {
      const saved = loadPending(branch);
      request = retry ?? saved[0];
      if (!request && comparison) {
        await verifyLocal(comparison);
        request = { requestId: crypto.randomUUID(), expectedMainSeq: comparison.mainSeq, expectedBranchSeq: comparison.branchSeq,
          selections: comparison.changes.filter((c) => choices[c.id]).map((c) => ({ id: c.id, resolution: choices[c.id] })) };
        // Storage failure prevents sending a request that cannot be recovered.
        saveMergeRequest(window.localStorage, userId, branch.mainDocumentId, branch.documentId, request);
      }
      if (!request) return;
      const outcome = await reviewRequest<{ merge: MergeRecord; duplicate: boolean; appliedOps: number }>(
        `${endpoint(branch.mainDocumentId)}/${branch.documentId}/merge`, getToken, { method: "POST", body: JSON.stringify(request) });
      if (!outcome.merge || outcome.merge.mergeId !== request.requestId || typeof outcome.merge.resultSeq !== "string" ||
          !outcome.merge.sourceRevisionId || !outcome.merge.resultRevisionId) {
        throw new Error("The merge response is incomplete. Retry the saved request to recover its result.");
      }
      clearMergeRequest(window.localStorage, userId, branch.mainDocumentId, branch.documentId, request.requestId);
      loadPending(branch); syncNow();
      setNotice(`Merge ${outcome.duplicate ? "recovered" : "committed"} at sequence ${outcome.merge.resultSeq}. The source and resulting revisions are recorded together with the edits.`);
      // Committed edits can still be reaching this editor over WebSocket.
      // Every new merge verifies the local digest again before sending.
      await compare(branch, false);
    } catch (cause) {
      if (request && cause instanceof ReviewRequestError && ["review_is_stale", "resolve_conflict_explicitly", "invalid_request"].includes(cause.code)) {
        clearMergeRequest(window.localStorage, userId, branch.mainDocumentId, branch.documentId, request.requestId);
      }
      try { loadPending(branch); } catch { /* Keep the original storage error visible. */ }
      setError(cause instanceof Error ? cause.message : "Merge response unavailable. Retry the saved request after reconnecting.");
    } finally { setBusy(false); }
  };
  const count = Object.keys(choices).length;
  return <section aria-label="Shared review branches" className="space-y-5">
    <div><h3 className="font-semibold">Review branches</h3><p className="mt-1 text-sm text-muted-foreground">Revise a saved version separately, invite review, and choose which changes join main.</p></div>
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => {
      if (comparison) { setComparison(null); setChoices({}); setPending([]); } else void refresh();
    }}>{comparison ? "Back to branches" : "Refresh branches"}</Button>
    {(error || notice) && <div ref={feedback} tabIndex={-1} className="space-y-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </div>}
    {!comparison && (list?.sourceBranch ? <div className="space-y-3 border-b pb-4">
      <p className="text-sm">You are editing <strong>{list.sourceBranch.name}</strong>. Main stays separate while you work, including offline.</p>
      <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={() => void compare(list.sourceBranch!)}>Compare with main</Button>
        <Button asChild variant="outline"><Link href={`/documents/${list.sourceBranch.mainDocumentId}`}>Open main</Link></Button></div>
      <p className="text-xs text-muted-foreground">Invite reviewers in Share. Add anchored feedback in Comments on this branch.</p>
      <p className="text-xs text-muted-foreground">Comparing with main also requires access there. Its owner can grant that separately in Share.</p>
    </div> : list && <>
      {canCreate && <form onSubmit={(event) => void create(event)} className="space-y-3 border-b pb-4">
        <label htmlFor="review-branch-name" className="text-sm font-medium">Branch name</label>
        <Input id="review-branch-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="For example: RFC storage proposal" required maxLength={120} />
        <label htmlFor="review-base-revision" className="block text-sm font-medium">Base saved version</label>
        <select id="review-base-revision" value={base} onChange={(event) => setBase(event.target.value)} className="h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required>
          <option value="">Choose a named version</option>{revisions.map((revision) => <option key={revision.revisionId} value={revision.revisionId}>{revision.label}</option>)}
        </select>
        {!revisions.length && <p className="text-sm text-muted-foreground">Save a named checkpoint in History, then refresh branches to choose it.</p>}
        <Button type="submit" disabled={busy || !base || !name.trim()}>{busy ? "Creating branch…" : "Create review branch"}</Button>
      </form>}
      {list.branches.length ? <ul className="divide-y">{list.branches.map((branch) => <li key={branch.documentId} className="space-y-2 py-3">
        <p className="font-medium">{branch.name}</p><p className="text-xs text-muted-foreground">Base sequence {branch.baseSeq}</p>
        <div className="flex flex-wrap gap-2"><Button asChild variant="outline" size="sm"><Link href={`/documents/${branch.documentId}`}>Open branch</Link></Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void compare(branch)}>Compare and merge</Button></div>
      </li>)}</ul> : <p className="text-sm text-muted-foreground">No shared branches available to you yet.</p>}
    </>)}
    {pending.length > 0 && <div className="space-y-2 rounded-md border p-3" role="status">
      <p className="text-sm">{pending.length} interrupted merge request{pending.length === 1 ? " is" : "s are"} saved on this device. Recover it before starting another merge.</p>
      <Button type="button" disabled={busy} onClick={() => void merge(pending[0])}>Retry saved merge</Button>
    </div>}
    {comparison && <div className="space-y-4 border-t pt-4">
      <div><h4 className="font-semibold">{comparison.branch.name} compared with main</h4>
        <p className="mt-1 text-xs text-muted-foreground">Main sequence {comparison.mainSeq}; branch sequence {comparison.branchSeq}. Only server-confirmed edits are included.</p></div>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void compare(comparison.branch)}>Refresh comparison</Button>
      {comparison.changes.length === 0 && <p className="text-sm text-muted-foreground">This branch has no changes from its base version.</p>}
      {comparison.changes.map((change, index) => <article key={change.id} className="space-y-3 border-t py-4" aria-label={`Review change ${index + 1}`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold">Change {index + 1}</h5>
          <span className="text-xs font-medium">{change.alreadyApplied ? "Already in main" : change.conflict ? "Conflict: both versions changed" : "Ready to merge"}</span></div>
        <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Original base</summary><div className="mt-2 break-words">{change.base.length ? renderPreview({ blocks: change.base }) : <p>Empty</p>}</div></details>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 break-words"><p className="mb-2 text-xs font-medium text-muted-foreground">Current main</p>{change.current.length ? renderPreview({ blocks: change.current }) : <p className="text-sm italic text-muted-foreground">Removed</p>}</div>
          <div className="min-w-0 break-words"><p className="mb-2 text-xs font-medium text-muted-foreground">Proposed branch</p>{change.proposed.length ? renderPreview({ blocks: change.proposed }) : <p className="text-sm italic text-muted-foreground">Removed</p>}</div>
        </div>
        {!change.alreadyApplied && comparison.canMerge && (change.conflict ? <div>
          <label htmlFor={`resolution-${change.id}`} className="text-sm font-medium">Resolve change {index + 1}</label>
          <select id={`resolution-${change.id}`} value={choices[change.id] ?? "keep"} disabled={busy || pending.length > 0} className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => setChoices((old) => { const next = { ...old }; if (event.target.value === "branch") next[change.id] = "branch"; else delete next[change.id]; return next; })}>
            <option value="keep">Keep main</option><option value="branch">Use branch: replace the shown main change</option>
          </select>
        </div> : <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(choices[change.id])} disabled={busy || pending.length > 0} className="size-4 accent-primary" onChange={(event) => setChoices((old) => { const next = { ...old }; if (event.target.checked) next[change.id] = "apply"; else delete next[change.id]; return next; })} />Include change {index + 1}</label>)}
      </article>)}
      {comparison.canMerge ? <Button type="button" disabled={busy || count === 0 || pending.length > 0} onClick={() => void merge()}>{busy ? "Merging…" : `Merge selected changes (${count})`}</Button> : <p className="text-sm text-muted-foreground">You can review this branch. A main document editor must merge the changes.</p>}
      {comparison.merges.length > 0 && <details className="border-t pt-4"><summary className="cursor-pointer text-sm font-semibold">Merge provenance ({comparison.merges.length})</summary><ul className="mt-2 space-y-3">{comparison.merges.map((record) => <li key={record.mergeId} className="break-words text-xs">
        <p>Result sequence {record.resultSeq}</p><p className="text-muted-foreground">Merge {record.mergeId}</p><p className="text-muted-foreground">Source revision {record.sourceRevisionId}</p><p className="text-muted-foreground">Result revision {record.resultRevisionId}</p>
      </li>)}</ul></details>}
    </div>}
    {!list && !error && <p role="status" className="text-sm text-muted-foreground">Loading branches…</p>}
  </section>;
}
