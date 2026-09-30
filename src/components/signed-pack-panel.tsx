"use client";

import { useAuth } from "@clerk/nextjs";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadBrowserCrdtFactory } from "@/lib/crdt/browser-factory";
import { MAX_CONCORDPACK_BYTES } from "@/lib/crdt/concordpack";
import { archiveTrust, parseTrustRecord, readSignedManifest, verifySignedConcordPack, type SignedManifest, type VerifiedSignedPack } from "@/lib/crdt/signed-concordpack";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import { useSyncStatusStore } from "@/store/use-sync-status-store";

function download(bytes: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}
interface ImportResult { documentId: string; retainedRevisions: number; prunedRevisions: number; stateDigest: string }

export function SignedPackPanel({ documentId, documentTitle, client, flushEditorBridge, renderPreview }: {
  documentId: string; documentTitle: string; client: CrdtClient | null;
  flushEditorBridge: (() => Promise<void>) | null; renderPreview: (content: unknown) => ReactNode;
}) {
  const { getToken, userId } = useAuth();
  const [exported, setExported] = useState<SignedManifest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [trustJson, setTrustJson] = useState("");
  const [title, setTitle] = useState("Restored document");
  const [verified, setVerified] = useState<VerifiedSignedPack | null>(null);
  const [restored, setRestored] = useState<ImportResult | null>(null);
  const [provenance, setProvenance] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const invalidate = () => { setVerified(null); setRestored(null); setError(""); setNotice(""); };
  const request = async (url: string, init?: RequestInit) => {
    const token = await getToken(); if (!token) throw new Error("Your session expired. Sign in again.");
    const response = await fetch(url, { ...init, cache: "no-store", headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      const messages: Record<string, string> = {
        stable_signing_key_required: "This gateway needs a stable signing key before it can export signed history.",
        untrusted_import_key: "This destination server has not authorized the archive's signing key for import.",
        not_found: "This document or import record is unavailable to your account.",
        request_id_conflicts: "A previous attempt used different import details. Restore with the original title and trusted details.",
      };
      throw new Error(messages[body.error ?? ""] ?? (response.status === 429 ? "Wait a minute before retrying." : body.error ?? "The gateway is unavailable. You can retry safely."));
    }
    return response;
  };
  const exportHistory = async () => {
    setBusy(true); setError(""); setNotice(""); setExported(null);
    try {
      if (!client || !flushEditorBridge) throw new Error("The local editor replica is unavailable.");
      await flushEditorBridge();
      const status = useSyncStatusStore.getState();
      if (status.localOnly) throw new Error("Signed history export needs collaboratively synced content. This document is using local-only whole-document storage.");
      if (status.error) throw new Error("Resolve the sync or local storage error before exporting signed history.");
      const outbox = status.outbox;
      // A durable ACK is sufficient for export; serverConfirmed additionally
      // waits for a later catch-up and is stronger than this check needs.
      if (!outbox || outbox.pending || outbox.sent) throw new Error("Wait for all edits to be saved to the server, then export again.");
      const response = await request(`/api/gateway/documents/${encodeURIComponent(documentId)}/concordpack`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const manifest = readSignedManifest(bytes);
      if (manifest.content.documentId !== documentId || manifest.content.stateDigest !== await client.digest()) throw new Error("The server's saved version differs from this replica. Wait for synchronization and retry.");
      const name = documentTitle.replace(/[^a-z0-9-_]+/gi, "-") || "document";
      download(bytes, `${name}-history.concordpack`, "application/vnd.concord.concordpack");
      setExported(manifest);
      setNotice(`Signed history exported: ${manifest.content.operations.length.toLocaleString()} retained operations and ${manifest.content.revisions.length} saved revisions.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "History export failed."); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    if (!file) return;
    setBusy(true); invalidate();
    try {
      if (file.size > MAX_CONCORDPACK_BYTES) throw new Error("Archive is larger than the 64 MiB limit.");
      const result = await verifySignedConcordPack(new Uint8Array(await file.arrayBuffer()), parseTrustRecord(trustJson), loadBrowserCrdtFactory);
      setVerified(result);
      setNotice("Verified locally: trusted signature, file checksums, operation identities, and retained revision states all match.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Archive verification failed."); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!verified || !file || !userId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const normalizedTitle = title.trim();
      if (!normalizedTitle || [...normalizedTitle].length > 200) throw new Error("Choose a document title of 1 to 200 characters.");
      // Persist only the retry identity and immutable request metadata. Reselect
      // the file after a reload; the archive itself never enters localStorage.
      const key = `concord.pack-import.v2.${encodeURIComponent(userId)}.${verified.archiveChecksum}`;
      const details = JSON.stringify({ title: normalizedTitle, trust: verified.trust });
      const stored = localStorage.getItem(key);
      const pending = stored ? JSON.parse(stored) as { requestId: string; details: string } : { requestId: crypto.randomUUID(), details };
      if (!pending.requestId || pending.details !== details) throw new Error("Retry the previous import with its original title and trusted details to avoid creating a duplicate document.");
      localStorage.setItem(key, JSON.stringify(pending));
      const query = new URLSearchParams({ requestId: pending.requestId, title: normalizedTitle, workspace: "personal",
        publicKey: verified.trust.publicKey, documentId: verified.trust.documentId, seq: verified.trust.seq,
        baseSnapshotSeq: verified.trust.baseSnapshotSeq });
      if (verified.trust.revisionId) query.set("revisionId", verified.trust.revisionId);
      const response = await request(`/api/gateway/concordpack/import?${query}`, { method: "POST",
        headers: { "Content-Type": "application/vnd.concord.concordpack" }, body: await file.arrayBuffer() });
      const result = await response.json() as ImportResult;
      setRestored(result);
      // Retain the successful request identity too: a repeated click/reload
      // resolves to the same document rather than duplicating restored history.
      setNotice("History restored to your personal workspace. Only you have access; you can share it from the restored document.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed. Retry safely with the same file and details."); }
    finally { setBusy(false); }
  };
  const showProvenance = async () => {
    setBusy(true); setError("");
    try { setProvenance(await (await request(`/api/gateway/documents/${documentId}/concordpack/provenance`)).json()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Import provenance is unavailable."); }
    finally { setBusy(false); }
  };
  return <section className="min-w-0 space-y-4" aria-label="Signed history archives">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">Take your document history with you</h3><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Export a signed archive, verify it without the original server, and restore its retained revisions into a new document.</p></div>
      <Button onClick={() => void exportHistory()} disabled={busy || !client || !flushEditorBridge}>Export signed history</Button>
    </div>
    {exported && <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <p>Saved version {exported.content.seq} · key {exported.keyId}</p>
      <p className="my-2 text-muted-foreground">Send verification details through a separate trusted channel so the recipient can check the source and expected version.</p>
      <Button variant="outline" size="sm" onClick={() => download(new TextEncoder().encode(JSON.stringify(archiveTrust(exported), null, 2)), "trusted-history.json", "application/json")}>Download verification details</Button>
    </div>}
    <div className="grid min-w-0 gap-4">
      <div className="min-w-0 space-y-3 rounded-md border p-4">
        <h4 className="font-medium">1. Verify an archive</h4>
        <label className="block text-sm" htmlFor="signed-history-file">History archive</label>
        <Input id="signed-history-file" type="file" accept=".concordpack" disabled={busy} onChange={(event) => { invalidate(); setFile(event.target.files?.[0] ?? null); }} />
        <label className="block text-sm" htmlFor="signed-history-trust">Trusted verification details</label>
        <label className="block text-xs text-muted-foreground" htmlFor="signed-history-trust-file">Load trusted details file, or paste below</label>
        <Input id="signed-history-trust-file" type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
          const details = event.target.files?.[0]; if (!details) return;
          invalidate(); setBusy(true);
          void (async () => {
            try { if (details.size > 4096) throw new Error("Trusted details are larger than the 4 KiB limit.");
              const text = await details.text(); parseTrustRecord(text); setTrustJson(text);
            } catch (cause) { setTrustJson(""); setError(cause instanceof Error ? cause.message : "Invalid trusted details file."); }
            finally { setBusy(false); }
          })();
        }} />
        <textarea id="signed-history-trust" rows={4} spellCheck={false} value={trustJson} disabled={busy}
          onChange={(event) => { invalidate(); setTrustJson(event.target.value); }}
          aria-describedby="signed-history-trust-help" className="w-full min-w-0 rounded-md border bg-background p-2 font-mono text-xs" />
        <p id="signed-history-trust-help" className="text-xs text-muted-foreground">Paste details obtained from the document owner through a separate trusted channel. The archive cannot choose its own trusted key.</p>
        <Button variant="outline" onClick={() => void verify()} disabled={busy || !file || !trustJson.trim()}>Verify signed archive</Button>
      </div>
      <div className="min-w-0 space-y-3 rounded-md border p-4">
        <h4 className="font-medium">2. Restore retained history</h4>
        <p className="text-sm text-muted-foreground">Create a private document in your personal workspace. Retained operations and saved revisions are preserved. Original author IDs remain in provenance; source collaborators receive no access.</p>
        <label className="block text-sm" htmlFor="signed-history-title">Restored document title</label>
        <Input id="signed-history-title" value={title} disabled={busy || !!restored} onChange={(event) => setTitle(event.target.value)} />
        <Button onClick={() => void restore()} disabled={busy || !verified || !!restored}>Restore as new document</Button>
        {restored && <div role="status" className="space-y-2 rounded-md bg-muted p-3 text-sm">
          <p>{restored.retainedRevisions} retained revisions restored{restored.prunedRevisions ? `; ${restored.prunedRevisions} pruned revision records remain unavailable` : ""}.</p>
          <Link className="font-medium underline" href={`/documents/${restored.documentId}`}>Open restored document</Link>
        </div>}
      </div>
    </div>
    {busy && <p role="status" className="text-sm text-muted-foreground">Checking and reconstructing retained history…</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    {verified && <div className="rounded-md border p-4">
      <h4 className="font-medium">Trusted archive verified</h4>
      <p className="my-2 break-all text-xs text-muted-foreground">Source {verified.manifest.content.documentId} · version {verified.manifest.content.seq} · {verified.manifest.content.stateDigest}</p>
      <p className="mb-3 text-sm">{verified.manifest.content.revisions.filter((r) => r.stateDigest).length} reconstructable revisions · {verified.manifest.content.snapshots.length} retained snapshots · {verified.manifest.content.operations.length} retained operations</p>
      {renderPreview(verified.visibleContent)}
    </div>}
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs text-muted-foreground">A signature authenticates the trusted server&apos;s statement; it does not prove physical storage. Previously pruned states are not recreated.</p>
      <Button variant="ghost" size="sm" onClick={() => void showProvenance()} disabled={busy}>View import provenance</Button>
      {provenance !== null && <details open><summary className="cursor-pointer text-sm">Original signed manifest and identity mappings</summary><pre tabIndex={0} aria-label="Signed import provenance" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify(provenance, null, 2)}</pre></details>}
    </div>
  </section>;
}
