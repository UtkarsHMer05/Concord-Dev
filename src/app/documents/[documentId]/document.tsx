"use client";

import { useMemo } from "react";

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
  // Transitional content loading: stored TipTap JSON (versioned envelope) if
  // present, otherwise the template's initial HTML content.
  const editorContent = parseDocumentContent(
    document.content,
    document.initialContent ?? null,
  );

  const canEdit = document.effectiveRole === "OWNER" || document.effectiveRole === "EDITOR";

  // Phase 2 local-first session: the worker owns the CRDT replica and its
  // IndexedDB durability; the editor bridge (created inside <Editor>) syncs
  // the TipTap document both ways. The client is created once per document.
  const crdtClient = useMemo(() => {
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      return null;
    }
    return new CrdtClient();
  }, []);

  return (
    <DocumentSessionProvider
      documentId={document.id}
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
          <Editor crdtClient={crdtClient} documentId={document.id} seedPmDoc={(editorContent ?? null) as never} />
        </div>
      </div>
    </DocumentSessionProvider>
  );
};
