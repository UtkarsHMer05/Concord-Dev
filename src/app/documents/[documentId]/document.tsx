"use client";

import { Preloaded, usePreloadedQuery } from "convex/react";

import { DocumentSessionProvider } from "@/lib/collaboration/provider";
import { parseDocumentContent } from "@/lib/collaboration/content";

import { Editor } from "./editor";
import { Navbar } from "./navbar";
import { Toolbar } from "./toolbar";
import { api } from "../../../../convex/_generated/api";

interface DocumentProps {
  preloadedDocument: Preloaded<typeof api.documents.getById>;
};

export const Document = ({ preloadedDocument }: DocumentProps) => {
  const document = usePreloadedQuery(preloadedDocument);

  // Transitional content loading: stored TipTap JSON (versioned envelope) if
  // present, otherwise the template's initial HTML content.
  const editorContent = parseDocumentContent(
    document.content,
    document.initialContent ?? null,
  );

  return (
    <DocumentSessionProvider documentId={document._id} editorContent={editorContent}>
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
