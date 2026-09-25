"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AnchorResolution, CrdtRangeAnchor } from "@/lib/comments/anchors";
import {
  deleteCommentOutboxItem,
  readCommentOutbox,
  removeCommentOutboxItem,
  saveCommentOutboxItem,
  type PendingComment,
} from "@/lib/comments/outbox";

export interface CommentSelection {
  anchor: CrdtRangeAnchor;
  quote: string;
}

export interface CommentsPanelProps {
  documentId: string;
  userId: string;
  canComment: boolean;
  canResolve: boolean;
  /** Current text selection converted to stable CRDT IDs by the editor host. */
  selection: CommentSelection | null;
  /** Increment after each local or remote editor transaction. */
  anchorRevision: number;
  /** Resolves a batch against one current editor/CRDT snapshot. Keep this callback stable. */
  resolveAnchors: (items: Array<{ threadId: string; anchor: CrdtRangeAnchor }>) => Promise<Record<string, AnchorResolution>>;
  /** Focuses and scrolls the editor to an attached range. */
  onNavigateToRange: (from: number, to: number) => void;
}

interface CommentMessage {
  id: string;
  createdBy: string;
  authorName: string | null;
  body: string;
  createdAt: string;
  deliveryError?: string;
  sending?: boolean;
}

interface CommentThread {
  id: string;
  anchor: CrdtRangeAnchor;
  quote: string;
  status: "open" | "resolved";
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  messages: CommentMessage[];
  deliveryError?: string;
  sending?: boolean;
}

interface CommentListResponse {
  threads: CommentThread[];
  truncated: { threads: boolean; messages: boolean };
}

class CommentRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${response.status})`;
    throw new CommentRequestError(message, response.status);
  }
  return body as T;
}

function endpoint(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/comments`;
}

function deliveryError(error: unknown): string {
  if (error instanceof CommentRequestError) {
    return error.status === 401 ? "Sign in again to sync this comment." : error.message;
  }
  return error instanceof Error ? error.message : "Connection failed";
}

function withPending(items: PendingComment[], threads: CommentThread[], sendingIds: Set<string>, userId: string): CommentThread[] {
  const result = threads.map((thread) => ({ ...thread, messages: [...thread.messages] }));
  for (const item of items) {
    const sending = sendingIds.has(item.id);
    if (item.kind === "thread") {
      if (result.some((thread) => thread.id === item.threadId)) continue;
      result.push({
        id: item.threadId,
        anchor: item.anchor,
        quote: item.quote,
        status: "open",
        authorName: "You",
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        messages: [{
          id: item.messageId,
          createdBy: userId,
          authorName: "You",
          body: item.body,
          createdAt: item.createdAt,
          deliveryError: item.error,
          sending,
        }],
        deliveryError: item.error,
        sending,
      });
      continue;
    }
    const thread = result.find((candidate) => candidate.id === item.threadId);
    if (thread && !thread.messages.some((message) => message.id === item.messageId)) {
      thread.messages.push({
        id: item.messageId,
        createdBy: userId,
        authorName: "You",
        body: item.body,
        createdAt: item.createdAt,
        deliveryError: item.error,
        sending,
      });
    }
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function CommentsPanel(props: CommentsPanelProps) {
  return <CommentsPanelState key={`${props.documentId}:${props.userId}`} {...props} />;
}

function CommentsPanelState({
  documentId,
  userId,
  canComment,
  canResolve,
  selection,
  anchorRevision,
  resolveAnchors,
  onNavigateToRange,
}: CommentsPanelProps) {
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [truncated, setTruncated] = useState({ threads: false, messages: false });
  const [outbox, setOutbox] = useState<PendingComment[]>([]);
  const outboxRef = useRef<PendingComment[]>([]);
  const flushing = useRef(false);
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [anchorStates, setAnchorStates] = useState<Record<string, AnchorResolution["status"]>>({});
  const [anchorErrors, setAnchorErrors] = useState<Set<string>>(new Set());
  const [newBody, setNewBody] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");

  const setQueue = useCallback((items: PendingComment[]) => {
    outboxRef.current = items;
    setOutbox(items);
  }, []);

  const refresh = useCallback(async () => {
    const result = await requestJson<CommentListResponse>(endpoint(documentId), { cache: "no-store" });
    setThreads(result.threads);
    setTruncated(result.truncated);
  }, [documentId]);

  const updatePersistedItem = useCallback((item: PendingComment) => {
    saveCommentOutboxItem(documentId, userId, item);
    const exists = outboxRef.current.some((candidate) => candidate.id === item.id);
    setQueue(exists
      ? outboxRef.current.map((candidate) => (candidate.id === item.id ? item : candidate))
      : [...outboxRef.current, item]);
  }, [documentId, userId, setQueue]);

  const deletePersistedItem = useCallback((id: string) => {
    deleteCommentOutboxItem(documentId, userId, id);
    setQueue(removeCommentOutboxItem(outboxRef.current, id));
  }, [documentId, userId, setQueue]);

  const flushOutbox = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    const attempted = new Set<string>();
    const saved: PendingComment[] = [];
    try {
      while (true) {
        const item = outboxRef.current.find((candidate) => !attempted.has(candidate.id));
        if (!item) break;
        attempted.add(item.id);
        setSendingIds((previous) => new Set(previous).add(item.id));
        try {
          if (item.kind === "thread") {
            await requestJson(`${endpoint(documentId)}`, {
              method: "POST",
              body: JSON.stringify({
                threadId: item.threadId,
                messageId: item.messageId,
                anchor: item.anchor,
                quote: item.quote,
                body: item.body,
              }),
            });
          } else {
            await requestJson(`${endpoint(documentId)}/${encodeURIComponent(item.threadId)}/messages`, {
              method: "POST",
              body: JSON.stringify({ messageId: item.messageId, body: item.body }),
            });
          }
          saved.push(item);
          try {
            deletePersistedItem(item.id);
          } catch {
            // The server ACK is durable; a leftover local ID safely retries idempotently.
            setQueue(removeCommentOutboxItem(outboxRef.current, item.id));
          }
        } catch (error) {
          const failed = outboxRef.current.find((candidate) => candidate.id === item.id);
          if (!failed) continue;
          const withError = { ...failed, error: deliveryError(error) };
          try {
            updatePersistedItem(withError);
          } catch {
            setQueue(outboxRef.current.map((candidate) => (candidate.id === item.id ? withError : candidate)));
          }
        } finally {
          setSendingIds((previous) => {
            const next = new Set(previous);
            next.delete(item.id);
            return next;
          });
        }
      }
      if (saved.length > 0) {
        setNotice("Saved to Concord.");
        try {
          await refresh();
        } catch {
          // POST returned the durable ACK; leave the optimistic items visible until the next refresh.
          setThreads((previous) => withPending(saved, previous, new Set(), userId));
        }
      }
    } finally {
      flushing.current = false;
    }
  }, [deletePersistedItem, documentId, refresh, setQueue, updatePersistedItem, userId]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        setQueue(readCommentOutbox(documentId, userId));
      } catch {
        setQueue([]);
      }
      void flushOutbox();
    });
    void Promise.resolve().then(async () => {
      try {
        await refresh();
      } catch (error) {
        if (active) setNotice(`Comments could not be loaded: ${deliveryError(error)}`);
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => { active = false; };
  }, [documentId, flushOutbox, refresh, setQueue, userId]);

  useEffect(() => {
    const retry = () => { void flushOutbox(); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [documentId, userId, flushOutbox]);

  const visibleThreads = useMemo(
    () => withPending(outbox, threads, sendingIds, userId),
    [outbox, sendingIds, threads, userId],
  );
  const anchorInputs = useMemo(
    () => withPending(outbox, threads, new Set(), userId).map(({ id, anchor }) => ({ threadId: id, anchor })),
    [outbox, threads, userId],
  );

  useEffect(() => {
    let active = true;
    void resolveAnchors(anchorInputs).then((results) => {
      if (active) {
        setAnchorStates(Object.fromEntries(Object.entries(results).map(([id, value]) => [id, value.status])));
        setAnchorErrors(new Set());
      }
    }).catch(() => {
      if (active) setAnchorErrors(new Set(anchorInputs.map((item) => item.threadId)));
    });
    return () => { active = false; };
  }, [anchorInputs, anchorRevision, resolveAnchors]);

  const enqueue = useCallback((item: PendingComment): boolean => {
    try {
      updatePersistedItem(item);
      return true;
    } catch (error) {
      setNotice(error instanceof Error && error.message.includes("limit")
        ? "Too many pending comments are queued on this device; reconnect and let them send first."
        : "Not saved yet. Browser storage is unavailable; keep this text and try again.");
      return false;
    }
  }, [updatePersistedItem]);

  const createThread = useCallback(() => {
    const body = newBody.trim();
    if (!selection || !body || !canComment) return;
    const threadId = crypto.randomUUID();
    const item: PendingComment = {
      id: `thread:${threadId}`,
      kind: "thread",
      threadId,
      messageId: crypto.randomUUID(),
      documentId,
      userId,
      anchor: selection.anchor,
      quote: selection.quote.slice(0, 1000),
      body,
      createdAt: new Date().toISOString(),
    };
    if (enqueue(item)) {
      setNewBody("");
      setNotice("Saved on this device. Sending to Concord…");
      void flushOutbox();
    }
  }, [canComment, documentId, enqueue, flushOutbox, newBody, selection, userId]);

  const createReply = useCallback(async (threadId: string) => {
    const body = (replyDrafts[threadId] ?? "").trim();
    if (!body || !canComment) return;
    const item: PendingComment = {
      id: `reply:${crypto.randomUUID()}`,
      kind: "reply",
      threadId,
      messageId: crypto.randomUUID(),
      documentId,
      userId,
      body,
      createdAt: new Date().toISOString(),
    };
    if (enqueue(item)) {
      setReplyDrafts((previous) => ({ ...previous, [threadId]: "" }));
      setNotice("Saved on this device. Sending to Concord…");
      void flushOutbox();
    }
  }, [canComment, documentId, enqueue, flushOutbox, replyDrafts, userId]);

  const openAnchor = useCallback(async (thread: CommentThread) => {
    try {
      const resolution = (await resolveAnchors([{ threadId: thread.id, anchor: thread.anchor }]))[thread.id];
      if (!resolution) throw new Error("Anchor could not be resolved");
      setAnchorStates((previous) => ({ ...previous, [thread.id]: resolution.status }));
      setAnchorErrors((previous) => { const next = new Set(previous); next.delete(thread.id); return next; });
      if (resolution.status === "attached") onNavigateToRange(resolution.from, resolution.to);
    } catch (error) {
      setAnchorErrors((previous) => new Set(previous).add(thread.id));
      setNotice(`Could not locate this comment: ${deliveryError(error)}`);
    }
  }, [onNavigateToRange, resolveAnchors]);

  const setThreadStatus = useCallback(async (thread: CommentThread) => {
    const status = thread.status === "open" ? "resolved" : "open";
    try {
      await requestJson(`${endpoint(documentId)}/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setNotice(status === "resolved" ? "Thread resolved." : "Thread reopened.");
      await refresh();
    } catch (error) {
      setNotice(`Thread status was not saved: ${deliveryError(error)}`);
    }
  }, [documentId, refresh]);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col rounded-lg border bg-background" aria-label="Document comments">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Review comments</h2>
          <p className="text-xs text-muted-foreground">Threads stay attached to CRDT content.</p>
        </div>
        {outbox.length > 0 && (
          <Button type="button" size="sm" variant="outline" onClick={() => void flushOutbox()}>
            Retry {outbox.length} pending
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {notice && <p className="text-sm text-muted-foreground" role="status" aria-live="polite">{notice}</p>}

        {canComment && (
          <form onSubmit={(event) => { event.preventDefault(); createThread(); }} className="space-y-2 rounded-md border p-3">
            <label htmlFor="new-comment" className="text-sm font-medium">New thread</label>
            {selection ? (
              <blockquote className="line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground">{selection.quote || "Selected passage"}</blockquote>
            ) : (
              <p className="text-xs text-muted-foreground">Select text in the document to anchor a thread.</p>
            )}
            <textarea
              id="new-comment"
              value={newBody}
              onChange={(event) => setNewBody(event.target.value)}
              maxLength={4000}
              rows={3}
              placeholder="Write a comment…"
              className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={!selection || !newBody.trim()}>
                Comment
              </Button>
            </div>
          </form>
        )}

        {loading ? <p className="text-sm text-muted-foreground">Loading comments…</p> : null}
        {(truncated.threads || truncated.messages) && (
          <p className="text-xs text-muted-foreground" role="status">
            Showing the latest 200 threads and 2,000 replies. Older comments are still saved but are not loaded yet.
          </p>
        )}
        {!loading && visibleThreads.length === 0 && <p className="text-sm text-muted-foreground">No threads yet.</p>}

        {visibleThreads.map((thread) => {
          const anchorState = anchorStates[thread.id];
          return (
            <article key={thread.id} className="space-y-3 rounded-md border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {thread.authorName ?? "Collaborator"} · {new Date(thread.createdAt).toLocaleString()}
                  </p>
                  <blockquote className="mt-1 line-clamp-3 border-l-2 pl-2 text-sm">{thread.quote || "Commented passage"}</blockquote>
                </div>
                {canResolve && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => void setThreadStatus(thread)}>
                    {thread.status === "open" ? "Resolve" : "Reopen"}
                  </Button>
                )}
              </div>

              {anchorErrors.has(thread.id) ? (
                <div className="flex items-center gap-2">
                  <p className="text-xs text-muted-foreground" role="status">Could not verify this passage.</p>
                  <Button type="button" size="sm" variant="outline" onClick={() => void openAnchor(thread)}>Retry</Button>
                </div>
              ) : anchorState === "orphaned" ? (
                <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900" role="status">Passage deleted; this thread is preserved as an orphan.</p>
              ) : anchorState === "unavailable" ? (
                <p className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground" role="status">The current document state is unavailable; this thread was not reattached.</p>
              ) : (
                <Button type="button" size="sm" variant="outline" onClick={() => void openAnchor(thread)} disabled={anchorState === undefined}>
                  {anchorState === undefined ? "Checking passage…" : "Open passage"}
                </Button>
              )}

              <div className="space-y-2">
                {thread.messages.map((message) => (
                  <div key={message.id} className="rounded bg-muted/40 px-2 py-2">
                    <p className="text-xs text-muted-foreground">{message.authorName ?? "Collaborator"}</p>
                    <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                    {message.sending && <p className="text-xs text-muted-foreground">Sending…</p>}
                    {message.deliveryError && <p className="text-xs text-destructive">Pending: {message.deliveryError}</p>}
                  </div>
                ))}
              </div>

              {canComment && thread.status === "open" && (
                <form onSubmit={(event) => { event.preventDefault(); void createReply(thread.id); }} className="flex gap-2">
                  <input
                    aria-label="Reply to thread"
                    value={replyDrafts[thread.id] ?? ""}
                    onChange={(event) => setReplyDrafts((previous) => ({ ...previous, [thread.id]: event.target.value }))}
                    maxLength={4000}
                    placeholder="Reply…"
                    className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button type="submit" size="sm" variant="outline" disabled={!(replyDrafts[thread.id] ?? "").trim()} aria-label="Send reply">Send</Button>
                </form>
              )}
              {thread.status === "resolved" && <p className="text-xs text-muted-foreground">Resolved</p>}
              {thread.deliveryError && <p className="text-xs text-destructive">Thread pending: {thread.deliveryError}</p>}
            </article>
          );
        })}
      </div>
    </aside>
  );
}
