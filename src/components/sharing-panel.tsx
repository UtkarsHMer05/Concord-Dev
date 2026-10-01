"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { LinkIcon, LockKeyhole, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type Role = "EDITOR" | "COMMENTER" | "VIEWER";
interface Person { userId: string; name: string; email: string | null; role: Role | "OWNER" }
interface Sharing {
  collaborationId: string; canManage: boolean; effectiveRole: Role | "OWNER";
  organizationAccess: boolean; grants: Person[]; owner: Person | null; profileWarning: boolean;
}
const roles = [{ value: "VIEWER", label: "Can view" }, { value: "COMMENTER", label: "Can comment" }, { value: "EDITOR", label: "Can edit" }] as const;
const selectClass = "h-10 rounded-md border bg-background px-3 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SharingPanel({ documentId }: { documentId: string }) {
  const id = useId();
  const [data, setData] = useState<Sharing | null>(null);
  const [target, setTarget] = useState("");
  const [identifyBy, setIdentifyBy] = useState("email");
  const [role, setRole] = useState<Role>("COMMENTER");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const url = `/api/documents/${documentId}/permissions`;
  const request = useCallback(async (body?: unknown, signal?: AbortSignal): Promise<Sharing> => {
    const response = await fetch(url, { cache: "no-store", signal,
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Sharing unavailable. Reconnect and try again.");
    return result;
  }, [url]);
  useEffect(() => {
    const controller = new AbortController();
    void request(undefined, controller.signal).then(setData).catch((e) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load access. Try again.");
    });
    return () => controller.abort();
  }, [request]);
  const refresh = async () => {
    setError(""); setBusy(true);
    try { setData(await request()); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load access. Try again."); }
    finally { setBusy(false); }
  };
  const mutate = async (body: unknown, message: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await request(body);
      setNotice(message); setTarget("");
      // Report a committed change even when the subsequent read fails.
      try { setData(await request()); }
      catch { setError("Access was saved, but the list could not refresh. Try again to see the current roles."); }
    } catch (e) { setError(e instanceof Error ? e.message : "Access could not be saved. Reconnect and try again."); }
    finally { setBusy(false); }
  };
  const grant = (event: FormEvent) => {
    event.preventDefault();
    void mutate({ action: "grant", ...(identifyBy === "email" ? { email: target.trim().toLowerCase() } : { targetUserId: target.trim() }), role }, "Access granted. Your collaborator can open this document from Shared with me.");
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(new URL(`/documents/${documentId}`, window.location.origin).href); setNotice("Document link copied."); }
    catch { setError("The link could not be copied. Select and copy the document link below."); }
  };
  return <section className="space-y-5" aria-label="Document sharing" aria-busy={busy}>
    {data?.canManage && <form onSubmit={grant} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${id}-target`} className="text-sm font-medium">{identifyBy === "email" ? "Collaborator email" : "Collaborator ID"}</label>
        <select aria-label="Identify collaborator by" value={identifyBy} disabled={busy} onChange={(event) => { setIdentifyBy(event.target.value); setTarget(""); }} className={`${selectClass} h-8 max-w-44`}>
          <option value="email">Email address</option><option value="id">Collaboration ID</option>
        </select>
      </div>
      <Input id={`${id}-target`} type={identifyBy === "email" ? "email" : "text"} required value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)} placeholder={identifyBy === "email" ? "name@example.com" : "Paste their collaboration ID"} maxLength={identifyBy === "email" ? 254 : 36} aria-describedby={`${id}-hint`} className="h-11 text-base" />
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">{identifyBy === "email" ? "Use the verified email of an existing Concord account." : "Ask your collaborator for the ID shown in their Share panel."}</p>
      <div className="flex gap-2">
        <select aria-label="Access" className={`${selectClass} min-w-0 flex-1`} value={role} disabled={busy} onChange={(event) => setRole(event.target.value as Role)}>{roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        <Button type="submit" disabled={busy || !target.trim()} className="h-10">{busy ? "Saving…" : "Grant access"}</Button>
      </div>
      <p className="text-sm text-muted-foreground">Viewers read. Commenters add feedback. Editors change content. Only the owner manages access.</p>
    </form>}
    {data && <div className="space-y-3">
      <h3 className="text-sm font-semibold">People with access</h3>
      {data.owner && <div className="flex items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted" aria-hidden="true"><Users className="size-4" /></span><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{data.owner.name} (you)</p>{data.owner.email && <p className="break-all text-sm text-muted-foreground">{data.owner.email}</p>}</div><span className="text-sm text-muted-foreground">Owner</span></div>}
      {data.canManage ? <>
        {data.grants.length === 0 ? <p className="text-sm text-muted-foreground">No one has direct access yet. Add a collaborator above.</p> : <ul className="max-h-60 divide-y overflow-y-auto">{data.grants.map((person) => <li key={person.userId} className="flex flex-wrap items-center gap-3 py-3">
          <div className="min-w-0 basis-40 flex-1"><p className="break-words text-sm font-medium">{person.name}</p>{person.email && <p className="break-all text-sm text-muted-foreground">{person.email}</p>}</div>
          <select aria-label={`Access for ${person.email ?? person.name}`} className={`${selectClass} max-w-full`} value={person.role} disabled={busy} onChange={(event) => void mutate({ action: "grant", targetUserId: person.userId, role: event.target.value }, "Role updated. Open sessions will refresh their access.")}>{roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
          <Button type="button" size="sm" variant="ghost" aria-label={`Remove access for ${person.email ?? person.name}`} disabled={busy} onClick={() => void mutate({ action: "revoke", targetUserId: person.userId }, data.organizationAccess ? "Direct access removed. Organization membership may still provide access." : "Access removed. This document is no longer shared with that collaborator.")}>Remove</Button>
        </li>)}</ul>}
      </> : <p className="text-sm text-muted-foreground">You {data.effectiveRole === "EDITOR" ? "can edit" : data.effectiveRole === "COMMENTER" ? "can comment" : "have view-only access"}. Ask the owner to change your access.</p>}
      {data.profileWarning && <p className="text-sm text-muted-foreground">Names could not be loaded. Collaboration IDs identify the saved grants; access controls still work.</p>}
    </div>}
    {data && <div className="space-y-3 border-t pt-4">
      <div className="flex items-center gap-2 text-sm font-medium"><LockKeyhole className="size-4" aria-hidden="true" />{data.organizationAccess ? "Organization and invited people" : "Restricted to invited people"}</div>
      <p className="text-sm text-muted-foreground">{data.organizationAccess ? "Organization members can edit by default. A direct role overrides that access; removing it restores organization access." : "A link opens this document only for its owner and people with access."} Review branches have separate access lists.</p>
      <Button type="button" variant="outline" onClick={() => void copyLink()}><LinkIcon className="size-4" aria-hidden="true" />Copy document link</Button>
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Link and your collaboration ID</summary><div className="mt-3 space-y-2">
        <label htmlFor={`${id}-link`}>Document link</label><Input id={`${id}-link`} readOnly value={typeof window === "undefined" ? `/documents/${documentId}` : new URL(`/documents/${documentId}`, window.location.origin).href} onFocus={(event) => event.target.select()} />
        <label htmlFor={`${id}-identity`}>Your collaboration ID</label><Input id={`${id}-identity`} readOnly value={data.collaborationId} onFocus={(event) => event.target.select()} />
      </div></details>
    </div>}
    {error && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh access</Button></div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Loading access…</p>}
  </section>;
}

export function ShareDialog({ documentId, title }: { documentId: string; title: string }) {
  return <Dialog>
    <DialogTrigger asChild><Button type="button" size="sm" className="shrink-0"><Users className="size-4" aria-hidden="true" /><span>Share</span></Button></DialogTrigger>
    <DialogContent className="max-h-[90dvh] w-[calc(100vw_-_2rem)] min-w-0 grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-lg">
      <DialogHeader className="pr-7 text-left"><DialogTitle className="break-words leading-snug">Share “{title}”</DialogTitle><DialogDescription>Choose who can open, comment on, or edit this document.</DialogDescription></DialogHeader>
      <SharingPanel documentId={documentId} />
    </DialogContent>
  </Dialog>;
}
