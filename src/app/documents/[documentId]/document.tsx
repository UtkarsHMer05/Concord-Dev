"use client";

import type { DocumentDetailDto } from "@/server/services/documents";

import { DocumentSessionProvider } from "@/lib/collaboration/provider";
import { parseDocumentContent } from "@/lib/collaboration/content";

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

  return (
    <DocumentSessionProvider
      documentId={document.id}
      initialContentVersion={document.contentVersion}
      canEditContent={canEdit}
      editorContent={editorContent}
    >
      <div className="min-h-screen bg-[#FAFBFD]">
        <div className="flex flex-col px-4 pt-2 gap-y-2 fixed top-0 left-0 right-0 z-10 bg-[#FAFBFD] print:hidden">
          <Navbar data={document} />
          <Toolbar />
        </div>
        <div className="pt-[114px] print:pt-0">
          <Editor />
        </div>
      </div>
    </DocumentSessionProvider>
  );
};
