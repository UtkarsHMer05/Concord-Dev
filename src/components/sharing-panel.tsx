"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Grant { userId: string; role: "EDITOR" | "COMMENTER" | "VIEWER" }
interface Sharing { collaborationId: string; canManage: boolean; grants: Grant[] }

export function SharingPanel({ documentId }: { documentId: string }) {
  const [data, setData] = useState<Sharing | null>(null);
  const [target, setTarget] = useState(""); const [role, setRole] = useState<Grant["role"]>("COMMENTER");
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const url = `/api/documents/${documentId}/permissions`;
  const request = useCallback(async (body?: unknown) => {
    const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Sharing unavailable. Retry when connected.");
    return result;
  }, [url]);
  const refresh = useCallback(async () => { try { setData(await request()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Could not load sharing."); } }, [request]);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);
  const grant = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await request({ action: "grant", targetUserId: target.trim(), role }); setTarget(""); await refresh(); setNotice("Access updated. Send the document link to your collaborator."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not invite this collaborator."); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setBusy(true); setError("");
    try { await request({ action: "revoke", targetUserId: id }); await refresh(); setNotice("Direct access removed."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not remove access."); }
    finally { setBusy(false); }
  };
  return <section className="space-y-5" aria-label="Document sharing">
    <div><h3 className="font-semibold">Invite a collaborator</h3><p className="mt-1 text-sm text-muted-foreground">Access applies to this document. Review branches have their own access list.</p></div>
    {data && <div className="space-y-2">
      <label htmlFor="collaboration-id" className="text-sm font-medium">Your collaboration ID</label>
      <Input id="collaboration-id" readOnly value={data.collaborationId} onFocus={(event) => event.target.select()} />
      <p className="text-xs text-muted-foreground">Ask your collaborator for the ID shown in their Share tab.</p>
      <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(window.location.href).then(() => setNotice("Document link copied."), () => setError("Copy the link from the address bar."))}>Copy document link</Button>
    </div>}
    {data?.canManage ? <>
      <form onSubmit={(event) => void grant(event)} className="space-y-3">
        <label htmlFor="collaborator-id" className="text-sm font-medium">Collaborator ID</label>
        <Input id="collaborator-id" required value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Paste their collaboration ID" maxLength={36} />
        <label htmlFor="collaborator-role" className="block text-sm font-medium">Access</label>
        <select id="collaborator-role" className="h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={role} onChange={(event) => setRole(event.target.value as Grant["role"])}>
          <option value="COMMENTER">Review and comment</option><option value="EDITOR">Edit</option><option value="VIEWER">View</option>
        </select>
        <Button type="submit" disabled={busy || !target.trim()}>{busy ? "Updating access…" : "Grant access"}</Button>
      </form>
      <div><h4 className="text-sm font-semibold">People with direct access</h4>
        {data.grants.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No direct invitations yet.</p> : <ul className="mt-2 divide-y">{data.grants.map((grant) => <li key={grant.userId} className="flex items-center justify-between gap-2 py-3">
          <div className="min-w-0"><p className="break-all text-xs">{grant.userId}</p><p className="text-sm text-muted-foreground">{grant.role === "COMMENTER" ? "Can review and comment" : grant.role === "EDITOR" ? "Can edit" : "Can view"}</p></div>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void revoke(grant.userId)}>Remove</Button>
        </li>)}</ul>}
      </div>
    </> : data && <p className="text-sm text-muted-foreground">The document owner manages invitations. Share your collaboration ID with them to request access.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Loading access…</p>}
  </section>;
}
