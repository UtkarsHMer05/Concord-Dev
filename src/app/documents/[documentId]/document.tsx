"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import type { DocumentDetailDto } from "@/server/services/documents";
import { CrdtClient } from "@/lib/crdt/worker/client";
import type { CatchupBriefing } from "@/lib/sync/catchup-briefing";
import { parseDocumentContent } from "@/lib/collaboration/content";
import { DocumentSessionProvider } from "@/lib/collaboration/provider";

import { Editor } from "./editor";
import { Navbar } from "./navbar";
import { Toolbar } from "./toolbar";

interface DocumentProps {
  document: DocumentDetailDto;
}

export const Document = ({ document }: DocumentProps) => {
  const { isLoaded, userId } = useAuth();
  const documentId = document.id;
  // Transitional content loading: stored TipTap JSON (versioned envelope) if
  // present, otherwise the template's initial HTML content.
  const editorContent = parseDocumentContent(
    document.content,
    document.initialContent ?? null,
  );

  const canEdit = document.effectiveRole === "OWNER" || document.effectiveRole === "EDITOR";
  const [catchupBriefing, setCatchupBriefing] = useState<CatchupBriefing | null>(null);
  const [syncNow, setSyncNow] = useState<() => void>(() => () => {});

  // Phase 2 local-first session: the worker owns the CRDT replica and its
  // IndexedDB durability; the editor bridge (created inside <Editor>) syncs
  // the TipTap document both ways. The client is scoped to this account and document.
  const crdtClient = useMemo(() => {
    if (
      typeof window === "undefined" ||
      typeof Worker === "undefined" ||
      !isLoaded ||
      !userId
    ) {
      return null;
    }
    return new CrdtClient();
    // Worker instances own one document's state and must be replaced on route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- document-scoped worker lifetime
  }, [documentId, isLoaded, userId]);

  return (
    <DocumentSessionProvider
      documentId={documentId}
      initialContentVersion={document.contentVersion}
      canEditContent={canEdit}
      editorContent={editorContent}
    >
      <div className="min-h-screen bg-[#FAFBFD]">
        <div className="flex flex-col px-2 sm:px-4 pt-2 gap-y-2 fixed top-0 left-0 right-0 z-10 bg-[#FAFBFD] print:hidden">
          <Navbar data={document} crdtClient={crdtClient} syncNow={syncNow} />
          <Toolbar />
          {catchupBriefing && (
            <aside className="flex items-start justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm shadow-sm" aria-label="While you were away" role="status">
              <div className="min-w-0">
                <p className="font-medium">While you were away</p>
                <p className="text-muted-foreground">
                  {catchupBriefing.durableOperationCount === null ? (
                    `A server snapshot covered part of the range between cursors ${catchupBriefing.fromCursor} and ${catchupBriefing.toCursor}; individual operation counts and origins are unavailable.`
                  ) : (
                    <>
                      {catchupBriefing.durableOperationCount} durable {catchupBriefing.durableOperationCount === 1 ? "operation" : "operations"} arrived between cursors {catchupBriefing.fromCursor} and {catchupBriefing.toCursor}.
                      {catchupBriefing.replicas && catchupBriefing.replicas.length > 0 ? ` Origins: ${catchupBriefing.replicas.map(({ replicaId, operationCount }) => `${replicaId} (${operationCount})`).join(", ")}.` : " No operation origin could be identified."}
                      {catchupBriefing.unattributedOperationCount !== null && catchupBriefing.unattributedOperationCount > 0 ? ` ${catchupBriefing.unattributedOperationCount} operation(s) had unreadable origins.` : ""}
                    </>
                  )}
                  {catchupBriefing.localUnackedOperationCount === null ? " Local outbox status could not be read." : ` ${catchupBriefing.localUnackedOperationCount} local operation(s) are still awaiting server confirmation.`}
                  {catchupBriefing.replicaListTruncated ? " Some replica IDs are omitted." : ""}
                </p>
                <p className="text-xs text-muted-foreground">Replica IDs are technical operation origins, not people or edit intent.</p>
              </div>
              <button type="button" className="shrink-0 rounded px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setCatchupBriefing(null)}>Dismiss</button>
            </aside>
          )}
          {!canEdit && (
            <div
              className="text-sm text-muted-foreground bg-muted/60 border border-border rounded-md px-3 py-1.5"
              role="status"
            >
              You have view-only access to this document.
            </div>
          )}
        </div>
        {/* The reconnect briefing adds one row below the fixed chrome; the
            816px sheet scrolls horizontally on narrow viewports. */}
        <div className={catchupBriefing ? "pt-[196px] print:pt-0" : "pt-[114px] print:pt-0"}>
          <Editor
            crdtClient={crdtClient}
            documentId={documentId}
            userId={userId ?? null}
            onCatchupBriefing={setCatchupBriefing}
            onSyncNowReady={(request) => setSyncNow(() => request)}
          />
        </div>
      </div>
    </DocumentSessionProvider>
  );
};
