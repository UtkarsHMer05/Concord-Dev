"use client";

import { useAuth } from "@clerk/nextjs";
import { FileText, History, Lightbulb, MessageSquareText, PackageOpen, GitBranch, Rewind, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ElementType, type FormEvent, type ReactNode } from "react";
import type { Editor as TipTapEditor } from "@tiptap/react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CommentsPanel, type CommentSelection } from "@/components/comments-panel";
import { SuggestionsPanel } from "@/components/suggestions-panel";
import { DraftsPanel } from "@/components/drafts-panel";
import { anchorSelection, resolveAnchors as resolveAnchorSet, type CrdtRangeAnchor } from "@/lib/comments/anchors";
import { loadBrowserCrdtFactory } from "@/lib/crdt/browser-factory";
import { blocksToPmDoc, SUPPORTED_MARKS, type CanonicalBlock, type PmNode } from "@/lib/crdt/pm-model";
import { exportMarkdown, importMarkdown } from "@/lib/markdown";
import {
  exportConcordPack,
  MAX_CONCORDPACK_BYTES,
  previewConcordPack,
} from "@/lib/crdt/concordpack";
import {
  verifyAgainstGateway,
  type ProofDocument,
  type ProofVerification,
} from "@/lib/crdt/proofs";
import { DocumentReplay, type ReplayState } from "@/lib/crdt/replay";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import type { DocumentDetailDto } from "@/server/services/documents";
import { useEditorStore } from "@/store/use-editor-store";
import { useSyncStatusStore } from "@/store/use-sync-status-store";

type ToolTab = "history" | "comments" | "drafts" | "bundle" | "replay" | "markdown" | "suggestions";

interface DocumentToolsProps {
  document: DocumentDetailDto;
  crdtClient: CrdtClient | null;
  syncNow: () => void;
}

interface Revision {
  revisionId: string;
  kind: "named" | "auto_checkpoint" | "restore_event";
  label: string | null;
  targetSeq: number;
  createdBy: string | null;
  createdAtMs: number;
}

interface VisibleBlock {
  type: string;
  attrs?: Record<string, string>;
  runs?: Array<{ t: string; m?: Record<string, string> }>;
}

interface RevisionPreview {
  revisionId: string;
  boundary: number;
  stateDigest: string;
  visibleContent: { blocks: VisibleBlock[] };
}

interface PackPreview {
  digest: string;
  visibleContent: unknown;
}

async function gatewayRequest<T>(
  url: string,
  getToken: () => Promise<string | null>,
  init?: RequestInit,
): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Your session expired. Sign in again.");
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    const message = response.status === 401 ? "Your session expired. Sign in again."
      : response.status === 404 ? "This revision is unavailable or you do not have access."
        : response.status === 429 ? "History is being requested too quickly. Wait a minute, then retry."
          : response.status >= 500 ? "History is temporarily unavailable. Check the connection and retry."
            : body?.error ?? `History request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function previewBlock(block: VisibleBlock, index: number) {
  const heading = /^heading-([1-6])$/.exec(block.type);
  const Tag: ElementType = heading ? (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[Number(heading[1]) - 1] : "p";
  const content = (block.runs ?? []).map((run, runIndex) => {
    let node: ReactNode = run.t;
    if (run.m?.bold === "1") node = <strong key={`b${runIndex}`}>{node}</strong>;
    if (run.m?.italic === "1") node = <em key={`i${runIndex}`}>{node}</em>;
    if (run.m?.underline === "1") node = <u key={`u${runIndex}`}>{node}</u>;
    return <span key={runIndex}>{node}</span>;
  });
  return <Tag key={index} className={heading ? "my-3 text-lg font-semibold" : "my-2 whitespace-pre-wrap"}>{content.length ? content : <br />}</Tag>;
}

function documentPreview(content: unknown) {
  if (typeof content !== "object" || content === null || !("blocks" in content) || !Array.isArray(content.blocks)) {
    return <p className="text-sm text-muted-foreground">No visible content.</p>;
  }
  const blocks = content.blocks as VisibleBlock[];
  if (blocks.length === 0) return <p className="text-sm text-muted-foreground">Empty document.</p>;
  return <div className="prose prose-sm max-w-none">{blocks.map(previewBlock)}</div>;
}

function asEditorDocument(content: unknown): PmNode | null {
  if (typeof content !== "object" || content === null || !("blocks" in content) || !Array.isArray(content.blocks)) return null;
  const blocks: CanonicalBlock[] = [];
  for (const value of content.blocks) {
    if (typeof value !== "object" || value === null) return null;
    const block = value as VisibleBlock;
    if (block.type !== "paragraph" && !/^heading-[1-6]$/.test(block.type)) return null;
    const attrs = block.attrs ?? {};
    if (Object.keys(attrs).some((key) => !["type", "align", "lineHeight"].includes(key))) return null;
    const runs = block.runs ?? [];
    const chars: CanonicalBlock["chars"] = [];
    for (const run of runs) {
      const marks = run.m ?? {};
      if (Object.keys(marks).some((key) => !SUPPORTED_MARKS.has(key))) return null;
      for (const scalar of Array.from(run.t)) chars.push({ scalar, marks });
    }
    blocks.push({ type: block.type, attrs, chars });
  }
  return blocksToPmDoc(blocks) as PmNode;
}

function HistoryPanel({ documentId, role, syncNow }: { documentId: string; role: DocumentDetailDto["effectiveRole"]; syncNow: () => void }) {
  const { getToken } = useAuth();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selected, setSelected] = useState<RevisionPreview | null>(null);
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL
    ? "/api/gateway/documents/" + encodeURIComponent(documentId) + "/revisions"
    : null;
  const isOwner = role === "OWNER";
  const canCheckpoint = role === "OWNER" || role === "EDITOR";

  const refresh = useCallback(async () => {
    if (!endpoint) {
      setError("Version history needs NEXT_PUBLIC_SYNC_GATEWAY_URL and the history-enabled gateway.");
      return;
    }
    try {
      const data = await gatewayRequest<{ revisions: Revision[] }>(`${endpoint}?limit=100`, getToken);
      setRevisions(data.revisions);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load history.");
    }
  }, [endpoint, getToken]);

  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  const openRevision = async (revision: Revision) => {
    if (!endpoint) return;
    setBusy(true);
    setError("");
    try {
      const data = await gatewayRequest<RevisionPreview>(`${endpoint}/${encodeURIComponent(revision.revisionId)}`, getToken);
      setSelected(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not preview this revision.");
    } finally {
      setBusy(false);
    }
  };

  const createCheckpoint = async (event: FormEvent) => {
    event.preventDefault();
    if (!endpoint || !label.trim()) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const created = await gatewayRequest<Revision>(endpoint, getToken, {
        method: "POST",
        body: JSON.stringify({ label: label.trim() }),
      });
      setLabel("");
      setNotice(`Checkpoint “${created.label ?? "Untitled"}” saved at durable sequence ${created.targetSeq}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Checkpoint was not saved.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!endpoint || !selected || !isOwner) return;
    if (!window.confirm("Restore this version? Concord will append new edits and preserve the existing history.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const outcome = await gatewayRequest<{ appliedOps: number }>(
        `${endpoint}/${encodeURIComponent(selected.revisionId)}/restore`, getToken, { method: "POST" },
      );
      setNotice(`Restore committed through the durable gateway (${outcome.appliedOps} new operations). Collaborators will receive it through sync.`);
      syncNow();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Restore was not committed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 gap-4 md:grid-cols-[minmax(14rem,0.85fr)_minmax(0,1.4fr)]">
      <section className="flex min-h-0 flex-col gap-3">
        {canCheckpoint && (
          <form onSubmit={(event) => void createCheckpoint(event)} className="flex gap-2">
            <Input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={200} placeholder="Checkpoint name" aria-label="Checkpoint name" />
            <Button type="submit" disabled={busy || !label.trim()}>Save</Button>
          </form>
        )}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto" aria-label="Document history">
          {revisions.map((revision) => (
            <button
              key={revision.revisionId}
              type="button"
              onClick={() => void openRevision(revision)}
              aria-pressed={selected?.revisionId === revision.revisionId}
              className="w-full rounded-md border px-3 py-2 text-left hover:bg-muted/50 aria-pressed:border-primary"
            >
              <span className="block truncate text-sm font-medium">{revision.label || (revision.kind === "restore_event" ? "Restore" : "Automatic checkpoint")}</span>
              <span className="block text-xs text-muted-foreground">{new Date(revision.createdAtMs).toLocaleString()} · seq {revision.targetSeq}</span>
            </button>
          ))}
          {revisions.length === 0 && !error && <p className="text-sm text-muted-foreground">No checkpoints yet.</p>}
        </div>
      </section>
      <section className="flex min-h-0 flex-col rounded-md border p-4">
        {notice && <p className="mb-3 text-sm text-muted-foreground" role="status">{notice}</p>}
        {error && <div className="mb-3 flex flex-wrap items-center justify-between gap-2" role="alert"><p className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>Retry</Button></div>}
        {busy && <p className="text-sm text-muted-foreground" role="status">Working…</p>}
        {selected ? (
          <>
            <div className="mb-3 flex items-start justify-between gap-3 border-b pb-3">
              <div className="min-w-0">
                <h3 className="font-semibold">Read-only preview</h3>
                <p className="break-all text-xs text-muted-foreground">Sequence {selected.boundary} · {selected.stateDigest}</p>
              </div>
              {isOwner && <Button type="button" variant="outline" onClick={() => void restore()} disabled={busy}>Restore version</Button>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{documentPreview(selected.visibleContent)}</div>
          </>
        ) : <p className="m-auto text-sm text-muted-foreground">Choose a revision to preview.</p>}
      </section>
    </div>
  );
}

function BundlePanel({ client, editor, flushEditorBridge, canEdit, documentId, documentTitle }: {
  client: CrdtClient | null;
  editor: TipTapEditor | null;
  flushEditorBridge: (() => Promise<void>) | null;
  canEdit: boolean;
  documentId: string;
  documentTitle: string;
}) {
  const { getToken } = useAuth();
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [proof, setProof] = useState<ProofVerification | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sync = useSyncStatusStore((state) => state.status);
  const proofEndpoint = process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL
    ? "/api/gateway/documents/" + encodeURIComponent(documentId) + "/proof"
    : null;

  // Feature 5: verify the gateway's Merkle + Ed25519-signed state receipt
  // against THIS replica's own digest. Read-only, additive to the bundle flow.
  const verifyReceipt = async () => {
    if (!client) {
      setError("The local CRDT replica is unavailable.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setProof(null);
    try {
      if (!flushEditorBridge) throw new Error("The local editor bridge is unavailable.");
      if (!proofEndpoint) throw new Error("Server receipts need NEXT_PUBLIC_SYNC_GATEWAY_URL and the history-enabled gateway.");
      await flushEditorBridge();
      const verification = await verifyAgainstGateway(client, () =>
        gatewayRequest<ProofDocument>(proofEndpoint, getToken),
      );
      setProof(verification);
    } catch (cause) {
      setError(cause instanceof Error ? `Receipt verification failed: ${cause.message}` : "Receipt verification failed.");
    } finally {
      setBusy(false);
    }
  };

  const exportBundle = async () => {
    if (!client) {
      setError("The local CRDT replica is unavailable.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!flushEditorBridge) throw new Error("The local editor bridge is unavailable.");
      await flushEditorBridge();
      const bytes = await exportConcordPack(client, loadBrowserCrdtFactory);
      const blobBytes = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(blobBytes).set(bytes);
      const href = URL.createObjectURL(new Blob([blobBytes], { type: "application/vnd.concord.pack" }));
      const link = document.createElement("a");
      link.href = href;
      link.download = `${documentTitle.replace(/[^a-z0-9-_]+/gi, "-") || "document"}.concordpack`;
      link.click();
      URL.revokeObjectURL(href);
      setNotice(`Verified bundle exported (${bytes.byteLength.toLocaleString()} bytes).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bundle export failed.");
    } finally {
      setBusy(false);
    }
  };

  const verifyFile = async (file: File | undefined) => {
    if (!file) return;
    setPreview(null);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (file.size > MAX_CONCORDPACK_BYTES) throw new Error("Bundle is larger than the 64 MiB limit.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const verified = await previewConcordPack(bytes, loadBrowserCrdtFactory);
      setPreview({ digest: verified.state.stateDigest, visibleContent: JSON.parse(verified.visibleJson) as unknown });
      setNotice(`${file.name} passed checksum and CRDT digest verification.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bundle verification failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const applyVerifiedContent = () => {
    if (!canEdit || !editor || !preview) return;
    const content = asEditorDocument(preview.visibleContent);
    if (!content) {
      setError("This bundle contains blocks or formatting outside the editor's supported CRDT subset; it remains verifiable but cannot be applied losslessly here.");
      return;
    }
    if (!window.confirm("Replace this editor's content with the verified bundle? Concord will record the replacement as new CRDT edits and keep prior history.")) return;
    editor.commands.setContent(content, { emitUpdate: true });
    setNotice(`Verified content applied as new editor edits. Current sync status: ${sync ?? "local-only"}.`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void exportBundle()} disabled={busy || !client || !flushEditorBridge}>Export verified bundle</Button>
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>Verify bundle</Button>
        <input ref={fileRef} type="file" accept=".concordpack,application/octet-stream" className="sr-only" onChange={(event) => void verifyFile(event.target.files?.[0])} aria-label="Choose a Concord document bundle" />
        <Button type="button" variant="outline" onClick={() => void verifyReceipt()} disabled={busy || !client}>Verify server receipt</Button>
        <span className="text-xs text-muted-foreground">Portable data + operation history · 64 MiB maximum</span>
      </div>
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {busy && <p role="status" className="text-sm text-muted-foreground">Verifying CRDT state…</p>}
      {proof && (
        <div role="status" className="rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">Server receipt {proof.merkleOk && proof.signatureOk ? "verified" : "REJECTED"}</p>
          <p className="text-muted-foreground">
            Merkle path {proof.merkleOk ? "✓" : "✗"} · Signature {proof.signatureOk ? "✓" : "✗"} (key {proof.keyId}{proof.keyEphemeral ? ", ephemeral — set GATEWAY_SIGNING_KEY for durable trust" : ""}) · Server state at seq {proof.seq} matches this replica: {proof.stateMatch ? "yes" : "not yet (still syncing, or content differs)"}
          </p>
          <p className="text-xs text-muted-foreground">
            The receipt covers {proof.opCount} retained operations. Third-party verifiability requires the gateway key out of band; the same-response key detects gateway-side tampering only.
          </p>
        </div>
      )}
      {preview && (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3 border-b pb-3">
            <div>
              <h3 className="font-semibold">Verified bundle preview</h3>
              <p className="break-all text-xs text-muted-foreground">{preview.digest}</p>
            </div>
            {canEdit && <Button type="button" variant="outline" onClick={applyVerifiedContent} disabled={!editor}>Apply as new edits</Button>}
          </div>
          {documentPreview(preview.visibleContent)}
        </div>
      )}
      {!preview && <p className="text-sm text-muted-foreground">A bundle checksum detects damage; the reconstructed CRDT digest proves its declared content matches. It is not a server signature.</p>}
    </div>
  );
}

function ReplayPanel({
  client,
  flushEditorBridge,
}: {
  client: CrdtClient | null;
  flushEditorBridge: (() => Promise<void>) | null;
}) {
  const replayRef = useRef<DocumentReplay | null>(null);
  const runnerRef = useRef<{ running: boolean; target: number | null }>({ running: false, target: null });
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState(0);
  const [position, setPosition] = useState(0);
  const [state, setState] = useState<ReplayState | null>(null);
  const [error, setError] = useState("");

  // The replay engine is single-threaded and stateful, so folds must never
  // overlap. Rapid slider drags collapse to the latest requested index: the
  // in-flight fold finishes, then the newest target is served and the ones
  // in between are dropped (O(1) amortized stepping, jitter-free UI).
  const requestAt = useCallback((index: number) => {
    const runner = runnerRef.current;
    runner.target = index;
    if (runner.running) return;
    runner.running = true;
    void (async () => {
      try {
        while (runner.target !== null) {
          const target = runner.target;
          runner.target = null;
          const replay = replayRef.current;
          if (!replay) break;
          setBusy(true);
          try {
            const next = await replay.at(target);
            setState(next);
            setError("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not reconstruct this state.");
          }
        }
      } finally {
        runner.running = false;
        setBusy(false);
      }
    })();
  }, []);
  // The caller keys this panel by document id, so a document switch remounts
  // it with fresh initial state — no synchronous resets in the effect body
  // (which the effect-purity lint forbids and which would double-render).
  useEffect(() => {
    if (!client || !flushEditorBridge) return;
    let cancelled = false;
    void (async () => {
      try {
        await flushEditorBridge();
        const ops = await client.exportOps();
        const opened = await DocumentReplay.open(ops, loadBrowserCrdtFactory);
        if (cancelled) {
          opened.close();
          return;
        }
        replayRef.current = opened;
        setTotal(opened.length);
        setPosition(opened.length);
        setReady(true);
        setLoading(false);
        requestAt(opened.length);
      } catch (cause) {
        if (!cancelled) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "Could not load the operation log.");
        }
      }
    })();

    return () => {
      cancelled = true;
      replayRef.current?.close();
      replayRef.current = null;
    };
  }, [client, flushEditorBridge, requestAt]);

  const moveTo = (index: number) => {
    setPosition(index);
    requestAt(index);
  };

  const preview = useMemo(() => {
    if (!state) return null;
    try {
      return documentPreview(JSON.parse(state.json));
    } catch {
      return <p className="text-sm text-destructive">This reconstructed state could not be rendered.</p>;
    }
  }, [state]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div>
        <h3 className="font-semibold">Time-travel replay</h3>
        <p className="text-sm text-muted-foreground">
          Fold any prefix of this replica&apos;s durable operation log back through the CRDT engine. Read-only, fully local, and works offline.
        </p>
      </div>
      {!client && <p role="alert" className="text-sm text-destructive">The local CRDT replica is unavailable in this session.</p>}
      {client && loading && <p role="status" className="text-sm text-muted-foreground">Loading the local operation log…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {ready && (
        <>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span id="replay-position-label" className="text-sm font-medium">
                {total === 0 ? "No operations to replay yet" : `State after ${position} of ${total} operations`}
              </span>
              <span className="flex gap-1">
                <Button type="button" variant="outline" size="sm" onClick={() => moveTo(0)} disabled={busy || total === 0 || position === 0}>Start</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => moveTo(total)} disabled={busy || total === 0 || position === total}>Latest</Button>
              </span>
            </div>
            <input
              id="replay-position"
              type="range"
              min={0}
              max={total}
              step={1}
              value={position}
              disabled={total === 0}
              aria-label="Replay position"
              aria-describedby="replay-position-label"
              aria-valuetext={`Operation ${position} of ${total}`}
              onChange={(event) => moveTo(Number(event.target.value))}
              className="w-full"
            />
            {state && <p className="break-all font-mono text-xs text-muted-foreground" aria-live="polite">{state.digest}</p>}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4" aria-busy={busy}>
            {preview ?? <p className="text-sm text-muted-foreground">Reconstructing…</p>}
          </div>
        </>
      )}
    </div>
  );
}

function MarkdownPanel({
  editor,
  flushEditorBridge,
  canEdit,
  documentTitle,
}: {
  editor: TipTapEditor | null;
  flushEditorBridge: (() => Promise<void>) | null;
  canEdit: boolean;
  documentTitle: string;
}) {
  const [markdown, setMarkdown] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const runExport = () => {
    if (!editor || !flushEditorBridge) {
      setError("The editor is unavailable.");
      return;
    }
    setError("");
    setNotice("");
    void flushEditorBridge().then(() => {
      const result = exportMarkdown(editor.getJSON() as PmNode);
      setMarkdown(result.markdown);
      const notes: string[] = [];
      if (!result.lossless) notes.push("content outside the collaborative subset was skipped");
      if (result.droppedAttributes > 0) notes.push(`${result.droppedAttributes} paragraph attribute(s) (alignment/line height) have no markdown equivalent and were dropped`);
      setNotice(notes.length ? `Exported. Note: ${notes.join("; ")}.` : `Exported ${result.markdown.length.toLocaleString()} characters (lossless round trip).`);
      const blob = new Blob([result.markdown], { type: "text/markdown" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${documentTitle.replace(/[^a-z0-9-_]+/gi, "-") || "document"}.md`;
      link.click();
      URL.revokeObjectURL(href);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Markdown export failed.");
    });
  };

  const importAsEdits = () => {
    if (!canEdit || !editor) return;
    setError("");
    setNotice("");
    try {
      if (markdown.length > 2_000_000) throw new Error("Markdown input exceeds the 2 MB limit.");
      const content = importMarkdown(markdown);
      editor.commands.setContent(content, { emitUpdate: true });
      setNotice("Imported as new editor edits — they flow through the CRDT like any other change. Prior history is preserved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Markdown import failed.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={runExport} disabled={!editor || !flushEditorBridge}>Export markdown</Button>
        <Button type="button" variant="outline" onClick={importAsEdits} disabled={!canEdit || !editor || markdown.length === 0}>Import as new edits</Button>
      </div>
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <textarea
        value={markdown}
        onChange={(event) => setMarkdown(event.target.value)}
        aria-label="Markdown content"
        placeholder={"# Heading\n\nParagraph with **bold**, *italic*, ~~strike~~, and <u>underline</u>."}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded-md border bg-background p-3 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="shrink-0 text-xs text-muted-foreground">
        Supported subset: paragraphs, headings 1–6, bold, italic, strikethrough, underline, backslash escapes. Tables, images, lists, and colors are outside the collaborative model and are never silently dropped — exports report them, imports keep them literal.
      </p>
    </div>
  );
}

// MARKDOWN_PANEL_PLACEHOLDER

export function DocumentTools({ document, crdtClient, syncNow }: DocumentToolsProps) {
  const { userId } = useAuth();
  const editor = useEditorStore((state) => state.editor);
  const flushEditorBridge = useEditorStore((state) => state.flushEditorBridge);
  const canEdit = document.effectiveRole === "OWNER" || document.effectiveRole === "EDITOR";
  const canComment = canEdit || document.effectiveRole === "COMMENTER";
  const canResolve = canEdit;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ToolTab>("history");
  const [editorState, setEditorState] = useState<{ json: unknown; version: number; anchorRevision: number }>({
    json: { type: "doc", content: [{ type: "paragraph" }] },
    version: document.contentVersion,
    anchorRevision: 0,
  });
  const [selection, setSelection] = useState<CommentSelection | null>(null);
  const selectionRevision = useRef(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!editor) return;
    let active = true;
    const update = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      setEditorState((state) => ({
        json: editor.getJSON(),
        version: state.version + 1,
        anchorRevision: state.anchorRevision + 1,
      }));
    };
    const updateSelection = () => {
      const revision = ++selectionRevision.current;
      const { from, to, empty } = editor.state.selection;
      if (empty) {
        setSelection(null);
        return;
      }
      const doc = editor.getJSON() as PmNode;
      const quote = editor.state.doc.textBetween(from, to, "\n").slice(0, 1000);
      void crdtClient?.exportStream().then((stream) => {
        if (revision !== selectionRevision.current) return;
        const anchor = anchorSelection(doc, stream, from, to);
        setSelection(anchor && quote.trim() ? { anchor, quote } : null);
      }).catch(() => setSelection(null));
    };
    void Promise.resolve().then(() => {
      if (active) setEditorState((state) => ({ ...state, json: editor.getJSON() }));
    });
    editor.on("transaction", update);
    editor.on("selectionUpdate", updateSelection);
    updateSelection();
    return () => {
      active = false;
      editor.off("transaction", update);
      editor.off("selectionUpdate", updateSelection);
    };
  }, [crdtClient, editor]);

  // Suggestion acceptance applies text through the editor as NORMAL durable
  // CRDT edits (Feature 4): replace the anchored range (or delete it when the
  // proposal is empty, or insert at a zero-width anchor).
  const applyReplacement = useCallback((from: number, to: number, proposedText: string) => {
    if (!editor || !canEdit) throw new Error("This document cannot be edited.");
    if (proposedText === "") {
      editor.chain().focus().deleteRange({ from, to }).run();
    } else if (from === to) {
      editor.chain().focus().insertContentAt(from, proposedText).run();
    } else {
      editor.chain().focus().insertContentAt({ from, to }, proposedText).run();
    }
  }, [editor, canEdit]);

  const resolveAnchors = useCallback(async (items: Array<{ threadId: string; anchor: CrdtRangeAnchor }>) => {
    if (!editor || !crdtClient) return Object.fromEntries(items.map(({ threadId }) => [threadId, { status: "unavailable" as const }]));
    const [doc, stream] = [editor.getJSON() as PmNode, await crdtClient.exportStream()];
    return resolveAnchorSet(doc, stream, items);
  }, [crdtClient, editor]);

  const navigateToRange = useCallback((from: number, to: number) => {
    if (!editor) return;
    editor.chain().focus().setTextSelection({ from, to }).run();
    const node = editor.view.domAtPos(from).node;
    (node instanceof HTMLElement ? node : node.parentElement)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editor]);

  const tabItems: Array<{ id: ToolTab; label: string; icon: typeof History }> = [
    { id: "history", label: "History", icon: History },
    { id: "comments", label: "Comments", icon: MessageSquareText },
    { id: "drafts", label: "Drafts", icon: GitBranch },
    { id: "bundle", label: "Concordpack", icon: PackageOpen },
    { id: "replay", label: "Replay", icon: Rewind },
    { id: "markdown", label: "Markdown", icon: FileText },
    { id: "suggestions", label: "Suggestions", icon: Lightbulb },
  ];
  const tabOrder = tabItems.map(({ id }) => id);
  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabOrder.length
      : event.key === "ArrowLeft" ? (index + tabOrder.length - 1) % tabOrder.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabOrder.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabOrder[next]);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        aria-label={open ? "Close review and history panel" : "Open review, history, and draft tools"}
        aria-expanded={open}
        aria-controls="document-tools-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <MessageSquareText /> <span className="hidden md:inline">Review & history</span>
      </Button>
      {open && <aside id="document-tools-panel" aria-label="Review and document history" className="fixed bottom-0 right-0 top-[104px] z-20 flex w-[min(32rem,calc(100vw-1rem))] flex-col gap-4 border-l bg-background p-4 shadow-xl sm:p-5">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Review and document history</h2>
            <p className="mt-1 text-sm text-muted-foreground">Anchored comments, checkpoints, drafts, and recovery.</p>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-label="Close review and history panel" onClick={() => setOpen(false)}><X /></Button>
        </header>
        <div role="tablist" aria-label="Document tools" className="flex shrink-0 gap-1 overflow-x-auto border-b">
          {tabItems.map(({ id, label: tabLabel, icon: Icon }, index) => (
            <button
              key={id}
              id={`document-tool-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls="document-tool-panel"
              tabIndex={tab === id ? 0 : -1}
              ref={(node) => { tabRefs.current[index] = node; }}
              onKeyDown={(event) => moveTabFocus(event, index)}
              onClick={() => setTab(id)}
              className="inline-flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm aria-selected:border-primary aria-selected:font-medium"
            >
              <Icon className="size-4" />{tabLabel}
            </button>
          ))}
        </div>
        <div id="document-tool-panel" role="tabpanel" tabIndex={0} aria-labelledby={`document-tool-tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
          {tab === "history" && <HistoryPanel documentId={document.id} role={document.effectiveRole} syncNow={syncNow} />}
          {tab === "comments" && (userId ? (
            <CommentsPanel
              documentId={document.id}
              userId={userId}
              canComment={canComment}
              canResolve={canResolve}
              selection={selection}
              anchorRevision={editorState.anchorRevision}
              resolveAnchors={resolveAnchors}
              onNavigateToRange={navigateToRange}
            />
          ) : <p className="text-sm text-muted-foreground">Sign in to view and add comments.</p>)}
          {tab === "drafts" && (
            <DraftsPanel
              documentId={document.id}
              userId={userId ?? null}
              currentContent={editorState.json}
              currentContentVersion={editorState.version}
              canEdit={canEdit}
              onApply={({ content }) => {
                if (!editor || !canEdit) throw new Error("This document cannot be edited.");
                editor.commands.setContent(content as unknown as PmNode, { emitUpdate: true });
              }}
            />
          )}
          {tab === "bundle" && <BundlePanel client={crdtClient} editor={editor} flushEditorBridge={flushEditorBridge} canEdit={canEdit} documentId={document.id} documentTitle={document.title} />}
          {tab === "replay" && <ReplayPanel key={document.id} client={crdtClient} flushEditorBridge={flushEditorBridge} />}
          {tab === "markdown" && (
            <MarkdownPanel
              key={document.id}
              editor={editor}
              flushEditorBridge={flushEditorBridge}
              canEdit={canEdit}
              documentTitle={document.title}
            />
          )}
          {tab === "suggestions" && (
            <SuggestionsPanel
              documentId={document.id}
              userId={userId ?? ""}
              canPropose={canComment}
              canAccept={canEdit}
              selection={selection}
              anchorRevision={editorState.anchorRevision}
              resolveAnchors={resolveAnchors}
              onNavigateToRange={navigateToRange}
              applyReplacement={applyReplacement}
            />
          )}
        </div>
      </aside>}
    </>
  );
}
