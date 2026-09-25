"use client";

/**
 * Suggestion mode v1 (Feature 4 — anchor sidecar, like comments).
 *
 * A suggestion = a CRDT range anchor + the proposed replacement text.
 * Accepting applies the text through the editor bridge as NORMAL durable
 * CRDT edits (no side channel, no op-format change); the anchored range
 * resolves with the same item-ID machinery as comments, so an anchor whose
 * target was deleted reports ORPHANED and the honest terminal state is
 * "discharged", never a silent mis-application.
 *
 * V1 scope note: proposals are made from a text SELECTION (replacement or
 * deletion; empty proposed text = deletion). Insertion proposals from a bare
 * caret are a later iteration.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AnchorResolution, CrdtRangeAnchor } from "@/lib/comments/anchors";

export interface SuggestionSelection {
  anchor: CrdtRangeAnchor;
  quote: string;
}

export interface SuggestionsPanelProps {
  documentId: string;
  userId: string;
  canPropose: boolean;
  canAccept: boolean;
  selection: SuggestionSelection | null;
  /** Increment after each local or remote editor transaction. */
  anchorRevision: number;
  /** Resolves a batch against one current editor/CRDT snapshot. Keep stable. */
  resolveAnchors: (items: Array<{ threadId: string; anchor: CrdtRangeAnchor }>) => Promise<Record<string, AnchorResolution>>;
  /** Focuses and scrolls the editor to an attached range. */
  onNavigateToRange: (from: number, to: number) => void;
  /** Applies the replacement as normal editor edits (host-owned: the panel
   *  never touches the editor directly). Throws when the doc is read-only. */
  applyReplacement: (from: number, to: number, proposedText: string) => void;
}

interface Suggestion {
  id: string;
  anchor: CrdtRangeAnchor;
  quote: string;
  proposedText: string;
  status: "proposed" | "accepted" | "rejected" | "discharged";
  createdBy: string;
  authorName: string | null;
  createdAt: string;
}

class SuggestionRequestError extends Error {
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
    throw new SuggestionRequestError(message, response.status);
  }
  return body as T;
}

function requestError(error: unknown): string {
  if (error instanceof SuggestionRequestError) {
    return error.status === 401 ? "Sign in again to sync this suggestion."
      : error.status === 403 ? "You do not have permission for that."
        : error.status === 409 ? "This suggestion was already resolved."
          : error.message;
  }
  return error instanceof Error ? error.message : "Connection failed";
}

const STATUS_LABEL: Record<Suggestion["status"], string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
  discharged: "Discharged (target text changed)",
};

export function SuggestionsPanel({
  documentId,
  userId,
  canPropose,
  canAccept,
  selection,
  anchorRevision,
  resolveAnchors,
  onNavigateToRange,
  applyReplacement,
}: SuggestionsPanelProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, AnchorResolution>>({});
  const [proposedText, setProposedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const endpoint = `/api/documents/${encodeURIComponent(documentId)}/suggestions`;

  const refresh = useCallback(async () => {
    try {
      const data = await requestJson<{ suggestions: Suggestion[] }>(endpoint);
      setSuggestions(data.suggestions);
      setError("");
    } catch (cause) {
      setError(requestError(cause));
    }
  }, [endpoint]);

  // setState must not run synchronously in the effect body (effect-purity
  // lint); defer into a microtask like the comments panel does.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (active) await refresh();
    });
    return () => { active = false; };
  }, [refresh]);

  // Resolve every proposal's anchor against the CURRENT document state.
  const anchorInputs = useMemo(
    () => (suggestions ?? []).map((suggestion) => ({ threadId: suggestion.id, anchor: suggestion.anchor })),
    [suggestions],
  );
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (anchorInputs.length === 0) {
        setResolutions({});
        return;
      }
      void resolveAnchors(anchorInputs)
        .then((result) => { if (active) setResolutions(result); })
        .catch(() => { if (active) setResolutions({}); });
    });
    return () => { active = false; };
  }, [anchorInputs, anchorRevision, resolveAnchors]);

  const propose = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canPropose || !selection || !proposedText.trim()) return;
    if (selection.quote === proposedText) {
      setError("The proposed text is identical to the selected text.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await requestJson(endpoint, {
        method: "POST",
        body: JSON.stringify({
          suggestionId: crypto.randomUUID(),
          anchor: selection.anchor,
          quote: selection.quote,
          proposedText,
        }),
      });
      setProposedText("");
      setNotice("Suggestion proposed. Editors can accept it to apply the change as durable edits.");
      await refresh();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const resolveSuggestion = async (suggestion: Suggestion, action: "accept" | "reject" | "discharge") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "accept") {
        const resolution = (await resolveAnchors([{ threadId: suggestion.id, anchor: suggestion.anchor }]))[suggestion.id];
        if (resolution?.status !== "attached") {
          // Honest path: the target text was deleted before acceptance.
          await requestJson(`${endpoint}/${encodeURIComponent(suggestion.id)}`, {
            method: "POST",
            body: JSON.stringify({ action: "discharge" }),
          });
          setNotice("The anchored text no longer exists — the suggestion was discharged instead of mis-applied.");
          await refresh();
          return;
        }
        // Authorize + mark first; only then mutate the document. If the
        // application fails, discharge so the record never claims success.
        await requestJson(`${endpoint}/${encodeURIComponent(suggestion.id)}`, {
          method: "POST",
          body: JSON.stringify({ action: "accept" }),
        });
        try {
          applyReplacement(resolution.from, resolution.to, suggestion.proposedText);
        } catch (applyError) {
          await requestJson(`${endpoint}/${encodeURIComponent(suggestion.id)}`, {
            method: "POST",
            body: JSON.stringify({ action: "discharge" }),
          }).catch(() => undefined);
          throw applyError;
        }
        setNotice("Suggestion applied as durable edits.");
      } else {
        await requestJson(`${endpoint}/${encodeURIComponent(suggestion.id)}`, {
          method: "POST",
          body: JSON.stringify({ action }),
        });
        setNotice(action === "reject" ? "Suggestion rejected." : "Suggestion discharged.");
      }
      await refresh();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  };

  const canResolveOne = (suggestion: Suggestion): boolean =>
    canAccept || suggestion.createdBy === userId;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {canPropose && (
        <form onSubmit={(event) => void propose(event)} className="shrink-0 space-y-2 rounded-md border p-3">
          {selection ? (
            <p className="truncate text-xs text-muted-foreground" aria-label="Selected text">
              Suggest a change to: “{selection.quote.slice(0, 80)}{selection.quote.length > 80 ? "…" : ""}”
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Select text in the document to propose a replacement.</p>
          )}
          <textarea
            value={proposedText}
            onChange={(event) => setProposedText(event.target.value)}
            aria-label="Proposed replacement text"
            placeholder="Proposed text (empty = delete the selection)"
            maxLength={4000}
            rows={3}
            className="w-full resize-none rounded-md border bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm" disabled={busy || !selection || !proposedText.trim()}>Propose change</Button>
        </form>
      )}
      {notice && <p role="status" className="shrink-0 text-sm text-muted-foreground">{notice}</p>}
      {error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto" aria-label="Document suggestions">
        {(suggestions ?? []).map((suggestion) => {
          const resolution = resolutions[suggestion.id];
          const attached = resolution?.status === "attached";
          return (
            <article key={suggestion.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {suggestion.createdBy === userId ? "You" : suggestion.authorName ?? "Unknown"} · {new Date(suggestion.createdAt).toLocaleString()}
                </span>
                <span className="rounded-full border px-2 py-0.5 text-xs">{STATUS_LABEL[suggestion.status]}</span>
              </div>
              {suggestion.status === "proposed" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {resolution === undefined ? "Checking anchor…" : attached ? "Target text is current." : "Target text changed or was deleted."}
                </p>
              )}
              <p className="mt-1 line-through decoration-destructive/60">{suggestion.quote || "(insertion point)"}</p>
              <p className="whitespace-pre-wrap font-medium">{suggestion.proposedText === "" ? "(delete the selection)" : suggestion.proposedText}</p>
              {suggestion.status === "proposed" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {canAccept && (
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void resolveSuggestion(suggestion, "accept")}>
                      Accept &amp; apply
                    </Button>
                  )}
                  {canResolveOne(suggestion) && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void resolveSuggestion(suggestion, "reject")}>
                      Reject
                    </Button>
                  )}
                  {resolution?.status === "attached" && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onNavigateToRange(resolution.from, resolution.to)}>
                      Show in document
                    </Button>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {suggestions !== null && suggestions.length === 0 && (
          <p className="text-sm text-muted-foreground">No suggestions yet.</p>
        )}
        {suggestions === null && !error && <p className="text-sm text-muted-foreground">Loading suggestions…</p>}
      </div>
    </div>
  );
}
