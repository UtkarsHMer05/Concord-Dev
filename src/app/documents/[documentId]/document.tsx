"use client";

import { useMemo } from "react";
import { useAuth } from "@clerk/nextjs";

import type { DocumentDetailDto } from "@/server/services/documents";
import { CrdtClient } from "@/lib/crdt/worker/client";
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
          <Navbar data={document} />
          <Toolbar />
          {!canEdit && (
            <div
              className="text-sm text-muted-foreground bg-muted/60 border border-border rounded-md px-3 py-1.5"
              role="status"
            >
              You have view-only access to this document.
            </div>
          )}
        </div>
        {/* Fixed chrome height: navbar (~52px) + toolbar (40px) + gaps.
            The 816px page below scrolls horizontally inside its container
            on narrow viewports (documented desktop-first limitation). */}
        <div className="pt-[114px] print:pt-0">
          <Editor crdtClient={crdtClient} documentId={documentId} userId={userId ?? null} />
        </div>
      </div>
    </DocumentSessionProvider>
  );
};
